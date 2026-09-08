import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { repositoryPaths, statePaths } from '../src/paths.mjs';
import { captureCheckpoint, getCheckpoint } from '../src/core/checkpoints.mjs';
import { createCore } from '../src/core/index.mjs';
import { withFileLock, writeJsonAtomic } from '../src/core/fs.mjs';
import { detectGitCheckout } from '../src/core/git.mjs';
import { automaticSessionCandidate, exportKnowledge } from '../src/core/knowledge-transfer.mjs';
import { searchKnowledgeIndex } from '../src/core/knowledge-index.mjs';
import {
  applyRetention, assertNoSensitive, collectionAllowed, getPrivacyPolicy,
  previewRetention, redactSensitiveText, scanSensitive, setPrivacyPolicy,
} from '../src/core/privacy.mjs';
import { resolveRepository } from '../src/core/repositories.mjs';

const execFileAsync = promisify(execFile);
const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
const sessionA = 'a'.repeat(64);
const sessionB = 'b'.repeat(64);

async function git(cwd, ...args) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-privacy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'work');
  await fs.mkdir(cwd);
  await git(cwd, 'init', '-b', 'main');
  await git(cwd, 'config', 'user.name', 'Privacy test');
  await git(cwd, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(cwd, 'README.md'), 'initial\n');
  await git(cwd, 'add', 'README.md');
  await git(cwd, 'commit', '-m', 'initial');
  const env = { ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: root };
  const resolved = await resolveRepository({ cwd, env });
  return { root, cwd, env, repoId: resolved.repository.id, sessionKey: null };
}

test('sensitive diagnostics expose only safe categories and positions', () => {
  const input = { title: 'A title', body: `first line\n${token}`, [token]: token };
  const findings = scanSensitive(input);
  assert.equal(findings.length, 3);
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].location, '$/body');
  assert.doesNotMatch(JSON.stringify(findings), new RegExp(token, 'u'));
  assert.throws(() => assertNoSensitive(input), (error) => {
    assert.equal(error.code, 'SENSITIVE_CONTENT');
    assert.doesNotMatch(JSON.stringify(error), new RegExp(token, 'u'));
    assert.doesNotMatch(error.message, new RegExp(token, 'u'));
    return true;
  });
  assert.deepEqual(assertNoSensitive(input, { allowSensitive: true }), findings);
  assert.deepEqual(scanSensitive('Use GITHUB_TOKEN from your environment. Never paste the API key.'), []);
  for (const secret of [
    `hnds_${'A'.repeat(42)}-`,
    `hndj_${'A'.repeat(43)}.${'B'.repeat(43)}.${'C'.repeat(11)}-`,
    `hnd-vault-v1:${'A'.repeat(42)}-`,
  ]) {
    assert.equal(scanSensitive(secret).length, 1);
    assert.doesNotMatch(redactSensitiveText(secret).text, /hndj_|hnds_|hnd-vault-v1:/u);
  }
});

test('automatic candidates redact credentials and partial private keys before forming titles', () => {
  const body = `${token} was used while debugging. ${'Useful observations about the code. '.repeat(4)}`;
  const candidate = automaticSessionCandidate({ last_assistant_message: body }, {
    agent: 'codex', sessionId: token, sessionKey: sessionA,
  });
  assert.doesNotMatch(JSON.stringify(candidate), new RegExp(token, 'u'));
  assert.match(candidate.body, /REDACTED:github_token/u);
  assert.equal(candidate.sources[0].ref, `hnd-session:${sessionA}`);
  assert.deepEqual(scanSensitive(candidate), []);
  const key = '-----BEGIN PRIVATE KEY-----\nvery-private-material';
  assert.equal(redactSensitiveText(key).text, '[REDACTED:private_key]');
  assert.deepEqual(scanSensitive('-----BEGIN PUBLIC KEY-----\npublic-material'), []);
  assert.throws(() => exportKnowledge([{ body: token }]), { code: 'SENSITIVE_CONTENT' });
  assert.match(exportKnowledge([{ body: token }], { allowSensitive: true }), new RegExp(token, 'u'));
});

