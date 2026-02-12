# Agent Lightning integration

Run the OpenClaw agent through [Agent Lightning](https://github.com/microsoft/agent-lightning) (AGL) to produce rollouts and traces. Traces can be exported to an SFT-style dataset.

## Quick start: collect traces and build SFT dataset

1. **Install dependencies** (from repo root or this directory):

   ```bash
   cd integrations/agent-lightning
   python3 -m venv .venv
   source .venv/bin/activate   # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```

2. **Set gateway env and start the gateway** (Mac app or `openclaw gateway`). The collector talks to the gateway so the agent runs with the same session and tools as the web UI:

   ```bash
   export GATEWAY_BASE_URL=http://127.0.0.1:18789
   export INTERNAL_SECRET=pick-a-secret-string   # same as gateway.agl.internalAgentRunSecret
   export SESSION_KEY=agent:dev:main     # or your session, e.g. agent:default:main
   ```

3. **Create a prompts file** (one prompt per line), e.g. `prompts.txt`:

   ```bash
   echo "What is 2+2?" > prompts.txt
   echo "Explain recursion in one sentence." >> prompts.txt
   ```

4. **Run the collector** (writes one trace per prompt to `traces/`):

   ```bash
   python collect_traces.py prompts.txt
   ```

   If you don’t pass a file, it uses `prompts.txt` in the current directory.

5. **Export the SFT dataset** from all traces:

   ```bash
   python export_sft_dataset.py
   ```

   This writes `sft_dataset.jsonl` with one `{"messages": [{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}` per line.

## Web UI chat through AGL (bridge)

To route **web UI chat** through AGL so each message creates a rollout and a trace:

1. Start the bridge: `python bridge_server.py --port 8765`
2. Configure the gateway with `gateway.agl.bridgeUrl` and `internalAgentRunSecret` in `~/.openclaw/openclaw.json`, then restart the gateway.
3. Use the web UI as usual; each message produces a trace. Run `python export_sft_dataset.py` to refresh the dataset from all traces.

## Files

- `openclaw_agent.py` – AGL agents: `openclaw_agent` (CLI) and `openclaw_agent_gateway` (gateway internal endpoint).
- `collect_traces.py` – Run many rollouts from a prompt list via the gateway; writes one trace file per prompt (requires GATEWAY_BASE_URL, INTERNAL_SECRET, SESSION_KEY).
- `export_sft_dataset.py` – Build `sft_dataset.jsonl` from `traces/rollout_*.json`.
- `bridge_server.py` – HTTP server for web UI chat via AGL.
- `run_with_agl.py` – Run a single task through AGL (CLI path).
- `requirements.txt` – Python dependencies.
