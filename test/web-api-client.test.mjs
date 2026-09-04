import assert from 'node:assert/strict';
import test from 'node:test';

import { request, setCsrfToken } from '../src/web/api.js';

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('a mutation rejected after another tab rotates CSRF refreshes the session and replays once', async (t) => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  globalThis.document = { querySelector: () => null };
  globalThis.window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };

  const oldCsrf = `hndc_${'a'.repeat(43)}`;
  const refreshedCsrf = `hndc_${'b'.repeat(43)}`;
  const calls = [];
  setCsrfToken(oldCsrf);
  globalThis.fetch = async (url, options) => {
    calls.push({
      url,
      method: options.method,
      csrf: options.headers.get('X-Hnd-CSRF'),
      ifMatch: options.headers.get('If-Match'),
      body: options.body,
    });
    if (calls.length === 1) {
      return jsonResponse(403, {
        error: 'invalid_csrf',
        message: 'CSRF validation failed.',
      });
    }
    if (calls.length === 2) {
      return jsonResponse(
        200,
        { authenticated: true },
        { 'X-Hnd-CSRF': refreshedCsrf },
      );
    }
    return jsonResponse(200, { reset: true, etag: '"after"' });
  };

  const body = { confirmation: 'RESET_VAULT' };
  const result = await request('/vault/reset', {
    method: 'POST',
    headers: { 'If-Match': '"before"' },
    body,
  });

  assert.deepEqual(result, { reset: true, etag: '"after"' });
  assert.deepEqual(
    calls.map(({ url, method, csrf }) => ({ url, method, csrf })),
    [
      { url: '/api/web/vault/reset', method: 'POST', csrf: oldCsrf },
      { url: '/api/web/auth/session', method: 'GET', csrf: null },
      { url: '/api/web/vault/reset', method: 'POST', csrf: refreshedCsrf },
    ],
  );
  assert.equal(calls[0].ifMatch, '"before"');
  assert.equal(calls[2].ifMatch, '"before"');
  assert.equal(calls[0].body, JSON.stringify(body));
  assert.equal(calls[2].body, JSON.stringify(body));
});

test('CSRF recovery is bounded to one replay', async (t) => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  globalThis.document = { querySelector: () => null };
  globalThis.window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };

  const oldCsrf = `hndc_${'c'.repeat(43)}`;
  const refreshedCsrf = `hndc_${'d'.repeat(43)}`;
  let calls = 0;
  setCsrfToken(oldCsrf);
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    if (options.method === 'GET') {
      return jsonResponse(
        200,
        { authenticated: true },
        { 'X-Hnd-CSRF': refreshedCsrf },
      );
    }
    return jsonResponse(403, {
      error: 'invalid_csrf',
      message: 'CSRF validation failed.',
    });
  };

  await assert.rejects(
    request('/vault/reset', { method: 'POST', body: {} }),
    (error) =>
      error?.code === 'invalid_csrf' &&
      /보안 확인 정보|Security information changed/u.test(error?.message),
  );
  assert.equal(calls, 3);
});

test('request timeout covers response bodies and preserves the timeout reason', async (t) => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  globalThis.document = { querySelector: () => null };
  globalThis.window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  globalThis.fetch = async (_url, options) => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => new Promise((_resolve, reject) => {
      const rejectOnAbort = () => reject(options.signal.reason);
      if (options.signal.aborted) rejectOnAbort();
      else options.signal.addEventListener('abort', rejectOnAbort, { once: true });
    }),
  });

  await assert.rejects(
    request('/slow-response', { timeout: 5 }),
    (error) => error?.code === 'timeout' && error.retryable === true,
  );
});

test('an already-aborted caller signal is reported as cancellation', async (t) => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  globalThis.document = { querySelector: () => null };
  globalThis.window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  globalThis.fetch = async (_url, options) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw options.signal.reason;
  };
  const controller = new AbortController();
  controller.abort(new Error('caller cancelled'));

  await assert.rejects(
    request('/cancelled', { signal: controller.signal, timeout: 5 }),
    (error) => error?.code === 'cancelled' && error.retryable === false,
  );
});
