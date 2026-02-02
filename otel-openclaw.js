// otel-openclaw.js - OpenClaw-specific instrumentation
import api from '@opentelemetry/api';

const { trace, SpanKind, SpanStatusCode, context } = api;
const tracer = trace.getTracer('openclaw-agent', '1.0.0');

/**
 * Wrap a skill/tool execution with a span
 */
export function traceSkillExecution(skillName, skillFn) {
  return async function tracedSkill(...args) {
    const span = tracer.startSpan(`skill.${skillName}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        'openclaw.skill.name': skillName,
        'openclaw.skill.args_count': args.length,
      },
    });

    try {
      const result = await context.with(trace.setSpan(context.active(), span), () => {
        return skillFn.apply(this, args);
      });

      span.setAttribute('openclaw.skill.success', true);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setAttribute('openclaw.skill.success', false);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  };
}

/**
 * Wrap an LLM call with a span (captures model, tokens, latency)
 */
export function traceLLMCall(modelProvider, callFn) {
  return async function tracedLLMCall(params) {
    const span = tracer.startSpan('llm.completion', {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.system': modelProvider, // anthropic, openai, etc.
        'gen_ai.request.model': params.model || 'unknown',
        'gen_ai.request.max_tokens': params.max_tokens,
        'gen_ai.request.temperature': params.temperature,
      },
    });

    const startTime = Date.now();

    try {
      const result = await context.with(trace.setSpan(context.active(), span), () => {
        return callFn.call(this, params);
      });

      // Capture response metadata
      span.setAttributes({
        'gen_ai.response.model': result.model || params.model,
        'gen_ai.usage.input_tokens': result.usage?.input_tokens,
        'gen_ai.usage.output_tokens': result.usage?.output_tokens,
        'gen_ai.response.finish_reason': result.stop_reason,
        'openclaw.llm.latency_ms': Date.now() - startTime,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  };
}

/**
 * Trace message routing decisions
 */
export function traceMessageRoute(channel, sessionId, agentId) {
  return tracer.startSpan('message.route', {
    kind: SpanKind.INTERNAL,
    attributes: {
      'openclaw.channel': channel,           // telegram, slack, whatsapp
      'openclaw.session_id': sessionId,
      'openclaw.agent_id': agentId,
      'messaging.system': channel,
    },
  });
}

/**
 * Create a parent span for an entire message processing flow
 */
export function traceMessageFlow(channel, messageId, userId) {
  return tracer.startSpan('message.process', {
    kind: SpanKind.SERVER,
    attributes: {
      'openclaw.channel': channel,
      'openclaw.message_id': messageId,
      'openclaw.user_id': userId,
      'messaging.operation.type': 'receive',
    },
  });
}

/**
 * Trace browser/automation tool usage
 */
export function traceBrowserAction(action, url) {
  return tracer.startSpan(`browser.${action}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      'openclaw.browser.action': action,      // navigate, click, type, screenshot
      'url.full': url,
      'http.request.method': 'GET',
    },
  });
}

export { tracer };
