# 🦞📊 OpenClawmetry

**OpenClaw + OpenTelemetry = Full Observability for AI Agents**

<p align="center">
  <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClawmetry" width="400">
</p>

<p align="center">
  <strong>See Everything Your AI Agent Does</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/OpenTelemetry-enabled-blueviolet?style=for-the-badge&logo=opentelemetry" alt="OpenTelemetry">
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=for-the-badge&logo=node.js" alt="Node.js">
</p>

---

OpenClawmetry is a fork of [OpenClaw](https://github.com/openclaw/openclaw) with **comprehensive distributed tracing** built in. See exactly what your AI agent is doing—every LLM call, tool execution, and message flow—visualized in Jaeger or your preferred observability platform.

## ✨ Why OpenClawmetry?

When AI agents make decisions, execute tools, and call LLMs, you need visibility into:

- ⏱️ **Where is time being spent?** — LLM calls vs tool execution vs routing
- 🔍 **What tools are being used?** — And are they succeeding or failing?
- 🧠 **How many tokens are consumed?** — Track costs across requests
- 🔀 **How are messages routed?** — Which agent handles what?
- 🐛 **Where do errors occur?** — Pinpoint failures in complex workflows

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   OpenClawmetry Gateway                         │
│  ws://127.0.0.1:18789                                          │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Channel  │→ │ Router   │→ │ Agent    │→ │ Skills/  │       │
│  │ Handlers │  │          │  │ Brain    │  │ Tools    │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
│       ↓              ↓             ↓             ↓              │
│  [span:         [span:       [span:        [span:              │
│   message.flow]  message.route] llm.call]   tool.*]            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │     Jaeger      │
                    │  localhost:16686│
                    └─────────────────┘
```

---

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/percepteye-ai/openclawmetry.git
cd openclawmetry
pnpm install
pnpm build
```

### 2. Start Jaeger

```bash
docker compose -f docker-compose.otel.yml up -d
```

### 3. Run with Tracing

```bash
# Development mode
npm run gateway:dev:otel

# Production mode
npm run gateway:otel
```

### 4. View Traces

Open **http://localhost:16686** → Select `openclaw-gateway` → Click **Find Traces**

---

## 📊 What Gets Traced

| Span | Description | Key Attributes |
|------|-------------|----------------|
| `message.flow` | Complete message lifecycle | `session_id`, `channel`, `message_length` |
| `message.route` | Agent routing decision | `agent_id`, `matched_by`, `session_key` |
| `tool.*` | Tool/skill execution | `tool_name`, `duration_ms`, `success` |
| `llm.completion` | LLM API calls | `model`, `input_tokens`, `output_tokens` |
| `HTTP *` | Outbound HTTP | `url`, `status_code` |
| `fetch` | Fetch API calls | `url`, `method` |

---

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318/v1/traces` | OTLP collector endpoint |
| `OPENCLAW_VERSION` | `1.0.0` | Service version in traces |
| `NODE_ENV` | `development` | Deployment environment |

### Production Backends

<details>
<summary><strong>Datadog</strong></summary>

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://http-intake.logs.datadoghq.com/api/v2/otlp"
export OTEL_EXPORTER_OTLP_HEADERS="DD-API-KEY=your_api_key"
```
</details>

<details>
<summary><strong>New Relic</strong></summary>

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp.nr-data.net:4318"
export OTEL_EXPORTER_OTLP_HEADERS="api-key=YOUR_LICENSE_KEY"
```
</details>

<details>
<summary><strong>Grafana Cloud</strong></summary>

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp-gateway-prod-us-central-0.grafana.net/otlp"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic base64(instanceId:apiKey)"
```
</details>

---

## 📁 Instrumentation Files

| File | Purpose |
|------|---------|
| `otel-setup.js` | SDK initialization & auto-instrumentation |
| `otel-openclaw.js` | Custom span helpers for LLM/tools |
| `otel-workflow.js` | Full workflow tracing with session correlation |
| `src/otel-instrumentation.ts` | TypeScript instrumentation integrated into source |
| `docker-compose.otel.yml` | Jaeger all-in-one for local development |

---

## 🔧 Extending Instrumentation

Add custom spans anywhere in the codebase:

```typescript
import {
  tracer,
  traceToolExecution,
  startMessageFlow,
  endMessageFlow
} from './otel-instrumentation.js';

// Wrap a function with tool tracing
const tracedFn = traceToolExecution('my-tool', myToolFunction);

// Or create manual spans
const span = tracer.startSpan('custom.operation');
try {
  // ... your code
  span.setStatus({ code: SpanStatusCode.OK });
} finally {
  span.end();
}
```

---

## 🧪 Verify Installation

```bash
# Quick test
node test-otel.js

# Check Jaeger at http://localhost:16686
```

---

## 🦞 About OpenClaw

OpenClawmetry is built on [OpenClaw](https://github.com/openclaw/openclaw), a personal AI assistant you run on your own devices. It supports WhatsApp, Telegram, Slack, Discord, Signal, iMessage, and more.

- [OpenClaw Docs](https://docs.openclaw.ai)
- [Getting Started](https://docs.openclaw.ai/start/getting-started)

---

## 📜 License

MIT License — see [LICENSE](LICENSE) for details.

- **OpenClaw** © 2025 Peter Steinberger
- **OpenTelemetry Instrumentation** © 2026 Srini

---

## 🙏 Acknowledgments

- [OpenClaw](https://github.com/openclaw/openclaw) — The AI agent framework
- [OpenTelemetry](https://opentelemetry.io/) — The observability standard
- [Jaeger](https://www.jaegertracing.io/) — Distributed tracing UI

---

<p align="center">
  <strong>Built with 🦞 and 📊 by <a href="https://github.com/percepteye-ai">PerceptEye</a></strong>
</p>
