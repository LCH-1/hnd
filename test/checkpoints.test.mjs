import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createCore } from '../src/core/index.mjs';

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return (await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim();
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-checkpoint-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'work');
  await fs.mkdir(repository);
  await git(repository, 'init', '-b', 'main');
  await git(repository, 'config', 'user.email', 'test@example.invalid');
  await git(repository, 'config', 'user.name', 'hnd test');
  await fs.writeFile(path.join(repository, 'README.md'), '# fixture\n');
  await git(repository, 'add', 'README.md');
  await git(repository, 'commit', '-m', 'initial');
  const env = {
    ...process.env,
    HND_HOME: path.join(root, 'state'),
    HND_USER_HOME: path.join(root, 'user'),
  };
  return { repository, env, core: createCore({ cwd: repository, env }) };
}

test('automatic checkpoints and remote synchronization are enabled by default', async (t) => {
  const { core } = await fixture(t);
  await core.init();
  assert.equal(await core.auto.get(), true);
  assert.equal(await core.sync.get(), true);
  assert.deepEqual((await core.auto.set(false)).enabled, false);
  assert.equal(await core.auto.get(), false);
  assert.deepEqual((await core.auto.set(true)).enabled, true);
  assert.deepEqual((await core.sync.set(false)).enabled, false);
  assert.equal(await core.sync.get(), false);
  assert.deepEqual((await core.sync.set(true)).enabled, true);
});

test('checkpoint capture records Git facts, deduplicates, and enters composed context', async (t) => {
  const { repository, core } = await fixture(t);
  await core.init();
  await core.repo.resolve({ create: true });

  const clean = await core.auto.capture({ agent: 'codex' });
  assert.equal(clean.changed, true);
  assert.equal(clean.checkpoint.branch, 'main');
  assert.equal(clean.checkpoint.dirty, false);

  const duplicate = await core.auto.capture({ agent: 'codex' });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.checkpoint.fingerprint, clean.checkpoint.fingerprint);

  await fs.writeFile(path.join(repository, 'README.md'), '# changed\n');
  await fs.writeFile(path.join(repository, 'new file.txt'), 'new\n');
  const dirty = await core.auto.capture({ agent: 'claude' });
  assert.equal(dirty.changed, true);
  assert.equal(dirty.checkpoint.dirty, true);
  assert.equal(dirty.checkpoint.totalChanges, 2);
  assert.deepEqual(
    dirty.checkpoint.changes.map((change) => change.path).sort(),
    ['README.md', 'new file.txt'],
  );

  const context = await core.compose();
  assert.match(context.content, /Automatic progress checkpoint/);
  assert.match(context.content, /README\.md/);
  assert.match(context.content, /new file\.txt/);
  assert.equal(context.layers.some((layer) => layer.kind === 'checkpoint'), true);

  const compact = await core.compose({ maxBytes: 1_000 });
  assert.equal(compact.layers.some((layer) => layer.kind === 'checkpoint'), false);
  assert.equal(
    compact.warnings.some((warning) => warning.code === 'CHECKPOINT_OMITTED_FOR_SIZE'),
    true,
  );
});

test('automatic capture never registers an unrelated repository', async (t) => {
  const { repository, core } = await fixture(t);
  await core.init();
  await assert.rejects(core.auto.capture({ agent: 'cursor' }), {
    code: 'REPOSITORY_NOT_REGISTERED',
  });
  assert.equal((await core.repo.list()).length, 0);
  assert.equal(await fs.readFile(path.join(repository, 'README.md'), 'utf8'), '# fixture\n');
});
