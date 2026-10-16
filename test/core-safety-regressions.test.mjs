import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createCore } from '../src/core/index.mjs';
import { assessKnowledgeFreshness, knowledgeMergeJournalPath } from '../src/core/knowledge.mjs';
import { statePaths, repositoryPaths } from '../src/paths.mjs';

function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
async function checkout(cwd, contents = 'original') {
  await fs.mkdir(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'safety@example.invalid');
  git(cwd, 'config', 'user.name', 'hnd safety');
  await fs.writeFile(path.join(cwd, 'README.md'), contents);
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', contents);
  git(cwd, 'remote', 'add', 'origin', 'https://example.invalid/' + contents + '.git');
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-core-safety-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); await checkout(cwd);
  const env = { ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user') };
  const core = createCore({ cwd, env, sessionKey: null });
  await core.repo.init();
  return { root, cwd, env, core };
}

test('reusing a registered path never delivers or learns an unrelated repository identity', async (t) => {
  const { root, cwd, env, core } = await fixture(t);
  const original = (await core.repo.resolve()).repository;
  await core.policy.set({ scope: 'repo', content: 'PRIVATE ORIGINAL POLICY' });
  await fs.rename(cwd, path.join(root, 'previous'));
  await checkout(cwd, 'unrelated');
  await assert.rejects(core.repo.binding(), { code: 'REPOSITORY_NOT_REGISTERED' });
  await assert.rejects(core.repo.resolve({ create: false }), { code: 'REPOSITORY_LINK_REQUIRED' });
  await assert.rejects(core.compose(), { code: 'REPOSITORY_LINK_REQUIRED' });
  assert.deepEqual((await core.repo.get(original.id)).remoteAliases, original.remoteAliases);
  const bindingFile = path.join(env.HND_HOME, 'bindings.json');
  const bindings = JSON.parse(await fs.readFile(bindingFile, 'utf8'));
  delete bindings.bindings[cwd].gitDirectoryIdentity;
  await fs.writeFile(bindingFile, JSON.stringify(bindings));
  await assert.rejects(core.repo.binding({ rememberGitIdentity: true }), { code: 'REPOSITORY_LINK_REQUIRED' });
});

test('an explicitly resolved replacement clone with matching remote and history can refresh its local identity', async (t) => {
  const { root, cwd, core } = await fixture(t);
  const id = (await core.repo.resolve()).repository.id;
  const moved = path.join(root, 'previous'); await fs.rename(cwd, moved);
  execFileSync('git', ['clone', '-q', moved, cwd]);
  git(cwd, 'remote', 'set-url', 'origin', 'https://example.invalid/original.git');
  await assert.rejects(core.repo.binding(), { code: 'REPOSITORY_NOT_REGISTERED' });
  assert.equal((await core.repo.resolve()).repository.id, id);
  assert.equal((await core.repo.binding()).repository.id, id);
});

test('named rule add, activation, edit, and manual invocation reject an oversized effective context atomically', async (t) => {
  const { core } = await fixture(t);
  await core.ruleRecord.add({ title: 'first', content: 'a'.repeat(16_000), scope: 'global' });
  await assert.rejects(core.ruleRecord.add({ title: 'second', content: 'b'.repeat(16_000), scope: 'global' }), { code: 'CONTEXT_TOO_LARGE' });
  const draft = await core.ruleRecord.add({ title: 'draft', content: 'b'.repeat(16_000), scope: 'global', status: 'draft' });
  await assert.rejects(core.ruleRecord.update({ id: draft.id, patch: { status: 'active' } }), { code: 'CONTEXT_TOO_LARGE' });
  assert.equal((await core.ruleRecord.list()).find((record) => record.id === draft.id).status, 'draft');
  const manual = await core.ruleRecord.add({ title: 'manual', content: 'b'.repeat(16_000), scope: 'global', activation: 'manual' });
  await assert.rejects(core.ruleRecord.invoke(manual.id), { code: 'CONTEXT_TOO_LARGE' });
  assert.equal((await core.config.get()).manualRules.includes(manual.id), false);
  assert.equal((await core.compose()).bytes < 32_768, true);
});

