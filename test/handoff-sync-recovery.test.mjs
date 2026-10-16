import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCore } from '../src/core/index.mjs';
import { writeJsonAtomic } from '../src/core/fs.mjs';
import { captureSyncSnapshot } from '../src/sync/capture.mjs';
import { remoteSyncConflictResolved, snapshotDigest } from '../src/remote-cli.mjs';

function file(relative, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  return { path: relative, encoding: 'base64', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('base64') };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-lease-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo');
  await fs.mkdir(cwd);
  execFileSync('git', ['-C', cwd, 'init', '-b', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' });
  const env = { HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user') };
  const clock = () => new Date('2026-10-16T00:00:00Z');
  const core = createCore({ cwd, env, clock, agent: 'codex', sessionId: 'owner' });
  await core.init();
  const task = await core.handoff.start({ task: 'test', objective: 'test' });
  const relative = `repositories/${task.repoId}/handoffs/${task.id}.json`;
  const target = path.join(env.HND_HOME, relative);
  const base = JSON.parse(await fs.readFile(target, 'utf8'));
  const local = { ...base, currentState: 'local work', history: [...base.history,
    { at: '2026-10-16T00:30:00Z', action: 'updated' }] };
  const remote = { ...base, claimExpiresAt: '2026-10-16T03:00:00Z', history: [...base.history,
    { at: '2026-10-16T01:00:00Z', action: 'claim_renewed', sessionKey: base.claimSessionKey }] };
  const etag = `"${'c'.repeat(64)}"`;
  async function prepare({ reportedRemote = remote, current = local, reportEtag = etag, cachedRemote = reportedRemote } = {}) {
    await writeJsonAtomic(target, cachedRemote);
    const snapshot = await captureSyncSnapshot(env.HND_HOME);
    await writeJsonAtomic(path.join(env.HND_HOME, 'cache', 'sync-bases', `${'c'.repeat(64)}.json`), {
      schemaVersion: 1, etag, snapshotDigest: snapshotDigest(snapshot), snapshot, savedAt: clock().toISOString(),
    });
    await writeJsonAtomic(path.join(env.HND_HOME, 'remotes.json'), {
      schemaVersion: 1, baseUrl: 'https://example.invalid', device: { id: 'test' }, etag, snapshotDigest: snapshotDigest(snapshot),
    });
    await writeJsonAtomic(path.join(env.HND_HOME, 'cache', 'merge-conflicts-2026-10-16T00-00-00.000Z-test.json'), {
      schemaVersion: 1, remoteEtag: reportEtag,
      conflicts: [{ path: relative, base: file(relative, base), local: file(relative, local), remote: file(relative, reportedRemote) }],
    });
    await writeJsonAtomic(target, current);
  }
  return { env, target, base, local, remote, prepare };
}

test('upgrade recovers a retained lease-only conflict with newer local progress and keeps a backup', async (t) => {
  const f = await fixture(t);
  await f.prepare({ current: { ...f.local, currentState: 'progress since conflict' } });
  assert.equal(await remoteSyncConflictResolved(f.env), true);
  const after = JSON.parse(await fs.readFile(f.target, 'utf8'));
  assert.equal(after.currentState, 'progress since conflict');
  assert.equal(after.claimExpiresAt, f.remote.claimExpiresAt);
  assert.ok(after.history.some((entry) => entry.action === 'claim_renewed'));
  const cache = await fs.readdir(path.join(f.env.HND_HOME, 'cache'));
  assert.ok(cache.some((name) => name.startsWith('pre-lease-conflict-recovery-')));
  assert.equal(cache.includes('restore-journal.json'), false);
});

test('upgrade keeps genuine content conflicts and stale or mismatched conflict reports blocked', async (t) => {
  const f = await fixture(t);
  for (const options of [
    { reportedRemote: { ...f.remote, currentState: 'remote work' } },
    { reportEtag: `"${'d'.repeat(64)}"` },
    { cachedRemote: { ...f.remote, currentState: 'different acknowledged revision' } },
    { current: { ...f.local, claimSessionKey: 'b'.repeat(64) } },
  ]) {
    await f.prepare(options);
    const before = await fs.readFile(f.target, 'utf8');
    assert.equal(await remoteSyncConflictResolved(f.env), false);
    assert.equal(await fs.readFile(f.target, 'utf8'), before);
  }
});
