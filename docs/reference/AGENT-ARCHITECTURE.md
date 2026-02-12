# OpenClaw Agent Architecture

This document describes how the OpenClaw agent is structured: entry points, sessions, routing, tools, nodes, channels, sandbox, and plugins.

## High-level flow

```
Inbound message (channel / chat / CLI / hook)
    → Routing (session key, agent ID, channel, account)
    → Auto-reply or Gateway agent command
    → runEmbeddedPiAgent → runEmbeddedAttempt
    → Sandbox resolution (optional Docker)
    → createOpenClawCodingTools + system prompt
    → Pi embedded session (createAgentSession)
    → Model API (streaming) + tool calls
    → Replies / tool results → delivery (channel, chat, CLI)
```

---

## 1. Entry points and run pipeline

### 1.1 Who invokes the agent

| Entry point | Location | Role |
|------------|----------|------|
| **Gateway `agent.command`** | `src/gateway/server-methods/agent.ts` | WebSocket RPC: message + optional images; resolves route, then calls `agentCommand`. |
| **Gateway chat** | `src/gateway/server-methods/chat.ts` | Web/CLI chat: session key + message; builds context, runs reply pipeline. |
| **Auto-reply** | `src/auto-reply/dispatch.ts` → `reply/agent-runner.ts` | Inbound channel messages (Telegram, Discord, Slack, etc.): dispatch → queue → `runReplyAgent`. |
| **CLI** | `src/agents/cli-runner.ts` | `openclaw agent` with prompt; tools disabled, minimal prompt. |
| **Hooks** | `src/gateway/server/hooks.ts` | HTTP hooks (e.g. cron, webhooks) that trigger agent runs. |

All of these ultimately call **`runEmbeddedPiAgent`** (`src/agents/pi-embedded-runner/run.ts`) or, for a single attempt, **`runEmbeddedAttempt`** (`src/agents/pi-embedded-runner/run/attempt.ts`).

### 1.2 Run pipeline (runEmbeddedPiAgent)

1. **Lanes** – Session lane + global lane for concurrency (`enqueueCommandInLane`).
2. **Model resolution** – `resolveModel(provider, modelId, agentDir, config)` → model + auth + registry.
3. **Context window** – `resolveContextWindowInfo`; guardrails for overflow/compaction.
4. **Attempt** – `runEmbeddedAttempt`:
   - Resolve workspace; **sandbox** (optional Docker) via `resolveSandboxContext`.
   - Skill env overrides (`applySkillEnvOverrides` from config/snapshot).
   - **Tools**: `createOpenClawCodingTools(...)` (see Tools below).
   - **System prompt**: `buildAgentSystemPrompt(...)` (skills, memory, docs, tools, runtime).
   - **Session**: Pi’s `createAgentSession` (session manager, resource loader, built-in + custom tools).
   - Stream to model; handle tool calls; compaction on overflow.
5. **Delivery** – Replies and tool-driven messages go back via the requested channel (or chat/CLI).

---

## 2. Routing and sessions

### 2.1 Session keys and agent IDs

- **Session key** – Identifies the conversation/session for persistence and concurrency (e.g. `agent:main:telegram:dm:123`).
- **Agent ID** – Which agent config to use (e.g. `main`). From `agents.list` in config; default from `resolveDefaultAgentId`.
- **Parsing** – `parseAgentSessionKey` (in `src/sessions/session-key-utils.js`) parses `agent:<agentId>:<rest>`; `resolveAgentIdFromSessionKey` returns the agent ID.

Key types and helpers live in:

- `src/routing/session-key.ts` – `buildAgentMainSessionKey`, `buildAgentPeerSessionKey`, `normalizeAgentId`, etc.
- `src/routing/resolve-route.ts` – `resolveAgentRoute` produces `agentId`, `sessionKey`, `channel`, `accountId` from channel + peer (DM/group/channel) + optional bindings.

### 2.2 Route resolution

- **Input**: `channel`, `accountId`, `peer` (kind + id), optional `guildId` / `teamId`.
- **Bindings** – `src/routing/bindings.ts`: configurable rules that map (channel, account, peer/guild/team) → agent ID and session semantics.
- **Output**: `ResolvedAgentRoute` with `agentId`, `sessionKey`, `mainSessionKey`, `channel`, `accountId`, and `matchedBy` (binding or default).