test('project and session collection policies intersect without weakening project exclusions', async (t) => {
  const options = await fixture(t);
  const defaults = await getPrivacyPolicy(options);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.retentionDays, null);
  assert.deepEqual(defaults.excludePaths, []);
  await setPrivacyPolicy({ ...options, policy: { excludePaths: ['**/.env*', 'private/**'], retentionDays: 30 } });
  await setPrivacyPolicy({
    ...options, sessionKey: sessionA, scope: 'session',
    policy: { excludePaths: ['logs/*.txt'], excludeSources: ['session'], retentionDays: 7 },
  });
  const policyA = await getPrivacyPolicy({ ...options, sessionKey: sessionA });
  const policyB = await getPrivacyPolicy({ ...options, sessionKey: sessionB });
  assert.equal(policyA.retentionDays, 7);
  assert.equal(policyB.retentionDays, 30);
  assert.equal(collectionAllowed({ policy: policyA, sourceKind: 'session' }), false);
  assert.equal(collectionAllowed({ policy: policyB, sourceKind: 'session' }), true);
  for (const relativePath of ['.env', 'nested/.env.local', 'private/credentials.json', 'logs/private.txt']) {
    assert.equal(collectionAllowed({ policy: policyA, sourceKind: 'file', relativePath }), false);
  }
  assert.equal(collectionAllowed({ policy: policyA, sourceKind: 'file', relativePath: 'src/app.js' }), true);
  await setPrivacyPolicy({ ...options, policy: { enabled: false } });
  await setPrivacyPolicy({ ...options, sessionKey: sessionA, scope: 'session', policy: { enabled: true } });
  assert.equal((await getPrivacyPolicy({ ...options, sessionKey: sessionA })).enabled, false);
});

test('collection policy rejects traversal, invalid durations, and anonymous session settings', async (t) => {
  const options = await fixture(t);
  for (const pattern of ['/etc/passwd', '../secret', 'src/../../private', 'C:/secret', 'src\\secret']) {
    await assert.rejects(setPrivacyPolicy({ ...options, policy: { excludePaths: [pattern] } }), { code: 'INVALID_PRIVACY_POLICY' });
  }
  for (const retentionDays of [0, -1, 1.5, '7', 36501]) {
    await assert.rejects(setPrivacyPolicy({ ...options, policy: { retentionDays } }), { code: 'INVALID_PRIVACY_POLICY' });
  }
  await assert.rejects(setPrivacyPolicy({ ...options, scope: 'session', policy: { enabled: false } }), { code: 'WORK_SESSION_REQUIRED' });
});

test('checkpoint capture and reread exclude private paths without leaking rename origins or commit credentials', async (t) => {
  const options = await fixture(t);
  await fs.writeFile(path.join(options.cwd, 'private.txt'), 'private\n');
  await git(options.cwd, 'add', 'private.txt');
  await git(options.cwd, 'commit', '-m', `credential accidentally committed: ${token}`);
  await git(options.cwd, 'mv', 'private.txt', 'renamed.txt');
  await fs.writeFile(path.join(options.cwd, '.env'), 'fixture only\n');
  await fs.writeFile(path.join(options.cwd, 'visible.txt'), 'visible\n');
  await setPrivacyPolicy({ ...options, policy: { excludePaths: ['.env', 'private.txt'] } });
  const captured = await captureCheckpoint({ ...options, sessionKey: sessionA, agent: 'codex' });
  assert.deepEqual(captured.checkpoint.changes.map((change) => change.path), ['visible.txt']);
  assert.equal(captured.checkpoint.totalChanges, 1);
  assert.equal(captured.checkpoint.sessionKey, sessionA);
  const bytes = await fs.readFile(captured.path, 'utf8');
  assert.doesNotMatch(bytes, /private\.txt|renamed\.txt|\.env/u);
  assert.doesNotMatch(bytes, new RegExp(token, 'u'));
  assert.match(bytes, /REDACTED:github_token/u);
  await setPrivacyPolicy({ ...options, policy: { excludePaths: ['.env', 'private.txt', 'visible.txt'] } });
  const reread = await getCheckpoint({ ...options, git: await detectGitCheckout(options.cwd) });
  assert.deepEqual(reread.changes, []);
  assert.equal(reread.dirty, false);
  await setPrivacyPolicy({ ...options, sessionKey: sessionA, scope: 'session', policy: { enabled: false } });
  assert.equal((await captureCheckpoint({ ...options, sessionKey: sessionA, agent: 'codex' })).skipped, true);
  assert.equal(await getCheckpoint({ ...options, sessionKey: sessionA, git: await detectGitCheckout(options.cwd) }), null);
});

