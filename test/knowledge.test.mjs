import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { createCore } from '../src/core/index.mjs';
import { mergeKnowledge } from '../src/core/knowledge.mjs';
import { captureSyncSnapshot, validateSyncSnapshot } from '../src/sync/capture.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-knowledge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    env: {
      ...process.env,
      HND_HOME: path.join(root, 'state'),
      HND_USER_HOME: path.join(root, 'user'),
    },
  };
}

function output() {
  let value = '';
  return { write: (chunk) => { value += String(chunk); }, value: () => value };
}

async function waitForPath(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for path: ${file}`);
}

test('knowledge is explicitly saved, tagged, searched, edited, and removed', async (t) => {
  const { env } = await fixture(t);
  const core = createCore({ env, cwd: process.cwd() });
  const first = await core.knowledge.add({
    title: 'SQLite migration lesson',
    body: 'Use BEGIN IMMEDIATE and keep the migration idempotent.',
    tags: ['database', 'Decision', 'database'],
  });
  const second = await core.knowledge.add({
    title: 'UI wording',
    body: 'Do not claim every PC is current.',
    tags: ['design'],
  });

  assert.deepEqual(first.tags, ['database', 'Decision']);
  assert.equal((await core.knowledge.list()).length, 2);
  assert.deepEqual((await core.knowledge.list({ tag: 'DATABASE' })).map((item) => item.id), [first.id]);
  assert.deepEqual(
    (await core.knowledge.search({ query: 'sqlite idempotent' })).map((item) => item.id),
    [first.id],
  );
  assert.deepEqual(
    (await core.knowledge.search({ query: 'design', tag: 'design' })).map((item) => item.id),
    [second.id],
  );

  const updated = await core.knowledge.update({
    id: first.id,
    title: 'SQLite migration rule',
    tags: [],
  });
  assert.equal(updated.title, 'SQLite migration rule');
  assert.deepEqual(updated.tags, []);
  assert.equal((await core.knowledge.remove({ id: second.id })).removed, true);
  assert.deepEqual((await core.knowledge.list()).map((item) => item.id), [first.id]);
});

test('knowledge merge preserves an update that holds the shared lock while merge starts', async (t) => {
  const { root, env } = await fixture(t);
  const core = createCore({ env, cwd: process.cwd() });
  const target = await core.knowledge.add({
    title: 'Merge target',
    body: 'original target body',
    tags: ['target'],
  });
  const source = await core.knowledge.add({
    title: 'Merge source',
    body: 'source body',
    tags: ['source'],
  });
  const readyFile = path.join(root, 'update-ready');
  const releaseFile = path.join(root, 'release-update');
  const knowledgeLock = path.join(env.HND_HOME, 'locks', 'knowledge.lock');
  const contentionGuard = `${knowledgeLock}.delete`;
  const knowledgeModule = new URL('../src/core/knowledge.mjs', import.meta.url).href;
  const childScript = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { updateKnowledge } from ${JSON.stringify(knowledgeModule)};

    const [id, readyFile, releaseFile] = process.argv.slice(1);
    const waitState = new Int32Array(new SharedArrayBuffer(4));
    const clock = () => {
      writeFileSync(readyFile, 'ready');
      while (!existsSync(releaseFile)) Atomics.wait(waitState, 0, 0, 10);
      return new Date('2026-09-04T08:00:00.000Z');
    };
    await updateKnowledge({
      id,
      body: 'concurrent target body',
      tags: ['target', 'concurrent'],
      actor: 'concurrent-update',
      env: process.env,
      clock,
    });
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', childScript, target.id, readyFile, releaseFile],
    { env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let childStderr = '';
  child.stderr.on('data', (chunk) => { childStderr += String(chunk); });
  const childExit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  let mergePromise;
  try {
    await waitForPath(readyFile);
    mergePromise = mergeKnowledge({
      targetId: target.id,
      sourceId: source.id,
      actor: 'merge',
      env,
      clock: () => new Date('2026-09-04T08:00:01.000Z'),
    });
    // Seeing the deletion guard proves merge reached the knowledge lock. In
    // the former implementation that happened only after its stale reads.
    await waitForPath(contentionGuard);
  } finally {
    await fs.writeFile(releaseFile, 'release');
  }

  const [merged, exited] = await Promise.all([mergePromise, childExit]);
  assert.deepEqual(exited, { code: 0, signal: null }, childStderr);
  const finalTarget = await core.knowledge.get({ id: target.id });
  const finalSource = await core.knowledge.get({ id: source.id });
  assert.equal(finalTarget.body, 'concurrent target body\n\n---\n\nsource body');
  assert.deepEqual(finalTarget.tags, ['target', 'concurrent', 'source']);
  assert.deepEqual(merged, finalTarget);
  assert.equal(finalSource.state, 'superseded');
  assert.ok(finalTarget.history.some((entry) => entry.actor === 'concurrent-update'));
  assert.equal(finalTarget.history.at(-1).actor, 'merge');
});

test('knowledge merge journal rolls forward after the second note write fails', async (t) => {
  const { env } = await fixture(t);
  const core = createCore({ env, cwd: process.cwd() });
  const target = await core.knowledge.add({
    title: 'Journal target',
    body: 'target body',
    tags: ['target'],
  });
  const source = await core.knowledge.add({
    title: 'Journal source',
    body: 'source body',
    tags: ['source'],
  });
  const sourceFile = path.join(env.HND_HOME, 'knowledge', `${source.id}.json`);
  const targetFile = path.join(env.HND_HOME, 'knowledge', `${target.id}.json`);
  const journalFile = path.join(env.HND_HOME, 'locks', 'knowledge-merge-journal.json');
  const originalRename = fs.rename;
  let failureInjected = false;
  fs.rename = async function failSecondNoteWrite(from, to, ...args) {
    if (!failureInjected && to === sourceFile) {
      failureInjected = true;
      const error = new Error('simulated second knowledge write failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename.call(this, from, to, ...args);
  };
  try {
    await assert.rejects(
      core.knowledge.merge({
        targetId: target.id,
        sourceId: source.id,
        actor: 'journal-merge',
      }),
      { code: 'EIO' },
    );
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(failureInjected, true);
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  assert.equal(journal.target.id, target.id);
  assert.equal(journal.source.id, source.id);
  assert.equal(
    JSON.parse(await fs.readFile(targetFile, 'utf8')).body,
    'target body\n\n---\n\nsource body',
  );
  assert.equal(JSON.parse(await fs.readFile(sourceFile, 'utf8')).state, 'verified');

  // Compose is read-only but still acquires state -> knowledge locks and rolls
  // the journal forward before it exposes either note as prompt context.
  const composed = await core.compose({
    globalOnly: true,
    knowledgeQuery: 'source body',
  });
  assert.match(composed.content, /Journal target/);
  const recoveredList = await core.knowledge.list();
  const recoveredTarget = await core.knowledge.get({ id: target.id });
  const recoveredSource = await core.knowledge.get({ id: source.id });
  assert.equal(recoveredTarget.body, 'target body\n\n---\n\nsource body');
  assert.equal(recoveredTarget.history.at(-1).actor, 'journal-merge');
  assert.equal(recoveredSource.state, 'superseded');
  assert.ok(recoveredSource.relationships.some((relationship) => (
    relationship.type === 'related' && relationship.targetId === target.id
  )));
  assert.deepEqual(
    new Set(recoveredList.map((entry) => entry.id)),
    new Set([target.id, source.id]),
  );
  await assert.rejects(fs.stat(journalFile), { code: 'ENOENT' });
});

test('knowledge merge journal preserves required links at the relationship limit', async (t) => {
  const { env } = await fixture(t);
  const core = createCore({ env, cwd: process.cwd() });
  const target = await core.knowledge.add({
    title: 'Full relationship target',
    relationships: Array.from({ length: 20 }, () => ({
      type: 'related',
      targetId: randomUUID(),
    })),
  });
  const source = await core.knowledge.add({
    title: 'Full relationship source',
    relationships: [
      { type: 'related', targetId: target.id },
      { type: 'related', targetId: target.id },
      ...Array.from({ length: 18 }, () => ({
        type: 'related',
        targetId: randomUUID(),
      })),
    ],
  });
  const sourceFile = path.join(env.HND_HOME, 'knowledge', `${source.id}.json`);
  const journalFile = path.join(env.HND_HOME, 'locks', 'knowledge-merge-journal.json');
  const originalRename = fs.rename;
  fs.rename = async function failSourceWrite(from, to, ...args) {
    if (to === sourceFile) {
      const error = new Error('simulated source write failure at relationship limit');
      error.code = 'EIO';
      throw error;
    }
    return originalRename.call(this, from, to, ...args);
  };
  try {
    await assert.rejects(
      core.knowledge.merge({ targetId: target.id, sourceId: source.id }),
      { code: 'EIO' },
    );
  } finally {
    fs.rename = originalRename;
  }

  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  assert.equal(journal.target.relationships.length, 20);
  assert.equal(journal.source.relationships.length, 19);
  assert.equal(journal.target.relationships.filter((relationship) => (
    relationship.type === 'supersedes' && relationship.targetId === source.id
  )).length, 1);
  assert.equal(journal.source.relationships.filter((relationship) => (
    relationship.type === 'related' && relationship.targetId === target.id
  )).length, 1);

  const recoveredTarget = await core.knowledge.get({ id: target.id });
  const recoveredSource = await core.knowledge.get({ id: source.id });
  assert.equal(recoveredTarget.relationships.length, 20);
  assert.equal(recoveredSource.relationships.length, 19);
  assert.equal(recoveredSource.state, 'superseded');
  await assert.rejects(fs.stat(journalFile), { code: 'ENOENT' });
});

test('knowledge merge recovery rejects a structurally valid but inconsistent journal', async (t) => {
  const { env } = await fixture(t);
  const core = createCore({ env, cwd: process.cwd() });
  const target = await core.knowledge.add({ title: 'Protected target' });
  const source = await core.knowledge.add({ title: 'Protected source' });
  const journalFile = path.join(env.HND_HOME, 'locks', 'knowledge-merge-journal.json');
  await fs.writeFile(journalFile, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'knowledge-merge',
    target: {
      ...target,
      relationships: [{ type: 'supersedes', targetId: source.id }],
    },
    source: {
      ...source,
      // A real committed merge journal must supersede its source.
      state: 'verified',
      relationships: [{ type: 'related', targetId: target.id }],
    },
  }, null, 2)}\n`);

  await assert.rejects(
    core.knowledge.add({ title: 'Must not be written' }),
    (error) => error?.code === 'STATE_CORRUPT' && error?.details?.path === journalFile,
  );
  await fs.unlink(journalFile);
  assert.deepEqual(
    new Set((await core.knowledge.list()).map((entry) => entry.title)),
    new Set(['Protected target', 'Protected source']),
  );
});

