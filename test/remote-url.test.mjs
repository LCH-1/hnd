import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { withFileLock } from '../src/core/fs.mjs';
import { createSyncServer } from '../src/sync/server.mjs';

async function fixture(t, { configured = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-remote-url-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: root,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
  };
  const remotePath = path.join(env.HND_HOME, 'remotes.json');
  const config = {
    schemaVersion: 1, baseUrl: 'https://old.example.test',
    device: { id: 'device-1', tenantId: 'tenant-1', name: 'Existing PC', revokedAt: null },
    etag: `"${'1'.repeat(64)}"`, etagHistory: [`"${'1'.repeat(64)}"`],
    snapshotDigest: '2'.repeat(64), enrolledAt: '2026-01-01T00:00:00.000Z',
    lastSyncAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  };
  const token = `hndd_${'A'.repeat(43)}`;
  const tokenPath = path.join(env.HND_HOME, 'secrets', 'device.token');
  const vaultPath = path.join(env.HND_HOME, 'secrets', 'vault.key');
  if (configured) {
    await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(remotePath, JSON.stringify(config), { mode: 0o600 });
    await fs.writeFile(tokenPath, token, { mode: 0o600 });
    await fs.writeFile(vaultPath, 'existing vault key must not be read or replaced', { mode: 0o600 });
  }
  async function run(args, answer) {
    const input = answer === undefined ? Readable.from([]) : new PassThrough();
    if (answer !== undefined) input.isTTY = true;
    const output = new PassThrough();
    let text = '';
    let answered = false;
    output.on('data', (chunk) => {
      text += chunk.toString();
      if (answer !== undefined && !answered && text.includes('New server address')) {
        answered = true;
        setImmediate(() => input.write(`${answer}\n`));
      }
    });
    try {
      await main(args, { env, cwd: root, stdin: input, stdout: output, stderr: output });
      return text;
    } finally {
      input.destroy();
      output.destroy();
    }
  }
  async function probe(handler) {
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization });
      if (handler) return handler(request, response);
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ devices: [config.device] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return { url: `http://127.0.0.1:${server.address().port}`, requests };
  }
  return { env, root, config, token, tokenPath, vaultPath, remotePath, run, probe };
}

test('remote show and setup remote report missing configuration without creating state', async (t) => {
  const item = await fixture(t, { configured: false });
  for (const command of [['remote', 'show'], ['sync', 'show'], ['setup', 'remote']]) {
    assert.deepEqual(JSON.parse(await item.run([...command, '--json'])), { configured: false, baseUrl: null });
  }
  assert.match(await item.run(['remote', 'show']), /hnd connect/);
  await assert.rejects(fs.stat(item.env.HND_HOME), { code: 'ENOENT' });
  await assert.rejects(item.run(['remote', 'set-url', 'https://new.example.test']), /hnd connect/);
});

test('remote show works offline without reading credentials or exposing other configuration', async (t) => {
  const item = await fixture(t);
  await fs.unlink(item.tokenPath);
  assert.equal(await item.run(['remote', 'show']), `${item.config.baseUrl}\n`);
  assert.deepEqual(JSON.parse(await item.run(['setup', 'remote', '--json'])), {
    configured: true, baseUrl: item.config.baseUrl,
  });
  assert.equal(await item.run(['setup', 'remote']), `${item.config.baseUrl}\n`);
  await assert.rejects(fs.stat(path.join(item.root, '.cursor')), { code: 'ENOENT' });
});