async function retentionFixture(t) {
  const options = await fixture(t);
  const paths = statePaths(options.env);
  const repository = repositoryPaths(options.repoId, options.env);
  const clock = () => new Date('2026-09-07T00:00:00.000Z');
  const old = '2026-01-01T00:00:00.000Z';
  const candidateId = randomUUID();
  const otherSessionId = randomUUID();
  const manualId = randomUUID();
  const activeId = randomUUID();
  const archivedId = randomUUID();
  const checkpointId = 'c'.repeat(64);
  const base = { schemaVersion: 1, repoId: options.repoId, updatedAt: old };
  const candidate = { ...base, id: candidateId, state: 'review_needed', approval: 'pending',
    tags: ['session-suggestion'], sources: [{ kind: 'session', ref: `hnd-session:${sessionA}` }] };
  await writeJsonAtomic(path.join(paths.knowledge, `${candidateId}.json`), candidate);
  await writeJsonAtomic(path.join(paths.knowledge, `${otherSessionId}.json`), {
    ...candidate, id: otherSessionId, sources: [{ kind: 'session', ref: `hnd-session:${sessionB}` }],
  });
  await writeJsonAtomic(path.join(paths.knowledge, `${manualId}.json`), {
    ...candidate, id: manualId, state: 'verified', approval: 'approved', tags: [],
  });
  await writeJsonAtomic(path.join(repository.handoffs, `${activeId}.json`), { ...base, id: activeId, status: 'active' });
  await writeJsonAtomic(path.join(repository.archive, `${archivedId}.json`), {
    ...base, id: archivedId, status: 'closed', history: [{ sessionKey: sessionA }],
  });
  await writeJsonAtomic(path.join(repository.checkpoints, `${checkpointId}.json`), {
    ...base, key: checkpointId, capturedAt: old, sessionKey: sessionA,
  });
  return { ...options, clock, paths, repository, candidateId, otherSessionId, manualId, activeId, archivedId, checkpointId };
}

test('retention is preview-only by default and deletes only reviewed local eligible records', async (t) => {
  const options = await retentionFixture(t);
  assert.equal((await previewRetention(options)).count, 0);
  await setPrivacyPolicy({ ...options, policy: { retentionDays: 7 } });
  const preview = await previewRetention(options);
  assert.equal(preview.count, 4);
  assert.equal(preview.applied, false);
  assert.equal(preview.remoteCopiesDeleted, false);
  for (const item of preview.items) await fs.stat(path.join(options.paths.home, item.path));
  await assert.rejects(applyRetention(options), { code: 'RETENTION_PREVIEW_REQUIRED' });
  const applied = await applyRetention({ ...options, previewId: preview.previewId });
  assert.equal(applied.applied, true);
  assert.equal(applied.removed.length, 4);
  assert.equal((await previewRetention(options)).count, 0);
  await fs.stat(path.join(options.paths.knowledge, `${options.manualId}.json`));
  await fs.stat(path.join(options.repository.handoffs, `${options.activeId}.json`));
});

test('session retention preserves peers, rejects changed previews, and never traverses a symlink', async (t) => {
  const options = await retentionFixture(t);
  await setPrivacyPolicy({ ...options, policy: { retentionDays: 7 } });
  const sessionOptions = { ...options, sessionKey: sessionA };
  const preview = await previewRetention(sessionOptions);
  assert.equal(preview.count, 3);
  assert.equal(preview.items.some((item) => item.id === options.otherSessionId), false);
  const checkpoint = path.join(options.repository.checkpoints, `${options.checkpointId}.json`);
  const value = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
  await writeJsonAtomic(checkpoint, { ...value, capturedAt: '2026-09-07T00:00:00.000Z' });
  await assert.rejects(applyRetention({ ...sessionOptions, previewId: preview.previewId }), { code: 'RETENTION_PREVIEW_STALE' });
  await fs.stat(path.join(options.paths.knowledge, `${options.candidateId}.json`));
  const outside = path.join(options.root, 'outside');
  await fs.rename(options.repository.archive, outside);
  await fs.symlink(outside, options.repository.archive, 'dir');
  await assert.rejects(previewRetention(options), { code: 'UNSAFE_STATE_PATH' });
  await fs.stat(path.join(outside, `${options.archivedId}.json`));
});

