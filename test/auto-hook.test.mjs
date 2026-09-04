import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';

function captureStream() {
  let value = '';
  return {
    write(chunk) {
      value += String(chunk);
      return true;
    },
    value: () => value,
  };
}

test('session start automatically registers a Git checkout with its own default environment', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-auto-register-hook-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'work');
  await fs.mkdir(repository);
  execFileSync('git', ['-C', repository, 'init', '--initial-branch=main']);
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'hnd test']);
  await fs.writeFile(path.join(repository, 'README.md'), '# auto register\n');
  execFileSync('git', ['-C', repository, 'add', 'README.md']);
  execFileSync('git', ['-C', repository, 'commit', '-m', 'initial']);
  const env = {
    ...process.env,
    HND_HOME: path.join(root, 'state'),
    HND_USER_HOME: path.join(root, 'user'),
  };
  const stdout = captureStream();
  const stderr = captureStream();
  await main(['hook', 'codex', 'start'], {
    env,
    cwd: repository,
    stdin: Readable.from([JSON.stringify({ cwd: repository, session_id: 'first' })]),
    stdout,
    stderr,
  });
  const wire = JSON.parse(stdout.value());
  assert.match(wire.hookSpecificOutput.additionalContext, /hnd live context/u);

  const statusOut = captureStream();
  await main(['status', '--json'], {
    env,
    cwd: repository,
    stdin: Readable.from([]),
    stdout: statusOut,
    stderr: captureStream(),
  });
  const status = JSON.parse(statusOut.value());
  assert.equal(status.repository.repository.name, 'work');
  assert.equal(status.environment, 'default');
});

test('stop hooks save progress by default, deduplicate at session end, and honor auto off', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-auto-hook-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'work');
  await fs.mkdir(repository);
  execFileSync('git', ['-C', repository, 'init', '--initial-branch=main']);
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'hnd test']);
  await fs.writeFile(path.join(repository, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', repository, 'add', 'README.md']);
  execFileSync('git', ['-C', repository, 'commit', '-m', 'initial']);
  const env = {
    ...process.env,
    HND_HOME: path.join(root, 'state'),
    HND_USER_HOME: path.join(root, 'user'),
  };

  const run = async (args, payload = '', overrides = {}) => {
    const stdout = captureStream();
    const stderr = captureStream();
    await main(args, {
      env: { ...env, ...overrides },
      cwd: repository,
      stdin: Readable.from([payload]),
      stdout,
      stderr,
    });
    return { stdout: stdout.value(), stderr: stderr.value() };
  };

  await run(['init']);
  await fs.writeFile(path.join(repository, 'progress.txt'), 'one\n');
  const stopped = await run(
    ['hook', 'codex', 'stop'],
    JSON.stringify({ cwd: repository, session_id: 'session-1' }),
  );
  assert.deepEqual(JSON.parse(stopped.stdout), {});
  assert.equal(stopped.stderr, '');

  const first = JSON.parse((await run(['status', '--json'])).stdout).checkpoint;
  assert.equal(first.agent, 'codex');
  assert.equal(first.totalChanges, 1);
  assert.equal(first.changes[0].path, 'progress.txt');

  const ended = await run(
    ['hook', 'codex', 'end'],
    JSON.stringify({ cwd: repository, session_id: 'session-1' }),
  );
  assert.equal(ended.stdout, '');
  const duplicate = JSON.parse((await run(['status', '--json'])).stdout).checkpoint;
  assert.equal(duplicate.capturedAt, first.capturedAt);
  assert.equal(duplicate.fingerprint, first.fingerprint);

  await run(['auto', 'off']);
  await fs.writeFile(path.join(repository, 'disabled.txt'), 'two\n');
  await run(['hook', 'claude', 'stop'], JSON.stringify({ cwd: repository }));
  const disabled = JSON.parse((await run(['status', '--json'])).stdout).checkpoint;
  assert.equal(disabled.fingerprint, first.fingerprint);

  await run(['auto', 'on']);
  await run(
    ['hook', 'cursor', 'stop'],
    JSON.stringify({ workspace_roots: [repository] }),
  );
  const cursor = JSON.parse((await run(['status', '--json'])).stdout).checkpoint;
  assert.equal(cursor.agent, 'cursor');
  assert.equal(cursor.totalChanges, 2);
});
