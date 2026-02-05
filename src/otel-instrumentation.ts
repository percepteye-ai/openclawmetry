// src/otel-instrumentation.ts
// OpenClaw-specific OpenTelemetry instrumentation
// This file patches key functions to add custom spans

import api from "@opentelemetry/api";
import { getSharedTracer } from "./otel-tracer.js";

const { trace, SpanKind, SpanStatusCode, context } = api;

// Use the shared tracer injected by otel-setup.js
function getTracer(): api.Tracer {
  try {
    return getSharedTracer();
  } catch (error) {
    console.error("[OTEL] Failed to get shared tracer:", error);
    // Fallback to API (will likely not work but prevents crash)
    return trace.getTracer("openclaw-agent-fallback", "1.0.0");
  }
}

// Helper to safely stringify payloads for span attributes
function safeStringify(value: any, maxLength = 10000): string {
  try {
    const str = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return str.length > maxLength ? str.slice(0, maxLength) + "...[truncated]" : str;
  } catch {
    return "[unable to stringify]";
  }
}

// ============================================================================
// LLM Call Tracing
// ============================================================================

/**
 * Wrap an async function that makes LLM calls to add tracing
 */
export function traceLLMCall<T extends (...args: any[]) => Promise<any>>(
  provider: string,
  model: string,
  fn: T,
): T {
  return (async (...args: Parameters<T>) => {
    const span = getTracer().startSpan("llm.completion", {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.system": provider,
        "gen_ai.request.model": model,
        "openclaw.component": "pi-embedded-runner",
        // Capture request payload
        "gen_ai.request.payload": safeStringify(args),
      },
    });

    const startTime = Date.now();

    try {
      const result = await context.with(trace.setSpan(context.active(), span), () => fn(...args));

      span.setAttributes({
        "openclaw.llm.duration_ms": Date.now() - startTime,
        "openclaw.llm.success": true,
        // Capture response payload
        "gen_ai.response.payload": safeStringify(result),
      });
      span.setStatus({ code: SpanStatusCode.OK });

      return result;
    } catch (error) {
      span.setAttributes({
        "openclaw.llm.duration_ms": Date.now() - startTime,
        "openclaw.llm.success": false,
      });
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }) as T;
}

// ============================================================================
// Tool/Skill Execution Tracing
// ============================================================================

/**
 * Wrap a tool execute function with tracing
 */
