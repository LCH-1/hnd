import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { formatDeviceInvite } from '../src/remote-cli.mjs';
import {
  AUTO_SYNC_PENDING_FILENAME,
  autoSync,
  readAutoSyncPending,
} from '../src/sync/auto.mjs';
import { readVaultKey } from '../src/sync/crypto.mjs';
import { createSyncServer } from '../src/sync/server.mjs';

const execFileAsync = promisify(execFile);

function captureStream() {
  let value = '';
  return {
    write(chunk) {
      value += String(chunk);
      return true;
    },
    value: () => value,
  };
}

function runner(env, cwd) {
  return async (args, input = '') => {
    const stdout = captureStream();
    const stderr = captureStream();
    await main(args, {
      env,
      cwd,
      stdin: Readable.from([input]),
      stdout,
      stderr,
    });
    return { stdout: stdout.value(), stderr: stderr.value() };
  };
}

async function git(cwd, ...args) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

async function makeTwinCheckouts(root) {
  const source = path.join(root, 'source');
  const workA = path.join(root, 'work-a');
  const workB = path.join(root, 'work-b');
  await fs.mkdir(source, { recursive: true });
  await git(source, 'init', '-b', 'main');
  await git(source, 'config', 'user.email', 'test@example.invalid');
  await git(source, 'config', 'user.name', 'hnd test');
  await fs.writeFile(path.join(source, 'README.md'), '# auto sync fixture\n');
  await git(source, 'add', 'README.md');
  await git(source, 'commit', '-m', 'initial');
  await execFileAsync('git', ['clone', source, workA]);
  await execFileAsync('git', ['clone', source, workB]);
  return { workA, workB };
}

async function issueAccountConnection(server, tenantId, hndHome) {
  const vaultKey = await readVaultKey(path.join(hndHome, 'secrets', 'vault.key'));
  try {
    await server.snapshots.adoptManagedVaultKey(tenantId, vaultKey);
  } finally {
    vaultKey.fill(0);
  }
  const issued = await server.snapshots.createManagedDeviceInvitation(
    tenantId,
    { ttlMs: 15 * 60 * 1000 },
  );
  try {
    return formatDeviceInvite(issued.invitationToken, issued.connectionSecret);
  } finally {
    issued.connectionSecret.fill(0);
  }
}

test('automatic sync is a no-op before remote enrollment', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-auto-none-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HND_HOME: path.join(root, '.hnd'),
    HND_USER_HOME: root,
  };

  const result = await autoSync({ env });
  assert.deepEqual(result, {
    status: 'not_configured',
    synced: false,
    pending: false,
  });
  assert.equal(await readAutoSyncPending({ env }), null);
});

