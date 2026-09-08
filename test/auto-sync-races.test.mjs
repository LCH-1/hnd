import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withFileLock, writeJsonAtomic } from '../src/core/fs.mjs';
import { statePaths } from '../src/paths.mjs';
import { snapshotDigest } from '../src/remote-cli.mjs';
import { autoSync, readAutoSyncPending } from '../src/sync/auto.mjs';
import { captureSyncSnapshot } from '../src/sync/capture.mjs';
import { readHookSyncMarker, syncForHook } from '../src/sync/hook-sync.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-sync-races-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HND_HOME: path.join(root, '.hnd'), HND_USER_HOME: root };
  const paths = statePaths(env);
  await writeJsonAtomic(paths.remotes, {
    schemaVersion: 1,
    baseUrl: 'https://sync.example.invalid',
    device: { id: 'test-device' },
    etag: null,
    snapshotDigest: '0'.repeat(64),
  });
  return { env, paths };
}

test('a hook waiting for the sync lock cannot erase a conflict or authentication barrier', async (t) => {
  for (const reason of ['conflict', 'authentication']) {
    await t.test(reason, async (t) => {
      const { env, paths } = await fixture(t);
      const initial = await autoSync({
        env,
        reconcile: async () => {
          if (reason === 'authentication') throw Object.assign(new Error('private'), { status: 401 });
          return { status: 'needs_attention', reason: 'conflict', conflicts: 1 };
        },
      });
      assert.equal(initial.reason, reason);
      const before = await readAutoSyncPending({ env });
      let reconciled = false;
      await withFileLock(path.join(paths.locks, 'auto-sync.lock'), async () => {
        const waiting = await autoSync({
          env,
          lockTimeoutMs: 1,
          reconcile: async () => { reconciled = true; return { status: 'synced' }; },
        });
        assert.equal(waiting.status, 'needs_attention');
        assert.equal(waiting.reason, reason);
        assert.deepEqual(await readAutoSyncPending({ env }), before);
      });
      const next = await autoSync({
        env,
        reconcile: async () => { reconciled = true; return { status: 'synced' }; },
      });
      assert.equal(next.blocked, true);
      assert.equal(reconciled, false);
    });
  }
});

test('a hook that cannot acquire the sync lock does not fabricate a persisted retry', async (t) => {
  const { env, paths } = await fixture(t);
  await withFileLock(path.join(paths.locks, 'auto-sync.lock'), async () => {
    const waiting = await autoSync({
      env,
      lockTimeoutMs: 1,
      reconcile: async () => { throw new Error('must not reconcile'); },
    });
    assert.equal(waiting.status, 'deferred');
    assert.equal(waiting.reason, 'busy');
    assert.equal(waiting.pending, false);
    assert.equal(await readAutoSyncPending({ env }), null);
  });
});

test('a manual sync lock timeout cannot downgrade an unresolved conflict', async (t) => {
  const { env, paths } = await fixture(t);
  await autoSync({
    env,
    reconcile: async () => ({ status: 'needs_attention', reason: 'conflict', conflicts: 1 }),
  });
  const before = await readAutoSyncPending({ env });
  await withFileLock(path.join(paths.locks, 'remote-operation.lock'), async () => {
    const result = await autoSync({
      env,
      lockTimeoutMs: 1,
      reconcile: async () => { throw new Error('must not reconcile'); },
    });
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.reason, 'conflict');
    assert.deepEqual(await readAutoSyncPending({ env }), before);
  });
});

test('SessionEnd retries edits made after Stop published its snapshot', async (t) => {
  const { env, paths } = await fixture(t);
  const acknowledged = snapshotDigest(await captureSyncSnapshot(paths.home));
  const options = { env, agent: 'codex', payload: { session_id: 'race-session' } };
  const stopped = await syncForHook({
    ...options,
    phase: 'stop',
    reconcile: async () => {
      // Another session saves work after the network operation captured and
      // published the old state but before the Stop hook records success.
      await fs.mkdir(path.dirname(paths.globalPolicy), { recursive: true });
      await fs.writeFile(paths.globalPolicy, 'not published yet\n');
      return { status: 'synced', snapshotDigest: acknowledged };
    },
  });
  assert.equal(stopped.status, 'synced');
  assert.equal((await readHookSyncMarker({ env })).snapshotDigest, acknowledged);
  let retried = false;
  const ended = await syncForHook({
    ...options,
    phase: 'end',
    reconcile: async () => { retried = true; return { status: 'synced' }; },
  });
  assert.equal(ended.status, 'synced');
  assert.equal(retried, true);
});

