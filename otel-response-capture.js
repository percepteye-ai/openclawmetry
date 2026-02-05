// otel-response-capture.js
// Patches fetch to capture HTTP response bodies for OpenTelemetry

import { trace, context as apiContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';

// Initialize global maps for body storage
if (!globalThis.__OTEL_REQUEST_BODIES) {
  globalThis.__OTEL_REQUEST_BODIES = new Map();
}
if (!globalThis.__OTEL_RESPONSE_BODIES) {
  globalThis.__OTEL_RESPONSE_BODIES = new Map();
}

const originalFetch = globalThis.fetch;
const tracer = trace.getTracer('fetch-body-capture', '1.0.0');


function safeStringify(value, maxLength = 10000) {
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return str.length > maxLength ? str.slice(0, maxLength) + '...[truncated]' : str;
  } catch {
    return '[unable to stringify]';
  }
}

if (originalFetch) {
  globalThis.fetch = async function patchedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = init?.method || 'GET';


    // Capture request body and store globally for span processor
    let requestBodyStr = '';
    if (init?.body) {
      try {
        if (typeof init.body === 'string') {
          requestBodyStr = init.body;
        } else if (init.body instanceof URLSearchParams) {
          requestBodyStr = init.body.toString();
        } else if (typeof init.body === 'object') {
          requestBodyStr = JSON.stringify(init.body);
        }

        if (requestBodyStr) {
          globalThis.__OTEL_REQUEST_BODIES.set(url, safeStringify(requestBodyStr));
        }
      } catch (err) {
      }
    }

    // Make the actual request
    const response = await originalFetch.call(this, input, init);

    // Capture response body and store globally for span processor
    try {
      const clonedResponse = response.clone();
      const responseText = await clonedResponse.text();

      if (responseText) {
        globalThis.__OTEL_RESPONSE_BODIES.set(url, safeStringify(responseText));
      }
    } catch (err) {
    }

    return response;
  };

}
