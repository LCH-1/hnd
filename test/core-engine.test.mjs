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

test('a live long-running lock holder is not displaced after staleMs', async (t) => {
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
  }, { timeoutMs: 1_000, staleMs: 20 });
  await firstIsEntered;
  const acquiredMetadata = await fs.stat(lockFile);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const heartbeatMetadata = await fs.stat(lockFile);
  assert.ok(heartbeatMetadata.mtimeMs > acquiredMetadata.mtimeMs);

  try {
    await assert.rejects(
      withFileLock(lockFile, async () => {}, { timeoutMs: 75, staleMs: 20 }),
      (error) => error instanceof CoreError && error.code === 'STATE_BUSY',
    );
  } finally {
    releaseFirst();
    await first;
  }

  await withFileLock(lockFile, async () => {}, { timeoutMs: 1_000, staleMs: 20 });
  await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
});

test('a delayed lock publication never exposes an incomplete live lease', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-lock-publication-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, 'state.lock');

  const originalOpen = fs.open;
  let delayFirstPublication = true;
  let publicationStarted;
  const firstPublicationStarted = new Promise((resolve) => { publicationStarted = resolve; });
  fs.open = async function delayAfterCreatingFirstLease(file, flags, ...args) {
    const handle = await originalOpen.call(this, file, flags, ...args);
    if (
      flags === 'wx'
      && delayFirstPublication
      && (file === lockFile || (file.startsWith(`${lockFile}.`) && file.endsWith('.pending')))
    ) {
      delayFirstPublication = false;
      publicationStarted();
      // Longer than the minimum incomplete-record grace. Publishing an empty
      // lock inode before this pause lets a waiter reclaim it and enter too.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    }
    return handle;
  };

  let active = 0;
  let maximumActive = 0;
  const enter = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 500));
    active -= 1;
  };
  try {
    const first = withFileLock(lockFile, enter, { timeoutMs: 4_000, staleMs: 1 });
    await firstPublicationStarted;
    const second = withFileLock(lockFile, enter, { timeoutMs: 4_000, staleMs: 1 });
    await Promise.all([first, second]);
  } finally {
    fs.open = originalOpen;
  }

  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
  await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('a same-process stale lock left by a failed release is reclaimed', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-lock-orphan-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, 'state.lock');

  const originalUnlink = fs.unlink;
  let rejectRelease = true;
  fs.unlink = async function failFirstRelease(file, ...args) {
    if (file === lockFile && rejectRelease) {
      rejectRelease = false;
      const error = new Error('simulated release failure');
      error.code = 'EACCES';
      throw error;
    }
    return originalUnlink.call(this, file, ...args);
  };
  try {
    await assert.rejects(
      withFileLock(lockFile, async () => {}, { timeoutMs: 1_000, staleMs: 1 }),
      { code: 'EACCES' },
    );
  } finally {
    fs.unlink = originalUnlink;
  }

  const orphan = JSON.parse(await fs.readFile(lockFile, 'utf8'));
  assert.equal(orphan.pid, process.pid);
  await fs.utimes(lockFile, new Date(0), new Date(0));

  let entered = false;
  await withFileLock(lockFile, async () => {
    entered = true;
  }, { timeoutMs: 1_000, staleMs: 1 });
  assert.equal(entered, true);
  await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
});

test('an out-of-range PID cannot make a corrupt stale lock permanent', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-lock-invalid-pid-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, 'state.lock');
  const old = new Date(0);
  await fs.writeFile(lockFile, `${JSON.stringify({
    owner: 'invalid-pid-owner',
    pid: 0x80000000,
    acquiredAt: old.toISOString(),
  })}\n`);
  await fs.utimes(lockFile, old, old);

  let entered = false;
  await withFileLock(lockFile, async () => {
    entered = true;
  }, { timeoutMs: 2_000, staleMs: 1 });
  assert.equal(entered, true);
  await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
});