So: one message is assigned to one agent and one session key, then that session key is used for the rest of the run (workspace, sandbox, tools, prompt).

---

## 3. Agents and workspaces

- **Agent list** – `config.agents.list` (optional). Each entry: `id`, `default`, `workspace`, `agentDir`, `model`, `sandbox`, `tools`, etc.
- **Scoping** – `src/agents/agent-scope.ts`: `resolveDefaultAgentId`, `resolveSessionAgentIds`, `resolveAgentWorkspaceDir`, `resolveOpenClawAgentDir`. Agent-specific workspace and agent dir drive file tools, skills, and sandbox.
- **Multi-agent** – Different `agentId` values get different configs (workspace, model, tool policy); session key always encodes which agent is used.

---

## 4. Tools

### 4.1 Tool construction

- **Single function** – `createOpenClawCodingTools` in `src/agents/pi-tools.ts` builds the full list for a run.
- **Order / sources**:
  1. **Base coding tools** (from `@mariozechner/pi-coding-agent`), with OpenClaw overrides:
     - `read` (or sandboxed read / OpenClaw read when applicable),
     - `write`, `edit`, `attach`
  2. **Sandbox-only** (when sandbox enabled and workspace writable): sandboxed `edit`, `write`
  3. **exec**, **process** – shell and background process management
  4. **apply_patch** – optional (model + config gated)
  5. **Channel agent tools** – `listChannelAgentTools(cfg)` (e.g. `whatsapp_login`)
  6. **OpenClaw tools** – from `createOpenClawTools` in `src/agents/openclaw-tools.ts`
  7. **Plugin tools** – `resolvePluginTools(context, existingToolNames, toolAllowlist)` (e.g. memory-core adds `memory_search`, `memory_get`)

### 4.2 OpenClaw tools (openclaw-tools.ts)

| Tool | Purpose |
|------|--------|
| **browser** | Control browser (tabs, navigate, snapshot, screenshot, act, upload, etc.); optional sandbox bridge |
| **canvas** | Present/hide/navigate/eval/snapshot/A2UI on canvas nodes |
| **nodes** | Paired nodes: status, describe, approve, notify, camera, screen_record, etc. |
| **cron** | Cron jobs: status, list, add/update/remove, run, wake |
| **message** | Send/react/read/edit/delete/pin and channel-specific actions (Discord, Slack, Telegram, etc.) |
| **tts** | Text-to-speech |
| **gateway** | Gateway restart |
| **agents_list** | List agents |
| **sessions_list** | List sessions |
| **sessions_history** | Session history |
| **sessions_send** | Send content into a session |
| **sessions_spawn** | Spawn sub-agent (task, model, timeout, etc.) |
| **session_status** | Session status |
| **web_search** | Web search (if configured) |
| **web_fetch** | Fetch URL content (if configured) |
| **image** | Image tool (if agentDir set) |

### 4.3 Tool policy

- **Config** – `config.tools` and per-agent `config.agents.list[].tools`: allow/deny by name, profile, provider, group (e.g. `group:memory`).
- **Resolution** – `src/agents/pi-tools.policy.ts`: `resolveEffectiveToolPolicy`; group/channel/sandbox policies in `src/agents/tool-policy.ts` and `src/agents/sandbox/tool-policy.ts`.
- **Filtering** – Tools are filtered by policy before being passed to the Pi session; plugin tools can be allowlisted via `pluginToolAllowlist`.

### 4.4 Channel message actions

- Channel plugins (Discord, Slack, Telegram, etc.) expose **message actions** (send, react, read, edit, pin, etc.) and optional **agent tools** (e.g. login).
- **Message tool** – The single `message` tool delegates to the right channel adapter via `provider` and action name; adapters live in `src/channels/plugins/` (e.g. `slack.actions.ts`) and in extensions (e.g. `extensions/slack`).
- **Display** – `src/agents/tool-display.json` (and UI copy) defines labels and detail keys for tools and actions.

---

## 5. Nodes

### 5.1 What nodes are

- **Nodes** are remote devices or peers that connect to the gateway over WebSocket and can run commands, camera, screen, etc.
- Used for: Peekaboo-style control, browser on a device, canvas, voice wake, remote skills.

### 5.2 Node registry and pairing