test('retention preserves completed prerequisites and knowledge still referenced by other records', async (t) => {
  const options = await retentionFixture(t);
  await setPrivacyPolicy({ ...options, policy: { retentionDays: 7 } });
  const activeFile = path.join(options.repository.handoffs, `${options.activeId}.json`);
  const active = JSON.parse(await fs.readFile(activeFile, 'utf8'));
  await writeJsonAtomic(activeFile, { ...active, dependencies: [options.archivedId] });
  const manualFile = path.join(options.paths.knowledge, `${options.manualId}.json`);
  const manual = JSON.parse(await fs.readFile(manualFile, 'utf8'));
  await writeJsonAtomic(manualFile, { ...manual, relationships: [{ type: 'related', targetId: options.candidateId }] });
  const preview = await previewRetention(options);
  assert.equal(preview.count, 2);
  assert.equal(preview.items.some((item) => item.id === options.archivedId || item.id === options.candidateId), false);
});

test('retention refuses partially recovered knowledge state without deleting anything', async (t) => {
  const options = await retentionFixture(t);
  await setPrivacyPolicy({ ...options, policy: { retentionDays: 7 } });
  await writeJsonAtomic(path.join(options.paths.cache, 'knowledge-merge-journal.json'), { interrupted: true });
  await assert.rejects(previewRetention(options), { code: 'STATE_RECOVERY_REQUIRED' });
  await fs.stat(path.join(options.paths.knowledge, `${options.candidateId}.json`));
  await fs.stat(path.join(options.repository.archive, `${options.archivedId}.json`));
});

test('a retention preview cannot authorize deletion from a cloned state home', async (t) => {
  const options = await retentionFixture(t);
  await setPrivacyPolicy({ ...options, policy: { retentionDays: 7 } });
  const preview = await previewRetention(options);
  const cloneHome = path.join(options.root, 'cloned-state');
  await fs.cp(options.paths.home, cloneHome, { recursive: true });
  const cloneOptions = { ...options, env: { ...options.env, HND_HOME: cloneHome } };
  const clonePreview = await previewRetention(cloneOptions);
  assert.equal(clonePreview.count, preview.count);
  assert.deepEqual(clonePreview.items, preview.items);
  assert.notEqual(clonePreview.previewId, preview.previewId);
  await assert.rejects(applyRetention({ ...cloneOptions, previewId: preview.previewId }), { code: 'RETENTION_PREVIEW_STALE' });
  await fs.stat(path.join(cloneHome, 'knowledge', `${options.candidateId}.json`));
});

test('retention waits for index users and invalidates plaintext/vector caches including SQLite sidecars', async (t) => {
  const options = await retentionFixture(t);
  await setPrivacyPolicy({ ...options, policy: { retentionDays: 7 } });
  const sensitiveBody = 'private draft text that must not survive in the local search index';
  searchKnowledgeIndex({
    entries: [{ id: options.candidateId, title: 'Draft', body: sensitiveBody, tags: [], updatedAt: '2026-01-01' }],
    query: 'private', env: options.env,
  });
  const indexFile = path.join(options.paths.cache, 'knowledge-fts.sqlite');
  assert.equal((await fs.readFile(indexFile)).includes(Buffer.from(sensitiveBody)), true);
  // searchKnowledgeIndex closed its synchronous SQLite handle before return.
  // Model sidecars left behind after a previous unclean process shutdown.
  await fs.writeFile(`${indexFile}-wal`, 'old journal');
  await fs.writeFile(`${indexFile}-shm`, 'old shared memory');
  await writeJsonAtomic(path.join(options.paths.cache, 'knowledge-vectors.json'), { old: true });
  await writeJsonAtomic(path.join(options.paths.cache, 'semantic-search-config.json'), { preserved: true });
  const preview = await previewRetention(options);
  assert.equal(preview.cacheInvalidation.length, 4);
  let applying;
  await withFileLock(path.join(options.paths.locks, 'knowledge.lock'), async () => {
    applying = applyRetention({ ...options, previewId: preview.previewId });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await fs.stat(indexFile);
    await fs.stat(path.join(options.paths.knowledge, `${options.candidateId}.json`));
  });
  const result = await applying;
  assert.deepEqual(result.invalidatedCaches, preview.cacheInvalidation);
  assert.match(result.warning, /not secure erasure/u);
  for (const relativePath of preview.cacheInvalidation) {
    await assert.rejects(fs.stat(path.join(options.paths.home, relativePath)), { code: 'ENOENT' });
  }
  await fs.stat(path.join(options.paths.cache, 'semantic-search-config.json'));
});

