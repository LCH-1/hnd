import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';

import { hookLockBudgetMs } from '../src/adapters/index.mjs';
import { CLAUDE_HOOK_TIMEOUT_SECONDS } from '../src/adapters/claude.mjs';
import { CODEX_HOOK_TIMEOUT_SECONDS } from '../src/adapters/codex.mjs';
import { createCore } from '../src/core/index.mjs';
import { processLockDeadline, setProcessLockDeadline, withProcessLockDeadline, withStateLock } from '../src/core/mutation-lock.mjs';
import { operationDeadline, withFileLock, withOperationDeadline } from '../src/core/fs.mjs';
import { captureSyncSnapshot } from '../src/sync/capture.mjs';
import { main } from '../src/cli.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-hook-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
  const env = { ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user') };
  const core = createCore({ env, cwd, agent: 'codex', sessionId: 'hook-lock-test' });
  await core.init();
  await core.repo.resolve({ create: true });
  return { cwd, env };
}

test('every hook phase budgets its lock wait below the vendor timeout', () => {
  for (const [agent, timeouts] of [['claude', CLAUDE_HOOK_TIMEOUT_SECONDS], ['codex', CODEX_HOOK_TIMEOUT_SECONDS]]) {
    for (const [phase, seconds] of Object.entries(timeouts)) {
      const budget = hookLockBudgetMs(agent, phase);
      // The budget has to leave room for process startup and the hook's actual
      // work; a wait that reaches the vendor timeout is a kill, not a failure.
      assert.equal(budget < seconds * 1_000, true, `${agent}/${phase} budget ${budget} must be under ${seconds}s`);
      assert.equal(budget >= 250, true, `${agent}/${phase} budget ${budget} is too small to ever succeed`);
    }
  }
  // A more generous prompt timeout must not turn into longer lock contention.
  assert.equal(hookLockBudgetMs('claude', 'prompt'), 1_000);
  assert.equal(hookLockBudgetMs('codex', 'prompt'), 1_000);
  // An unknown agent or phase still yields a usable, bounded wait.
  assert.equal(hookLockBudgetMs('unknown', 'prompt'), 250);
  assert.equal(hookLockBudgetMs('claude', 'nonexistent'), 250);
});

test('a contended state lock fails inside the hook budget instead of overrunning it', async (t) => {
  const { cwd, env } = await fixture(t);
  const budget = hookLockBudgetMs('claude', 'prompt');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  // Hold the lock exactly the way a busy sibling session would.
  const holder = withStateLock(() => held, { env, timeoutMs: 5_000 });
  await new Promise((resolve) => { setTimeout(resolve, 150); });

  const hookCore = createCore({ env, cwd, agent: 'claude', sessionId: 'contended', lockTimeoutMs: budget });
  const started = Date.now();
  await assert.rejects(hookCore.repo.resolve({ create: false }), (error) => error.code === 'STATE_BUSY');
  const waited = Date.now() - started;
  release();
  await holder;

  assert.equal(waited >= budget, true, `gave up after ${waited}ms, before its own ${budget}ms budget`);
  // Keep compatibility with PCs whose hook settings still have the old 2s cap.
  assert.equal(waited < 2_000, true, `waited ${waited}ms, past the legacy 2s timeout`);
});

test('sequential lock attempts share one deadline instead of each getting the full budget', async (t) => {
  const { cwd, env } = await fixture(t);
  const budget = hookLockBudgetMs('claude', 'prompt');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const holder = withStateLock(() => held, { env, timeoutMs: 10_000 });
  await new Promise((resolve) => { setTimeout(resolve, 150); });

  const hookCore = createCore({
    env, cwd, agent: 'claude', sessionId: 'sequential', lockDeadlineAt: Date.now() + budget,
  });
  const started = Date.now();
  // A real hook takes the lock several times in a row. Without a shared
  // deadline these four attempts would cost 4 x budget and blow past the
  // vendor timeout even though every single wait looked short enough.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(hookCore.repo.resolve({ create: false }), (error) => error.code === 'STATE_BUSY');
  }
  const waited = Date.now() - started;
  release();
  await holder;

  assert.equal(waited < 2_000, true, `four attempts took ${waited}ms, past the legacy 2s timeout`);
});

test('the process deadline bounds lock waits that were never given a timeout', async (t) => {
  const { env } = await fixture(t);
  t.after(() => setProcessLockDeadline(null));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const holder = withStateLock(() => held, { env, timeoutMs: 10_000 });
  await new Promise((resolve) => { setTimeout(resolve, 150); });

  // The sync and restore paths take this lock from a dozen places that pass no
  // timeout at all, so they inherit the 15s default. Threading an argument into
  // every one of them is what a missed call site would silently undo; the
  // process-wide ceiling covers them without being passed anywhere.
  setProcessLockDeadline(Date.now() + 700);
  const started = Date.now();
  await assert.rejects(withStateLock(() => 'unreachable', { env }), (error) => error.code === 'STATE_BUSY');
  const waited = Date.now() - started;
  release();
  await holder;

  assert.equal(waited < 2_000, true, `an untimed wait took ${waited}ms despite a 700ms process deadline`);
});

