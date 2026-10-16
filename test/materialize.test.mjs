import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyOperations } from '../src/fs-operations.mjs';
import { withFileLockDeadline } from '../src/core/fs.mjs';
import {
  CURSOR_RULE_OWNERSHIP_MARKER,
  MaterializeError,
  installExcludeBlock,
  planCursorDematerialization,
  planCursorMaterialization,
  removeExcludeBlock,
  renderCursorRule,
  materializeCursor,
} from '../src/materialize.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

async function repositoryFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-materialize-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '--initial-branch=main');
  return {
    root,
    rule: path.join(root, '.cursor', 'rules', '50-hnd.mdc'),
    exclude: path.join(root, '.git', 'info', 'exclude'),
  };
}

test('exclude marker round-trips user bytes with LF, CRLF, and no final newline', () => {
  for (const source of ['', 'user-pattern', 'user-pattern\n', 'user-pattern\r\n']) {
    const installed = installExcludeBlock(source, { previousFile: source !== '' });
    assert.match(installed, /hnd managed cursor fallback/);
    assert.equal(removeExcludeBlock(installed), source);
  }
});

test('exclude removal keeps user lines appended after a managed block separate', () => {
  for (const [source, appended, expected] of [
    ['user-pattern', 'later-pattern\n', 'user-pattern\nlater-pattern\n'],
    ['user-pattern\r\nnext-pattern', 'later-pattern\r\n', 'user-pattern\r\nnext-pattern\r\nlater-pattern\r\n'],
  ]) {
    const installed = installExcludeBlock(source);
    assert.equal(removeExcludeBlock(`${installed}${appended}`), expected);
  }
});