export function traceToolExecution<T extends (...args: any[]) => Promise<any>>(
  toolName: string,
  fn: T,
): T {
  return (async (...args: Parameters<T>) => {
    const span = getTracer().startSpan(`tool.${toolName}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "openclaw.tool.name": toolName,
        "openclaw.tool.args_count": args.length,
        "openclaw.component": "tools",
        // Capture request payload
        "openclaw.tool.request": safeStringify(args),
      },
    });

    const startTime = Date.now();

    try {
      const result = await context.with(trace.setSpan(context.active(), span), () => fn(...args));

      span.setAttributes({
        "openclaw.tool.duration_ms": Date.now() - startTime,
        "openclaw.tool.success": true,
        // Capture response payload
        "openclaw.tool.response": safeStringify(result),
      });
      span.setStatus({ code: SpanStatusCode.OK });

      return result;
    } catch (error) {
      span.setAttributes({
        "openclaw.tool.duration_ms": Date.now() - startTime,
        "openclaw.tool.success": false,
      });
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }) as T;
}

// ============================================================================
// Message Routing Tracing
// ============================================================================

/**
 * Create a span for message routing
 */
export function traceMessageRoute(
  channel: string,
  sessionKey: string,
  agentId: string,
  matchedBy: string,
) {
  const span = getTracer().startSpan("message.route", {
    kind: SpanKind.INTERNAL,
    attributes: {
      "openclaw.channel": channel,
      "openclaw.session_key": sessionKey,
      "openclaw.agent_id": agentId,
      "openclaw.route.matched_by": matchedBy,
      "messaging.system": channel,
      "openclaw.component": "routing",
    },
  });
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
  return span;
}

// ============================================================================
// Message Flow Tracing (for complete request lifecycle)
// ============================================================================

interface ActiveFlow {
  rootSpan: api.Span;
  rootCtx: api.Context;
  traceparent: string;
  channel: string;
  sessionId: string;
  messageText?: string;
}

const activeFlows = new Map<string, ActiveFlow>();

function makeTraceparent(sc: api.SpanContext): string {
  const version = "00";
  const traceId = sc.traceId;
  const spanId = sc.spanId;
  const flags = (sc.traceFlags ?? api.TraceFlags.SAMPLED).toString(16).padStart(2, "0");
  return `${version}-${traceId}-${spanId}-${flags}`;
}

/**
 * Start tracing a message flow (call at the beginning of message handling).
 * Creates only the root span; the message.flow span is created inside withFlowContext
 * so it stays active for the whole async dispatch (ensuring HTTP client spans share the trace).
 */
export function startMessageFlow(
  sessionId: string,
  channel: string,
  messageText?: string,
): { traceparent: string } {
  const tracer = getTracer();

  const rootSpan = tracer.startSpan("session.root", {
    kind: SpanKind.SERVER,
    attributes: {
      "openclaw.session_id": sessionId,
      "openclaw.channel": channel,
      "openclaw.component": "session",
    },
  });
  const rootCtx = trace.setSpan(context.active(), rootSpan);
  const traceparent = makeTraceparent(rootSpan.spanContext());

  activeFlows.set(sessionId, {
    rootSpan,
    rootCtx,
    traceparent,
    channel,
    sessionId,
    messageText,
  });

  return { traceparent };
}

/**
 * End-flow callback passed to withFlowContext. Call once when the flow is done.
 */
export type EndFlowFn = (opts?: {
  success?: boolean;
  responseText?: string;
  errorMessage?: string;
}) => void;

/**
 * Execute the dispatch inside an active message.flow span so all downstream work
 * (LLM HTTP, Slack HTTP, etc.) runs in the same trace. Runs inside the session root
 * context so message.flow is a child of session.root; startActiveSpan then sets
 * message.flow as the active span for the callback so instrumentations (e.g. undici)
 * attach HTTP spans to this trace.
 */
export async function withFlowContext<T>(
  sessionId: string,
  fn: (endFlow: EndFlowFn) => Promise<T>,
): Promise<T> {
  const flow = activeFlows.get(sessionId);
  if (!flow) {
    return fn(() => {});
  }

  const tracer = getTracer();

  // Run inside root context so the message.flow span is created with session.root as parent.
  return context.with(flow.rootCtx, () =>
    tracer.startActiveSpan(
      "message.flow",
      {
        kind: SpanKind.SERVER,
        attributes: {
          "openclaw.session_id": flow.sessionId,
          "openclaw.channel": flow.channel,
          "openclaw.message.length": flow.messageText?.length ?? 0,
          "openclaw.flow.start_time": new Date().toISOString(),
          "openclaw.component": "auto-reply",
          "openclaw.message.request": flow.messageText ? safeStringify(flow.messageText) : "",
        },
      },
      context.active(),
      async (span) => {
        let flowSpanEnded = false;
        const endFlow: EndFlowFn = (opts = {}) => {
          if (flowSpanEnded) return;
          flowSpanEnded = true;
          span.setAttribute("openclaw.flow.success", opts.success ?? true);
          span.setAttribute("openclaw.flow.end_time", new Date().toISOString());
          if (opts.responseText != null) {
            span.setAttribute("openclaw.message.response", safeStringify(opts.responseText));
          }
          if (opts.success === false && opts.errorMessage != null) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: opts.errorMessage });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
          span.end();
        };
        try {
          const result = await fn(endFlow);
          if (!flowSpanEnded) endFlow({ success: true });
          return result;
        } catch (err) {
          if (!flowSpanEnded) {
            endFlow({
              success: false,
              errorMessage: err instanceof Error ? err.message : String(err),
            });
          }
          throw err;
        } finally {
          flow.rootSpan.end();
          activeFlows.delete(sessionId);
        }
      },
    ),
  );
}

/**
 * Add a step to the current message flow (optional; requires active flow from withFlowContext).
 */
export function addFlowStep(
  sessionId: string,
  stepName: string,
  attributes: Record<string, string | number | boolean> = {},
): api.Span | null {
  const flow = activeFlows.get(sessionId);
  if (!flow) return null;

  return context.with(flow.rootCtx, () => {
    const span = getTracer().startSpan(`flow.${stepName}`, {
      kind: SpanKind.INTERNAL,
      attributes: { "openclaw.session_id": sessionId, ...attributes },
    });
    return span;
  });
}

/**
 * End the message flow (no-op when using withFlowContext; kept for compatibility.)
 */
export function endMessageFlow(
  _sessionId: string,
  _success = true,
  _responseText?: string,
  _errorMessage?: string,
): void {
  // Flow and root span are ended inside withFlowContext / endFlow.
}

// ============================================================================
// Export tracer for direct use
// ============================================================================

export { getTracer as tracer };