- **NodeRegistry** – `src/gateway/node-registry.ts`: in-memory map of connected nodes (`nodesById`, `nodesByConn`). When a client connects with role `node`, it’s registered with `nodeId`, `connId`, `client`, `displayName`, `platform`, `commands`, `caps`, etc.
- **Pairing** – `src/infra/node-pairing.ts`: `requestNodePairing`, `approveNodePairing`, `listNodePairing`. Persisted pairing state so the gateway knows which nodes are approved.
- **Gateway methods** – `src/gateway/server-methods/nodes.ts`: `node.pair.request`, `node.pair.list`, `node.pair.approve`, etc. WS handler in `src/gateway/server/ws-connection/message-handler.ts` registers the client as a node and updates pairing metadata.

### 5.3 Nodes tool

- **nodes** tool – `src/agents/tools/nodes-tool.ts`: `createNodesTool`. Calls gateway RPCs (`node.list` or `node.pair.list`) to list nodes; supports actions: `status`, `describe`, `pending`, `approve`, `reject`, `notify`, `camera_snap`, `camera_list`, `camera_clip`, `screen_record`, etc.
- **Invoke** – The tool can invoke commands on a node via the gateway; the node runs them and returns results.

---

## 6. Channels

### 6.1 Channel plugins

- **Channel plugin** – Implements messaging (receive/send), optional slash commands, and optional agent tools. Loaded via plugin registry: `src/channels/plugins/load.ts` (`loadChannelPlugin`), `src/channels/plugins/catalog.ts`, `src/plugins/registry.ts`.
- **Core channels** – Implementations live under `src/` (e.g. `src/telegram`, `src/discord`, `src/slack`, `src/signal`, `src/imessage`, `src/web`).
- **Extensions** – Additional channels as workspace packages under `extensions/*` (e.g. `extensions/slack`, `extensions/msteams`).

### 6.2 Message flow

- Inbound message → gateway or long-polling → **auto-reply** `dispatchInboundMessage` → queue and reply pipeline → **runReplyAgent** → `runEmbeddedPiAgent` with session key and channel context.
- Outbound: agent uses **message** tool or direct delivery; **message-action-runner** and channel adapters send via the right provider and target (DM, thread, channel).

### 6.3 Routing and session key

- Channel + account + peer (user/group/channel) are passed to **resolveAgentRoute**; bindings and defaults yield `agentId` and `sessionKey`, which are used for the rest of the run and for delivery (thread/topic, etc.).

---

## 7. Sandbox

### 7.1 Role

- Optional **Docker-based sandbox** for exec and file operations: isolated workspace, controlled network, and (optionally) a browser in the container.
- Controlled per agent via `config.agents.list[].sandbox` and global sandbox config.

### 7.2 Resolution

- **resolveSandboxContext** – `src/agents/sandbox/context.ts`: uses `sessionKey` and config to decide if the run is sandboxed; resolves scope (e.g. per-session vs shared), workspace dir, and **workspace access** (ro vs rw).
- **Container** – `src/agents/sandbox/docker.ts`: `ensureSandboxContainer` creates/reuses a container; workspace and agent workspace can be mounted; skills are synced into the sandbox when workspace is read-only.
- **Tools in sandbox** – When sandbox is enabled, read/edit/write are replaced by **sandboxed** versions that operate inside the container; **exec** runs inside the container; **browser** can use a bridge to a browser in the sandbox.

---

## 8. System prompt and context

