// Shared tracer instance using global object so it survives rebuilds
// This will be set by otel-setup.js before any other code runs

import type * as api from "@opentelemetry/api";

const GLOBAL_TRACER_KEY = "__OPENCLAW_OTEL_TRACER__";

export function setSharedTracer(tracer: api.Tracer): void {
  (globalThis as any)[GLOBAL_TRACER_KEY] = tracer;
}

export function getSharedTracer(): api.Tracer {
  const tracer = (globalThis as any)[GLOBAL_TRACER_KEY];
  if (!tracer) {
    throw new Error("Shared tracer not initialized! otel-setup.js must run first");
  }
  return tracer;
}
