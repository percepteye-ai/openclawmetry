#!/usr/bin/env python3
"""
Export an SFT-style dataset from Agent Lightning rollout traces.

Uses AGL's TraceToMessages adapter only. For each rollout we take only the
**last** gen_ai span (which has the full cumulative message sequence and final
assistant completion), so one rollout → one training example.

Reads ./traces/rollout_*.json and writes ./sft_dataset.jsonl (one JSON object per line).

Usage (from repo root or this directory, ideally inside the venv):

  cd integrations/agent-lightning
  python export_sft_dataset.py
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from agentlightning.adapter.messages import TraceToMessages

ROOT_DIR = Path(__file__).resolve().parent
TRACES_DIR = ROOT_DIR / "traces"
OUTPUT_PATH = ROOT_DIR / "sft_dataset.jsonl"


def _load_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _normalize_attributes_for_adapter(attrs: Dict[str, Any]) -> Dict[str, Any]:
    """Copy attributes: map role 'toolResult' -> 'tool' and add placeholder tool_call_id for tool messages."""
    out = dict(attrs)
    for key, value in list(out.items()):
        if isinstance(value, str) and value == "toolResult" and ".role" in key:
            out[key] = "tool"
            # OpenAI ChatCompletionToolMessageParam requires tool_call_id; add placeholder if missing
            base = key.rsplit(".", 1)[0]  # e.g. gen_ai.prompt.1
            tool_call_id_key = f"{base}.tool_call_id"
            if tool_call_id_key not in out or out[tool_call_id_key] is None:
                out[tool_call_id_key] = "call_placeholder"
    return out


def _span_like_from_dict(d: Dict[str, Any]) -> Any:
    """Build a span-like object with .attributes, .span_id, .parent_id for TraceToMessages."""
    raw_attrs = d.get("attributes")
    if not isinstance(raw_attrs, dict):
        raw_attrs = {}
    attrs = _normalize_attributes_for_adapter(raw_attrs)
    span_id = d.get("span_id")
    parent_id = d.get("parent_id")

    class SpanLike:
        __slots__ = ("attributes", "span_id", "parent_id")

        def __init__(self) -> None:
            self.attributes = attrs
            self.span_id = span_id
            self.parent_id = parent_id

    s = SpanLike()
    return s


def main() -> None:
    if not TRACES_DIR.exists():
        print(f"No traces directory found at {TRACES_DIR} (nothing to export).")
        return

    trace_files = sorted(TRACES_DIR.glob("rollout_*.json"))
    if not trace_files:
        print(f"No rollout_*.json files found under {TRACES_DIR} (nothing to export).")
        return

    adapter = TraceToMessages()
    samples: List[Dict[str, Any]] = []

    for trace_path in trace_files:
        data = _load_json(trace_path)
        if not data:
            continue

        raw_spans = data.get("spans") or []
        if not isinstance(raw_spans, list):
            continue

        # Only gen_ai spans contribute to the adapter; keep order so last span = full conversation
        gen_ai_spans = [s for s in raw_spans if isinstance(s.get("name"), str) and s["name"] == "gen_ai"]
        if not gen_ai_spans:
            continue
        span_likes: Sequence[Any] = [_span_like_from_dict(s) for s in gen_ai_spans]
        try:
            openai_messages_list = adapter.adapt(span_likes)
        except Exception:
            continue

        # One rollout → one example: use only the last span (full message sequence + final completion)
        if not openai_messages_list:
            continue
        entry = openai_messages_list[-1]
        messages = entry.get("messages")
        if not messages:
            continue
        row: Dict[str, Any] = {"messages": messages}
        if entry.get("tools") is not None:
            row["tools"] = entry["tools"]
        samples.append(row)

    if not samples:
        print(
            "No SFT samples from TraceToMessages. "
            "Ensure rollouts emit gen_ai.* spans (e.g. gateway returns messages)."
        )
        return

    with OUTPUT_PATH.open("w", encoding="utf-8") as f:
        for row in samples:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(f"Wrote {len(samples)} SFT samples to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
