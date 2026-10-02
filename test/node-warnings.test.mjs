import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { VERSION as RUNTIME_VERSION } from '../src/constants.mjs';
import {
  isSqliteExperimentalWarning,
  suppressSqliteExperimentalWarning,
} from '../src/node-warnings.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(projectRoot, 'bin', 'hnd.mjs');
const SQLITE_WARNING = 'SQLite is an experimental feature and might change at any time';

// Newer Node 24 releases no longer warn about node:sqlite. Recreate the older
// behavior by emitting the same warning at the moment node:sqlite is resolved.
const legacySqliteWarningPreload = `
import { registerHooks } from 'node:module';
let emitted = false;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!emitted && (specifier === 'node:sqlite' || specifier === 'sqlite')) {
      emitted = true;
      process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, 'ExperimentalWarning');
    }
    return nextResolve(specifier, context);
  },
});
`;

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-node-warnings-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('only the node:sqlite experimental warning is recognized', () => {
  assert.equal(isSqliteExperimentalWarning(SQLITE_WARNING, 'ExperimentalWarning'), true);
  assert.equal(isSqliteExperimentalWarning(SQLITE_WARNING, { type: 'ExperimentalWarning' }), true);
  assert.equal(isSqliteExperimentalWarning(
    Object.assign(new Error(SQLITE_WARNING), { name: 'ExperimentalWarning' }),
  ), true);

  assert.equal(isSqliteExperimentalWarning(SQLITE_WARNING), false);
  assert.equal(isSqliteExperimentalWarning(SQLITE_WARNING, 'Warning'), false);
  assert.equal(isSqliteExperimentalWarning(new Error(SQLITE_WARNING)), false);
  assert.equal(isSqliteExperimentalWarning(
    'WASI is an experimental feature and might change at any time',
    'ExperimentalWarning',
  ), false);
});

test('the warning filter forwards every other warning unchanged', () => {
  const calls = [];
  const target = {
    emitWarning(...args) {
      calls.push({ self: this, args });
      return 'forwarded';
    },
  };
  suppressSqliteExperimentalWarning(target);

  assert.equal(target.emitWarning(SQLITE_WARNING, 'ExperimentalWarning'), undefined);
  assert.equal(target.emitWarning(SQLITE_WARNING, { type: 'ExperimentalWarning', code: 'X' }), undefined);
  assert.deepEqual(calls, []);

  const options = { type: 'DeprecationWarning', code: 'DEP0001' };
  assert.equal(target.emitWarning('old API', options), 'forwarded');
  assert.equal(target.emitWarning('custom', 'Warning', 'CODE', Function), 'forwarded');
  assert.deepEqual(calls, [
    { self: target, args: ['old API', options] },
    { self: target, args: ['custom', 'Warning', 'CODE', Function] },
  ]);
});

test('hnd installs the filter before the launcher loads node:sqlite', async (t) => {
  const root = await temporaryDirectory(t);
  const preload = path.join(root, 'legacy-sqlite-warning.mjs');
  await fs.writeFile(preload, legacySqliteWarningPreload);
  const env = {
    ...process.env,
    HND_HOME: path.join(root, 'state'),
    HND_USER_HOME: path.join(root, 'user'),
    HND_DISABLE_AUTO_UPDATE: '1',
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_NO_WARNINGS;

  // Without the hnd entrypoint the simulated warning must reach stderr, or the
  // assertion below would pass without proving anything.
  const control = await execFileAsync(process.execPath, [
    '--import', preload, '--input-type=module', '--eval', "import 'node:sqlite';",
  ], { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
  assert.match(control.stderr, /ExperimentalWarning: SQLite is an experimental feature/u);

  const result = await execFileAsync(process.execPath, [
    '--import', preload, binPath, '--version',
  ], { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.stdout.trim(), RUNTIME_VERSION);
  assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/u);
});
