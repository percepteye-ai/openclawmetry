// otel-span-processor.js
// Custom span processor that adds request/response bodies to HTTP spans

import { SpanKind } from '@opentelemetry/api';

// Global store for captured bodies (populated by fetch patch)
globalThis.__OTEL_REQUEST_BODIES = new Map();
globalThis.__OTEL_RESPONSE_BODIES = new Map();

export class BodyCaptureSpanProcessor {
  constructor() {
  }

  onStart(span, parentContext) {
    // Span is starting - we'll add bodies in onEnd
  }

  onEnd(span) {
    try {
      const attributes = span.attributes;

      // Check if this is an HTTP span
      if (attributes['url.full'] || attributes['http.url'] || attributes['server.address']) {
        const url = attributes['url.full'] || attributes['http.url'] ||
                    `https://${attributes['server.address']}${attributes['url.path'] || ''}`;


        // Try to find matching request/response bodies
        const requestBody = globalThis.__OTEL_REQUEST_BODIES.get(url);
        const responseBody = globalThis.__OTEL_RESPONSE_BODIES.get(url);

        if (requestBody) {
          span.setAttribute('http.request.body', requestBody);
          globalThis.__OTEL_REQUEST_BODIES.delete(url);
        }

        if (responseBody) {
          span.setAttribute('http.response.body', responseBody);
          globalThis.__OTEL_RESPONSE_BODIES.delete(url);
        }

        // Log if no bodies were found
        if (!requestBody && !responseBody) {
        }

        // Clean up old entries (prevent memory leaks)
        if (globalThis.__OTEL_REQUEST_BODIES.size > 100) {
          const keysToDelete = Array.from(globalThis.__OTEL_REQUEST_BODIES.keys()).slice(0, 50);
          keysToDelete.forEach(k => globalThis.__OTEL_REQUEST_BODIES.delete(k));
        }
        if (globalThis.__OTEL_RESPONSE_BODIES.size > 100) {
          const keysToDelete = Array.from(globalThis.__OTEL_RESPONSE_BODIES.keys()).slice(0, 50);
          keysToDelete.forEach(k => globalThis.__OTEL_RESPONSE_BODIES.delete(k));
        }
      }
    } catch (err) {
    }
  }

  shutdown() {
    return Promise.resolve();
  }

  forceFlush() {
    return Promise.resolve();
  }
}