test('rule preflight checks other registered projects and multibyte content', async (t) => {
  const { core, env, root } = await fixture(t);
  const other = path.join(root, 'other'); await checkout(other, 'other');
  const otherCore = createCore({ cwd: other, env, sessionKey: null });
  await otherCore.repo.init();
  await otherCore.policy.set({ scope: 'repo', content: 'x'.repeat(20_000) });
  await assert.rejects(core.ruleRecord.add({ title: 'global', scope: 'global', content: '한'.repeat(5_000) }), { code: 'CONTEXT_TOO_LARGE' });
  assert.equal((await core.ruleRecord.list()).length, 0);
});

test('freshness never follows outside symlinks, blocks on FIFOs, or reads oversized files', async (t) => {
  const { root, cwd } = await fixture(t);
  const text = 'outside source'; const hash = createHash('sha256').update(text).digest('hex');
  await fs.writeFile(path.join(root, 'outside.txt'), text);
  await fs.symlink('../outside.txt', path.join(cwd, 'source.txt'));
  const entry = { sources: [{ kind: 'file', ref: 'source.txt', hash }] };
  assert.equal((await assessKnowledgeFreshness(entry, { root: cwd })).freshness, 'review_needed');
  await fs.unlink(path.join(cwd, 'source.txt'));
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [path.join(cwd, 'source.txt')]);
    const started = Date.now();
    assert.equal((await assessKnowledgeFreshness(entry, { root: cwd })).freshness, 'unknown');
    assert.equal(Date.now() - started < 500, true);
    await fs.unlink(path.join(cwd, 'source.txt'));
  }
  await fs.writeFile(path.join(cwd, 'source.txt'), Buffer.alloc(1024 * 1024 + 1));
  assert.equal((await assessKnowledgeFreshness(entry, { root: cwd })).freshness, 'unknown');
  await fs.writeFile(path.join(cwd, 'source.txt'), text);
  assert.equal((await assessKnowledgeFreshness(entry, { root: cwd })).freshness, 'current');
});

test('freshness inspection releases the shared state lock and respects its own elapsed budget', async (t) => {
  const { cwd, core } = await fixture(t);
  const text = 'source'; await fs.writeFile(path.join(cwd, 'source.txt'), text);
  await core.knowledge.add({ title: 'pinned', body: 'reference', pinned: true,
    sources: [{ kind: 'file', ref: 'source.txt', hash: createHash('sha256').update(text).digest('hex') }] });
  const originalRealpath = fs.realpath; let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  let release; const held = new Promise((resolve) => { release = resolve; });
  fs.realpath = async (file, ...args) => {
    if (file === path.join(cwd, 'source.txt')) { entered(); await held; }
    return originalRealpath(file, ...args);
  };
  try {
    const composing = core.compose(); await ready;
    await core.config.get();
    const composed = await composing;
    assert.equal(composed.layers.some((layer) => layer.kind === 'knowledge'), true);
  } finally { release(); fs.realpath = originalRealpath; }
});

test('a failed close is recovered before any further work mutation or read', async (t) => {
  const { core, env } = await fixture(t);
  const work = await core.handoff.start({ task: 'closure', objective: 'preserve progress', currentState: 'complete' });
  const active = path.join(repositoryPaths(work.repoId, env).handoffs, work.id + '.json');
  const originalUnlink = fs.unlink;
  fs.unlink = async (file) => { if (file === active) throw Object.assign(new Error('injected interruption'), { code: 'EIO' }); return originalUnlink(file); };
  try { await assert.rejects(core.handoff.close({ id: work.id }), { code: 'EIO' }); }
  finally { fs.unlink = originalUnlink; }
  const shown = await core.handoff.show({ id: work.id });
  assert.equal(shown.status, 'closed');
  await assert.rejects(core.handoff.update({ id: work.id, currentState: 'must not disappear' }), { code: 'HANDOFF_NOT_FOUND' });
  assert.equal((await core.handoff.list({ status: 'all' })).find((record) => record.id === work.id).status, 'closed');
});