- **buildAgentSystemPrompt** – `src/agents/system-prompt.ts`: builds the full system prompt (identity, project context, skills section, memory section, docs section, tool list, workspace notes, runtime info, safety, etc.).
- **Skills** – Eligible skills are listed in the prompt (name, description, location); the agent is instructed to **read** the chosen skill’s SKILL.md with the read tool and follow it. Skills come from bundled, managed, workspace, and extra dirs; eligibility and env (e.g. `NOTION_API_KEY`) are applied.
- **Memory** – If `memory_search` and `memory_get` are available, the prompt tells the agent to search memory (e.g. MEMORY.md, memory/*.md) and then fetch only needed lines.
- **Runtime** – Prompt can include agent ID, host, channel, capabilities, sandbox info, reaction guidance (e.g. Telegram), and message-tool hints for the current channel.

---

## 9. Plugins and extensions

### 9.1 Plugin types

- **Channel plugins** – Messaging providers; register in plugin registry under `channels`.
- **Tool plugins** – Register tool factories; `resolvePluginTools` in `src/plugins/tools.ts` loads them and merges into the agent tool list (with allowlist/name conflicts handled).
- **Extensions** – Workspace packages under `extensions/*` that provide channels, tools, or both (e.g. `extensions/memory-core`, `extensions/slack`, `extensions/diagnostics-otel`).

### 9.2 Runtime

- **Plugin runtime** – `src/plugins/runtime/index.ts`: exposes shared services and factories (e.g. model auth, channel handlers, memory tools) to the gateway and agent run. The default runtime is used by the gateway and by sandbox/agent code that needs config or channel resolution.

---

## 10. Subagents

- **sessions_spawn** tool – Creates a child run with its own task, model, and timeout; registered in **subagent registry** (`src/agents/subagent-registry.ts`): `registerSubagentRun`, wait for completion via gateway RPC or in-process listener.
- **Policy** – Subagent tool policy can be restricted (e.g. no exec) via config; session key is a subagent key so routing and scoping stay consistent.

---

## 11. Diagram (conceptual)

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                   Entry points                          │
                    │  Gateway (agent.command, chat) │ Auto-reply │ CLI │ Hooks │
                    └───────────────────────────────┬─────────────────────────┘
                                                     │
                                                     ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │  Routing (resolveAgentRoute)                              │
                    │  → agentId, sessionKey, channel, accountId                │
                    └───────────────────────────────┬─────────────────────────┘
                                                     │
                                                     ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │  runEmbeddedPiAgent / runEmbeddedAttempt                  │
                    │  • resolveSandboxContext (optional Docker)              │
                    │  • createOpenClawCodingTools (policy-filtered)           │
                    │  • buildAgentSystemPrompt (skills, memory, docs, tools)   │
                    │  • createAgentSession (Pi) → stream + tool loop           │
                    └───────────────────────────────┬─────────────────────────┘
                                                     │
         ┌───────────────────────────────────────────┼───────────────────────────────────────────┐
         │                                           │                                           │
         ▼                                           ▼                                           ▼
┌─────────────────┐                    ┌─────────────────────────┐                    ┌─────────────────────┐
│ Tools            │                    │ Channels                 │                    │ Nodes               │
│ read/write/edit  │                    │ Telegram, Discord,       │                    │ NodeRegistry        │
│ exec, process    │                    │ Slack, Signal, etc.      │                    │ node.pair.*         │
│ message, cron    │                    │ message tool → adapter   │                    │ nodes tool          │
│ browser, canvas  │                    │ Outbound → channel       │                    │ camera, screen      │
│ nodes, sessions_*│                    │ send/deliver             │                    │ invoke on device    │
│ web_*, image     │                    └─────────────────────────┘                    └─────────────────────┘
│ plugin (memory)  │
└─────────────────┘
```

---

## 12. Key files reference

| Layer | Files |
|-------|--------|
| **Run** | `src/agents/pi-embedded-runner/run.ts`, `run/attempt.ts`, `run/params.ts`, `run/payloads.ts` |
| **Tools** | `src/agents/pi-tools.ts`, `src/agents/openclaw-tools.ts`, `src/agents/tools/*.ts`, `src/plugins/tools.ts` |
| **Policy** | `src/agents/pi-tools.policy.ts`, `src/agents/tool-policy.ts`, `src/agents/sandbox/tool-policy.ts` |
| **Prompt** | `src/agents/system-prompt.ts`, `src/agents/pi-embedded-runner/system-prompt.ts` |
| **Routing** | `src/routing/resolve-route.ts`, `src/routing/session-key.ts`, `src/routing/bindings.ts` |
| **Agents** | `src/agents/agent-scope.ts`, `src/agents/agent-paths.ts` |
| **Sessions** | `src/sessions/session-key-utils.ts`; Pi session manager in run |
| **Sandbox** | `src/agents/sandbox/context.ts`, `docker.ts`, `workspace.ts`, `config.ts` |
| **Nodes** | `src/gateway/node-registry.ts`, `src/infra/node-pairing.ts`, `src/gateway/server-methods/nodes.ts`, `src/agents/tools/nodes-tool.ts` |
| **Channels** | `src/channels/plugins/*.ts`, `src/auto-reply/dispatch.ts`, `src/infra/outbound/*.ts` |
| **Gateway** | `src/gateway/server-methods/agent.ts`, `chat.ts`, `src/gateway/server/ws-connection/message-handler.ts` |