test('clearing the process deadline restores the default wait', async (t) => {
  const { env } = await fixture(t);
  t.after(() => setProcessLockDeadline(null));
  setProcessLockDeadline(Date.now() + 500);
  setProcessLockDeadline(null);
  assert.equal(processLockDeadline(), null);
  // With no deadline the lock is taken normally, not refused.
  assert.equal(await withStateLock(() => 'acquired', { env }), 'acquired');
});

test('Git execution retains the total hook budget after its short lock-wait deadline is spent', async (t) => {
  const { cwd, env } = await fixture(t);
  const lockDeadlineAt = Date.now() - 100;
  const executionDeadlineAt = Date.now() + 2_000;
  await withOperationDeadline(executionDeadlineAt, () => withProcessLockDeadline(lockDeadlineAt, async () => {
    const core = createCore({ env, cwd, lockDeadlineAt });
    const composition = await core.compose({ fastRepository: true, createRepository: false });
    assert.ok(composition.repository?.id, 'an expired lock wait allowance must not discard repository rules');
    assert.equal(processLockDeadline(), lockDeadlineAt);
    assert.equal(operationDeadline(), executionDeadlineAt);
  }));
  assert.equal(operationDeadline(), null);
  await withOperationDeadline(Date.now() - 1, async () => {
    await assert.rejects(createCore({ env, cwd }).repo.binding(), { code: 'OPERATION_DEADLINE_EXCEEDED' });
  });
});

test('a late hook input cannot add its full lock allowance beyond the total execution deadline', async (t) => {
  const { cwd, env } = await fixture(t);
  const started = Date.now();
  await withStateLock(async () => {
    await withOperationDeadline(Date.now() + 200, async () => {
      const stdin = Readable.from((async function* () {
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield JSON.stringify({ cwd, session_id: 'late-input' });
      })());
      await main(['hook', 'claude', 'prompt'], {
        cwd, env, stdin, stdout: { write: () => true }, stderr: { write: () => true },
      });
    });
  }, { env });
  assert.ok(Date.now() - started < 800, 'the hook spent a new full 1s waiting after its total deadline');
});

test('a hook deadline does not shorten a concurrent ordinary caller in the same process', async (t) => {
  const { env } = await fixture(t);
  let ordinary;
  await withStateLock(async () => {
    const hook = withProcessLockDeadline(Date.now() + 100, async () => {
      await assert.rejects(withStateLock(() => 'hook', { env }), { code: 'STATE_BUSY' });
    });
    let finished = false;
    ordinary = withStateLock(() => 'ordinary', { env }).then((value) => {
      finished = true;
      return value;
    });
    await hook;
    assert.equal(processLockDeadline(), null);
    assert.equal(finished, false);
  }, { env });
  assert.equal(await ordinary, 'ordinary');
});

test('a nested knowledge lock cannot outlive the hook deadline while holding the state lock', async (t) => {
  const { env } = await fixture(t);
  t.after(() => setProcessLockDeadline(null));
  await withFileLock(path.join(env.HND_HOME, 'locks', 'knowledge.lock'), async () => {
    setProcessLockDeadline(Date.now() + 300);
    const started = Date.now();
    await assert.rejects(withStateLock(() => captureSyncSnapshot(env.HND_HOME), { env }), { code: 'STATE_BUSY' });
    assert.ok(Date.now() - started < 1_500, 'nested lock retained the old five-second wait');
    setProcessLockDeadline(null);
  });
});

test('the default state lock wait is unchanged for ordinary CLI callers', async (t) => {
  const { cwd, env } = await fixture(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const holder = withStateLock(() => held, { env, timeoutMs: 5_000 });
  await new Promise((resolve) => { setTimeout(resolve, 150); });

  // No lockTimeoutMs: this caller keeps the 15s default, so it is still waiting
  // long after a hook would have given up.
  const cliCore = createCore({ env, cwd, agent: 'codex', sessionId: 'cli' });
  const pending = cliCore.repo.resolve({ create: false });
  const outcome = await Promise.race([
    pending.then(() => 'resolved', () => 'rejected'),
    new Promise((resolve) => { setTimeout(() => resolve('still-waiting'), 1_500); }),
  ]);
  assert.equal(outcome, 'still-waiting');
  release();
  await holder;
  await pending;
});

test('a dead owner is reclaimed promptly without waiting for its full lease', async (t) => {
  const { env } = await fixture(t);
  const lockFile = path.join(env.HND_HOME, 'locks', 'state-generation.lock');
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  // A lease left behind by a process that no longer exists. PID 2^22 is above
  // every default pid_max, so it can never be a live process on this host.
  await fs.writeFile(lockFile, JSON.stringify({ owner: 'abandoned', pid: 4_194_304, acquiredAt: new Date(0).toISOString() }));
  const old = new Date(Date.now() - 2_000);
  await fs.utimes(lockFile, old, old);

  const started = Date.now();
  assert.equal(await withStateLock(() => 'acquired', { env, timeoutMs: 2_000 }), 'acquired');
  // A complete lease with a provably dead owner clears the 1s grace period.
  assert.equal(Date.now() - started < 2_000, true);
});