test('sync capture rolls a pending knowledge merge forward before reading files', async (t) => {
  const { env } = await fixture(t);
  const core = createCore({ env, cwd: process.cwd() });
  const target = await core.knowledge.add({ title: 'Snapshot target', body: 'target' });
  const source = await core.knowledge.add({ title: 'Snapshot source', body: 'source' });
  const mergedTarget = await core.knowledge.merge({
    targetId: target.id,
    sourceId: source.id,
    actor: 'snapshot-recovery',
  });
  const mergedSource = await core.knowledge.get({ id: source.id });
  const sourceFile = path.join(env.HND_HOME, 'knowledge', `${source.id}.json`);
  const journalFile = path.join(env.HND_HOME, 'locks', 'knowledge-merge-journal.json');

  // Recreate the durable state left by a process that stopped after writing
  // the target but before writing the source.
  await fs.writeFile(sourceFile, `${JSON.stringify(source, null, 2)}\n`);
  await fs.writeFile(journalFile, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'knowledge-merge',
    target: mergedTarget,
    source: mergedSource,
  }, null, 2)}\n`);

  const snapshot = await captureSyncSnapshot(env.HND_HOME);
  const capturedSource = snapshot.files.find(
    (file) => file.path === `knowledge/${source.id}.json`,
  );
  assert.ok(capturedSource);
  assert.equal(
    JSON.parse(Buffer.from(capturedSource.content, 'base64').toString('utf8')).state,
    'superseded',
  );
  await assert.rejects(fs.stat(journalFile), { code: 'ENOENT' });
});

test('knowledge entries are included in the encrypted sync snapshot allowlist', async (t) => {
  const { env } = await fixture(t);
  const core = createCore({ env, cwd: process.cwd() });
  const entry = await core.knowledge.add({ title: 'Durable note', body: 'remember this', tags: ['ops'] });
  const snapshot = await captureSyncSnapshot(env.HND_HOME);
  const knowledgeFile = snapshot.files.find((file) => file.path === `knowledge/${entry.id}.json`);
  assert.ok(knowledgeFile);
  const validated = validateSyncSnapshot(snapshot);
  assert.ok(validated.files.some((file) => file.path === `knowledge/${entry.id}.json`));
});

test('knowledge can be scoped to the account, project, or project environment', async (t) => {
  const { root, env } = await fixture(t);
  const repository = path.join(root, 'project');
  await fs.mkdir(repository);
  execFileSync('git', ['-C', repository, 'init', '--quiet']);
  const core = createCore({ env, cwd: repository });
  const registered = await core.repo.register();
  await core.env.set('test');

  const shared = await core.knowledge.add({ title: 'Shared decision' });
  const project = await core.knowledge.add({ title: 'Project decision', scope: 'repo' });
  const environment = await core.knowledge.add({ title: 'Test deployment', scope: 'env' });

  assert.deepEqual(
    [shared.scope, shared.repoId, shared.environment],
    ['global', null, null],
  );
  assert.deepEqual(
    [project.scope, project.repoId, project.environment],
    ['repo', registered.repository.id, null],
  );
  assert.deepEqual(
    [environment.scope, environment.repoId, environment.environment],
    ['env', registered.repository.id, 'test'],
  );
  assert.deepEqual(
    (await core.knowledge.list({ scope: 'repo' })).map((entry) => entry.id),
    [project.id],
  );
  assert.deepEqual(
    (await core.knowledge.search({ query: 'deployment', scope: 'env' })).map((entry) => entry.id),
    [environment.id],
  );

  const moved = await core.knowledge.update({
    id: shared.id,
    scope: 'env',
    environment: 'prod',
  });
  assert.deepEqual(
    [moved.scope, moved.repoId, moved.environment],
    ['env', registered.repository.id, 'prod'],
  );
});

test('short know commands manage and search durable knowledge', async (t) => {
  const { env } = await fixture(t);
  const run = async (args, input = '') => {
    const stdout = output();
    const stderr = output();
    await main(args, {
      env,
      cwd: process.cwd(),
      stdin: Readable.from([input]),
      stdout,
      stderr,
    });
    return stdout.value();
  };

  const added = JSON.parse(await run([
    'know', 'add', 'Passkey boundary', '--text', 'Passkeys never derive the vault key.',
    '--tag', 'security', '--json',
  ]));
  const found = JSON.parse(await run(['know', 'find', 'vault key', '--json']));
  assert.deepEqual(found.map((item) => item.id), [added.id]);
  assert.match(await run(['know', 'show', added.id]), /Passkeys never derive/);
  await run(['know', 'edit', added.id, '--title', 'Passkey and vault', '--clear-tags']);
  assert.equal(JSON.parse(await run(['knowledge', 'list', '--json']))[0].title, 'Passkey and vault');
  assert.match(await run(['know', 'remove', added.id]), /Removed/);
});

test('know CLI stores project and environment scopes from the current checkout', async (t) => {
  const { root, env } = await fixture(t);
  const repository = path.join(root, 'cli-project');
  await fs.mkdir(repository);
  execFileSync('git', ['-C', repository, 'init', '--quiet']);
  const core = createCore({ env, cwd: repository });
  const registered = await core.repo.register();
  await core.env.set('staging');
  const run = async (args) => {
    const stdout = output();
    const stderr = output();
    await main(args, {
      env,
      cwd: repository,
      stdin: Readable.from([]),
      stdout,
      stderr,
    });
    return stdout.value();
  };

  const project = JSON.parse(await run([
    'know', 'add', 'Project contract', '--scope', 'repo', '--json',
  ]));
  const environment = JSON.parse(await run([
    'know', 'add', 'Staging contract', '--scope', 'env', '--json',
  ]));

  assert.deepEqual(
    [project.scope, project.repoId, project.environment],
    ['repo', registered.repository.id, null],
  );
  assert.deepEqual(
    [environment.scope, environment.repoId, environment.environment],
    ['env', registered.repository.id, 'staging'],
  );
  assert.deepEqual(
    JSON.parse(await run(['know', 'list', '--scope', 'env', '--json']))
      .map((entry) => entry.id),
    [environment.id],
  );
});