test('a heartbeat after stale inspection prevents snapshot removal', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-lock-heartbeat-race-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, 'state.lock');
  const old = new Date(0);
  await fs.writeFile(lockFile, `${JSON.stringify({
    owner: 'namespace-hidden-owner',
    pid: 0x7fffffff,
    acquiredAt: old.toISOString(),
  })}\n`);
  await fs.utimes(lockFile, old, old);

  const originalOpen = fs.open;
  let readOpenCount = 0;
  fs.open = async function heartbeatBeforeRemoval(file, flags, ...args) {
    const handle = await originalOpen.call(this, file, flags, ...args);
    if (file === lockFile && typeof flags === 'number') {
      readOpenCount += 1;
      if (readOpenCount === 2) {
        const now = new Date();
        await fs.utimes(lockFile, now, now);
      }
    }
    return handle;
  };
  try {
    await assert.rejects(
      withFileLock(lockFile, async () => {}, { timeoutMs: 100, staleMs: 1_000 }),
      (error) => error instanceof CoreError && error.code === 'STATE_BUSY',
    );
  } finally {
    fs.open = originalOpen;
  }

  assert.equal(readOpenCount >= 2, true);
  assert.equal(JSON.parse(await fs.readFile(lockFile, 'utf8')).owner, 'namespace-hidden-owner');
  assert.ok((await fs.stat(lockFile)).mtimeMs > old.getTime());
});

test('an orphaned deletion guard does not permanently block the lock', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-lock-guard-orphan-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, 'state.lock');
  const guardFile = `${lockFile}.delete`;
  const recoveryFile = `${guardFile}.recovery`;
  await fs.writeFile(lockFile, `${JSON.stringify({
    owner: 'orphaned-lock-owner',
    acquiredAt: new Date(0).toISOString(),
  })}\n`);
  // Older HND releases created an empty deletion-guard file, so recovery must
  // also handle that exact crash artifact.
  await fs.writeFile(guardFile, '');
  // A second crash while reclaiming the guard must not move the permanent
  // blockage to the recovery lease.
  await fs.writeFile(recoveryFile, '');
  await fs.utimes(lockFile, new Date(0), new Date(0));
  await fs.utimes(guardFile, new Date(0), new Date(0));
  await fs.utimes(recoveryFile, new Date(0), new Date(0));

  let entered = false;
  await withFileLock(lockFile, async () => {
    entered = true;
  }, { timeoutMs: 1_000, staleMs: 1 });
  assert.equal(entered, true);
  await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
  await assert.rejects(fs.stat(guardFile), { code: 'ENOENT' });
  await assert.rejects(fs.stat(recoveryFile), { code: 'ENOENT' });
});

test('lock, deletion guard, and recovery lease symlinks fail closed', async (t) => {
  if (process.platform === 'win32') t.skip('symlink creation requires elevated privileges on Windows');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-lock-symlink-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const old = new Date(0);

  for (const lease of ['lock', 'guard', 'recovery']) {
    const lockFile = path.join(directory, `${lease}.lock`);
    const guardFile = `${lockFile}.delete`;
    const recoveryFile = `${guardFile}.recovery`;
    const leaseFile = lease === 'lock'
      ? lockFile
      : lease === 'guard'
        ? guardFile
        : recoveryFile;
    const target = path.join(directory, `${lease}.outside`);
    const targetSource = `outside-${lease}\n`;
    await fs.writeFile(target, targetSource);
    await fs.utimes(target, old, old);

    if (lease !== 'lock') {
      await fs.writeFile(lockFile, `${JSON.stringify({
        owner: `orphaned-lock-${lease}`,
        pid: process.pid,
        acquiredAt: old.toISOString(),
      })}\n`);
      await fs.utimes(lockFile, old, old);
    }
    if (lease === 'recovery') {
      await fs.writeFile(guardFile, `${JSON.stringify({
        owner: 'orphaned-guard-recovery',
        pid: process.pid,
        acquiredAt: old.toISOString(),
      })}\n`);
      await fs.utimes(guardFile, old, old);
    }
    await fs.symlink(target, leaseFile);

    await assert.rejects(
      withFileLock(lockFile, async () => {}, { timeoutMs: 250, staleMs: 1 }),
      (error) => (
        error instanceof CoreError
        && error.code === 'UNSAFE_STATE_PATH'
        && error.details?.path === leaseFile
      ),
    );
    assert.equal(await fs.readFile(target, 'utf8'), targetSource);
    assert.equal((await fs.lstat(leaseFile)).isSymbolicLink(), true);
  }
});

