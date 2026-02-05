// otel-body-interceptor.js
// Intercepts undici at a lower level to capture request/response bodies

import { Dispatcher } from 'undici';

const pendingBodies = new Map();

// Store the original dispatch
const originalDispatch = Dispatcher.prototype.dispatch;

// Override dispatch to intercept requests/responses
Dispatcher.prototype.dispatch = function (opts, handler) {
  const requestId = Math.random().toString(36);

  // Capture request body
  if (opts.body) {
    let bodyStr = '';
    if (typeof opts.body === 'string') {
      bodyStr = opts.body;
    } else if (Buffer.isBuffer(opts.body)) {
      bodyStr = opts.body.toString('utf-8');
    }
    pendingBodies.set(requestId, { request: bodyStr, response: '' });
  }

  // Wrap the handler to capture response
  const wrappedHandler = {
    ...handler,
    onData(chunk) {
      const pending = pendingBodies.get(requestId);
      if (pending) {
        pending.response += chunk.toString('utf-8');
      }
      return handler.onData?.(chunk);
    },
    onComplete(trailers) {
      const pending = pendingBodies.get(requestId);
      if (pending) {
        // Store globally so the undici hook can access it
        globalThis.__OTEL_LAST_RESPONSE_BODY = pending.response;
        globalThis.__OTEL_LAST_REQUEST_BODY = pending.request;
      }
      pendingBodies.delete(requestId);
      return handler.onComplete?.(trailers);
    },
    onError(err) {
      pendingBodies.delete(requestId);
      return handler.onError?.(err);
    }
  };

  return originalDispatch.call(this, opts, wrappedHandler);
};

