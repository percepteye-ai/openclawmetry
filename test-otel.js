// test-otel.js - Simple test to verify OpenTelemetry is sending traces
import './otel-setup.js';

// Make a simple HTTP request that will be traced
const response = await fetch('https://httpbin.org/get');
const data = await response.json();

console.log('Test request completed:', data.url);
console.log('Check Jaeger UI at http://localhost:16686 for traces');
console.log('Look for service: openclaw-gateway');

// Give time for traces to be exported
await new Promise(r => setTimeout(r, 2000));
process.exit(0);
