import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArgs, optionBoolean, optionList, UsageError } from '../src/args.mjs';
import { applyOperations, OperationConflictError } from '../src/fs-operations.mjs';

test('argument parsing retains repeated structured handoff fields', () => {
  const parsed = parseArgs([
    'handoff', 'save', 'task-1',
    '--decision', 'use hooks',
    '--decision=keep local cache',
    '--json',
  ]);
  assert.deepEqual(parsed.positionals, ['handoff', 'save', 'task-1']);
  assert.deepEqual(optionList(parsed.options.decision), ['use hooks', 'keep local cache']);
  assert.equal(optionBoolean(parsed.options, 'json'), true);
});

test('boolean options reject ambiguous values', () => {
  assert.throws(
    () => optionBoolean({ dry_run: 'perhaps' }, 'dry_run'),
    UsageError,
  );
});

test('file operations are atomic, idempotent, and conflict-aware', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-ops-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'agent', 'hooks.json');
  const operation = {
    kind: 'write',
    path: target,
    content: '{"hooks":{}}\n',
    previous: undefined,
    agent: 'codex',
    component: 'hooks',
  };

  const preview = await applyOperations([operation], { dryRun: true });
  assert.equal(preview[0].changed, true);
  await assert.rejects(fs.access(target));

  const written = await applyOperations([operation]);
  assert.equal(written[0].changed, true);
  assert.equal(await fs.readFile(target, 'utf8'), operation.content);

  const unchanged = await applyOperations([{ ...operation, previous: operation.content }]);
  assert.equal(unchanged[0].changed, false);

  await fs.writeFile(target, 'user changed this\n');
  await assert.rejects(
    applyOperations([{ ...operation, previous: operation.content }]),
    OperationConflictError,
  );
});

test('file operations never follow a target symlink', async (context) => {
  if (process.platform === 'win32') {
    context.skip('Windows symlink creation requires environment-specific privileges');
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-ops-symlink-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outside = path.join(directory, 'outside.json');
  const target = path.join(directory, 'hooks.json');
  await fs.writeFile(outside, 'user-owned\n');
  await fs.symlink(outside, target);

  await assert.rejects(applyOperations([{
    kind: 'write',
    path: target,
    content: 'managed\n',
    previous: 'user-owned\n',
  }]), OperationConflictError);
  await assert.rejects(applyOperations([{
    kind: 'remove',
    path: target,
    previous: 'user-owned\n',
  }]), OperationConflictError);
  assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(outside, 'utf8'), 'user-owned\n');
});