test('lock, deletion guard, and recovery lease FIFOs fail closed without blocking', async (t) => {
  if (process.platform === 'win32') t.skip('FIFO files are not available on Windows');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-lock-fifo-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const old = new Date(0);

  for (const lease of ['lock', 'guard', 'recovery']) {
    const lockFile = path.join(directory, `${lease}.lock`);
    const guardFile = `${lockFile}.delete`;
    const recoveryFile = `${guardFile}.recovery`;
    const leaseFile = lease === 'lock'
      ? lockFile
      : lease === 'guard'
        ? guardFile
        : recoveryFile;

    if (lease !== 'lock') {
      await fs.writeFile(lockFile, `${JSON.stringify({
        owner: `orphaned-lock-${lease}`,
        pid: process.pid,
        acquiredAt: old.toISOString(),
      })}\n`);
      await fs.utimes(lockFile, old, old);
    }
    if (lease === 'recovery') {
      await fs.writeFile(guardFile, `${JSON.stringify({
        owner: 'orphaned-guard-recovery-fifo',
        pid: process.pid,
        acquiredAt: old.toISOString(),
      })}\n`);
      await fs.utimes(guardFile, old, old);
    }
    await execFileAsync('mkfifo', [leaseFile]);

    await assert.rejects(
      withFileLock(lockFile, async () => {}, { timeoutMs: 250, staleMs: 1 }),
      (error) => (
        error instanceof CoreError
        && error.code === 'UNSAFE_STATE_PATH'
        && error.details?.path === leaseFile
      ),
    );
    assert.equal((await fs.lstat(leaseFile)).isFIFO(), true);
  }
});

test('regular guard and recovery generation churn is retried safely', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-lock-generation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const old = new Date(0);

  for (const lease of ['guard', 'recovery']) {
    const lockFile = path.join(directory, `${lease}.lock`);
    const guardFile = `${lockFile}.delete`;
    const recoveryFile = `${guardFile}.recovery`;
    const churnFile = lease === 'guard' ? guardFile : recoveryFile;
    for (const [file, owner] of [
      [lockFile, `orphaned-lock-${lease}`],
      [guardFile, `orphaned-guard-${lease}`],
      ...(lease === 'recovery'
        ? [[recoveryFile, 'orphaned-recovery-generation']]
        : []),
    ]) {
      await fs.writeFile(file, `${JSON.stringify({
        owner,
        pid: process.pid,
        acquiredAt: old.toISOString(),
      })}\n`);
      await fs.utimes(file, old, old);
    }

    const originalLstat = fs.lstat;
    let churnLstatCount = 0;
    fs.lstat = async function replaceBetweenOpenAndVerification(file, ...args) {
      if (file === churnFile) {
        churnLstatCount += 1;
        if (churnLstatCount === 2) {
          await fs.unlink(file);
          await fs.writeFile(file, `${JSON.stringify({
            owner: `replacement-${lease}`,
            pid: process.pid,
            acquiredAt: old.toISOString(),
          })}\n`);
          await fs.utimes(file, old, old);
        }
      }
      return originalLstat.call(this, file, ...args);
    };
    try {
      await withFileLock(lockFile, async () => {}, { timeoutMs: 2_000, staleMs: 1 });
    } finally {
      fs.lstat = originalLstat;
    }

    assert.equal(churnLstatCount >= 2, true);
    await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
    await assert.rejects(fs.stat(guardFile), { code: 'ENOENT' });
    await assert.rejects(fs.stat(recoveryFile), { code: 'ENOENT' });
  }
});

test('competing waiters recover stale lock leases without violating mutual exclusion', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-lock-waiters-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  let activeReplacement = 0;
  let maximumActiveReplacements = 0;
  const waiterCount = 12;
  const old = new Date(0);
  for (let round = 0; round < 5; round += 1) {
    const lockFile = path.join(directory, `state-${round}.lock`);
    const guardFile = `${lockFile}.delete`;
    const recoveryFile = `${guardFile}.recovery`;
    for (const [file, owner] of [
      [lockFile, `orphaned-lock-${round}`],
      [guardFile, `orphaned-guard-${round}`],
      [recoveryFile, `orphaned-recovery-${round}`],
    ]) {
      await fs.writeFile(file, `${JSON.stringify({
        owner,
        pid: process.pid,
        acquiredAt: old.toISOString(),
      })}\n`);
      await fs.utimes(file, old, old);
    }

    const waiters = Array.from({ length: waiterCount }, (_, index) => withFileLock(
      lockFile,
      async () => {
        activeReplacement += 1;
        maximumActiveReplacements = Math.max(maximumActiveReplacements, activeReplacement);
        await new Promise((resolve) => setTimeout(resolve, 5 + (index % 3)));
        activeReplacement -= 1;
      },
      { timeoutMs: 5_000, staleMs: 1 },
    ));

    await Promise.all(waiters);
    await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
    await assert.rejects(fs.stat(guardFile), { code: 'ENOENT' });
    await assert.rejects(fs.stat(recoveryFile), { code: 'ENOENT' });
  }
  assert.equal(maximumActiveReplacements, 1);
  assert.equal(activeReplacement, 0);
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
