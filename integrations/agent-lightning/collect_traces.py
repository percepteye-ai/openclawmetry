#!/usr/bin/env python3
"""
Run many AGL rollouts from a list of prompts via the gateway and write a trace file for each.

Uses openclaw_agent_gateway so the agent runs inside the gateway with the same
session and tools as the web UI. Put one prompt per line in prompts.txt, run
this script, then export_sft_dataset.py to build sft_dataset.jsonl.

Required env (start the gateway first):
  GATEWAY_BASE_URL   e.g. http://127.0.0.1:19001
  INTERNAL_SECRET    same as gateway.agl.internalAgentRunSecret
  SESSION_KEY        e.g. agent:dev:main

Usage:
  cd integrations/agent-lightning
  source .venv/bin/activate
  export GATEWAY_BASE_URL=http://127.0.0.1:19001
  export INTERNAL_SECRET=pick-a-secret-string
  export SESSION_KEY=agent:dev:main
  python collect_traces.py prompts.txt
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path
from datetime import datetime

ROOT_DIR = Path(__file__).resolve().parent
TRACES_DIR = ROOT_DIR / "traces"
DEFAULT_PROMPTS_FILE = ROOT_DIR / "prompts.txt"

sys.path.insert(0, str(ROOT_DIR))


def _span_to_dict(s: object) -> dict:
    if hasattr(s, "model_dump"):
        return s.model_dump()
    if hasattr(s, "dict"):
        return s.dict()
    return {"name": getattr(s, "name", str(s)), "attributes": getattr(s, "attributes", {})}


async def main() -> None:
    gateway_base_url = os.environ.get("GATEWAY_BASE_URL", "").strip().rstrip("/")
    internal_secret = os.environ.get("INTERNAL_SECRET", "").strip()
    session_key = os.environ.get("SESSION_KEY", "").strip()
    if not gateway_base_url or not internal_secret or not session_key:
        print("Missing required env. Set GATEWAY_BASE_URL, INTERNAL_SECRET, and SESSION_KEY.", file=sys.stderr)
        print("Example: export GATEWAY_BASE_URL=http://127.0.0.1:19001 INTERNAL_SECRET=pick-a-secret-string SESSION_KEY=agent:dev:main", file=sys.stderr)
        sys.exit(1)

    prompts_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PROMPTS_FILE
    if not prompts_path.exists():
        print(f"Prompts file not found: {prompts_path}", file=sys.stderr)
        print("Create a text file with one prompt per line, or pass a path.", file=sys.stderr)
        sys.exit(1)

    lines = prompts_path.read_text(encoding="utf-8").strip().splitlines()
    prompts = [line.strip() for line in lines if line.strip()]
    if not prompts:
        print("No non-empty prompts found.", file=sys.stderr)
        sys.exit(1)

    from agentlightning import LitAgentRunner, OtelTracer
    from agentlightning.store import InMemoryLightningStore
    from agentlightning.types.resources import PromptTemplate
    from openclaw_agent import openclaw_agent_gateway

    store = InMemoryLightningStore()
    await store.add_resources({
        "prompt_template": PromptTemplate(template="User message: {input}", engine="f-string"),
    })
    tracer = OtelTracer()
    tracer.init_worker(0, store=store)
    runner = LitAgentRunner(tracer=tracer)
    runner.init(openclaw_agent_gateway)
    runner.init_worker(0, store=store)

    TRACES_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    try:
        for i, message in enumerate(prompts):
            # Pass gateway payload at top level so it survives AGL prompt_template rendering
            # (which may replace task.input with a string). Agent reads from task.input first, then task.
            task_input = {
                "input": message,
                "gatewayBaseUrl": gateway_base_url,
                "internalSecret": internal_secret,
                "sessionKey": session_key,
                "message": message,
                "idempotencyKey": str(uuid.uuid4()),
            }
            print(f"[{i+1}/{len(prompts)}] {message[:60]}{'...' if len(message) > 60 else ''}")
            try:
                rollout = await runner.step(task_input, mode="val")
            except Exception as e:
                print(f"  Rollout failed: {e}", file=sys.stderr)
                continue
            rollout_id = getattr(rollout, "rollout_id", None) or (
                rollout.get("rollout_id") if isinstance(rollout, dict) else None
            )
            if not rollout_id:
                print("  No rollout_id, skipping trace write.", file=sys.stderr)
                continue
            spans = await store.query_spans(rollout_id)
            timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
            trace_file = TRACES_DIR / f"rollout_{rollout_id}_{timestamp}.json"
            payload = {
                "rollout_id": rollout_id,
                "attempt_id": getattr(rollout, "attempt_id", None) if not isinstance(rollout, dict) else rollout.get("attempt_id"),
                "status": getattr(rollout, "status", None) if not isinstance(rollout, dict) else rollout.get("status"),
                "task_input": task_input,
                "span_count": len(spans),
                "spans": [_span_to_dict(s) for s in spans],
            }
            trace_file.write_text(json.dumps(payload, indent=2, default=str))
            written += 1
    finally:
        runner.teardown_worker(0)
        runner.teardown()

    print(f"Wrote {written} trace(s) to {TRACES_DIR}. Run: python export_sft_dataset.py")


if __name__ == "__main__":
    asyncio.run(main())
