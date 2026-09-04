import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { createCore } from '../src/core/index.mjs';
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
