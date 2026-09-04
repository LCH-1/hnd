import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  CoreError,
  createCore,
  ensureDirectory,
  normalizeRemoteUrl,
  readJson,
  withFileLock,
  writeJsonAtomic,
} from '../src/core/index.mjs';

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return result.stdout.trim();
}

async function makeRepository(directory, remote = 'git@github.com:Acme/Widget.git') {
  await fs.mkdir(directory, { recursive: true });
  await git(directory, 'init', '-b', 'main');
  await git(directory, 'config', 'user.email', 'test@example.invalid');
  await git(directory, 'config', 'user.name', 'hnd test');
  await fs.writeFile(path.join(directory, 'README.md'), '# fixture\n');
  await git(directory, 'add', 'README.md');
  await git(directory, 'commit', '-m', 'initial');
  if (remote) await git(directory, 'remote', 'add', 'origin', remote);
  return directory;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-core-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = await makeRepository(path.join(root, 'work'));
  const env = {
    ...process.env,
    HND_HOME: path.join(root, 'state'),
    HND_USER_HOME: path.join(root, 'user'),
  };
  let milliseconds = Date.parse('2026-08-26T00:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const advanceHours = (hours) => {
    milliseconds += hours * 60 * 60 * 1000;
  };
  return { root, repository, env, clock, advanceHours };
}

test('atomic JSON writes install complete state and corruption fails closed', async (t) => {
  const { root, repository, env, clock } = await fixture(t);
  const target = path.join(root, 'atomic', 'value.json');
  assert.equal(await writeJsonAtomic(target, { first: true }, { overwrite: false }), true);
  assert.equal(await writeJsonAtomic(target, { second: true }, { overwrite: false }), false);
  assert.deepEqual(await readJson(target), { first: true });

  await fs.writeFile(target, '{broken');
  await assert.rejects(
    readJson(target),
    (error) => error instanceof CoreError && error.code === 'STATE_CORRUPT',
  );

  if (process.platform !== 'win32') {
    const core = createCore({ env, cwd: repository, clock });
    await core.init();
    const outside = path.join(root, 'outside-policy.md');
    const globalPolicy = path.join(env.HND_HOME, 'policies', 'global.md');
    await fs.writeFile(outside, 'must not be followed');
    await fs.symlink(outside, globalPolicy);
    await assert.rejects(
      core.policy.get({ scope: 'global' }),
      (error) => error instanceof CoreError && error.code === 'UNSAFE_STATE_PATH',
    );
  }
});

test('state initialization refuses a managed directory symlink without touching its target', async (t) => {
  if (process.platform === 'win32') t.skip('symlink creation requires elevated privileges on Windows');
  const { root, repository, env, clock } = await fixture(t);
  const outside = path.join(root, 'outside-directory');
  await fs.mkdir(env.HND_HOME, { recursive: true });
  await fs.mkdir(outside, { mode: 0o755 });
  await fs.chmod(outside, 0o755);
  await fs.symlink(outside, path.join(env.HND_HOME, 'policies'));

  const core = createCore({ env, cwd: repository, clock });
  await assert.rejects(
    () => core.init(),
    (error) => error instanceof CoreError && error.code === 'UNSAFE_STATE_PATH',
  );
  await assert.rejects(
    () => fs.access(path.join(outside, 'global.md')),
    (error) => error.code === 'ENOENT',
  );
  assert.equal((await fs.stat(outside)).mode & 0o777, 0o755);
});

test('managed directory creation refuses an intermediate symlink below its trusted root', async (t) => {
  if (process.platform === 'win32') t.skip('symlink creation requires elevated privileges on Windows');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-directory-chain-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  const outside = path.join(root, 'outside');
  await fs.mkdir(state);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(state, 'repositories'));

  await assert.rejects(
    ensureDirectory(path.join(state, 'repositories', 'prepared-repo'), undefined, {
      trustedRoot: state,
    }),
    (error) => error instanceof CoreError && error.code === 'UNSAFE_STATE_PATH',
  );
  await assert.rejects(fs.stat(path.join(outside, 'prepared-repo')), { code: 'ENOENT' });
});

