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

const activeFlows = new Map<string, { span: api.Span; ctx: api.Context }>();

/**
 * Start tracing a message flow (call at the beginning of message handling)
 */
export function startMessageFlow(
  sessionId: string,
  channel: string,
  messageText?: string,
): { span: api.Span; context: api.Context } {
  const span = getTracer().startSpan("message.flow", {
    kind: SpanKind.SERVER,
    attributes: {
      "openclaw.session_id": sessionId,
      "openclaw.channel": channel,
      "openclaw.message.length": messageText?.length ?? 0,
      "openclaw.flow.start_time": new Date().toISOString(),
      "openclaw.component": "auto-reply",
      // Capture incoming message
      "openclaw.message.request": messageText ? safeStringify(messageText) : "",
    },
  });

  const ctx = trace.setSpan(context.active(), span);
  activeFlows.set(sessionId, { span, ctx });

  return { span, context: ctx };
}

/**
 * Add a step to the current message flow
 */
export function addFlowStep(
  sessionId: string,
  stepName: string,
  attributes: Record<string, string | number | boolean> = {},
): api.Span | null {
  const flow = activeFlows.get(sessionId);
  if (!flow) {
    return null;
  }

  return context.with(flow.ctx, () => {
    const span = getTracer().startSpan(`flow.${stepName}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "openclaw.session_id": sessionId,
        ...attributes,
      },
    });
    return span;
  });
}

/**
 * End the message flow
 */
export function endMessageFlow(
  sessionId: string,
  success = true,
  responseText?: string,
  errorMessage?: string,
): void {
  const flow = activeFlows.get(sessionId);
  if (!flow) {
    return;
  }

  flow.span.setAttribute("openclaw.flow.success", success);
  flow.span.setAttribute("openclaw.flow.end_time", new Date().toISOString());

  // Capture outgoing response
  if (responseText) {
    flow.span.setAttribute("openclaw.message.response", safeStringify(responseText));
  }

  if (success) {
    flow.span.setStatus({ code: SpanStatusCode.OK });
  } else {
    flow.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: errorMessage,
    });
  }

  flow.span.end();
  activeFlows.delete(sessionId);
}

// ============================================================================
// Convenience: Run function within a flow context
// ============================================================================

/**
 * Execute a function within the context of a message flow
 */
export async function withFlowContext<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const flow = activeFlows.get(sessionId);
  if (!flow) {
    return fn();
  }
  return context.with(flow.ctx, fn);
}

// ============================================================================
// Export tracer for direct use
// ============================================================================

export { getTracer as tracer };
