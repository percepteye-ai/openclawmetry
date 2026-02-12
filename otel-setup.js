// otel-setup.js - Load BEFORE any other imports

// FIRST: Import the exporter wrapper
import { BodyInjectingExporter } from './otel-exporter-wrapper.js';

import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import resourcesModule from '@opentelemetry/resources';
const { resourceFromAttributes } = resourcesModule;
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

// Helper to safely stringify and truncate
function safeStringify(value, maxLength = 10000) {
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return str.length > maxLength ? str.slice(0, maxLength) + '...[truncated]' : str;
  } catch {
    return '[unable to stringify]';
  }
}

// Create the OTLP exporter and wrap it
const baseExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://104.198.148.137:4318/v1/traces',
});

const wrappedExporter = new BodyInjectingExporter(baseExporter);

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'openclaw-gateway',
    [ATTR_SERVICE_VERSION]: process.env.OPENCLAW_VERSION || '1.0.0',
    'deployment.environment': process.env.NODE_ENV || 'development',
  }),
  spanProcessors: [
    new BatchSpanProcessor(wrappedExporter),  // Use wrapped exporter
  ],
  instrumentations: [
    // Auto-instrumentations (excluding undici and fs)
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-undici': { enabled: false }, // We'll configure this separately
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) => {
          return req.url === '/health' || req.url === '/ready';
        },
      },
    }),

    // Explicit undici instrumentation with request/response capture
    new UndiciInstrumentation({
      startHook: (span, request) => {
        try {
          // Check if interceptor captured the request body
          if (globalThis.__OTEL_LAST_REQUEST_BODY) {
            span.setAttribute('http.request.body', safeStringify(globalThis.__OTEL_LAST_REQUEST_BODY));
          }
        } catch (err) {
          span.setAttribute('http.request.capture.error', String(err));
        }
      },
      endHook: (span, request, response) => {
        try {
          // Check if interceptor captured the response body
          if (globalThis.__OTEL_LAST_RESPONSE_BODY) {
            span.setAttribute('http.response.body', safeStringify(globalThis.__OTEL_LAST_RESPONSE_BODY));

            // Clear the globals
            delete globalThis.__OTEL_LAST_REQUEST_BODY;
            delete globalThis.__OTEL_LAST_RESPONSE_BODY;
          }
        } catch (err) {
          span.setAttribute('http.response.capture.error', String(err));
        }
      },
    }),
  ],
});

await sdk.start();
console.log('OpenTelemetry instrumentation started');

// Wait for SDK to fully initialize
await new Promise(resolve => setTimeout(resolve, 100));

// Patch fetch to capture request/response bodies
await import('./otel-response-capture.js');

// Import API and create tracer
import api from '@opentelemetry/api';
const workingTracer = api.trace.getTracer('openclaw-gateway', '1.0.0');

// Inject shared tracer for compiled code to use
try {
  const { setSharedTracer } = await import('./dist/otel-tracer.js');
  setSharedTracer(workingTracer);
} catch (error) {
  console.error('[OTEL] Failed to inject shared tracer:', error);
}

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('OTel SDK shut down'))
    .catch((err) => console.error('OTel shutdown error', err))
    .finally(() => process.exit(0));
});

export default sdk;
