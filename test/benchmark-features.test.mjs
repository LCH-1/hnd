import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';

import { createCore } from '../src/core/index.mjs';
import { exportKnowledge, importKnowledgeFile } from '../src/core/knowledge-transfer.mjs';
import { main } from '../src/cli.mjs';

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-benchmark-features-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'project');
  await fs.mkdir(repository);
  await execFileAsync('git', ['-C', repository, 'init', '--quiet']);
  await execFileAsync('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid']);
  await execFileAsync('git', ['-C', repository, 'config', 'user.name', 'hnd test']);
  await fs.writeFile(path.join(repository, 'README.md'), '# fixture\n');
  await execFileAsync('git', ['-C', repository, 'add', 'README.md']);
  await execFileAsync('git', ['-C', repository, 'commit', '-m', 'initial']);
  const env = {
    ...process.env,
    HND_HOME: path.join(root, 'state'),
    HND_USER_HOME: path.join(root, 'user'),
  };
  const clock = () => new Date('2026-09-04T00:00:00.000Z');
  return { root, repository, env, clock, core: createCore({ env, cwd: repository, clock }) };
}

test('knowledge is typed, review-gated, indexed, and selected without injecting the whole vault', async (t) => {
  const { core } = await fixture(t);
  await core.repo.register();
  await core.env.set('prod');

  const pinned = await core.knowledge.add({
    title: 'Production safety',
    body: 'Always verify the backup before deployment.',
    type: 'caution',
    pinned: true,
    sources: [{ kind: 'file', ref: 'README.md', label: 'README' }],
  });
  const relevant = await core.knowledge.add({
    title: 'Refresh token rotation',
    body: 'Allow a five minute overlap during token rotation.',
    type: 'decision',
    scope: 'env',
    approval: 'approved',
  });
  const pending = await core.knowledge.add({
    title: 'Unreviewed token claim',
    body: 'This suggestion must not reach an agent yet.',
    scope: 'repo',
    approval: 'pending',
    state: 'review_needed',
  });

  const selected = await core.knowledge.relevant({
    query: 'refresh token rotation',
    repoId: relevant.repoId,
    environment: 'prod',
  });
  assert.deepEqual(selected.map((entry) => entry.id), [pinned.id, relevant.id]);
  assert.ok(selected.every((entry) => entry.id !== pending.id));

  // The fixed clock deliberately keeps updatedAt unchanged and verifies that
  // the derived FTS index fingerprints actual searchable content.
  await core.knowledge.update({ id: relevant.id, body: 'Use rotating nonce zebra-signal.' });
  assert.deepEqual(
    (await core.knowledge.search({ query: 'zebra-signal' })).map((entry) => entry.id),
    [relevant.id],
  );

  const composed = await core.compose({
    knowledgeQuery: 'Please inspect an unrelated controller and remember the refresh token zebra-signal decision.',
  });
  assert.match(composed.content, /Production safety/u);
  assert.match(composed.content, /rotating nonce zebra-signal/u);
  assert.doesNotMatch(composed.content, /Unreviewed token claim/u);
  assert.equal((await core.knowledge.get({ id: relevant.id })).history.at(-1).actor, 'cli');
});

test('knowledge exports round-trip as JSON, Markdown, and portable OKF-shaped records', async (t) => {
  const { core, repository, env } = await fixture(t);
  const entry = await core.knowledge.add({
    title: 'Database recovery',
    body: 'Restore into a new database and verify checksums.',
    type: 'runbook',
    tags: ['database', 'recovery'],
  });

  for (const format of ['json', 'markdown', 'okf']) {
    const exported = exportKnowledge([entry], { format, project: 'fixture' });
    const imported = importKnowledgeFile(`knowledge.${format}`, exported);
    assert.equal(imported.length, 1);
    assert.equal(imported[0].title, entry.title);
    assert.equal(imported[0].approval, 'pending');
    assert.equal(imported[0].state, 'review_needed');
  }

  let output = '';
  await main(['know', 'import', 'README.md', '--apply', '--scope', 'repo', '--json'], {
    env,
    cwd: repository,
    stdin: Readable.from([]),
    stdout: { write(chunk) { output += String(chunk); } },
    stderr: { write() {} },
  });
  const imported = JSON.parse(output);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].approval, 'pending');
  assert.equal(imported[0].sources[0].ref, 'README.md');
});