test('a stale lock holder cannot delete the replacement owner lock', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-lock-owner-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, 'state.lock');

  let releaseFirst;
  let firstEntered;
  const firstIsEntered = new Promise((resolve) => { firstEntered = resolve; });
  const firstCanExit = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withFileLock(lockFile, async () => {
    firstEntered();
    await firstCanExit;
  });
  await firstIsEntered;
  const firstOwner = JSON.parse(await fs.readFile(lockFile, 'utf8')).owner;

  const old = new Date(0);
  await fs.utimes(lockFile, old, old);
  let releaseSecond;
  let secondEntered;
  const secondIsEntered = new Promise((resolve) => { secondEntered = resolve; });
  const secondCanExit = new Promise((resolve) => { releaseSecond = resolve; });
  const second = withFileLock(lockFile, async () => {
    secondEntered();
    await secondCanExit;
  }, { timeoutMs: 1_000, staleMs: 1 });
  await secondIsEntered;

  const secondOwner = JSON.parse(await fs.readFile(lockFile, 'utf8')).owner;
  assert.notEqual(secondOwner, firstOwner);
  releaseFirst();
  await first;
  assert.equal(JSON.parse(await fs.readFile(lockFile, 'utf8')).owner, secondOwner);

  await assert.rejects(
    withFileLock(lockFile, async () => {}, { timeoutMs: 75, staleMs: 60_000 }),
    (error) => error instanceof CoreError && error.code === 'STATE_BUSY',
  );

  releaseSecond();
  await second;
  await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
});

test('competing stale-lock waiters serialize inspection and preserve replacement ownership', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-lock-waiters-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, 'state.lock');

  let releaseOriginal;
  let originalEntered;
  const originalIsEntered = new Promise((resolve) => { originalEntered = resolve; });
  const originalCanExit = new Promise((resolve) => { releaseOriginal = resolve; });
  const original = withFileLock(lockFile, async () => {
    originalEntered();
    await originalCanExit;
  });
  await originalIsEntered;
  const old = new Date(0);
  await fs.utimes(lockFile, old, old);

  // Hold the first stale-file inspection open. Without serialized deletion,
  // every waiter can inspect the same old inode and later unlink a fresh
  // replacement. With the guard, exactly one inspection reaches fs.stat.
  const originalStat = fs.stat;
  let inspectionCount = 0;
  let firstInspection;
  let releaseInspection;
  const firstInspectionStarted = new Promise((resolve) => { firstInspection = resolve; });
  const firstInspectionCanFinish = new Promise((resolve) => { releaseInspection = resolve; });
  fs.stat = async function interceptedStat(file, ...args) {
    if (file === lockFile) {
      inspectionCount += 1;
      if (inspectionCount === 1) {
        firstInspection();
        await firstInspectionCanFinish;
      }
    }
    return originalStat.call(this, file, ...args);
  };

  let activeReplacement = 0;
  let maximumActiveReplacements = 0;
  const waiterCount = 12;
  let waiters = [];
  try {
    waiters = Array.from({ length: waiterCount }, (_, index) => withFileLock(
      lockFile,
      async () => {
        activeReplacement += 1;
        maximumActiveReplacements = Math.max(maximumActiveReplacements, activeReplacement);
        await new Promise((resolve) => setTimeout(resolve, 5 + (index % 3)));
        activeReplacement -= 1;
      },
      { timeoutMs: 5_000, staleMs: 60_000 },
    ));

    await firstInspectionStarted;
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(inspectionCount, 1);

    releaseInspection();
    await Promise.all(waiters);
    assert.equal(maximumActiveReplacements, 1);
    assert.equal(activeReplacement, 0);
  } finally {
    fs.stat = originalStat;
    releaseInspection?.();
    releaseOriginal();
    await Promise.allSettled(waiters);
    await original;
  }

  await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
});