test('Stop success without an acknowledged snapshot cannot suppress SessionEnd', async (t) => {
  const { env, paths } = await fixture(t);
  const options = { env, agent: 'codex', payload: { session_id: 'unknown-snapshot' } };
  await syncForHook({
    ...options,
    phase: 'stop',
    reconcile: async () => ({
      status: 'synced',
      snapshotDigest: snapshotDigest(await captureSyncSnapshot(paths.home)),
    }),
  });
  assert.ok(await readHookSyncMarker({ env }));
  await syncForHook({ ...options, phase: 'stop', reconcile: async () => ({ status: 'synced' }) });
  assert.equal(await readHookSyncMarker({ env }), null);
  let retried = false;
  await syncForHook({
    ...options,
    phase: 'end',
    reconcile: async () => { retried = true; return { status: 'synced' }; },
  });
  assert.equal(retried, true);
});

test('SessionEnd cannot hide a newer attention barrier behind an earlier successful Stop', async (t) => {
  for (const reason of ['conflict', 'authentication']) {
    await t.test(reason, async (t) => {
      const { env, paths } = await fixture(t);
      const options = { env, agent: 'codex', payload: { session_id: 'attention-after-stop' } };
      await syncForHook({
        ...options,
        phase: 'stop',
        reconcile: async () => ({
          status: 'synced',
          snapshotDigest: snapshotDigest(await captureSyncSnapshot(paths.home)),
        }),
      });
      await autoSync({
        env,
        reconcile: async () => {
          if (reason === 'authentication') throw Object.assign(new Error('private'), { status: 401 });
          return { status: 'needs_attention', reason: 'conflict', conflicts: 1 };
        },
      });
      const before = await readAutoSyncPending({ env });
      const ended = await syncForHook({
        ...options,
        phase: 'end',
        reconcile: async () => { throw new Error('must not bypass attention'); },
      });
      assert.equal(ended.status, 'needs_attention');
      assert.equal(ended.reason, reason);
      assert.equal(ended.synced, false);
      assert.equal(ended.pending, true);
      assert.equal(ended.blocked, true);
      assert.deepEqual(await readAutoSyncPending({ env }), before);
    });
  }
});

test('SessionEnd retries a newer transient failure even when the snapshot is unchanged', async (t) => {
  const { env, paths } = await fixture(t);
  const options = { env, agent: 'codex', payload: { session_id: 'retry-after-stop' } };
  const acknowledged = snapshotDigest(await captureSyncSnapshot(paths.home));
  await syncForHook({
    ...options,
    phase: 'stop',
    reconcile: async () => ({ status: 'synced', snapshotDigest: acknowledged }),
  });
  await autoSync({
    env,
    reconcile: async () => { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); },
  });
  let reconciled = false;
  const ended = await syncForHook({
    ...options,
    phase: 'end',
    reconcile: async () => {
      reconciled = true;
      return { status: 'synced', snapshotDigest: acknowledged };
    },
  });
  assert.equal(reconciled, true);
  assert.equal(ended.status, 'synced');
  assert.equal(ended.retried, true);
  assert.equal(await readAutoSyncPending({ env }), null);
});

test('SessionEnd cannot skip an in-flight sync using an earlier Stop marker', async (t) => {
  const { env, paths } = await fixture(t);
  const options = { env, agent: 'codex', payload: { session_id: 'busy-after-stop' } };
  await syncForHook({
    ...options,
    phase: 'stop',
    reconcile: async () => ({
      status: 'synced',
      snapshotDigest: snapshotDigest(await captureSyncSnapshot(paths.home)),
    }),
  });
  await withFileLock(path.join(paths.locks, 'auto-sync.lock'), async () => {
    const ended = await syncForHook({
      ...options,
      phase: 'end',
      lockTimeoutMs: 1,
      reconcile: async () => { throw new Error('must not race the lock owner'); },
    });
    assert.equal(ended.status, 'deferred');
    assert.equal(ended.reason, 'busy');
    assert.equal(ended.synced, false);
    assert.equal(ended.pending, false);
    assert.equal(await readAutoSyncPending({ env }), null);
  });
});
