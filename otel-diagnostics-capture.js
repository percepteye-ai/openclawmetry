// otel-diagnostics-capture.js
// Uses Node.js diagnostic channels to capture undici request/response bodies

import diagnosticsChannel from 'diagnostics_channel';
import { trace, context as apiContext } from '@opentelemetry/api';


const requestBodies = new WeakMap();
const responseChunks = new WeakMap();

function safeStringify(value, maxLength = 10000) {
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return str.length > maxLength ? str.slice(0, maxLength) + '...[truncated]' : str;
  } catch {
    return '[unable to stringify]';
  }
}

// Undici diagnostic channels
const requestChannel = diagnosticsChannel.channel('undici:request:create');
const headersChannel = diagnosticsChannel.channel('undici:request:headers');
const bodyChunkChannel = diagnosticsChannel.channel('undici:request:bodySent');
const responseHeadersChannel = diagnosticsChannel.channel('undici:response:headers');
const responseBodyChannel = diagnosticsChannel.channel('undici:response:trailers');

// Capture request body
requestChannel.subscribe((message) => {
  // Log ALL available properties to see what we have
    origin: message.request?.origin,
    path: message.request?.path,
    method: message.request?.method,
    hasBody: !!message.request?.body,
    bodyType: message.request?.body ? typeof message.request?.body : 'none',
    bodyKeys: message.request?.body && typeof message.request?.body === 'object'
      ? Object.keys(message.request.body)
      : 'not an object'
  });

  // Store the request for later body attachment
  if (message.request) {
    requestBodies.set(message.request, { bodyChunks: [] });
  }
});

// Capture response headers and try to get the span
responseHeadersChannel.subscribe((message) => {
    statusCode: message.response?.statusCode
  });

  const span = trace.getSpan(apiContext.active());

  if (span && message.request) {
    // Add request body if we captured it
    const requestBody = requestBodies.get(message.request);
    if (requestBody) {
      span.setAttribute('http.request.body', safeStringify(requestBody));
      requestBodies.delete(message.request);
    }

    // Initialize response chunks collector
    if (!responseChunks.has(message.request)) {
      responseChunks.set(message.request, []);
    }
  }
});

// Capture request body chunks (bodySent channel)
if (bodyChunkChannel) {
  bodyChunkChannel.subscribe((message) => {
      hasRequest: !!message.request,
      hasChunk: !!message.chunk,
      hasBody: !!message.body,
      chunkType: message.chunk ? typeof message.chunk : 'none'
    });

    if (message.request && message.chunk) {
      const reqData = requestBodies.get(message.request);
      if (reqData) {
        reqData.bodyChunks.push(message.chunk);
      }
    }
  });
}

// Also subscribe to response body chunks
const responseDataChannel = diagnosticsChannel.channel('undici:response:data');
if (responseDataChannel) {
  responseDataChannel.subscribe((message) => {
    if (message.request && message.chunk) {
      const chunks = responseChunks.get(message.request);
      if (chunks) {
        chunks.push(message.chunk);
      }
    }
  });
}

// Add response body to span when complete
responseBodyChannel.subscribe((message) => {

  const span = trace.getSpan(apiContext.active());

  if (span && message.request) {
    const chunks = responseChunks.get(message.request);
    if (chunks && chunks.length > 0) {
      const responseBody = Buffer.concat(chunks).toString('utf-8');
      span.setAttribute('http.response.body', safeStringify(responseBody));
      responseChunks.delete(message.request);
    }
  }
});

