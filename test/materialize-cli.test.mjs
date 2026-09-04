import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { createCore } from '../src/core/index.mjs';
import { CURSOR_RULE_OWNERSHIP_MARKER } from '../src/materialize.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

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

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-materialize-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo');
  const userHome = path.join(root, 'user');
  const stateHome = path.join(root, 'state');
  await fs.mkdir(repository, { recursive: true });
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.email', 'hnd-test@example.invalid');
  git(repository, 'config', 'user.name', 'hnd test');
  await fs.writeFile(path.join(repository, 'README.md'), '# fixture\n');
  git(repository, 'add', 'README.md');
  git(repository, 'commit', '-m', 'initial');
  const env = {
    ...process.env,
    LANG: 'en_US.UTF-8',
    LC_ALL: '',
    HND_HOME: stateHome,
    HND_USER_HOME: userHome,
  };
  const run = async (argv, input = '') => {
    const stdout = captureStream();
    const stderr = captureStream();
    await main(argv, {
      cwd: repository,
      env,
      stdin: Readable.from([input]),
      stdout,
      stderr,
      binPath: path.resolve('bin/hnd.mjs'),
    });
    return { stdout: stdout.value(), stderr: stderr.value() };
  };
  return {
    root,
    repository,
    env,
    run,
    rule: path.join(repository, '.cursor', 'rules', '50-hnd.mdc'),
    exclude: path.join(repository, '.git', 'info', 'exclude'),
  };
}

test('CLI mutations refresh Cursor fallback and uninstall restores user exclude bytes', async (t) => {
  const item = await fixture(t);
  const originalExclude = `${await fs.readFile(item.exclude, 'utf8')}# exact-user-tail`;
  await fs.writeFile(item.exclude, originalExclude);

  await item.run(['init', '--env', 'laptop']);
  let rule = await fs.readFile(item.rule, 'utf8');
  assert.match(rule, /alwaysApply: true/);
  assert.match(rule, /hnd live context/);

  await item.run(['policy', 'set', 'repo', '--text', 'CURSOR-REPO-POLICY']);
  rule = await fs.readFile(item.rule, 'utf8');
  assert.match(rule, /CURSOR-REPO-POLICY/);

  const materialized = JSON.parse((await item.run(['materialize', '--json'])).stdout);
  assert.equal(materialized.operations.length, 0);
  assert.equal(materialized.path, item.rule);

  await item.run(['setup', '--agents', 'cursor']);
  await item.run(['uninstall', '--agents', 'cursor']);
  await assert.rejects(fs.stat(item.rule), { code: 'ENOENT' });
  assert.equal(await fs.readFile(item.exclude, 'utf8'), originalExclude);

  await item.run(['policy', 'set', 'repo', '--text', 'AFTER-CURSOR-UNINSTALL']);
  await assert.rejects(fs.stat(item.rule), { code: 'ENOENT' });
  assert.equal(await fs.readFile(item.exclude, 'utf8'), originalExclude);
});

test('setup installs the fallback and cursor hook preserves output when a user target conflicts', async (t) => {
  const item = await fixture(t);
  const core = createCore({ env: item.env, cwd: item.repository });
  await core.init();
  await core.repo.resolve({ create: true });
  await core.policy.set({ scope: 'repo', content: 'SETUP-MATERIALIZED' });

  const dryRun = JSON.parse((await item.run([
    'setup', '--agents', 'cursor', '--dry-run', '--json',
  ])).stdout);
  assert.ok(dryRun.operations.some((operation) => operation.component === 'cursor-rule'));
  await assert.rejects(fs.stat(item.rule), { code: 'ENOENT' });

  await item.run(['setup', '--agents', 'cursor']);
  const repeatedSetup = await item.run(['setup', '--agents', 'cursor']);
  assert.equal(repeatedSetup.stdout, 'Setup is already complete. No changes needed.\n');
  assert.match(await fs.readFile(item.rule, 'utf8'), /SETUP-MATERIALIZED/);
  await item.run(['uninstall', '--agents', 'cursor']);

  await fs.mkdir(path.dirname(item.rule), { recursive: true });
  const userRule = '---\nalwaysApply: true\n---\nUSER-CURSOR-RULE\n';
  await fs.writeFile(item.rule, userRule);
  const hook = await item.run(['hook', 'cursor'], JSON.stringify({ cwd: item.repository }));
  assert.match(JSON.parse(hook.stdout).additional_context, /SETUP-MATERIALIZED/);
  assert.match(hook.stderr, /Cursor fallback update failed/);
  assert.equal(await fs.readFile(item.rule, 'utf8'), userRule);
  assert.equal(userRule.includes(CURSOR_RULE_OWNERSHIP_MARKER), false);
});
