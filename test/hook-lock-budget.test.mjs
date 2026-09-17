import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hookLockBudgetMs } from '../src/adapters/index.mjs';
import { CLAUDE_HOOK_TIMEOUT_SECONDS } from '../src/adapters/claude.mjs';
import { CODEX_HOOK_TIMEOUT_SECONDS } from '../src/adapters/codex.mjs';
import { createCore } from '../src/core/index.mjs';
import { processLockDeadline, setProcessLockDeadline, withStateLock } from '../src/core/mutation-lock.mjs';

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
  // The tightest real budget is Claude's 2s UserPromptSubmit hook.
  assert.equal(hookLockBudgetMs('claude', 'prompt'), 1_000);
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
  // The whole point: it must give up well before Claude Code's 2s kill.
  assert.equal(waited < CLAUDE_HOOK_TIMEOUT_SECONDS.prompt * 1_000, true, `waited ${waited}ms, past the 2s vendor timeout`);
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

  assert.equal(waited < CLAUDE_HOOK_TIMEOUT_SECONDS.prompt * 1_000, true, `four attempts took ${waited}ms, past the 2s vendor timeout`);
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

test('an abandoned lease is reclaimed within a minute, not five', async (t) => {
  const { env } = await fixture(t);
  const lockFile = path.join(env.HND_HOME, 'locks', 'state-generation.lock');
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  // A lease left behind by a process that no longer exists. PID 2^22 is above
  // every default pid_max, so it can never be a live process on this host.
  await fs.writeFile(lockFile, JSON.stringify({ owner: 'abandoned', pid: 4_194_304, acquiredAt: new Date(0).toISOString() }));
  const old = new Date(Date.now() - 90_000);
  await fs.utimes(lockFile, old, old);

  const started = Date.now();
  assert.equal(await withStateLock(() => 'acquired', { env, timeoutMs: 2_000 }), 'acquired');
  // 90s of staleness clears the 60s bound. Under the previous 5-minute bound
  // this same lease would still have blocked every caller.
  assert.equal(Date.now() - started < 2_000, true);
});
