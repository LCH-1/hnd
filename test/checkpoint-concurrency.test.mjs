import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCore } from '../src/core/index.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-checkpoint-concurrency-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
  const env = { ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user') };
  const core = createCore({ env, cwd, agent: 'codex', sessionId: 'checkpoint-test' });
  await core.init();
  await core.repo.resolve();
  return core;
}

function progress(file) {
  return { branch: 'main', head: null, lastCommit: '', dirty: true, totalChanges: 1,
    truncated: false, changes: [{ code: ' M', path: file }] };
}

test('a slow Git inspection allows other sessions to read state', async (t) => {
  const core = await fixture(t);
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const capture = core.auto.capture({ inspectGit: async () => { entered(); await held; return progress('first.txt'); } });
  await ready;
  let timer;
  try {
    await Promise.race([
      core.config.get(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Git inspection still holds the global state lock')), 1_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    release();
    await capture;
  }
});

test('a delayed capture cannot overwrite a checkpoint committed by another session', async (t) => {
  const core = await fixture(t);
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const older = core.auto.capture({ inspectGit: async () => { entered(); await held; return progress('older.txt'); } });
  await ready;
  try {
    const newer = await core.auto.capture({ inspectGit: async () => progress('newer.txt') });
    assert.equal(newer.changed, true);
  } finally {
    release();
  }
  const result = await older;
  assert.equal(result.reason, 'concurrent_checkpoint');
  assert.equal(result.checkpoint.changes[0].path, 'newer.txt');
});

test('a privacy change during Git inspection prevents checkpoint collection', async (t) => {
  const core = await fixture(t);
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const capture = core.auto.capture({ inspectGit: async () => { entered(); await held; return progress('private.txt'); } });
  await ready;
  try {
    await core.privacy.set({ policy: { enabled: false } });
  } finally {
    release();
  }
  const result = await capture;
  assert.equal(result.reason, 'collection_disabled');
  assert.equal(result.checkpoint, null);
});
