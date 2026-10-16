import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import test from 'node:test';
import { createCore } from '../src/core/index.mjs';
import { writeJsonAtomic } from '../src/core/fs.mjs';
import { remoteMain, snapshotDigest, formatDeviceInvite } from '../src/remote-cli.mjs';
import { autoSync, readAutoSyncPending } from '../src/sync/auto.mjs';
import { createSyncServer } from '../src/sync/server.mjs';
import { captureSyncSnapshot } from '../src/sync/capture.mjs';
import { SyncClient } from '../src/sync/client.mjs';
import { validatePolicySnapshot } from '../src/sync/validate-state.mjs';
import { readVaultKey, generateVaultKey, encryptBytes } from '../src/sync/crypto.mjs';

function record(relative, text) {
  const bytes = Buffer.from(text);
  return { path: relative, encoding: 'base64', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('base64') };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-recovery-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user'), HND_DISABLE_AUTO_UPDATE: '1' };
  await createCore({ env, cwd: root }).init();
  const server = await createSyncServer({ dataDirectory: path.join(root, 'server') });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const run = async (command, options = {}, targetEnv = env) => {
    let out = '';
    await remoteMain({ subcommand: command, options, rest: [], env: targetEnv, stdin: Readable.from([]), stdout: { write(s) { out += s; } }, jsonOutput: true });
    return JSON.parse(out);
  };
  const enroll = await server.createEnrollmentKey('recovery');
  await run('enroll', { url: address.url, key: enroll.enrollmentKey, create_vault_key: true, name: 'A' });
  await run('push');
  const key = await readVaultKey(path.join(env.HND_HOME, 'secrets', 'vault.key'));
  t.after(() => key.fill(0));
  const token = (await fs.readFile(path.join(env.HND_HOME, 'secrets', 'device.token'), 'utf8')).trim();
  const client = new SyncClient({ baseUrl: address.url, deviceToken: token });
  return { root, env, run, server, address, key, client };
}
const pending = (at) => ({ schemaVersion: 1, pending: true, kind: 'attention', reason: 'local_state', attempts: 1, firstPendingAt: at, lastAttemptAt: at });

test('local-state recovery refuses invalid domain schemas before publishing and resumes after repair', async (t) => {
  const { env, client, key } = await fixture(t);
  const index = path.join(env.HND_HOME, 'repositories.json');
  await writeJsonAtomic(index, { schemaVersion: 999, repositories: {} });
  await writeJsonAtomic(path.join(env.HND_HOME, 'cache', 'auto-sync-pending.json'), pending('2020-01-01T00:00:00.000Z'));
  const result = await autoSync({ env, timeoutMs: 5_000 });
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.blocked, true);
  const remote = await client.pullSnapshot(key);
  assert.equal(JSON.parse(Buffer.from(remote.snapshot.files.find(f => f.path === 'repositories.json').content, 'base64')).schemaVersion, 1);
  await writeJsonAtomic(index, { schemaVersion: 1, repositories: {} });
  assert.equal((await autoSync({ env, timeoutMs: 5_000, clock: { now: () => Date.now() + 61_000 } })).status, 'synced');
});

test('invalid remote domain records cannot replace valid local state or advance its checkpoint', async (t) => {
  const { env, client, key, run } = await fixture(t);
  const before = await fs.readFile(path.join(env.HND_HOME, 'remotes.json'), 'utf8');
  const current = await client.pullSnapshot(key);
  const invalid = { schemaVersion: 1, files: current.snapshot.files.map(f => f.path === 'repositories.json'
    ? record(f.path, '{"schemaVersion":999,"repositories":{}}') : f) };
  await client.pushSnapshot(invalid, key, { etag: current.etag });
  await assert.rejects(run('pull'), { code: 'SYNC_STATE_INVALID' });
  assert.equal(await fs.readFile(path.join(env.HND_HOME, 'remotes.json'), 'utf8'), before);
  assert.equal(JSON.parse(await fs.readFile(path.join(env.HND_HOME, 'repositories.json'))).schemaVersion, 1);
});

test('verified manual sync clears repaired attention while failed verification preserves it', async (t) => {
  const { env, run } = await fixture(t);
  const marker = path.join(env.HND_HOME, 'cache', 'auto-sync-pending.json');
  for (const reason of ['schema', 'authentication', 'integrity']) {
    const attention = { ...pending(new Date().toISOString()), reason };
    await writeJsonAtomic(marker, attention);
    const blocked = await autoSync({ env });
    assert.equal(blocked.status, 'needs_attention');
    assert.equal(blocked.blocked, true);
    await assert.rejects(remoteMain({
      subcommand: 'push', options: {}, rest: [], env, jsonOutput: true,
      stdout: { write() {} }, syncClientOptions: {
        fetchImpl: async () => { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); },
      },
    }), { code: 'ECONNREFUSED' });
    assert.deepEqual(await readAutoSyncPending({ env }), attention);
    await run('push');
    assert.equal(await readAutoSyncPending({ env }), null);
    assert.equal((await autoSync({ env })).status, 'synced');
  }
});

