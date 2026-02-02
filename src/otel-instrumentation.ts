// src/otel-instrumentation.ts
// OpenClaw-specific OpenTelemetry instrumentation
// This file patches key functions to add custom spans

import api from "@opentelemetry/api";

const { trace, SpanKind, SpanStatusCode, context } = api;
const tracer = trace.getTracer("openclaw-agent", "1.0.0");

// ============================================================================
// LLM Call Tracing
// ============================================================================

/**
 * Wrap an async function that makes LLM calls to add tracing
 */
export function traceLLMCall<T extends (...args: any[]) => Promise<any>>(
  provider: string,
  model: string,
  fn: T
): T {
  return (async (...args: Parameters<T>) => {
    const span = tracer.startSpan("llm.completion", {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.system": provider,
        "gen_ai.request.model": model,
        "openclaw.component": "pi-embedded-runner",
      },
    });

    const startTime = Date.now();

    try {
      const result = await context.with(
        trace.setSpan(context.active(), span),
        () => fn(...args)
      );

      span.setAttributes({
        "openclaw.llm.duration_ms": Date.now() - startTime,
        "openclaw.llm.success": true,
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
  fn: T
): T {
  return (async (...args: Parameters<T>) => {
    const span = tracer.startSpan(`tool.${toolName}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "openclaw.tool.name": toolName,
        "openclaw.tool.args_count": args.length,
        "openclaw.component": "tools",
      },
    });

    const startTime = Date.now();

    try {
      const result = await context.with(
        trace.setSpan(context.active(), span),
        () => fn(...args)
      );

      span.setAttributes({
        "openclaw.tool.duration_ms": Date.now() - startTime,
        "openclaw.tool.success": true,
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
  matchedBy: string
) {
  const span = tracer.startSpan("message.route", {
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
  messageLength?: number
): { span: api.Span; context: api.Context } {
  const span = tracer.startSpan("message.flow", {
    kind: SpanKind.SERVER,
    attributes: {
      "openclaw.session_id": sessionId,
      "openclaw.channel": channel,
      "openclaw.message.length": messageLength ?? 0,
      "openclaw.flow.start_time": new Date().toISOString(),
      "openclaw.component": "auto-reply",
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
  attributes: Record<string, string | number | boolean> = {}
): api.Span | null {
  const flow = activeFlows.get(sessionId);
  if (!flow) {
    return null;
  }

  return context.with(flow.ctx, () => {
    const span = tracer.startSpan(`flow.${stepName}`, {
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
  errorMessage?: string
): void {
  const flow = activeFlows.get(sessionId);
  if (!flow) return;

  flow.span.setAttribute("openclaw.flow.success", success);
  flow.span.setAttribute("openclaw.flow.end_time", new Date().toISOString());

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
export async function withFlowContext<T>(
  sessionId: string,
  fn: () => Promise<T>
): Promise<T> {
  const flow = activeFlows.get(sessionId);
  if (!flow) {
    return fn();
  }
  return context.with(flow.ctx, fn);
}

// ============================================================================
// Export tracer for direct use
// ============================================================================

export { tracer };
