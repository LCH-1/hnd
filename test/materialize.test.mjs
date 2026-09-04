import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyOperations } from '../src/fs-operations.mjs';
import {
  CURSOR_RULE_OWNERSHIP_MARKER,
  MaterializeError,
  installExcludeBlock,
  planCursorDematerialization,
  planCursorMaterialization,
  removeExcludeBlock,
  renderCursorRule,
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