test('remote URL normalization equates common SSH and HTTPS forms', () => {
  assert.equal(
    normalizeRemoteUrl('git@github.com:Acme/Widget.git'),
    'github.com/Acme/Widget',
  );
  assert.equal(
    normalizeRemoteUrl('https://github.com/Acme/Widget.git'),
    'github.com/Acme/Widget',
  );
  assert.equal(
    normalizeRemoteUrl('ssh://git@github.com:22/Acme/Widget.git'),
    'github.com/Acme/Widget',
  );
  if (process.platform !== 'win32') {
    assert.equal(normalizeRemoteUrl('file:///tmp/Acme/Widget.git'), 'file:/tmp/Acme/Widget');
  }
});

test('repository registry binds paths, matches remote aliases, and never auto-links history alone', async (t) => {
  const { root, repository, env, clock, advanceHours } = await fixture(t);
  const core = createCore({ env, cwd: repository, clock });
  const created = await core.repo.resolve();
  assert.equal(created.match, 'created');
  assert.match(created.repository.id, /^[0-9a-f-]{36}$/);
  await git(
    repository,
    'remote',
    'set-url',
    'origin',
    'https://token-user:ghp_DO_NOT_EXPOSE@github.com/Acme/Widget.git',
  );
  const credentialSafe = await core.repo.resolve();
  assert.equal(JSON.stringify(credentialSafe).includes('ghp_DO_NOT_EXPOSE'), false);
  assert.deepEqual(credentialSafe.git.remotes, [{
    name: 'origin',
    normalized: 'github.com/Acme/Widget',
  }]);
  const indexPath = path.join(env.HND_HOME, 'repositories.json');
  const metadataPath = path.join(
    env.HND_HOME,
    'repositories',
    created.repository.id,
    'repository.json',
  );
  const bindingsPath = path.join(env.HND_HOME, 'bindings.json');
  const stableBytes = await Promise.all(
    [indexPath, metadataPath, bindingsPath].map((file) => fs.readFile(file, 'utf8')),
  );
  advanceHours(1);
  assert.equal((await core.repo.resolve()).match, 'binding');
  await core.compose({});
  assert.deepEqual(
    await Promise.all([indexPath, metadataPath, bindingsPath].map((file) => fs.readFile(file, 'utf8'))),
    stableBytes,
  );

  const second = path.join(root, 'second');
  await execFileAsync('git', ['clone', '--quiet', repository, second]);
  await git(second, 'remote', 'set-url', 'origin', 'https://github.com/Acme/Widget.git');
  const matched = await createCore({ env, cwd: second, clock }).repo.resolve();
  assert.equal(matched.match, 'remote');
  assert.equal(matched.repository.id, created.repository.id);

  const spoofedRemote = await makeRepository(
    path.join(root, 'spoofed-remote'),
    'https://github.com/Acme/Widget.git',
  );
  await fs.writeFile(path.join(spoofedRemote, 'README.md'), '# unrelated content with spoofed origin\n');
  await git(spoofedRemote, 'add', 'README.md');
  await git(spoofedRemote, 'commit', '--amend', '--no-edit');
  await assert.rejects(
    createCore({ env, cwd: spoofedRemote, clock }).repo.resolve(),
    (error) =>
      error instanceof CoreError
      && error.code === 'REPOSITORY_LINK_REQUIRED'
      && error.details.reason === 'history-mismatch',
  );

  const possibleFork = path.join(root, 'possible-fork');
  await execFileAsync('git', ['clone', '--quiet', repository, possibleFork]);
  await git(possibleFork, 'remote', 'remove', 'origin');
  await assert.rejects(
    createCore({ env, cwd: possibleFork, clock }).repo.resolve(),
    (error) =>
      error instanceof CoreError &&
      error.code === 'REPOSITORY_LINK_REQUIRED' &&
      error.details.candidates[0].id === created.repository.id,
  );

  const linked = await createCore({ env, cwd: possibleFork, clock }).repo.link({
    repoId: created.repository.id,
  });
  assert.equal(linked.match, 'linked');
  assert.equal((await core.repo.bindings()).length, 3);

  const forkWithUpstream = path.join(root, 'fork-with-upstream');
  await execFileAsync('git', ['clone', '--quiet', repository, forkWithUpstream]);
  await git(forkWithUpstream, 'remote', 'set-url', 'origin', 'git@github.com:Me/Widget.git');
  await git(
    forkWithUpstream,
    'remote',
    'add',
    'upstream',
    'https://github.com/Acme/Widget.git',
  );
  await assert.rejects(
    createCore({ env, cwd: forkWithUpstream, clock }).repo.resolve(),
    (error) => error instanceof CoreError && error.code === 'REPOSITORY_LINK_REQUIRED',
  );
  const registeredFork = await createCore({ env, cwd: forkWithUpstream, clock }).repo.register();
  assert.equal(registeredFork.match, 'created-explicitly');
  assert.notEqual(registeredFork.repository.id, created.repository.id);

  const unrelated = await makeRepository(
    path.join(root, 'unrelated'),
    'https://github.com/Elsewhere/Unrelated.git',
  );
  await fs.writeFile(path.join(unrelated, 'README.md'), '# unrelated fixture\n');
  await git(unrelated, 'add', 'README.md');
  await git(unrelated, 'commit', '--amend', '--no-edit');
  const unrelatedCore = createCore({ env, cwd: unrelated, clock });
  await assert.rejects(
    unrelatedCore.repo.link({ repoId: created.repository.id }),
    (error) => error instanceof CoreError && error.code === 'REPOSITORY_LINK_UNRELATED',
  );
  assert.equal(
    (await unrelatedCore.repo.link({ repoId: created.repository.id, force: true })).match,
    'linked',
  );
  const unlinked = await unrelatedCore.repo.unlink();
  assert.equal(unlinked.removed, true);
  assert.equal(unlinked.repoId, created.repository.id);
});