test('set-url verifies the existing device and preserves registration, secrets, and sync history', async (t) => {
  const item = await fixture(t);
  const server = await item.probe();
  const oldToken = await fs.readFile(item.tokenPath);
  const oldVault = await fs.readFile(item.vaultPath);
  const result = JSON.parse(await item.run(['remote', 'set-url', `${server.url}/`, '--json']));
  assert.deepEqual(result, {
    changed: true, previousUrl: item.config.baseUrl, baseUrl: server.url,
    backupPath: `${item.remotePath}.before-url-change`,
  });
  const saved = JSON.parse(await fs.readFile(item.remotePath));
  assert.deepEqual({ ...saved, baseUrl: item.config.baseUrl, updatedAt: item.config.updatedAt }, item.config);
  assert.deepEqual(JSON.parse(await fs.readFile(result.backupPath)), item.config);
  assert.deepEqual(await fs.readFile(item.tokenPath), oldToken);
  assert.deepEqual(await fs.readFile(item.vaultPath), oldVault);
  assert.deepEqual(server.requests.map(({ method, url }) => [method, url]), [['GET', '/v1/devices']]);
  assert.equal(JSON.parse(await item.run(['sync', 'show', '--json'])).baseUrl, server.url);
  assert.doesNotMatch(JSON.stringify(result), /hndd_|vault key/);
  if (process.platform !== 'win32') {
    for (const file of [item.remotePath, result.backupPath]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
});

test('setup remote supports URL arguments and interactive entry, with Enter preserving the saved file', async (t) => {
  const item = await fixture(t);
  const first = await item.probe();
  const second = await item.probe();
  const result = JSON.parse(await item.run(['setup', 'remote', '--url', first.url, '--json']));
  assert.equal(result.baseUrl, first.url);
  assert.match(await item.run(['setup', 'remote'], second.url), /Server address updated/);
  assert.equal(JSON.parse(await fs.readFile(item.remotePath)).baseUrl, second.url);
  const before = await fs.readFile(item.remotePath, 'utf8');
  assert.match(await item.run(['setup', 'remote'], ''), /Current server address/);
  assert.equal(await fs.readFile(item.remotePath, 'utf8'), before);
  assert.equal(second.requests.length, 1);
});

test('same URL is a no-op even when the current server is offline', async (t) => {
  const item = await fixture(t);
  const before = await fs.readFile(item.remotePath, 'utf8');
  assert.deepEqual(JSON.parse(await item.run(['remote', 'set-url', `${item.config.baseUrl}/`, '--json'])), {
    changed: false, baseUrl: item.config.baseUrl,
  });
  assert.equal(await fs.readFile(item.remotePath, 'utf8'), before);
  await assert.rejects(fs.stat(`${item.remotePath}.before-url-change`), { code: 'ENOENT' });
});

test('invalid addresses and ambiguous command arguments do not change the remote', async (t) => {
  const item = await fixture(t);
  const before = await fs.readFile(item.remotePath, 'utf8');
  for (const url of ['not-a-url', 'http://public.example.test', 'https://user:password@example.test',
    'https://example.test/app', 'https://example.test/?token=secret', 'https://example.test/#fragment']) {
    await assert.rejects(item.run(['remote', 'set-url', url]), { name: 'UsageError' });
  }
  for (const args of [
    ['remote', 'set-url'], ['remote', 'set-url', item.config.baseUrl, 'extra'],
    ['remote', 'show', '--url', item.config.baseUrl], ['setup', 'remote', '--url'],
    ['setup', 'remote', '--dry-run'], ['setup', 'remote', 'extra'],
  ]) await assert.rejects(item.run(args), { name: 'UsageError' });
  assert.equal(await fs.readFile(item.remotePath, 'utf8'), before);
});

test('authentication failure, wrong device, wrong account, and revoked devices leave settings untouched', async (t) => {
  const item = await fixture(t);
  const before = await fs.readFile(item.remotePath, 'utf8');
  for (const [status, body] of [
    [401, { error: 'Unauthorized' }],
    [200, { devices: [{ ...item.config.device, id: 'other' }] }],
    [200, { devices: [{ ...item.config.device, tenantId: 'other' }] }],
    [200, { devices: [{ ...item.config.device, revokedAt: '2026-01-03T00:00:00Z' }] }],
    [200, { unexpected: true }],
    [200, { devices: [null] }],
  ]) {
    const server = await item.probe((_request, response) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await assert.rejects(item.run(['remote', 'set-url', server.url]), /existing address is unchanged/);
    assert.equal(await fs.readFile(item.remotePath, 'utf8'), before);
  }
  await assert.rejects(fs.stat(`${item.remotePath}.before-url-change`), { code: 'ENOENT' });
});

test('redirects never forward the device token to another origin', async (t) => {
  const item = await fixture(t);
  const target = await item.probe();
  const redirect = await item.probe((_request, response) => {
    response.writeHead(302, { Location: `${target.url}/v1/devices` }).end();
  });
  await assert.rejects(item.run(['remote', 'set-url', redirect.url]), /existing address is unchanged/);
  assert.equal(target.requests.length, 0);
  assert.equal(JSON.parse(await fs.readFile(item.remotePath)).baseUrl, item.config.baseUrl);
});

test('connection recovery clears authentication failures but preserves conflict and integrity barriers', async (t) => {
  const item = await fixture(t);
  const pendingPath = path.join(item.env.HND_HOME, 'cache', 'auto-sync-pending.json');
  await fs.mkdir(path.dirname(pendingPath), { recursive: true });
  for (const reason of ['authentication', 'offline', 'conflict', 'integrity']) {
    const pending = {
      schemaVersion: 1, pending: true, kind: reason === 'offline' ? 'retry' : 'attention', reason,
      attempts: 1, firstPendingAt: '2026-01-01T00:00:00Z', lastAttemptAt: '2026-01-01T00:00:00Z',
    };
    await fs.writeFile(pendingPath, JSON.stringify(pending));
    const server = await item.probe();
    await item.run(['remote', 'set-url', server.url]);
    if (['conflict', 'integrity'].includes(reason)) {
      assert.deepEqual(JSON.parse(await fs.readFile(pendingPath)), pending);
    } else await assert.rejects(fs.stat(pendingPath), { code: 'ENOENT' });
  }
});

test('URL changes wait for active remote operations and preserve their latest checkpoint', async (t) => {
  const item = await fixture(t);
  const server = await item.probe();
  const newer = { ...item.config, snapshotDigest: '3'.repeat(64), lastSyncAt: '2026-01-03T00:00:00Z' };
  let changing;
  await withFileLock(path.join(item.env.HND_HOME, 'locks', 'remote-operation.lock'), async () => {
    changing = item.run(['remote', 'set-url', server.url]);
    await new Promise(setImmediate);
    await fs.writeFile(item.remotePath, JSON.stringify(newer));
  });
  await changing;
  const result = JSON.parse(await fs.readFile(item.remotePath));
  assert.equal(result.snapshotDigest, newer.snapshotDigest);
  assert.equal(result.lastSyncAt, newer.lastSyncAt);
  assert.equal(result.baseUrl, server.url);
});

test('setup and sync help advertise the address commands in both languages', async (t) => {
  const item = await fixture(t, { configured: false });
  for (const language of ['en_US.UTF-8', 'ko_KR.UTF-8']) {
    item.env.LC_ALL = language;
    for (const command of ['setup', 'remote', 'sync']) {
      const help = await item.run([command, 'help']);
      assert.match(help, /hnd remote show/);
      assert.match(help, /hnd remote set-url URL/);
      assert.match(help, /hnd setup remote/);
    }
  }
});

test('an existing device continues real encrypted sync after its server moves to a new address', async (t) => {
  const item = await fixture(t, { configured: false });
  const dataDirectory = path.join(item.root, 'server');
  let server = await createSyncServer({ dataDirectory });
  t.after(() => server.close());
  const oldAddress = await server.listen({ host: '127.0.0.1', port: 0 });
  const enrollment = await server.createEnrollmentKey('same-account');
  await item.run(['sync', 'auto', 'off']);
  await item.run(['sync', 'enroll', '--url', oldAddress.url, '--key', enrollment.enrollmentKey, '--create-vault-key']);
  await item.run(['rule', 'set', 'all', '--text', 'Keep the existing encrypted rules.']);
  await item.run(['sync', 'push']);
  const previous = JSON.parse(await fs.readFile(item.remotePath));
  const token = await fs.readFile(item.tokenPath);
  const key = await fs.readFile(item.vaultPath);
  await server.close();
  server = await createSyncServer({ dataDirectory });
  const newAddress = await server.listen({ host: '127.0.0.1', port: 0 });
  assert.notEqual(newAddress.url, oldAddress.url);
  const result = JSON.parse(await item.run(['setup', 'remote', '--url', newAddress.url, '--json']));
  assert.equal(result.changed, true);
  const current = JSON.parse(await fs.readFile(item.remotePath));
  assert.deepEqual(current.device, previous.device);
  assert.equal(current.etag, previous.etag);
  assert.equal(current.snapshotDigest, previous.snapshotDigest);
  assert.deepEqual(await fs.readFile(item.tokenPath), token);
  assert.deepEqual(await fs.readFile(item.vaultPath), key);
  assert.equal(JSON.parse(await item.run(['sync', 'devices'])).devices.length, 1);
  const pushed = JSON.parse(await item.run(['sync', 'push', '--json']));
  assert.equal(pushed.unchanged, true);
  assert.match(await item.run(['rule', 'show', 'all']), /Keep the existing encrypted rules/);
});