test('work dependencies, blocking, claims, hierarchy, and audit produce a ready queue', async (t) => {
  const { core } = await fixture(t);
  await core.repo.register();
  const prerequisite = await core.handoff.start({
    task: 'schema',
    objective: 'Prepare the schema',
    priority: 'high',
  });
  const dependent = await core.handoff.start({
    task: 'api',
    objective: 'Build the API',
    dependencies: [prerequisite.id],
    parentId: prerequisite.id,
    claimedBy: 'codex-session',
  });

  let listed = await core.handoff.list({ status: 'active' });
  assert.equal(listed.find((item) => item.id === dependent.id).ready, false);
  assert.equal(listed.find((item) => item.id === dependent.id).claimedBy, 'codex-session');

  await core.handoff.update({
    id: dependent.id,
    workflowStatus: 'blocked',
    blockedReason: 'Waiting for credentials',
    unblockCriteria: 'A test credential is issued',
  });
  assert.equal((await core.handoff.show({ id: dependent.id })).workflowStatus, 'blocked');

  await core.handoff.close({ id: prerequisite.id });
  await core.handoff.update({
    id: dependent.id,
    workflowStatus: 'in_progress',
    blockedReason: '',
    unblockCriteria: '',
  });
  listed = await core.handoff.list({ status: 'active' });
  const ready = listed.find((item) => item.id === dependent.id);
  assert.equal(ready.ready, true);
  assert.equal(ready.history.at(-1).actor, 'cli');
});

test('named rules respect draft, manual, path, and environment activation', async (t) => {
  const { core } = await fixture(t);
  await core.repo.register();
  await core.env.set('prod');
  const pathRule = await core.ruleRecord.add({
    title: 'Auth boundary',
    content: 'AUTH-PATH-RULE',
    scope: 'env',
    status: 'draft',
    paths: ['src/auth/**'],
  });
  const manualRule = await core.ruleRecord.add({
    title: 'Release checklist',
    content: 'MANUAL-RELEASE-RULE',
    scope: 'repo',
    activation: 'manual',
  });

  let composed = await core.compose({ knowledgeQuery: 'edit src/auth/token.mjs' });
  assert.doesNotMatch(composed.content, /AUTH-PATH-RULE|MANUAL-RELEASE-RULE/u);

  await core.ruleRecord.update({ id: pathRule.id, patch: { status: 'active' } });
  composed = await core.compose({ knowledgeQuery: 'edit src/public/page.mjs' });
  assert.doesNotMatch(composed.content, /AUTH-PATH-RULE/u);
  composed = await core.compose({ knowledgeQuery: 'edit src/auth/token.mjs' });
  assert.match(composed.content, /AUTH-PATH-RULE/u);
  assert.doesNotMatch(composed.content, /MANUAL-RELEASE-RULE/u);

  await core.ruleRecord.invoke(manualRule.id, true);
  composed = await core.compose({ knowledgeQuery: 'prepare release' });
  assert.match(composed.content, /MANUAL-RELEASE-RULE/u);
  assert.equal((await core.ruleRecord.list()).find((item) => item.id === pathRule.id).history.at(-1).actor, 'cli');
});

test('opt-in Claude PreCompact stores only a review candidate and never injects it', async (t) => {
  const { core, repository, env } = await fixture(t);
  await core.repo.register();
  await core.config.update({ knowledgeSuggestions: true });
  await core.auto.set(false);
  await core.sync.set(false);
  let stderr = '';
  const body = 'Decision: keep the refresh-token overlap at five minutes because retrying clients may race during rotation. This needs review.';
  await main(['hook', 'claude', 'precompact'], {
    env,
    cwd: repository,
    stdin: Readable.from([JSON.stringify({
      session_id: 'session-precompact',
      cwd: repository,
      last_assistant_message: body,
    })]),
    stdout: { write() {} },
    stderr: { write(chunk) { stderr += String(chunk); } },
  });
  const pending = await core.knowledge.list({ approval: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sources[0].ref, 'session-precompact');
  assert.match(stderr, /knowledge candidate/u);
  assert.doesNotMatch((await core.compose({ knowledgeQuery: 'refresh token' })).content, /five minutes/u);
});