test('manual pull leaves an attention barrier when local unpushed edits remain', async (t) => {
  const { env, run } = await fixture(t);
  await fs.writeFile(path.join(env.HND_HOME, 'policies', 'global.md'), 'UNPUSHED');
  const attention = { ...pending(new Date().toISOString()), reason: 'schema' };
  await writeJsonAtomic(path.join(env.HND_HOME, 'cache', 'auto-sync-pending.json'), attention);
  await run('pull');
  assert.deepEqual(await readAutoSyncPending({ env }), attention);
  await run('push');
  assert.equal(await readAutoSyncPending({ env }), null);
});

test('policy preflight checks named-rule environments absent from local selection and tolerates unavailable success cache', async (t) => {
  const { root, env } = await fixture(t);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const core = createCore({ env, cwd: root });
  const linked = await core.repo.init();
  const snapshot = await captureSyncSnapshot(env.HND_HOME);
  const repoId = linked.repository.id;
  const rule = (id) => ({ schemaVersion: 1, id, scope: 'env', repoId, environment: 'hidden-env',
    title: 'Hidden environment', content: 'x'.repeat(16_000), status: 'active', activation: 'always',
    paths: [], files: [], history: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  const ids = ['ba217aec-07cb-42b6-85ca-e40cb560a6ea', 'bdd0eb3d-b364-4661-a69b-486cc4ccc202'];
  const candidate = { ...snapshot, files: [...snapshot.files, ...ids.map(id =>
    record(`repositories/${repoId}/rules/${id}.json`, JSON.stringify(rule(id))))] };
  await assert.rejects(validatePolicySnapshot(candidate, env), { code: 'CONTEXT_TOO_LARGE' });
  const mixedCase = { ...snapshot, files: [...snapshot.files,
    record(`repositories/${repoId}/environments/prod.md`, 'p'.repeat(16_000)),
    record(`repositories/${repoId}/rules/${ids[0]}.json`, JSON.stringify({ ...rule(ids[0]), environment: 'Prod' })),
  ] };
  await assert.rejects(validatePolicySnapshot(mixedCase, env), { code: 'CONTEXT_TOO_LARGE' });
  const cache = path.join(env.HND_HOME, 'cache', 'policy-preflight.json');
  await fs.rm(cache, { force: true });
  await fs.mkdir(cache);
  await validatePolicySnapshot(snapshot, env);
});

test('automatic sync recovers a valid interrupted restore before recent local-state attention', async (t) => {
  const { env } = await fixture(t);
  const previous = await captureSyncSnapshot(env.HND_HOME);
  const target = { schemaVersion: 1, files: [...previous.files.filter(f => f.path !== 'policies/global.md'), record('policies/global.md', 'RECOVERED')] };
  const journal = path.join(env.HND_HOME, 'cache', 'restore-journal.json');
  await writeJsonAtomic(journal, { schemaVersion: 1, operationId: 'interrupted', previous, target, targetDigest: snapshotDigest(target) });
  await fs.writeFile(path.join(env.HND_HOME, 'policies/global.md'), 'partial');
  await writeJsonAtomic(path.join(env.HND_HOME, 'cache', 'auto-sync-pending.json'), pending(new Date().toISOString()));
  assert.equal((await autoSync({ env, timeoutMs: 5_000 })).status, 'synced');
  assert.equal(await fs.readFile(path.join(env.HND_HOME, 'policies/global.md'), 'utf8'), 'RECOVERED');
  await assert.rejects(fs.stat(journal), { code: 'ENOENT' });
  assert.equal(await readAutoSyncPending({ env }), null);
});

test('a partially committed connection resumes from its private journal without consuming another invitation', async (t) => {
  const { root, env, run } = await fixture(t);
  const target = { ...env, HND_HOME: path.join(root, 'new-state') };
  await createCore({ env: target, cwd: root }).init();
  const secret = generateVaultKey(), vault = generateVaultKey();
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests += 1;
    await fs.mkdir(path.join(target.HND_HOME, 'secrets', 'device.token'), { recursive: true });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ deviceToken: `hndd_${'a'.repeat(43)}`, device: { id: 'partial-device', name: 'partial' }, wrappedVaultKey: encryptBytes(vault, secret, { maxBytes: 32 }).toString('base64') }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const code = formatDeviceInvite(`hndi_${'a'.repeat(43)}`, secret);
  await assert.rejects(run('connect', { url, code }, target));
  const journal = path.join(target.HND_HOME, 'secrets/enrollment.pending.json');
  assert.ok((await fs.stat(journal)).isFile());
  if (process.platform !== 'win32') assert.equal((await fs.stat(journal)).mode & 0o777, 0o600);
  await fs.rmdir(path.join(target.HND_HOME, 'secrets/device.token'));
  const resumed = await run('connect', { url }, target);
  assert.equal(resumed.resumed, true);
  assert.equal(requests, 1);
  assert.ok((await readVaultKey(path.join(target.HND_HOME, 'secrets/vault.key'))).equals(vault));
  await assert.rejects(fs.stat(journal), { code: 'ENOENT' });
});

test('two PCs can publish divergent automatic checkpoints on the same branch without blocking rules sync', async (t) => {
  const { root, env, run, server, address, key } = await fixture(t);
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  await fs.mkdir(a);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  git(a, 'init', '-b', 'main');
  git(a, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  execFileSync('git', ['clone', '--quiet', a, b]);
  for (const cwd of [a, b]) {
    try { git(cwd, 'remote', 'add', 'origin', 'https://example.invalid/team/repo.git'); }
    catch { git(cwd, 'remote', 'set-url', 'origin', 'https://example.invalid/team/repo.git'); }
  }
  const coreA = createCore({ env, cwd: a });
  await coreA.repo.init();
  await coreA.auto.capture({ agent: 'claude' });
  await run('push');
  const envB = { ...env, HND_HOME: path.join(root, 'state-b') };
  await createCore({ env: envB, cwd: b }).init();
  const enrollment = await server.createEnrollmentKey('recovery');
  await run('enroll', { url: address.url, key: enrollment.enrollmentKey, vault_key_file: path.join(env.HND_HOME, 'secrets/vault.key'), name: 'B' }, envB);
  await run('pull', {}, envB);
  const coreB = createCore({ env: envB, cwd: b });
  await coreB.repo.init();
  await fs.writeFile(path.join(a, 'a-only.txt'), 'A');
  await fs.writeFile(path.join(b, 'b-only.txt'), 'B');
  const left = (await coreA.auto.capture({ agent: 'claude' })).checkpoint;
  const right = (await coreB.auto.capture({ agent: 'codex' })).checkpoint;
  await run('push');
  const result = await autoSync({ env: envB, timeoutMs: 5_000 });
  assert.equal(result.status, 'synced');
  assert.equal(result.conflicts, 0);
  const checkpoint = await coreB.auto.show();
  assert.ok([left.fingerprint, right.fingerprint].includes(checkpoint.fingerprint));
  assert.equal(await readAutoSyncPending({ env: envB }), null);
});

test('a mismatched restore-journal digest never changes live state', async (t) => {
  const { env } = await fixture(t);
  const previous = await captureSyncSnapshot(env.HND_HOME);
  const target = { schemaVersion: 1, files: [...previous.files.filter(f => f.path !== 'policies/global.md'), record('policies/global.md', 'UNACKNOWLEDGED')] };
  const journal = path.join(env.HND_HOME, 'cache', 'restore-journal.json');
  await fs.writeFile(path.join(env.HND_HOME, 'policies/global.md'), 'ORIGINAL');
  await writeJsonAtomic(journal, { schemaVersion: 1, operationId: 'invalid-digest', previous, target, targetDigest: '0'.repeat(64) });
  const { recoverInterruptedRemoteRestore } = await import('../src/remote-cli.mjs');
  await assert.rejects(recoverInterruptedRemoteRestore(env), /digest mismatch/);
  assert.equal(await fs.readFile(path.join(env.HND_HOME, 'policies/global.md'), 'utf8'), 'ORIGINAL');
  assert.ok((await fs.stat(journal)).isFile());
});

test('distributed named-rule combinations are preflighted with the actual renderer before restore', async (t) => {
  const { env, root } = await fixture(t);
  const core = createCore({ env, cwd: root });
  const first = await core.ruleRecord.add({ title: 'first', content: 'a'.repeat(16_000), scope: 'global' });
  const snapshot = await captureSyncSnapshot(env.HND_HOME);
  const second = { ...first, id: '22222222-2222-4222-8222-222222222222', title: 'second', content: 'b'.repeat(16_000) };
  const candidate = { schemaVersion: 1, files: [...snapshot.files, record(`rules/${second.id}.json`, JSON.stringify(second))] };
  const { validateSyncedState, validatePolicySnapshot } = await import('../src/sync/validate-state.mjs');
  assert.doesNotThrow(() => validateSyncedState(candidate));
  await assert.rejects(validatePolicySnapshot(candidate, env), { code: 'CONTEXT_TOO_LARGE' });
  second.status = 'draft';
  const inactive = { schemaVersion: 1, files: [...snapshot.files, record(`rules/${second.id}.json`, JSON.stringify(second))] };
  await validatePolicySnapshot(inactive, env);
  // A successful check for a draft candidate must never authorize its active form.
  await assert.rejects(validatePolicySnapshot(candidate, env), { code: 'CONTEXT_TOO_LARGE' });
  assert.equal((await fs.readdir(path.join(env.HND_HOME, 'rules'))).length, 1);
});
