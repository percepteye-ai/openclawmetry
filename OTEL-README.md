# OpenClaw OpenTelemetry Instrumentation

This directory contains OpenTelemetry instrumentation for OpenClaw, enabling distributed tracing across the gateway and agent operations.

## Quick Start

### 1. Start Jaeger (Trace Viewer)

```bash
docker compose -f docker-compose.otel.yml up -d
```

Access the Jaeger UI at http://localhost:16686

### 2. Run OpenClaw with Instrumentation

```bash
# Option 1: Require at startup
node --require ./otel-setup.js gateway.js

# Option 2: Environment variable
export NODE_OPTIONS="--require ./otel-setup.js"
openclaw gateway

# Option 3: With custom endpoint
OTEL_EXPORTER_OTLP_ENDPOINT=http://your-collector:4318/v1/traces \
  node --require ./otel-setup.js gateway.js
```

## Instrumentation Levels

### Level 1: Auto-Instrumentation (`otel-setup.js`)

- Automatically traces HTTP, WebSocket, and database operations
- Zero code changes required
- Captures request/response timing and errors

### Level 2: Custom Spans (`otel-openclaw.js`)

- OpenClaw-specific operation tracing
- Skill/tool execution spans
- LLM call spans with token tracking
- Message routing spans
- Browser automation spans

**Usage in your code:**

```javascript
const { traceSkillExecution, traceLLMCall } = require("./otel-openclaw");

// Wrap skill functions
skill.execute = traceSkillExecution(skill.name, skill.execute);

// Wrap LLM calls
const tracedClient = traceLLMCall("anthropic", anthropicClient.messages.create);
```

### Level 3: Full Workflow Correlation (`otel-workflow.js`)

- End-to-end message flow tracing
- Session-based span correlation
- Tool call and LLM call recording within flows
- Trace context propagation for external services

**Usage in your code:**

```javascript
const workflowTracer = require("./otel-workflow");

// Start tracing a message flow
workflowTracer.startFlow(sessionId, "telegram", message.content);

// Record operations
workflowTracer.recordLLMCall(sessionId, "claude-3", 1000, 500, 2500);
workflowTracer.recordToolCall(sessionId, "web_search", input, output, 350);

// End the flow
workflowTracer.endFlow(sessionId, true);
```

## Environment Variables

| Variable                      | Default                           | Description               |
| ----------------------------- | --------------------------------- | ------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318/v1/traces` | OTLP collector endpoint   |
| `OPENCLAW_VERSION`            | `1.0.0`                           | Service version in traces |
| `NODE_ENV`                    | `development`                     | Deployment environment    |

## Production Setup

### Datadog

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://http-intake.logs.datadoghq.com/api/v2/otlp"
export OTEL_EXPORTER_OTLP_HEADERS="DD-API-KEY=your_api_key"
```

### New Relic

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp.nr-data.net:4318"
export OTEL_EXPORTER_OTLP_HEADERS="api-key=YOUR_LICENSE_KEY"
```

### Grafana Cloud

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp-gateway-prod-us-central-0.grafana.net/otlp"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic base64(instanceId:apiKey)"
```

## Agent Lightning

To see rollouts and spans **emitted by Agent Lightning** (AGL), use the Python integration in `integrations/agent-lightning/`. That integration uses AGL's own Runner, Tracer, and Store ([Working with Traces](https://microsoft.github.io/agent-lightning/stable/tutorials/traces/)); no custom OTEL or span processor is added in Node for AGL. Use this OTEL setup only for **Jaeger** (OpenClaw spans). For **web UI chat** through AGL, run the bridge server (`python bridge_server.py`) and set `gateway.agl.bridgeUrl` and `gateway.agl.internalAgentRunSecret` in config. See `integrations/agent-lightning/README.md`.

## Files

- `otel-setup.js` - SDK initialization and auto-instrumentation
- `otel-openclaw.js` - Custom span helpers for OpenClaw operations
- `otel-workflow.js` - Full workflow tracing with session correlation
- `docker-compose.otel.yml` - Jaeger all-in-one for local development
