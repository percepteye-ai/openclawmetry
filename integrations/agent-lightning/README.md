# Agent Lightning integration

Run the OpenClaw Pi agent through [Agent Lightning](https://github.com/microsoft/agent-lightning) (AGL) so that **rollouts, attempts, and spans are created and emitted by AGL**—using AGL's Runner, Tracer, and Store. No custom OTEL or span processor is used in the Node/OpenClaw codebase for AGL; the existing OpenClaw OTEL setup is for **Jaeger** only (view OpenClaw's own spans there).

Reference: [Working with Traces](https://microsoft.github.io/agent-lightning/stable/tutorials/traces/).

## How it works

- **AGL** creates rollout_id and attempt_id and runs the agent inside its `trace_context`. All spans emitted by AGL's tracer are written to the LightningStore.
- The **agent** from AGL's perspective is a Python function (`openclaw_agent`) decorated with `@agl.prompt_rollout`. It invokes the OpenClaw CLI (`openclaw agent --message "..."`) so each rollout is one OpenClaw run.
- **OpenClaw** itself is unchanged: use the existing OTEL setup (e.g. `node --require ./otel-setup.js gateway.js`) to send OpenClaw spans to Jaeger. Do not add rollout_id/attempt_id in Node; let AGL own that.

## Setup

1. **Python 3.10+** and `openclaw` on PATH (or set `OPENCLAW_BIN`).

2. **Install Agent Lightning** (use a virtual environment so `aiohttp` and AGL are available to the same Python that runs the scripts):

   ```bash
   cd integrations/agent-lightning
   python3 -m venv .venv
   source .venv/bin/activate   # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. **Run one task through AGL:**

   ```bash
   python run_with_agl.py "Your message here"
   ```

   This uses AGL's `OtelTracer`, `InMemoryLightningStore`, and `LitAgentRunner`. The runner creates a rollout, runs `openclaw_agent` inside AGL's trace context, and stores the resulting spans in the in-memory store.

## Viewing spans

- **AGL-emitted spans** (rollout/attempt, agent execution): use the LightningStore (e.g. `store.query_spans(rollout_id)` in Python, or AGL's dashboard if you switch to a persistent store).
- **OpenClaw spans** (LLM, tools, HTTP): run OpenClaw with the existing OTEL setup and point `OTEL_EXPORTER_OTLP_ENDPOINT` at Jaeger (see [OTEL-README.md](../../OTEL-README.md)). Use Jaeger only for these; do not try to mimic AGL's rollout/attempt in Node.

## Web UI chat through AGL (bridge)

To have **OpenClaw web UI chat** go through AGL (so each message creates an AGL rollout and traces):

1. **Start the AGL bridge server** (from the same venv where you ran `pip install -r requirements.txt`):

   ```bash
   cd integrations/agent-lightning
   source .venv/bin/activate   # if not already active
   python bridge_server.py --port 8765
   ```

2. **Configure the gateway** — add `gateway.agl` to your OpenClaw config (usually `~/.openclaw/openclaw.json`). If the file already has a `"gateway": { ... }` block, add `"agl": { "bridgeUrl": "...", "internalAgentRunSecret": "..." }` inside it; otherwise add a full `gateway` block:

   ```json
   {
     "gateway": {
       "port": 18789,
       "agl": {
         "bridgeUrl": "http://127.0.0.1:8765",
         "internalAgentRunSecret": "your-secret"
       }
     }
   }
   ```

   Then **restart the gateway** (config is read at startup).

3. **Use the web UI** as usual. Each chat message is forwarded to the bridge; the bridge runs an AGL rollout with `openclaw_agent_gateway`, which calls back to the gateway’s internal `POST /_openclaw/internal/agent-run` endpoint. The agent runs in the gateway and streams to the UI; the bridge returns the final response and traces are created by AGL.

- **Bridge** (`bridge_server.py`): HTTP server with `POST /chat`. Receives `sessionKey`, `message`, `gatewayBaseUrl`, `internalSecret`, etc., runs `LitAgentRunner.step()` with the gateway-calling agent, returns `responseText` and `runId`.
- **Gateway** when `gateway.agl.bridgeUrl` is set: for `chat.send` it POSTs to the bridge instead of running the agent directly; the bridge calls back to `/_openclaw/internal/agent-run` (authenticated with `X-OpenClaw-Internal-Secret`).

**Troubleshooting (NO_REPLY, bridge terminal empty):** If the web UI shows "NO_REPLY" and the bridge terminal never prints `[bridge] /chat request received`, the gateway is **not** forwarding to the bridge. Add `gateway.agl` (with `bridgeUrl` and `internalAgentRunSecret`) to your config and restart the gateway.

**Troubleshooting (Gateway unreachable / Connection refused):** The bridge calls back to the gateway at `http://127.0.0.1:{gateway.port}` by default. If you see "Connection refused" or "Gateway unreachable" in the trace or bridge terminal: (1) **Same machine** — ensure the OpenClaw gateway is running and listening on that port (start the Mac app or run `openclaw gateway`; then `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/` should return a status code). (2) **Gateway on another host** — set `gateway.agl.gatewayBaseUrlOverride` to the URL the bridge can use to reach the gateway (e.g. `http://my-server:18789` or `http://192.168.1.5:18789`), then restart the gateway.

## Going further

- **Persistent store**: Replace `InMemoryLightningStore` with a store that supports OTLP or AGL's dashboard (see [Agent Lightning docs](https://microsoft.github.io/agent-lightning/stable/reference/store/)).
- **Trainer + algorithms**: Use `agl.Trainer` with an algorithm (e.g. APO) and pass `openclaw_agent` as the agent; AGL will manage rollouts and resources.
- **LLM Proxy**: To have LLM calls from OpenClaw appear as spans in AGL, you can route OpenClaw's LLM traffic through [AGL's LLM Proxy](https://microsoft.github.io/agent-lightning/stable/tutorials/traces/#llm-proxy) so the proxy emits spans into the store.

## Files

- `openclaw_agent.py` – AGL agents: `openclaw_agent` (CLI) and `openclaw_agent_gateway` (calls gateway internal endpoint).
- `run_with_agl.py` – Script that runs one task with `LitAgentRunner` + `OtelTracer` + `InMemoryLightningStore` (CLI path).
- `bridge_server.py` – HTTP server for web UI chat; runs AGL rollouts that call the gateway.
- `requirements.txt` – `agentlightning>=0.3.0`, `aiohttp>=3.9.0`.
