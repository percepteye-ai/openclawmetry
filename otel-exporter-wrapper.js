// otel-exporter-wrapper.js
// Wraps the OTLP exporter to add request/response bodies before export

export class BodyInjectingExporter {
  constructor(baseExporter) {
    this.baseExporter = baseExporter;
  }

  export(spans, resultCallback) {
    // Modify spans before export by mutating their attributes directly
    spans.forEach(span => {
      const attributes = span.attributes || {};
      const url = attributes['url.full'] || attributes['http.url'] ||
        `https://${attributes['server.address'] || ''}${attributes['url.path'] || ''}`;

      // Check for captured bodies
      const requestBody = globalThis.__OTEL_REQUEST_BODIES?.get(url);
      const responseBody = globalThis.__OTEL_RESPONSE_BODIES?.get(url);

      if (requestBody) {
        span.attributes['http.request.body'] = requestBody;
        globalThis.__OTEL_REQUEST_BODIES.delete(url);
      }

      if (responseBody) {
        span.attributes['http.response.body'] = responseBody;
        globalThis.__OTEL_RESPONSE_BODIES.delete(url);
      }
    });

    // Export the modified spans
    return this.baseExporter.export(spans, resultCallback);
  }

  shutdown() {
    return this.baseExporter.shutdown();
  }

  forceFlush() {
    return this.baseExporter.forceFlush?.() || Promise.resolve();
  }
}