test('policy CRUD, handoff lifecycle, and context composition preserve security order', async (t) => {
  const { repository, env, clock } = await fixture(t);
  const core = createCore({ env, cwd: repository, clock });
  const resolved = await core.repo.resolve();
  await core.env.set('prod-seoul');
  await core.policy.set({ scope: 'global', content: 'GLOBAL RULE' });
  await core.policy.set({ scope: 'repo', content: 'REPO RULE' });
  await core.policy.set({ scope: 'env', content: 'ENV RULE' });
  await core.policy.set({ scope: 'local', content: 'LOCAL SAFETY RULE' });

  const started = await core.handoff.start({
    task: 'ship-context',
    objective: 'Finish the local context engine',
    currentState: 'Core modules compile.',
    decisions: ['Keep policy and handoff semantically separate.'],
    failedApproaches: ['Do not identify repositories by root commit alone.'],
    changedFiles: ['src/core/index.mjs'],
    validation: ['node --test passes'],
    nextSteps: ['Integrate the CLI'],
    openQuestions: ['None'],
  });
  assert.equal(started.repoId, resolved.repository.id);
  assert.equal(started.status, 'active');
  assert.equal(started.branch, 'main');

  const updated = await core.handoff.update({
    currentState: 'Core behavior is covered by tests.',
    decisions: ['Reject an oversized context instead of truncating it.'],
  });
  assert.equal(updated.currentState, 'Core behavior is covered by tests.');
  assert.equal(updated.decisions.length, 2);
  assert.equal((await core.handoff.show()).id, started.id);

  const context = await core.compose({});
  assert.equal(context.environment, 'prod-seoul');
  assert.deepEqual(
    context.layers.map((layer) => layer.scope),
    ['global', 'repo', 'env', 'handoff', 'local'],
  );
  const positions = [
    'GLOBAL RULE',
    'REPO RULE',
    'ENV RULE',
    'Active handoff context (not policy)',
    'LOCAL SAFETY RULE',
  ].map((value) => context.content.indexOf(value));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.match(context.content, /cannot override or weaken any policy/i);

  const closed = await core.handoff.close();
  assert.equal(closed.status, 'closed');
  assert.equal((await core.handoff.list({ status: 'active' })).length, 0);
  assert.equal((await core.handoff.list({ status: undefined })).length, 1);
});

