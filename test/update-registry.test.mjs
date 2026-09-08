import assert from 'node:assert/strict';
import test from 'node:test';

import { checkLauncherRelease, LAUNCHER_LATEST_URL } from '../src/update/registry.mjs';

test('launcher version lookup uses the fixed public registry without device credentials', async () => {
  const result = await checkLauncherRelease({ fetchImpl: async (url, options) => {
    assert.equal(url, LAUNCHER_LATEST_URL);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ name: '@lch-1/hnd', version: '0.3.0' });
  } });
  assert.deepEqual(result, { launcherLatestVersion: '0.3.0', launcherCheckError: null });
});

test('launcher version lookup does not invent a latest version on HTTP or malformed metadata failures', async () => {
  for (const response of [
    new Response('', { status: 503 }),
    new Response('not json'),
    Response.json({ name: '@another/package', version: '1.0.0' }),
    Response.json({ name: '@lch-1/hnd', version: '1.0.0\nrun something' }),
    Response.json({ name: '@lch-1/hnd', version: null }),
  ]) {
    const result = await checkLauncherRelease({ fetchImpl: async () => response });
    assert.equal(result.launcherLatestVersion, null);
    assert.equal(typeof result.launcherCheckError, 'string');
  }
});

test('registry response size is bounded for declared and chunked bodies', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(33 * 1024)); },
    cancel() { cancelled = true; },
  });
  for (const response of [
    new Response('{}', { headers: { 'content-length': '99999999' } }),
    new Response('{}', { headers: { 'content-length': 'invalid' } }),
    new Response(stream),
  ]) {
    const result = await checkLauncherRelease({ fetchImpl: async () => response });
    assert.equal(result.launcherLatestVersion, null);
    assert.match(result.launcherCheckError, /too large/);
  }
  assert.equal(cancelled, true);
});

test('registry timeout covers both a stalled fetch and a stalled response body', async () => {
  for (const fetchImpl of [
    () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const result = await checkLauncherRelease({ fetchImpl, timeoutMs: 10 });
    assert.equal(result.launcherLatestVersion, null);
    assert.match(result.launcherCheckError, /timed out/);
  }
});