test('legacy duplicate active/archive state blocks writes instead of hiding acknowledged progress', async (t) => {
  const { core, env } = await fixture(t);
  const work = await core.handoff.start({ task: 'legacy closure', objective: 'preserve both copies' });
  const paths = repositoryPaths(work.repoId, env);
  const source = JSON.parse(await fs.readFile(path.join(paths.handoffs, work.id + '.json'), 'utf8'));
  await fs.writeFile(path.join(paths.archive, work.id + '.json'), JSON.stringify({ ...source, status: 'closed' }));
  await assert.rejects(core.handoff.update({ id: work.id, currentState: 'new progress' }), { code: 'STATE_RECOVERY_REQUIRED' });
  await assert.rejects(core.handoff.show({ id: work.id }), { code: 'STATE_RECOVERY_REQUIRED' });
});

test('retention detects the actual interrupted knowledge transaction journal before deleting records', async (t) => {
  const { core, env } = await fixture(t);
  await core.privacy.set({ policy: { retentionDays: 1 } });
  await fs.writeFile(knowledgeMergeJournalPath(statePaths(env)), JSON.stringify({ interrupted: true }));
  await assert.rejects(core.privacy.preview(), { code: 'STATE_RECOVERY_REQUIRED' });
});

test('Git child helpers cannot outlive the core execution deadline or retain its state lock', { skip: process.platform === 'win32' }, async (t) => {
  const { root, cwd, env, core } = await fixture(t);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = path.join(root, 'slow-bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'git'), '#!/bin/sh\nsleep 1\nexec ' + realGit + ' "$@"\n', { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + previousPath;
  const started = Date.now();
  try {
    const limited = createCore({ env, cwd, sessionKey: null, lockDeadlineAt: Date.now() + 100 });
    await assert.rejects(limited.repo.binding(), (error) => ['GIT_TIMEOUT', 'OPERATION_DEADLINE_EXCEEDED'].includes(error.code));
    assert.equal(Date.now() - started < 600, true, 'the sleep helper kept the subprocess pipes open after its deadline');
    await core.config.get();
  } finally { process.env.PATH = previousPath; }
});

test('closure journal recovers an archive write failure and explicit close retries are idempotent', async (t) => {
  const { core, env } = await fixture(t);
  const work = await core.handoff.start({ task: 'archive failure', objective: 'recover before publication' });
  const archive = path.join(repositoryPaths(work.repoId, env).archive, work.id + '.json');
  const rename = fs.rename;
  fs.rename = async (source, target) => { if (target === archive) throw Object.assign(new Error('injected archive interruption'), { code: 'EIO' }); return rename(source, target); };
  try { await assert.rejects(core.handoff.close({ id: work.id }), { code: 'EIO' }); }
  finally { fs.rename = rename; }
  const retried = await core.handoff.close({ id: work.id });
  assert.equal(retried.status, 'closed');
  assert.equal(retried.alreadyClosed, true);
  assert.equal((await core.handoff.close({ id: work.id })).alreadyClosed, true);
});

test('global rule preflight includes environments represented only by named rules', async (t) => {
  const { core } = await fixture(t);
  await core.ruleRecord.add({ title: 'unselected environment', scope: 'env', environment: 'hidden', content: 'x'.repeat(16_000) });
  assert.notEqual(await core.env.get(), 'hidden');
  await assert.rejects(core.ruleRecord.add({ title: 'global', scope: 'global', content: 'y'.repeat(16_000) }), { code: 'CONTEXT_TOO_LARGE' });
  assert.equal((await core.ruleRecord.list()).length, 1);
});

test('pure policy budget matches the live mandatory renderer while excluding inactive scopes and manual rules', async (t) => {
  const { core } = await fixture(t);
  const { validatePolicyContextBudget } = await import('../src/core/compose.mjs');
  const repository = (await core.repo.resolve()).repository;
  await core.env.set('prod');
  const policies = { global: 'global policy', repo: 'repository policy', env: 'production policy', local: 'private local policy' };
  for (const scope of ['global', 'repo', 'env', 'local']) await core.policy.set({ scope, content: policies[scope] });
  await core.ruleRecord.add({ title: 'SQL', scope: 'repo', content: 'check schema', paths: ['database/**'] });
  await core.ruleRecord.add({ title: 'manual', scope: 'global', content: 'inactive manual', activation: 'manual' });
  await core.ruleRecord.add({ title: 'production', scope: 'env', environment: 'prod', content: 'production safety' });
  const records = await core.ruleRecord.list();
  const config = await core.config.get();
  const context = await core.compose();
  const budget = validatePolicyContextBudget({ repository, environment: 'prod', policies, records, config, appSettings: config });
  assert.equal(budget.bytes, context.bytes);
  const inactive = records.find((entry) => entry.activation === 'manual');
  const extra = { ...inactive, id: '44444444-4444-4444-8444-444444444444', scope: 'env', repoId: repository.id,
    environment: 'other', activation: 'always', content: 'x'.repeat(100_000) };
  assert.equal(validatePolicyContextBudget({ repository, environment: 'prod', policies, records: [...records, extra], config, appSettings: config }).bytes, context.bytes);
  assert.throws(() => validatePolicyContextBudget({ repository, environment: 'prod', policies, records,
    config, appSettings: config, maxBytes: budget.bytes - 1 }), { code: 'CONTEXT_TOO_LARGE' });
});

test('knowledge history growth rejects the first unsyncable update without discarding content or audit entries', async (t) => {
  const { core, env } = await fixture(t);
  const note = await core.knowledge.add({ title: 'long reference', body: 'x'.repeat(90_000) });
  const file = path.join(env.HND_HOME, 'knowledge', note.id + '.json');
  let rejected = false;
  for (let index = 0; index < 15; index += 1) {
    const before = await fs.readFile(file, 'utf8');
    try { await core.knowledge.update({ id: note.id, body: 'x'.repeat(90_000) + index }); }
    catch (error) {
      assert.equal(error.code, 'KNOWLEDGE_TOO_LARGE');
      assert.equal(await fs.readFile(file, 'utf8'), before);
      rejected = true; break;
    }
  }
  assert.equal(rejected, true);
  const { captureSyncSnapshot } = await import('../src/sync/capture.mjs');
  await captureSyncSnapshot(env.HND_HOME);
  await assert.rejects(core.knowledge.add({ title: 'escaped body', body: '\u0001'.repeat(180_000) }), { code: 'KNOWLEDGE_TOO_LARGE' });
});

test('rule audit growth measures actual escaped JSON bytes and rejects atomically', async (t) => {
  const { core, env } = await fixture(t);
  const record = await core.ruleRecord.add({ title: 'long draft', content: '\u0001'.repeat(16_000), status: 'draft' });
  const file = path.join(env.HND_HOME, 'rules', record.id + '.json');
  let rejected = false;
  for (let index = 0; index < 15; index += 1) {
    const before = await fs.readFile(file, 'utf8');
    try { await core.ruleRecord.update({ id: record.id, patch: { title: 'draft ' + index } }); }
    catch (error) {
      assert.equal(error.code, 'RULE_RECORD_TOO_LARGE');
      assert.equal(await fs.readFile(file, 'utf8'), before);
      rejected = true; break;
    }
  }
  assert.equal(rejected, true);
});

test('oversized knowledge merge and adoption fail before publishing their transaction journal', async (t) => {
  const { core, env } = await fixture(t);
  const target = await core.knowledge.add({ title: 'long target', body: 'x'.repeat(180_000) });
  for (let index = 0; index < 4; index += 1) await core.knowledge.update({ id: target.id, body: 'x'.repeat(180_000) + index });
  const source = await core.knowledge.add({ title: 'source', body: 'xxx' });
  const file = path.join(env.HND_HOME, 'knowledge', target.id + '.json');
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(core.knowledge.merge({ targetId: target.id, sourceId: source.id }), { code: 'KNOWLEDGE_TOO_LARGE' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await assert.rejects(fs.access(knowledgeMergeJournalPath(statePaths(env))), { code: 'ENOENT' });
  const work = await core.handoff.start({ task: 'large experiment', objective: 'preserve proposal history' });
  const { entry } = await core.knowledge.branch.create({ name: 'large', workId: work.id, title: 'large proposal', body: 'x'.repeat(180_000) });
  for (let index = 0; index < 4; index += 1) await core.knowledge.update({ id: entry.id, body: 'x'.repeat(180_000) + index });
  const diff = await core.knowledge.branch.diff({ id: entry.id });
  await assert.rejects(core.knowledge.branch.adopt({ id: entry.id, expectedRevision: diff.revision }), { code: 'KNOWLEDGE_TOO_LARGE' });
  assert.equal((await core.knowledge.get({ id: entry.id })).state, 'review_needed');
  await assert.rejects(fs.access(knowledgeMergeJournalPath(statePaths(env))), { code: 'ENOENT' });
});

test('large checkpoint path matches never expand a mandatory rule beyond its preflight budget', async (t) => {
  const { core } = await fixture(t);
  await core.ruleRecord.add({ title: 'JavaScript safety', scope: 'global', content: 'Check changed JavaScript', paths: ['**/*.js'] });
  const paths = Array.from({ length: 450 }, (_, index) => 'src/' + 'long-directory-'.repeat(20) + '/' + index + '.js');
  await core.auto.capture({ agent: 'codex', inspectGit: async () => ({ branch: 'main', head: null,
    lastCommit: '', dirty: true, totalChanges: paths.length, truncated: false,
    changes: paths.map((file) => ({ code: ' M', path: file })) }) });
  const context = await core.compose();
  const layer = context.layers.find((entry) => entry.ruleId);
  assert.match(layer.content, /paths matching: \*\*\/\*\.js/u);
  assert.equal(layer.content.length < 200, true);
  assert.equal(context.bytes < 32_768, true);
});

test('work audit growth cannot make a previously syncable record exceed the per-file limit', async (t) => {
  const { core, env } = await fixture(t);
  const work = await core.handoff.start({ task: 'long work metadata', objective: 'preserve audit',
    plannedFiles: Array.from({ length: 40 }, (_, index) => 'src/' + 'dir/'.repeat(98) + index + '.js'),
    blockedReason: 'x'.repeat(4_000), unblockCriteria: 'y'.repeat(4_000) });
  const file = path.join(repositoryPaths(work.repoId, env).handoffs, work.id + '.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  const before = Object.fromEntries(['priority', 'workflowStatus', 'dependencies', 'parentId', 'claimedBy',
    'claimExpiresAt', 'claimSessionKey', 'blockedReason', 'unblockCriteria', 'plannedFiles'].map((key) => [key, record[key]]));
  const audit = { at: record.updatedAt, action: 'updated', actor: 'legacy', agent: null, sessionId: null, sessionKey: null, before };
  while (record.history.length < 50) {
    record.history.push(audit);
    if (Buffer.byteLength(JSON.stringify(record, null, 2) + '\n') > 1024 * 1024) { record.history.pop(); break; }
  }
  assert.equal(record.history.length < 50, true);
  const previous = JSON.stringify(record, null, 2) + '\n';
  await fs.writeFile(file, previous);
  await assert.rejects(core.handoff.update({ id: work.id, currentState: 'must not poison sync' }), { code: 'HANDOFF_TOO_LARGE' });
  assert.equal(await fs.readFile(file, 'utf8'), previous);
  const { captureSyncSnapshot } = await import('../src/sync/capture.mjs');
  await captureSyncSnapshot(env.HND_HOME);
});