test('environment policy filenames stay portable without stranding legacy data', async (t) => {
  const { repository, env, clock } = await fixture(t);
  const core = createCore({ env, cwd: repository, clock });
  const resolved = await core.repo.resolve();
  const environmentDirectory = path.join(
    env.HND_HOME,
    'repositories',
    resolved.repository.id,
    'environments',
  );

  for (const environment of [
    'CON',
    'con.prod',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'com9.test',
    'LPT1',
    'lpt9.prod',
  ]) {
    await assert.rejects(
      core.policy.set({ scope: 'env', environment, content: 'must not be created' }),
      (error) => error instanceof CoreError && error.code === 'UNPORTABLE_ENVIRONMENT',
    );
  }

  const first = await core.policy.set({
    scope: 'env',
    environment: 'Prod',
    content: 'FIRST',
  });
  const caseAlias = await core.policy.set({
    scope: 'env',
    environment: 'prod',
    content: 'SECOND',
  });
  assert.equal(caseAlias.environment, 'Prod');
  assert.equal(caseAlias.path, first.path);
  assert.equal((await core.policy.get({ scope: 'env', environment: 'PROD' })).content, 'SECOND');
  assert.deepEqual(
    (await fs.readdir(environmentDirectory)).filter((name) => name.toLowerCase() === 'prod.md'),
    ['Prod.md'],
  );

  for (const environment of ['com10', 'console', 'con-prod', 'prod.con']) {
    const saved = await core.policy.set({ scope: 'env', environment, content: environment });
    assert.equal(saved.environment, environment);
  }

  // Older Linux installations may already contain a Windows-reserved name.
  // Keep it addressable for migration instead of making the file impossible to
  // inspect, update, or remove after this portability check is introduced.
  if (process.platform !== 'win32') {
    const legacyReserved = path.join(environmentDirectory, 'CON.md');
    await fs.writeFile(legacyReserved, 'LEGACY');
    assert.equal(
      (await core.policy.get({ scope: 'env', environment: 'con' })).content,
      'LEGACY',
    );
    const migrated = await core.policy.set({
      scope: 'env',
      environment: 'con',
      content: 'LEGACY-UPDATED',
    });
    assert.equal(migrated.environment, 'CON');
    assert.equal(migrated.path, legacyReserved);
  }

  // Fail closed when a case-sensitive legacy filesystem already contains two
  // names that would alias on Windows or the default macOS filesystem.
  const upperCollision = path.join(environmentDirectory, 'Qa.md');
  const lowerCollision = path.join(environmentDirectory, 'qa.md');
  await fs.writeFile(upperCollision, 'UPPER');
  await fs.writeFile(lowerCollision, 'LOWER');
  const collisionEntries = (await fs.readdir(environmentDirectory))
    .filter((name) => name.toLowerCase() === 'qa.md');
  if (collisionEntries.length === 2) {
    await assert.rejects(
      core.policy.list(),
      (error) => error instanceof CoreError && error.code === 'ENVIRONMENT_CASE_COLLISION',
    );
    await assert.rejects(
      core.policy.set({ scope: 'env', environment: 'QA', content: 'AMBIGUOUS' }),
      (error) => error instanceof CoreError && error.code === 'ENVIRONMENT_CASE_COLLISION',
    );
  }
});