test('automatic sync converges safely, defers offline, and blocks conflicts or auth failures', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-auto-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = await createSyncServer({ dataDirectory: path.join(root, 'server') });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const { workA, workB } = await makeTwinCheckouts(root);
  const deviceARoot = path.join(root, 'device-a');
  const deviceBRoot = path.join(root, 'device-b');
  const envA = {
    ...process.env,
    HND_HOME: path.join(deviceARoot, '.hnd'),
    HND_USER_HOME: deviceARoot,
  };
  const envB = {
    ...process.env,
    HND_HOME: path.join(deviceBRoot, '.hnd'),
    HND_USER_HOME: deviceBRoot,
  };
  const runA = runner(envA, workA);
  const runB = runner(envB, workB);

  const enrollment = await server.createEnrollmentKey('auto-tenant');
  await runA([
    'sync', 'enroll', '--url', address.url, '--key', enrollment.enrollmentKey,
    '--name', 'device-a', '--create-vault-key',
  ]);
  await runA(['sync', 'auto', 'off']);
  await runA(['init']);
  await runA(['rule', 'set', 'all', '--text', 'GLOBAL-BASE']);
  await runA(['rule', 'set', 'repo', '--text', 'REPO-BASE']);
  await runA(['sync', 'push']);
  // Seed a legacy tenant once, then model the signed-in account adopting its
  // key and issuing the normal server-managed connection code.
  const connectionCode = await issueAccountConnection(server, 'auto-tenant', envA.HND_HOME);
  await runB([
    'connect', '--url', address.url, '--code', connectionCode, '--name', 'device-b',
  ]);
  await runB(['sync', 'auto', 'off']);
  await runB(['sync', 'pull']);
  await runB(['init']);

  // Independent changes converge through a verified three-way merge and push.
  await runB(['rule', 'set', 'all', '--text', 'GLOBAL-REMOTE']);
  await runB(['sync', 'push']);
  await runA(['rule', 'set', 'repo', '--text', 'REPO-LOCAL']);
  const merged = await autoSync({ env: envA });
  assert.equal(merged.status, 'synced');
  assert.equal(merged.pending, false);
  assert.equal(merged.conflicts, 0);
  assert.match((await runA(['rule', 'show', 'all'])).stdout, /GLOBAL-REMOTE/);
  assert.match((await runA(['rule', 'show', 'repo'])).stdout, /REPO-LOCAL/);
  assert.equal((await autoSync({ env: envB })).status, 'synced');
  assert.match((await runB(['rule', 'show', 'repo'])).stdout, /REPO-LOCAL/);

  // A same-file conflict is merged locally for review but never auto-pushed.
  await runB(['rule', 'set', 'all', '--text', 'GLOBAL-B-CONFLICT']);
  await runB(['sync', 'push']);
  await runA(['rule', 'set', 'all', '--text', 'GLOBAL-A-CONFLICT']);
  const attention = await autoSync({ env: envA });
  assert.equal(attention.status, 'needs_attention');
  assert.equal(attention.reason, 'conflict');
  assert.equal(attention.conflicts, 1);
  assert.match((await runA(['rule', 'show', 'all'])).stdout, /GLOBAL-A-CONFLICT/);
  await runB(['sync', 'pull']);
  assert.match((await runB(['rule', 'show', 'all'])).stdout, /GLOBAL-B-CONFLICT/);

  let blockedReconcileCalled = false;
  const blocked = await autoSync({
    env: envA,
    reconcile: async () => {
      blockedReconcileCalled = true;
      return { status: 'synced' };
    },
  });
  assert.equal(blocked.status, 'needs_attention');
  assert.equal(blocked.blocked, true);
  assert.equal(blockedReconcileCalled, false);

  // A reviewed manual push acknowledges the local resolution and unblocks auto sync.
  await runA(['sync', 'push']);
  const resumed = await autoSync({ env: envA });
  assert.equal(resumed.status, 'synced');
  assert.equal(resumed.retried, true);
  assert.equal(await readAutoSyncPending({ env: envA }), null);
  await autoSync({ env: envB });
  assert.match((await runB(['rule', 'show', 'all'])).stdout, /GLOBAL-A-CONFLICT/);

  // Network errors fail open, persist only a sanitized atomic retry marker,
  // and retry on the next invocation.
  await runA(['rule', 'set', 'all', '--text', 'OFFLINE-LOCAL']);
  const offlineFetch = async () => {
    const cause = Object.assign(new Error('must-not-be-persisted'), { code: 'ECONNREFUSED' });
    throw new TypeError('fetch failed: must-not-be-persisted', { cause });
  };
  const deferred = await autoSync({ env: envA, fetchImpl: offlineFetch });
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.reason, 'offline');
  const retryMarker = await readAutoSyncPending({ env: envA });
  assert.equal(retryMarker.kind, 'retry');
  assert.equal(JSON.stringify(retryMarker).includes('must-not-be-persisted'), false);
  if (process.platform !== 'win32') {
    const markerPath = path.join(envA.HND_HOME, 'cache', AUTO_SYNC_PENDING_FILENAME);
    assert.equal((await fs.stat(markerPath)).mode & 0o777, 0o600);
  }
  const retried = await autoSync({ env: envA });
  assert.equal(retried.status, 'synced');
  assert.equal(retried.retried, true);
  assert.equal(await readAutoSyncPending({ env: envA }), null);

  // Authentication and trust failures require explicit attention and never
  // expose the device token through return values or pending state.
  const deviceToken = (await fs.readFile(
    path.join(envA.HND_HOME, 'secrets', 'device.token'),
    'utf8',
  )).trim();
  const authFetch = async () => new Response(
    JSON.stringify({ message: `private:${deviceToken}` }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
  const authentication = await autoSync({ env: envA, fetchImpl: authFetch });
  assert.equal(authentication.status, 'needs_attention');
  assert.equal(authentication.reason, 'authentication');
  const authMarker = await readAutoSyncPending({ env: envA });
  assert.equal(authMarker.kind, 'attention');
  assert.equal(JSON.stringify([authentication, authMarker]).includes(deviceToken), false);
  blockedReconcileCalled = false;
  const authBlocked = await autoSync({
    env: envA,
    reconcile: async () => {
      blockedReconcileCalled = true;
      return { status: 'synced' };
    },
  });
  assert.equal(authBlocked.blocked, true);
  assert.equal(blockedReconcileCalled, false);
  assert.equal((await autoSync({ env: envA, retryAttention: true })).status, 'synced');

  // The separate cross-process lock also serializes simultaneous hook calls.
  let active = 0;
  let maximumActive = 0;
  const serializedReconcile = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 60));
    active -= 1;
    return { status: 'synced', changed: false, attempts: 1, conflicts: 0 };
  };
  const concurrent = await Promise.all([
    autoSync({ env: envA, reconcile: serializedReconcile }),
    autoSync({ env: envA, reconcile: serializedReconcile }),
  ]);
  assert.deepEqual(concurrent.map((result) => result.status), ['synced', 'synced']);
  assert.equal(maximumActive, 1);
});
