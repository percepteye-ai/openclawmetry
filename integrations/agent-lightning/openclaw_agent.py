"""
OpenClaw agent implementations for Agent Lightning (AGL).

This module exposes two AGL agents:
- `openclaw_agent`: calls the OpenClaw CLI directly (`openclaw agent --message "..."`).
- `openclaw_agent_gateway`: calls the gateway's internal /_openclaw/internal/agent-run endpoint.

Both are decorated with `@agl.prompt_rollout` so that rollouts + spans are created
and emitted by Agent Lightning, not by custom OTEL wiring in Node.
"""

from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import agentlightning as agl

# Integration lives at repo/integrations/agent-lightning/; repo root is parent of parent
_INTEGRATION_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _INTEGRATION_DIR.parent.parent
_BIN_IN_REPO = _REPO_ROOT / "node_modules" / ".bin" / "openclaw"
_OPENCLAW_MJS = _REPO_ROOT / "openclaw.mjs"


def _openclaw_cmd_prefix() -> list[str]:
    """
    Return the executable prefix for the CLI:
    - [OPENCLAW_BIN] if set
    - [<repo>/node_modules/.bin/openclaw] if it exists
    - ["node", <repo>/openclaw.mjs] if it exists
    - ["openclaw"] as a last resort
    """
    env_bin = os.environ.get("OPENCLAW_BIN", "").strip()
    if env_bin:
        return [env_bin]
    if _BIN_IN_REPO.exists():
        return [str(_BIN_IN_REPO)]
    if _OPENCLAW_MJS.exists():
        return ["node", str(_OPENCLAW_MJS)]
    return ["openclaw"]


def _run_openclaw(message: str, timeout_seconds: int = 120, session_file: str | None = None) -> str:
    """Run OpenClaw CLI with the given message; return stdout or stderr."""
    cmd = _openclaw_cmd_prefix() + ["agent", "--message", message]
    # Agent command requires --to, --session-id, or --agent. Prefer env so CLI path works.
    agent_id = os.environ.get("OPENCLAW_AGENT_ID", "").strip()
    session_id = os.environ.get("OPENCLAW_SESSION_ID", "").strip()
    if agent_id:
        cmd.extend(["--agent", agent_id])
    elif session_id:
        cmd.extend(["--session-id", session_id])
    if session_file:
        cmd.extend(["--session-file", session_file])

    cwd = os.environ.get("OPENCLAW_CWD") or str(_REPO_ROOT)
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            cwd=cwd,
        )
        return result.stdout if result.returncode == 0 else (result.stderr or result.stdout or "")
    except subprocess.TimeoutExpired:
        return "[OpenClaw run timed out]"
    except FileNotFoundError:
        return f"[OpenClaw not found: {cmd[0]!r}. Set OPENCLAW_BIN or ensure openclaw is on PATH.]"
    except Exception as e:
        return f"[OpenClaw error: {e}]"


@agl.prompt_rollout
def openclaw_agent(task: Any, prompt_template: Any) -> None:
    """
    AGL rollout that invokes the OpenClaw Pi agent via the CLI.

    - `task.input` (or dict-style `task["input"]`) is treated as the user message.
    - The CLI output is emitted as a message span and printed to stdout.
    """
    message = getattr(task, "input", task) if hasattr(task, "input") else task
    if isinstance(message, dict):
        message = message.get("input", message.get("message", message))
    message_str = str(message)

    output = _run_openclaw(message_str)
    body = output[:5000] if len(output) > 5000 else output
    agl.emit_message(body)  # attach to trace
    print(output)
    return None


def _call_gateway_agent_run(
    gateway_base_url: str,
    internal_secret: str,
    session_key: str,
    message: str,
    idempotency_key: str,
    timeout_seconds: int = 300,
) -> tuple[str, list[dict[str, Any]]]:
    """
    POST to the gateway internal /_openclaw/internal/agent-run endpoint.

    Returns (response_text, messages) on success. messages is the conversation
    for this call (role + content) when the gateway includes it.
    """
    url = gateway_base_url.rstrip("/") + "/_openclaw/internal/agent-run"
    payload = {
        "sessionKey": session_key,
        "message": message,
        "mode": "cli",
        "idempotencyKey": idempotency_key,
    }
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "X-OpenClaw-Internal-Secret": internal_secret,
        "X-OpenClaw-Idempotency-Key": idempotency_key,
    }
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            body_bytes = resp.read()
            body_text = body_bytes.decode("utf-8", errors="replace")
            if resp.status != 200:
                return (f"[Gateway agent error {resp.status}: {body_text}]", [])
            try:
                parsed = json.loads(body_text)
            except json.JSONDecodeError:
                return (body_text, [])
            if not isinstance(parsed, dict):
                return (body_text, [])
            response_text = str(parsed.get("responseText", body_text))
            messages = parsed.get("messages")
            if isinstance(messages, list) and messages:
                return (response_text, list(messages))
            return (response_text, [])
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        return (f"[Gateway agent HTTP error {e.code}: {text}]", [])
    except urllib.error.URLError as e:
        return (f"[Gateway unreachable: {e.reason}]", [])
    except Exception as e:
        return (f"[Gateway agent error: {e}]", [])


