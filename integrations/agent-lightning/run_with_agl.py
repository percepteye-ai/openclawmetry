#!/usr/bin/env python3
"""
Run OpenClaw through Agent Lightning's Runner and Tracer.

This script uses AGL's OtelTracer, InMemoryLightningStore, and LitAgentRunner
so that rollouts and attempts are created by AGL and spans are emitted by
AGL's tracer. No custom OTEL or span processor is used in Node for AGL;
use Jaeger (existing OTEL) to view OpenClaw's own spans.

Usage:
  pip install -r requirements.txt
  python run_with_agl.py "Your message here"
  # Or with default message:
  python run_with_agl.py

Ref: https://microsoft.github.io/agent-lightning/stable/tutorials/traces/
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from datetime import datetime

# Add parent so we can import openclaw_agent
sys.path.insert(0, str(Path(__file__).resolve().parent))

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

from openclaw_agent import openclaw_agent

# Minimal prompt_template resource (AGL expects PromptTemplate with template + engine)
_MINIMAL_PROMPT = PromptTemplate(
    template="You are a helpful assistant. User message: {input}",
    engine="f-string",
)


async def main() -> None:
    message = sys.argv[1] if len(sys.argv) > 1 else "Hello, what can you do?"
    task_input = {"input": message}

    store = InMemoryLightningStore()
    await store.add_resources({"prompt_template": _MINIMAL_PROMPT})

    tracer = OtelTracer()
    tracer.init_worker(0, store=store)

    runner = LitAgentRunner(tracer=tracer)
    runner.init(openclaw_agent)
    runner.init_worker(0, store=store)

    try:
        rollout = await runner.step(task_input, mode="val")
        print("Rollout status:", getattr(rollout, "status", rollout))
        print("Rollout id:", getattr(rollout, "rollout_id", "—"))
        if hasattr(rollout, "rollout_id"):
            rollout_id = rollout.rollout_id
            spans = await store.query_spans(rollout_id)
            print(f"Spans in store for this rollout: {len(spans)}")
            for i, s in enumerate(spans[:5]):
                print(f"  [{i}] name={getattr(s, 'name', s)}")

            # Write rollout traces to a file
            TRACES_DIR.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
            trace_file = TRACES_DIR / f"rollout_{rollout_id}_{timestamp}.json"
            payload = {
                "rollout_id": rollout_id,
                "attempt_id": getattr(rollout, "attempt_id", None),
                "status": getattr(rollout, "status", None),
                "task_input": task_input,
                "span_count": len(spans),
                "spans": [_span_to_dict(s) for s in spans],
            }
            trace_file.write_text(json.dumps(payload, indent=2, default=str))
            print(f"Traces written to: {trace_file}")
    finally:
        runner.teardown_worker(0)
        runner.teardown()


if __name__ == "__main__":
    asyncio.run(main())
