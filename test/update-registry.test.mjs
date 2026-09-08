import assert from 'node:assert/strict';
import test from 'node:test';

import { checkLauncherRelease, checkServerRelease, LAUNCHER_LATEST_URL, SERVER_LATEST_URL } from '../src/update/registry.mjs';

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
    Response.json({ name: '@lch-1/hnd', version: '1.0.0\n' }),
    Response.json({ name: '@lch-1/hnd', version: null }),
  ]) {
    const result = await checkLauncherRelease({ fetchImpl: async () => response });
    assert.equal(result.launcherLatestVersion, null);
    assert.equal(typeof result.launcherCheckError, 'string');
  }
});

test('server latest version uses only stable server releases from the fixed public GitHub endpoint', async () => {
  const result = await checkServerRelease({ fetchImpl: async (url, options) => {
    assert.equal(url, SERVER_LATEST_URL);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Accept: 'application/vnd.github+json' });
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ tag_name: 'server-v2.0.0', draft: false, prerelease: false, html_url: 'https://untrusted.example/' });
  } });
  assert.deepEqual(result, {
    serverLatestVersion: '2.0.0',
    serverReleaseUrl: 'https://github.com/LCH-1/hnd/releases/tag/server-v2.0.0',
    serverReleaseStatus: 'available',
    serverReleaseError: null,
  });
});

test('server release checks distinguish unpublished from failed and reject other components or prereleases', async () => {
  for (const [response, status] of [
    [new Response('', { status: 404 }), 'not_published'],
    [new Response('', { status: 403 }), 'check_failed'],
    [new Response('', { status: 429 }), 'check_failed'],
    [new Response('bad json'), 'check_failed'],
    [Response.json(null), 'check_failed'],
    ...[
      { tag_name: 'v0.2.4', draft: false, prerelease: false },
      { tag_name: 'server-v1.0.0', draft: true, prerelease: false },
      { tag_name: 'server-v1.0.0', draft: false, prerelease: true },
      { tag_name: 'server-v1.0.0-rc.1', draft: false, prerelease: false },
      { tag_name: 'server-v1.0.0\n', draft: false, prerelease: false },
    ].map((value) => [Response.json(value), 'check_failed']),
  ]) {
    const result = await checkServerRelease({ fetchImpl: async () => response });
    assert.equal(result.serverLatestVersion, null);
    assert.equal(result.serverReleaseStatus, status);
    assert.equal(typeof result.serverReleaseError, 'string');
  }
});

test('server release lookup also bounds metadata size and stalled response bodies', async () => {
  for (const fetchImpl of [
    async () => new Response('{}', { headers: { 'content-length': '99999999' } }),
    () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const result = await checkServerRelease({ fetchImpl, timeoutMs: 10 });
    assert.equal(result.serverLatestVersion, null);
    assert.match(result.serverReleaseError, /too large|timed out/);
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