test('materialization owns one Cursor rule, is idempotent, and uninstall restores exclude bytes', async (t) => {
  const fixture = await repositoryFixture(t);
  const originalExclude = 'node_modules/\n# user bytes stay exact';
  await fs.writeFile(fixture.exclude, originalExclude);

  const first = await planCursorMaterialization({ cwd: fixture.root, content: 'FIRST-CONTEXT\n' });
  assert.deepEqual(first.operations.map((operation) => operation.component), [
    'cursor-exclude',
    'cursor-rule',
  ]);
  await applyOperations(first.operations);

  const rule = await fs.readFile(fixture.rule, 'utf8');
  assert.equal(rule, renderCursorRule('FIRST-CONTEXT\n'));
  assert.match(rule, /alwaysApply: true/);
  assert.match(rule, new RegExp(CURSOR_RULE_OWNERSHIP_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(git(fixture.root, 'check-ignore', '.cursor/rules/50-hnd.mdc'), '.cursor/rules/50-hnd.mdc');
  assert.deepEqual(
    (await planCursorMaterialization({ cwd: fixture.root, content: 'FIRST-CONTEXT\n' })).operations,
    [],
  );

  const update = await planCursorMaterialization({ cwd: fixture.root, content: 'SECOND-CONTEXT' });
  assert.deepEqual(update.operations.map((operation) => operation.component), ['cursor-rule']);
  await applyOperations(update.operations);
  assert.equal(await fs.readFile(fixture.rule, 'utf8'), renderCursorRule('SECOND-CONTEXT'));

  const remove = await planCursorDematerialization({ cwd: fixture.root });
  assert.deepEqual(remove.operations.map((operation) => operation.component), [
    'cursor-rule',
    'cursor-exclude',
  ]);
  await applyOperations(remove.operations);
  await assert.rejects(fs.stat(fixture.rule), { code: 'ENOENT' });
  assert.equal(await fs.readFile(fixture.exclude, 'utf8'), originalExclude);
});

test('a previously missing exclude file is removed again on uninstall', async (t) => {
  const fixture = await repositoryFixture(t);
  await fs.rm(fixture.exclude);
  await applyOperations(
    (await planCursorMaterialization({ cwd: fixture.root, content: 'context' })).operations,
  );
  assert.match(await fs.readFile(fixture.exclude, 'utf8'), /previous-file=0/);
  await applyOperations((await planCursorDematerialization({ cwd: fixture.root })).operations);
  await assert.rejects(fs.stat(fixture.exclude), { code: 'ENOENT' });
});

test('an unmanaged or malformed Cursor target is never overwritten or removed', async (t) => {
  const fixture = await repositoryFixture(t);
  await fs.mkdir(path.dirname(fixture.rule), { recursive: true });
  const unmanaged = '---\nalwaysApply: true\n---\nUSER RULE\n';
  await fs.writeFile(fixture.rule, unmanaged);
  const excludeBefore = await fs.readFile(fixture.exclude, 'utf8');

  await assert.rejects(
    planCursorMaterialization({ cwd: fixture.root, content: 'hnd' }),
    (error) => error instanceof MaterializeError && error.code === 'MATERIALIZE_CONFLICT',
  );
  assert.equal(await fs.readFile(fixture.rule, 'utf8'), unmanaged);
  assert.equal(await fs.readFile(fixture.exclude, 'utf8'), excludeBefore);

  const uninstall = await planCursorDematerialization({ cwd: fixture.root });
  assert.deepEqual(uninstall.operations, []);
  assert.equal(await fs.readFile(fixture.rule, 'utf8'), unmanaged);

  await fs.writeFile(fixture.rule, `${CURSOR_RULE_OWNERSHIP_MARKER}\ncorrupt`);
  await assert.rejects(
    planCursorDematerialization({ cwd: fixture.root }),
    (error) => error instanceof MaterializeError && error.code === 'MATERIALIZE_CONFLICT',
  );
});

test('materialization refuses a Cursor rule path already tracked by Git', async (t) => {
  const fixture = await repositoryFixture(t);
  await fs.mkdir(path.dirname(fixture.rule), { recursive: true });
  await fs.writeFile(fixture.rule, 'tracked placeholder\n');
  git(fixture.root, 'add', '--', '.cursor/rules/50-hnd.mdc');
  await fs.rm(fixture.rule);

  await assert.rejects(
    planCursorMaterialization({ cwd: fixture.root, content: 'private context' }),
    (error) => error instanceof MaterializeError && error.code === 'MATERIALIZE_CONFLICT',
  );
  await assert.rejects(fs.stat(fixture.rule), { code: 'ENOENT' });
  assert.match(git(fixture.root, 'ls-files', '--stage', '--', '.cursor/rules/50-hnd.mdc'), /50-hnd\.mdc/);
});

test('edited or duplicate exclude ownership markers fail closed', () => {
  const installed = installExcludeBlock('user\n');
  assert.throws(
    () => removeExcludeBlock(installed.replace('/.cursor/rules/50-hnd.mdc', '/user-rule')),
    (error) => error.code === 'MATERIALIZE_CONFLICT',
  );
  assert.throws(
    () => installExcludeBlock(`${installed}${installed}`),
    (error) => error.code === 'MATERIALIZE_CONFLICT',
  );
});

test('materialization refuses a symlinked Cursor directory', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await repositoryFixture(t);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-materialize-external-'));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.symlink(external, path.join(fixture.root, '.cursor'), 'dir');

  await assert.rejects(
    planCursorMaterialization({ cwd: fixture.root, content: 'must-not-escape' }),
    (error) => error.code === 'MATERIALIZE_CONFLICT',
  );
  await assert.rejects(fs.stat(path.join(external, 'rules', '50-hnd.mdc')), { code: 'ENOENT' });
});

test('Git ignore negations cannot expose private Cursor context', async (t) => {
  for (const relative of ['.gitignore', '.cursor/.gitignore', '.cursor/rules/.gitignore']) {
    const fixture = await repositoryFixture(t);
    const ignore = path.join(fixture.root, relative);
    await fs.mkdir(path.dirname(ignore), { recursive: true });
    await fs.writeFile(ignore, '!50-hnd.mdc\n!rules/50-hnd.mdc\n!.cursor/rules/50-hnd.mdc\n');
    const originalExclude = await fs.readFile(fixture.exclude, 'utf8');
    await assert.rejects(
      planCursorMaterialization({ cwd: fixture.root, content: 'PRIVATE CONTEXT' }),
      (error) => error.code === 'MATERIALIZE_CONFLICT' && /negation/u.test(error.message),
    );
    await assert.rejects(fs.stat(fixture.rule), { code: 'ENOENT' });
    assert.equal(await fs.readFile(fixture.exclude, 'utf8'), originalExclude);
  }
});

test('a new exclude block supersedes earlier info/exclude negations but edited precedence fails closed', async (t) => {
  const fixture = await repositoryFixture(t);
  await fs.writeFile(fixture.exclude, '!/.cursor/rules/50-hnd.mdc\n');
  await applyOperations((await planCursorMaterialization({ cwd: fixture.root, content: 'private' })).operations);
  assert.equal(git(fixture.root, 'check-ignore', '.cursor/rules/50-hnd.mdc'), '.cursor/rules/50-hnd.mdc');
  await fs.appendFile(fixture.exclude, '!/.cursor/rules/50-hnd.mdc\n');
  await assert.rejects(planCursorMaterialization({ cwd: fixture.root, content: 'updated private' }), { code: 'MATERIALIZE_CONFLICT' });
  assert.equal(await fs.readFile(fixture.rule, 'utf8'), renderCursorRule('private'));
});

test('actual refresh removes generated private context exposed by changed ignore rules, while preview preserves it', async (t) => {
  const fixture = await repositoryFixture(t);
  await materializeCursor({ cwd: fixture.root, content: 'PRIVATE ORIGINAL' });
  await fs.writeFile(path.join(fixture.root, '.gitignore'), '!.cursor/rules/50-hnd.mdc\n');
  await assert.rejects(materializeCursor({ cwd: fixture.root, content: 'PRIVATE UPDATED', dryRun: true }), { code: 'MATERIALIZE_CONFLICT' });
  assert.match(await fs.readFile(fixture.rule, 'utf8'), /PRIVATE ORIGINAL/u);
  await assert.rejects(materializeCursor({ cwd: fixture.root, content: 'PRIVATE UPDATED' }), { code: 'MATERIALIZE_CONFLICT' });
  await assert.rejects(fs.stat(fixture.rule), { code: 'ENOENT' });
});

test('removing one worktree rule preserves the shared ignore protection of other worktrees', async (t) => {
  const fixture = await repositoryFixture(t);
  git(fixture.root, '-c', 'user.email=hnd@example.invalid', '-c', 'user.name=hnd', 'commit', '--allow-empty', '-m', 'initial');
  const other = path.join(path.dirname(fixture.root), `${path.basename(fixture.root)}-worktree`);
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  git(fixture.root, 'worktree', 'add', '-b', 'second', other);
  for (const cwd of [fixture.root, other]) {
    await applyOperations((await planCursorMaterialization({ cwd, content: `PRIVATE ${cwd}` })).operations);
  }
  await applyOperations((await planCursorDematerialization({ cwd: fixture.root })).operations);
  assert.equal(git(other, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(git(other, 'check-ignore', '.cursor/rules/50-hnd.mdc'), '.cursor/rules/50-hnd.mdc');
  assert.match(await fs.readFile(path.join(other, '.cursor/rules/50-hnd.mdc'), 'utf8'), /PRIVATE/u);
});

test('Cursor Git inspection cannot outlive its hook deadline through inherited helper pipes', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await repositoryFixture(t);
  const originalPath = process.env.PATH;
  const actualGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(fixture.root, 'fake-bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'git'), `#!/bin/sh\ncase "$*" in *check-ignore*) sleep 5 ;; esac\nexec '${actualGit.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  try {
    const started = Date.now();
    await assert.rejects(
      withFileLockDeadline(started + 500, () => planCursorMaterialization({ cwd: fixture.root, content: 'must stay private' })),
      (error) => ['GIT_TIMEOUT', 'OPERATION_DEADLINE_EXCEEDED'].includes(error.code),
    );
    assert.ok(Date.now() - started < 1_200, 'inherited pipes must not keep the hook waiting for the helper');
    await assert.rejects(fs.stat(fixture.rule), { code: 'ENOENT' });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});
