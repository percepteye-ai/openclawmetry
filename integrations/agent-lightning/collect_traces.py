#!/usr/bin/env python3
"""
Run many AGL rollouts from a prompts file via the gateway in parallel; write a trace file for each.

Reads one prompt per line from a txt file, runs each through openclaw_agent_gateway in parallel
(to save time), then writes rollout traces. Run export_sft_dataset.py afterward to build sft_dataset.jsonl.

Required env (start the gateway first):
  GATEWAY_BASE_URL   e.g. http://127.0.0.1:19001
  INTERNAL_SECRET    same as gateway.agl.internalAgentRunSecret
  SESSION_KEY        e.g. agent:dev:main

Optional env:
  MAX_CONCURRENT     max parallel rollouts (default 4)

Usage:
  cd integrations/agent-lightning
  source .venv/bin/activate
  export GATEWAY_BASE_URL=http://127.0.0.1:19001 INTERNAL_SECRET=... SESSION_KEY=agent:dev:main
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

    try:
        max_concurrent = max(1, int(os.environ.get("MAX_CONCURRENT", "4")))
    except ValueError:
        max_concurrent = 4

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

    sem = asyncio.Semaphore(max_concurrent)

    async def run_one(i: int, message: str) -> tuple[int, object | None, list, dict | None]:
        task_input = {
            "input": message,
            "gatewayBaseUrl": gateway_base_url,
            "internalSecret": internal_secret,
            "sessionKey": session_key,
            "message": message,
            "idempotencyKey": str(uuid.uuid4()),
        }
        async with sem:
            try:
                rollout = await runner.step(task_input, mode="val")
            except Exception as e:
                print(f"[{i+1}/{len(prompts)}] failed: {e}", file=sys.stderr)
                return (i, None, [], None)
        rollout_id = getattr(rollout, "rollout_id", None) or (
            rollout.get("rollout_id") if isinstance(rollout, dict) else None
        )
        if not rollout_id:
            print(f"[{i+1}/{len(prompts)}] no rollout_id", file=sys.stderr)
            return (i, None, [], None)
        spans = await store.query_spans(rollout_id)
        return (i, rollout, spans, task_input)

    TRACES_DIR.mkdir(parents=True, exist_ok=True)
    try:
        results = await asyncio.gather(
            *[run_one(i, msg) for i, msg in enumerate(prompts)],
            return_exceptions=False,
        )
    finally:
        runner.teardown_worker(0)
        runner.teardown()

    written = 0
    for i, rollout, spans, task_input in results:
        if rollout is None or task_input is None:
            continue
        rollout_id = getattr(rollout, "rollout_id", None) or (
            rollout.get("rollout_id") if isinstance(rollout, dict) else None
        )
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

    print(f"Wrote {written} trace(s) to {TRACES_DIR}. Run: python export_sft_dataset.py")


if __name__ == "__main__":
    asyncio.run(main())
