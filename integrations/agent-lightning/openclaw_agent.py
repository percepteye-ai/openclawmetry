"""
OpenClaw agent for Agent Lightning (AGL).

This module uses AGL's decorators and Runner/Tracer/Store so that rollouts and
spans are created and emitted by Agent Lightning, not by custom OTEL in Node.
See: https://microsoft.github.io/agent-lightning/stable/tutorials/traces/

The "agent" from AGL's perspective is a Python function that invokes the
OpenClaw CLI (or gateway). AGL creates rollout_id and attempt_id and runs
this function inside its trace_context; all spans emitted by AGL are visible
in the LightningStore.
"""

from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from typing import Any

import agentlightning as agl


def _openclaw_bin() -> str:
    return os.environ.get("OPENCLAW_BIN", "openclaw")


def _run_openclaw(message: str, timeout_seconds: int = 120, session_file: str | None = None) -> str:
    """Run OpenClaw agent with the given message; return stdout or stderr."""
    cmd = [_openclaw_bin(), "agent", "--message", message]
    if session_file:
        cmd.extend(["--session-file", session_file])
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            cwd=os.environ.get("OPENCLAW_CWD"),
        )
        return result.stdout if result.returncode == 0 else (result.stderr or result.stdout or "")
    except subprocess.TimeoutExpired:
        return "[OpenClaw run timed out]"
    except FileNotFoundError:
        return f"[OpenClaw not found: {_openclaw_bin()}. Set OPENCLAW_BIN or ensure openclaw is on PATH.]"
    except Exception as e:
        return f"[OpenClaw error: {e}]"


@agl.prompt_rollout
def openclaw_agent(task: Any, prompt_template: Any) -> None:
    """
    AGL rollout that invokes the OpenClaw Pi agent.

    task: has task.input (the user message / task payload).
    prompt_template: from AGL resources (we only use task.input here).

    Returns None; LitAgentRunner expects None, float (reward), or list of spans.
    The OpenClaw output is emitted as a message span and printed to stdout.
    """
    message = str(getattr(task, "input", task) if hasattr(task, "input") else task)
    if hasattr(message, "get") and isinstance(message, dict):
        message = message.get("input", message.get("message", str(message)))
    output = _run_openclaw(message)
    agl.emit_message(output[:5000] if len(output) > 5000 else output)  # attach to trace
    print(output)
    return None


def _call_gateway_agent_run(
    gateway_base_url: str,
    internal_secret: str,
    session_key: str,
    message: str,
    idempotency_key: str,
    timeout_seconds: int = 300,
) -> str:
    """POST to the gateway internal agent-run endpoint; return response text or error."""
    url = f"{gateway_base_url.rstrip('/')}/_openclaw/internal/agent-run"
    data = json.dumps({
        "sessionKey": session_key,
        "message": message,
        "idempotencyKey": idempotency_key,
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-OpenClaw-Internal-Secret": internal_secret,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            if isinstance(body, dict) and body.get("ok") and "responseText" in body:
                return str(body["responseText"])
            return str(body)
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8")
            return f"[Gateway error {e.code}]: {err_body[:2000]}"
        except Exception:
            return f"[Gateway error {e.code}]: {e.reason}"
    except OSError as e:
        if "refused" in str(e).lower() or getattr(e, "errno", None) == 61:
            return (
                f"[Gateway unreachable] Connection refused to {url}. "
                "Ensure the OpenClaw gateway is running and listening on that port (e.g. start the app or run `openclaw gateway`)."
            )
        return f"[Gateway request error]: {e}"
    except Exception as e:
        return f"[Gateway request error]: {e}"


@agl.prompt_rollout
def openclaw_agent_gateway(task: Any, prompt_template: Any) -> None:
    """
    AGL rollout that calls the OpenClaw gateway internal agent-run endpoint.

    task / task.input must be a dict with: gatewayBaseUrl, internalSecret, sessionKey,
    message, idempotencyKey. Used by the AGL bridge so web UI chat goes through AGL.
    """
    # Runner may pass task as dict (task_input) or object with .input
    if isinstance(task, dict) and "input" in task:
        inp = task["input"]
    else:
        inp = getattr(task, "input", task)
    if not isinstance(inp, dict):
        output = "[openclaw_agent_gateway] task.input must be a dict with gatewayBaseUrl, internalSecret, sessionKey, message, idempotencyKey]"
        agl.emit_message(output)
        print(output)
        return None
    gateway_base_url = inp.get("gatewayBaseUrl") or ""
    internal_secret = inp.get("internalSecret") or ""
    session_key = inp.get("sessionKey") or ""
    message = inp.get("message") or ""
    idempotency_key = inp.get("idempotencyKey") or f"bridge-{id(task)}"
    if not gateway_base_url or not message:
        output = "[openclaw_agent_gateway] gatewayBaseUrl and message required"
        agl.emit_message(output)
        print(output)
        return None
    output = _call_gateway_agent_run(
        gateway_base_url, internal_secret, session_key, message, idempotency_key
    )
    agl.emit_message(output[:5000] if len(output) > 5000 else output)
    print(output)
    # Bridge captures response via mutable ref passed in task.input
    response_ref = inp.get("_response_ref")
    if isinstance(response_ref, list):
        response_ref.append(output)
    return None