test('stale handoffs leave a visible review notice unless explicitly included', async (t) => {
  const { repository, env, clock, advanceHours } = await fixture(t);
  const core = createCore({ env, cwd: repository, clock });
  await core.repo.resolve();
  const handoff = await core.handoff.start({
    task: 'old-task',
    objective: 'Demonstrate staleness',
    staleHours: 1,
  });
  advanceHours(2);

  const safe = await core.compose({});
  assert.equal(safe.handoff, null);
  assert.equal(safe.warnings[0].code, 'HANDOFF_STALE');
  assert.doesNotMatch(safe.content, /Demonstrate staleness/);
  assert.match(safe.content, new RegExp(`old-task[\\s\\S]+${handoff.id}`));
  assert.match(safe.content, /Stale active handoff needs review/);

  const included = await core.compose({ includeStale: true });
  assert.equal(included.handoff.id, handoff.id);
  assert.match(included.content, /Demonstrate staleness/);
});

test('new and explicitly selected handoffs control the current checkout context', async (t) => {
  const { repository, env, clock } = await fixture(t);
  const core = createCore({ env, cwd: repository, clock });
  await core.repo.resolve();
  const first = await core.handoff.start({ task: 'first-task', objective: 'First goal' });
  const second = await core.handoff.start({ task: 'second-task', objective: 'Second goal' });

  const context = await core.compose({});
  assert.equal(context.handoff.id, second.id);
  assert.match(context.content, /Second goal/);
  assert.doesNotMatch(context.content, /First goal/);

  const selectedFirst = await core.handoff.select({ id: first.id });
  assert.equal(selectedFirst.id, first.id);
  const afterSelection = await core.compose({});
  assert.equal(afterSelection.handoff.id, first.id);
  assert.match(afterSelection.content, /First goal/);
  assert.doesNotMatch(afterSelection.content, /Second goal/);

  const selected = await core.compose({ task: 'second-task' });
  assert.equal(selected.handoff.id, second.id);
  assert.match(selected.content, /Second goal/);
  assert.doesNotMatch(selected.content, /First goal/);
});

test('current branch disambiguates active handoffs in the same worktree', async (t) => {
  const { repository, env, clock } = await fixture(t);
  const core = createCore({ env, cwd: repository, clock });
  await core.repo.resolve();
  await core.handoff.start({ task: 'main-work', objective: 'Work on main' });
  await git(repository, 'checkout', '-b', 'feature/context');
  const feature = await core.handoff.start({
    task: 'feature-work',
    objective: 'Work on the feature branch',
  });

  const context = await core.compose({});
  assert.equal(context.handoff.id, feature.id);
  assert.match(context.content, /Work on the feature branch/);
  assert.doesNotMatch(context.content, /Work on main/);
});

test('mutations preflight the context budget and composition never truncates a block', async (t) => {
  const { repository, env, clock } = await fixture(t);
  const core = createCore({ env, cwd: repository, clock });
  await core.repo.resolve();
  await core.policy.set({ scope: 'global', content: 'x'.repeat(16 * 1024) });

  await assert.rejects(
    core.compose({ maxBytes: 1024 }),
    (error) =>
      error instanceof CoreError &&
      error.code === 'CONTEXT_TOO_LARGE' &&
      error.details.bytes > error.details.maxBytes &&
      error.message.includes('No partial context'),
  );
  await assert.rejects(
    core.policy.set({ scope: 'repo', content: 'y'.repeat(16 * 1024) }),
    (error) => error instanceof CoreError && error.code === 'CONTEXT_TOO_LARGE',
  );
  assert.equal((await core.policy.get({ scope: 'repo' })).exists, false);
  await assert.rejects(
    core.handoff.show({ id: '../../../../config' }),
    (error) => error instanceof CoreError && error.code === 'INVALID_HANDOFF_ID',
  );
});