def _messages_to_gen_ai_rounds(
    messages: list[dict[str, Any]],
) -> list[tuple[list[dict[str, Any]], list[dict[str, Any]]]]:
    """
    Split a flat message list into (prompt, completion) rounds for gen_ai spans.
    Each round: prompt = full conversation so far (cumulative context, matching
    the LLM's actual messages array), completion = this turn's assistant reply.
    """
    rounds: list[tuple[list[dict[str, Any]], list[dict[str, Any]]]] = []
    i = 0
    cumulative: list[dict[str, Any]] = []
    while i < len(messages):
        # Collect non-assistant messages into this round's prompt prefix
        turn_prompt: list[dict[str, Any]] = []
        while i < len(messages) and messages[i].get("role") != "assistant":
            turn_prompt.append(messages[i])
            cumulative.append(messages[i])
            i += 1
        completion: list[dict[str, Any]] = []
        while i < len(messages) and messages[i].get("role") == "assistant":
            completion.append(messages[i])
            i += 1
        if not completion:
            continue
        # Full context for this LLM call = everything before this completion
        prompt = cumulative.copy()
        cumulative.extend(completion)
        rounds.append((prompt, completion))
    return rounds


def _normalize_role_for_openai(role: str) -> str:
    """Map transcript roles to OpenAI ChatCompletionMessageParam roles (user/assistant/system/tool)."""
    if role in ("user", "assistant", "system", "tool"):
        return role
    if (role or "").lower() == "toolresult":
        return "tool"
    return role or "user"


def _flatten_gen_ai_attrs(
    prompt: list[dict[str, Any]],
    completion: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build flat gen_ai.* attributes for TraceToMessages (AGL adapter)."""
    attrs: dict[str, Any] = {}
    for idx, msg in enumerate(prompt):
        role = _normalize_role_for_openai(str(msg.get("role") or "user"))
        content = msg.get("content") or ""
        attrs[f"gen_ai.prompt.{idx}.role"] = role
        attrs[f"gen_ai.prompt.{idx}.content"] = content
        if role == "tool":
            # OpenAI tool messages require tool_call_id; use placeholder if missing
            attrs[f"gen_ai.prompt.{idx}.tool_call_id"] = msg.get("tool_call_id") or "call_placeholder"
    for idx, msg in enumerate(completion):
        role = _normalize_role_for_openai(str(msg.get("role") or "assistant"))
        content = msg.get("content") or ""
        attrs[f"gen_ai.completion.{idx}.role"] = role
        attrs[f"gen_ai.completion.{idx}.content"] = content
    return attrs


def _emit_gen_ai_spans(messages: list[dict[str, Any]]) -> None:
    """Emit gen_ai.* spans so AGL TraceToMessages produces the dataset."""
    tracer = agl.get_active_tracer()
    if tracer is None:
        return
    rounds = _messages_to_gen_ai_rounds(messages)
    for prompt, completion in rounds:
        attrs = _flatten_gen_ai_attrs(prompt, completion)
        tracer.create_span("gen_ai", attributes=attrs)


@agl.prompt_rollout
def openclaw_agent_gateway(task: Any, prompt_template: Any) -> None:
    """
    AGL rollout that calls the gateway's internal /agent-run endpoint.

    Expects `task.input` (or dict-style `task["input"]`) to contain:
      - gatewayBaseUrl
      - internalSecret
      - sessionKey
      - message
      - idempotencyKey

    On success, attaches the response text to the trace and also stores it under
    task.input["_response_ref"] so the bridge can return it to the caller.
    """
    # Normalize task.input whether task is a dataclass-like object or dict
    raw_input: Any = getattr(task, "input", task) if hasattr(task, "input") else task
    if isinstance(raw_input, dict):
        inp = dict(raw_input)
    else:
        inp = getattr(raw_input, "__dict__", None) if hasattr(raw_input, "__dict__") else None
        inp = dict(inp) if isinstance(inp, dict) else {}

    # AGL may render the prompt template and pass a string as task.input; then gateway
    # fields are lost. Also read from the task itself (top-level) when present.
    def _get(key: str, alt: str | None = None) -> str:
        v = inp.get(key) or (inp.get(alt) if alt else None)
        if v is not None:
            return str(v).strip()
        if isinstance(task, dict):
            v = task.get(key) or (task.get(alt) if alt else None)
        else:
            v = getattr(task, key, None) or (getattr(task, alt, None) if alt else None)
        return str(v).strip() if v is not None else ""

    gateway_base_url = _get("gatewayBaseUrl", "gateway_base_url")
    internal_secret = _get("internalSecret", "internal_secret")
    session_key = _get("sessionKey", "session_key")
    message = _get("message") or _get("input")
    idempotency_key = _get("idempotencyKey", "idempotency_key")

    if not gateway_base_url or not message:
        err = "[Gateway agent error: gatewayBaseUrl and message required]"
        agl.emit_message(err)
        print(err)
        return None

    response_text, messages = _call_gateway_agent_run(
        gateway_base_url=gateway_base_url,
        internal_secret=internal_secret,
        session_key=session_key,
        message=message,
        idempotency_key=idempotency_key or "agl-bridge",
    )

    if messages:
        _emit_gen_ai_spans(messages)
    body = response_text[:5000] if len(response_text) > 5000 else response_text
    agl.emit_message(body)
    print(response_text)

    try:
        # Support both object-style and dict-style task.input
        if isinstance(raw_input, dict):
            raw_input["_response_ref"] = response_text
        elif hasattr(task, "input"):
            current = getattr(task, "input", {}) or {}
            if isinstance(current, dict):
                current["_response_ref"] = response_text
                setattr(task, "input", current)
    except Exception:
        # Best-effort; don't crash rollout on bookkeeping failure.
        pass

    return None