test('unsafe derived-cache paths fail before retention deletes any source record', async (t) => {
  const options = await retentionFixture(t);
  await setPrivacyPolicy({ ...options, policy: { retentionDays: 7 } });
  const outside = path.join(options.root, 'outside-cache');
  await fs.writeFile(outside, 'outside must remain');
  await fs.symlink(outside, path.join(options.paths.cache, 'knowledge-fts.sqlite-wal'));
  const preview = await previewRetention(options);
  await assert.rejects(applyRetention({ ...options, previewId: preview.previewId }), { code: 'UNSAFE_STATE_PATH' });
  await fs.stat(path.join(options.paths.knowledge, `${options.candidateId}.json`));
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside must remain');
});

test('automatic suggestions honor opt-in and deduplicate concurrent project candidates', async (t) => {
  const options = await fixture(t);
  const coreA = createCore({ ...options, sessionKey: sessionA, agent: 'codex' });
  const coreB = createCore({ ...options, sessionKey: sessionB, agent: 'codex' });
  const payload = { last_assistant_message: 'Decision: use one shared knowledge record for identical session observations. This draft must remain pending until a person reviews it.' };
  assert.equal(await coreA.auto.suggest({ payload }), null);
  assert.equal((await coreA.knowledge.list({ scope: 'repo', approval: 'pending' })).length, 0);
  await coreA.config.update({ knowledgeSuggestions: true });
  const results = await Promise.all([
    coreA.auto.suggest({ payload }), coreB.auto.suggest({ payload }), coreA.auto.suggest({ payload }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  const pending = await coreA.knowledge.list({ scope: 'repo', approval: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].history.at(-1).actor, 'hook');
  assert.equal(pending[0].history.at(-1).agent, 'codex');
});

test('automatic suggestion provenance cannot override the bound session collection policy', async (t) => {
  const options = await fixture(t);
  const core = createCore({ ...options, sessionKey: sessionA, agent: 'codex' });
  const payload = { last_assistant_message: 'Decision: source transcript identifiers only describe provenance. They must not replace the agent identity used for collection opt-out checks.' };
  await core.config.update({ knowledgeSuggestions: true });
  await core.privacy.set({ scope: 'session', policy: { enabled: false } });
  assert.equal(await core.auto.suggest({ payload, sourceSessionId: 'another-raw-session' }), null);
  assert.equal((await core.knowledge.list({ scope: 'repo', approval: 'pending' })).length, 0);
  await core.privacy.set({ scope: 'session', policy: { enabled: true } });
  const saved = await core.auto.suggest({ payload, sourceSessionId: 'another-raw-session' });
  assert.equal(saved.sources[0].ref, `hnd-session:${sessionA}`);
  assert.equal(saved.sources[0].label, 'codex');
});

test('collection opt-out cannot complete between an automatic policy check and its saved candidate', async (t) => {
  const options = await fixture(t);
  const core = createCore({ ...options, sessionKey: sessionA, agent: 'codex' });
  await core.config.update({ knowledgeSuggestions: true });
  const payload = { last_assistant_message: 'Decision: serialize the automatic collection gate and durable write with privacy settings. An opt-out that has completed must prevent later candidate writes.' };
  const originalOpen = fs.open;
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  let paused = false;
  let saving;
  let disabling;
  let disabled = false;
  fs.open = async function pauseCandidateWrite(file, ...args) {
    if (!paused && typeof file === 'string'
      && file.startsWith(`${statePaths(options.env).knowledge}${path.sep}`) && file.endsWith('.tmp')) {
      paused = true;
      reached.resolve();
      await release.promise;
    }
    return originalOpen.call(this, file, ...args);
  };
  try {
    saving = core.auto.suggest({ payload });
    saving.catch((error) => reached.reject(error));
    await reached.promise;
    disabling = core.privacy.set({ scope: 'session', policy: { enabled: false } }).then((value) => {
      disabled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(disabled, false);
    release.resolve();
    assert.ok(await saving);
    await disabling;
    assert.equal(disabled, true);
    assert.equal(await core.auto.suggest({ payload: { last_assistant_message: `${payload.last_assistant_message} A new observation.` } }), null);
  } finally {
    release.resolve();
    fs.open = originalOpen;
    await Promise.allSettled([saving, disabling].filter(Boolean));
  }
});
