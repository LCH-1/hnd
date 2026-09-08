import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkServerVersion } from '../src/update/client.mjs';

async function environment(t, { connected = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-version-check-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { HND_HOME: root, HND_USER_HOME: path.join(root, 'user') };
  if (connected) {
    await fs.mkdir(path.join(root, 'secrets'), { mode: 0o700 });
    await fs.writeFile(path.join(root, 'remotes.json'), JSON.stringify({
      schemaVersion: 1, baseUrl: 'https://hnd.example/',
    }), { mode: 0o600 });
    await fs.writeFile(path.join(root, 'secrets', 'device.token'), `hndd_${'a'.repeat(43)}`, { mode: 0o600 });
  }
  return env;
}

test('server version lookup uses only the enrolled origin and does not expose the device token', async (t) => {
  const env = await environment(t);
  const result = await checkServerVersion({ env, fetchImpl: async (url, options) => {
    assert.equal(String(url), 'https://hnd.example/v1/connector/server');
    assert.equal(options.redirect, 'error');
    assert.match(options.headers.Authorization, /^Bearer hndd_/);
    return Response.json({ schemaVersion: 1, version: '4.0.0', token: 'ignored' });
  } });
  assert.deepEqual(result, { serverVersion: '4.0.0', serverVersionStatus: 'available', serverVersionError: null });
});

test('unconnected version lookup does not make an authenticated request', async (t) => {
  const env = await environment(t, { connected: false });
  assert.deepEqual(await checkServerVersion({ env, fetchImpl: () => assert.fail('unexpected request') }), {
    serverVersion: null, serverVersionStatus: 'not_connected', serverVersionError: null,
  });
});

test('unsupported, unauthorized and invalid server versions are not called current', async (t) => {
  const env = await environment(t);
  for (const [response, status] of [
    [new Response('', { status: 404 }), 'unsupported'],
    [new Response('', { status: 401 }), 'check_failed'],
    [new Response('', { status: 500 }), 'check_failed'],
    [Response.json({ schemaVersion: 2, version: '1.0.0' }), 'check_failed'],
    [Response.json({ schemaVersion: 1, version: '1.0.0\n' }), 'check_failed'],
    [Response.json({ version: '1.0.0' }), 'check_failed'],
    [Response.json(null), 'check_failed'],
  ]) {
    const result = await checkServerVersion({ env, fetchImpl: async () => response });
    assert.equal(result.serverVersion, null);
    assert.equal(result.serverVersionStatus, status);
    assert.ok(result.serverVersionError);
  }
});

test('server version lookup bounds response size and time even if a body stalls', async (t) => {
  const env = await environment(t);
  for (const fetchImpl of [
    async () => new Response('{}', { headers: { 'content-length': '99999999' } }),
    () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const result = await checkServerVersion({ env, fetchImpl, timeoutMs: 10 });
    assert.equal(result.serverVersionStatus, 'check_failed');
    assert.match(result.serverVersionError, /too large|timed out/);
  }
});
