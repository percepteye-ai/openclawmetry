// otel-workflow.js - Full workflow tracing with context propagation
import api from '@opentelemetry/api';

const { trace, context, propagation, SpanKind, SpanStatusCode } = api;
const tracer = trace.getTracer('openclaw-workflow', '1.0.0');

class WorkflowTracer {
  constructor() {
    this.activeFlows = new Map(); // sessionId -> { span, context }
  }

  /**
   * Start tracing a new message flow
   */
  startFlow(sessionId, channel, messageContent) {
    const span = tracer.startSpan('workflow.message_flow', {
      kind: SpanKind.SERVER,
      attributes: {
        'openclaw.session_id': sessionId,
        'openclaw.channel': channel,
        'openclaw.message.length': messageContent?.length || 0,
        'openclaw.flow.start_time': new Date().toISOString(),
      },
    });

    const ctx = trace.setSpan(context.active(), span);
    this.activeFlows.set(sessionId, { span, context: ctx });

    return { span, context: ctx };
  }

  /**
   * Add a step to the current flow
   */
  addStep(sessionId, stepName, attributes = {}) {
    const flow = this.activeFlows.get(sessionId);
    if (!flow) {
      console.warn(`No active flow for session ${sessionId}`);
      return null;
    }

    return context.with(flow.context, () => {
      return tracer.startSpan(`workflow.${stepName}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          'openclaw.session_id': sessionId,
          ...attributes,
        },
      });
    });
  }

  /**
   * Record a tool/skill invocation within the flow
   */
  recordToolCall(sessionId, toolName, input, output, durationMs, success = true) {
    const span = this.addStep(sessionId, 'tool_call', {
      'openclaw.tool.name': toolName,
      'openclaw.tool.input_size': JSON.stringify(input).length,
      'openclaw.tool.output_size': JSON.stringify(output).length,
      'openclaw.tool.duration_ms': durationMs,
      'openclaw.tool.success': success,
    });

    if (span) {
      span.setStatus({ code: success ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      span.end();
    }
  }

  /**
   * Record an LLM interaction
   */
  recordLLMCall(sessionId, model, inputTokens, outputTokens, durationMs) {
    const span = this.addStep(sessionId, 'llm_call', {
      'gen_ai.request.model': model,
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'openclaw.llm.duration_ms': durationMs,
    });

    if (span) {
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    }
  }

  /**
   * End the flow and return trace context for propagation
   */
  endFlow(sessionId, success = true, errorMessage = null) {
    const flow = this.activeFlows.get(sessionId);
    if (!flow) return null;

    flow.span.setAttribute('openclaw.flow.success', success);
    flow.span.setAttribute('openclaw.flow.end_time', new Date().toISOString());

    if (success) {
      flow.span.setStatus({ code: SpanStatusCode.OK });
    } else {
      flow.span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
    }

    flow.span.end();
    this.activeFlows.delete(sessionId);

    // Return trace context for external propagation
    const traceContext = {};
    propagation.inject(flow.context, traceContext);
    return traceContext;
  }

  /**
   * Get current trace context for external calls (n8n, APIs, etc.)
   */
  getTraceHeaders(sessionId) {
    const flow = this.activeFlows.get(sessionId);
    if (!flow) return {};

    const headers = {};
    propagation.inject(flow.context, headers);
    return headers;
  }
}

export default new WorkflowTracer();
