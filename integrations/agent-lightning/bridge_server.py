#!/usr/bin/env python3
"""
AGL bridge server for OpenClaw web UI chat.

When the gateway has gateway.agl.bridgeUrl set, chat.send is forwarded here.
This server runs an AGL rollout with openclaw_agent_gateway, which calls back
to the gateway's POST /_openclaw/internal/agent-run. Traces are created by AGL.

Usage:
  pip install -r requirements.txt
  python bridge_server.py [--port 8765]

Then set in OpenClaw config (e.g. ~/.openclaw/config.json):
  "gateway": {
    "port": 18789,
    "agl": {
      "bridgeUrl": "http://127.0.0.1:8765",
      "internalAgentRunSecret": "your-secret"
    }
  }
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path

# Add parent so we can import openclaw_agent_gateway
sys.path.insert(0, str(Path(__file__).resolve().parent))

from aiohttp import web

TRACES_DIR = Path(__file__).resolve().parent / "traces"


def _span_to_dict(s: object) -> dict:
    """Serialize a span to a JSON-serializable dict."""
    if hasattr(s, "model_dump"):
        return s.model_dump()
    if hasattr(s, "dict"):
        return s.dict()
    return {"name": getattr(s, "name", str(s)), "attributes": getattr(s, "attributes", {})}

from agentlightning import LitAgentRunner, OtelTracer
from agentlightning.store import InMemoryLightningStore
from agentlightning.types.resources import PromptTemplate

from openclaw_agent import openclaw_agent_gateway

_MINIMAL_PROMPT = PromptTemplate(
    template="User message: {input}",
    engine="f-string",
)

_store: InMemoryLightningStore | None = None
_runner: LitAgentRunner | None = None


async def _ensure_runner() -> LitAgentRunner:
    global _store, _runner
    if _runner is not None:
        return _runner
    _store = InMemoryLightningStore()
    await _store.add_resources({"prompt_template": _MINIMAL_PROMPT})
    tracer = OtelTracer()
    tracer.init_worker(0, store=_store)
    _runner = LitAgentRunner(tracer=tracer)
    _runner.init(openclaw_agent_gateway)
    _runner.init_worker(0, store=_store)
    return _runner


async def handle_chat(request: web.Request) -> web.Response:
    print("[bridge] /chat request received", flush=True)
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response(
            {"ok": False, "error": f"Invalid JSON: {e}"},
            status=400,
        )
    session_key = body.get("sessionKey") or ""
    message = body.get("message") or ""
    idempotency_key = body.get("idempotencyKey") or ""
    gateway_base_url = (body.get("gatewayBaseUrl") or "").rstrip("/")
    internal_secret = body.get("internalSecret") or ""
    if not session_key or not message or not gateway_base_url:
        return web.json_response(
            {"ok": False, "error": "sessionKey, message, and gatewayBaseUrl required"},
            status=400,
        )
    response_ref: list[str] = []
    task_input = {
        "input": {
            "gatewayBaseUrl": gateway_base_url,
            "internalSecret": internal_secret,
            "sessionKey": session_key,
            "message": message,
            "idempotencyKey": idempotency_key or f"bridge-{id(body)}",
            "_response_ref": response_ref,
        },
    }
    try:
        runner = await _ensure_runner()
        rollout = await runner.step(task_input, mode="val")
        print(f"[bridge] step() returned type={type(rollout).__name__}", flush=True)
    except Exception as e:
        return web.json_response(
            {"ok": False, "error": str(e)},
            status=500,
        )

    # Persist traces to file (rollout from store, or fallback to tracer's last trace)
    try:
        rollout_id = None
        attempt_id = None
        status = None
        spans = []
        if rollout is not None:
            rollout_id = getattr(rollout, "rollout_id", None) or (
                rollout.get("rollout_id") if isinstance(rollout, dict) else None
            )
            attempt_id = getattr(rollout, "attempt_id", None) if not isinstance(rollout, dict) else rollout.get("attempt_id")
            status = getattr(rollout, "status", None) if not isinstance(rollout, dict) else rollout.get("status")
            print(f"[bridge] rollout_id={rollout_id!r} attempt_id={attempt_id!r} status={status!r}", flush=True)
        if _store and rollout_id:
            spans = await _store.query_spans(rollout_id)
            print(f"[bridge] store.query_spans({rollout_id!r}) -> {len(spans)} spans", flush=True)
        if not spans and runner.tracer is not None and hasattr(runner.tracer, "get_last_trace"):
            spans = runner.tracer.get_last_trace() or []
            print(f"[bridge] tracer.get_last_trace() -> {len(spans)} spans", flush=True)
            if not rollout_id:
                rollout_id = f"bridge-{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}"
        # Always write a trace file for every chat (use synthetic id if needed)
        timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
        rid = rollout_id or f"bridge-{timestamp}"
        TRACES_DIR.mkdir(parents=True, exist_ok=True)
        trace_file = TRACES_DIR / f"rollout_{rid}_{timestamp}.json"
        task_input_safe = {
            "input": {
                k: v for k, v in task_input.get("input", {}).items()
                if k != "_response_ref"
            }
        }
        payload = {
            "rollout_id": rid,
            "attempt_id": attempt_id,
            "status": status,
            "task_input": task_input_safe,
            "span_count": len(spans),
            "spans": [_span_to_dict(s) for s in spans],
        }
        trace_file.write_text(json.dumps(payload, indent=2, default=str))
        print(f"[bridge] traces written to {trace_file}", flush=True)
    except Exception as e:
        import traceback
        print(f"[bridge] trace write failed: {e}", flush=True)
        traceback.print_exc()
    response_text = response_ref[0] if response_ref else ""
    return web.json_response(
        {
            "ok": True,
            "responseText": response_text,
            "runId": idempotency_key or task_input["input"].get("idempotencyKey", ""),
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="AGL bridge for OpenClaw web chat")
    parser.add_argument("--port", type=int, default=8765, help="Port to listen on")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind")
    args = parser.parse_args()
    app = web.Application()
    app.router.add_post("/chat", handle_chat)
    web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
