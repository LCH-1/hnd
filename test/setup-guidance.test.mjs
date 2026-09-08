import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { createCore } from '../src/core/index.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-setup-guidance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HND_HOME: path.join(root, 'state'),
    HND_USER_HOME: path.join(root, 'user'),
    LANG: 'en_US.UTF-8',
    LC_ALL: '',
    LC_MESSAGES: '',
  };
  const repository = async (name, { registered = true } = {}) => {
    const cwd = path.join(root, name);
    await fs.mkdir(cwd);
    execFileSync('git', ['init', '--initial-branch=main', cwd], { stdio: 'ignore' });
    if (registered) {
      const core = createCore({ env, cwd });
      await core.init();
      await core.repo.resolve({ create: true });
    }
    return cwd;
  };
  const run = async (cwd, args, language = 'en') => {
    let stdout = '';
    await main(args, {
      cwd,
      env: { ...env, LANG: language === 'ko' ? 'ko_KR.UTF-8' : 'en_US.UTF-8' },
      stdin: Readable.from([]),
      stdout: { write(chunk) { stdout += String(chunk); } },
      stderr: { write() {} },
      binPath: path.resolve('bin/hnd.mjs'),
    });
    return stdout;
  };
  return { root, env, repository, run };
}

test('setup shows only changed files across two projects and a single line when already configured', async (t) => {
  const item = await fixture(t);
  const first = await item.repository('first');
  const second = await item.repository('second');
  const firstOutput = await item.run(first, ['setup']);
  assert.match(firstOutput, /^Setup complete\./u);
  assert.ok(firstOutput.includes(path.join(first, '.cursor', 'rules', '50-hnd.mdc')));
  const commonFiles = [
    path.join(item.env.HND_USER_HOME, '.claude', 'settings.json'),
    path.join(item.env.HND_USER_HOME, '.codex', 'hooks.json'),
    path.join(item.env.HND_USER_HOME, '.cursor', 'hooks.json'),
  ];
  for (const file of commonFiles) assert.ok(firstOutput.includes(file));
  const before = await Promise.all(commonFiles.map((file) => fs.readFile(file, 'utf8')));
  const secondOutput = await item.run(second, ['setup']);
  assert.ok(secondOutput.includes(path.join(second, '.cursor', 'rules', '50-hnd.mdc')));
  for (const file of commonFiles) assert.ok(!secondOutput.includes(file));
  assert.doesNotMatch(secondOutput, /Identical files|Shared user settings|hnd doctor/u);
  assert.deepEqual(await Promise.all(commonFiles.map((file) => fs.readFile(file, 'utf8'))), before);

  const repeated = await item.run(second, ['setup']);
  assert.equal(repeated, 'Already configured.\n');
  assert.doesNotMatch(repeated, /No managed files found|Saved|approve the changed/u);
});

test('setup dry-run describes future work and preserves the JSON contract without writing files', async (t) => {
  const item = await fixture(t);
  const cwd = await item.repository('project');
  const preview = await item.run(cwd, ['setup', '--dry-run']);
  assert.match(preview, /^Preview: files will not be changed\./u);
  assert.match(preview, /Would save/u);
  assert.doesNotMatch(preview, /Setup complete|approve the changed/u);
  await assert.rejects(fs.stat(path.join(cwd, '.cursor', 'rules', '50-hnd.mdc')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(item.env.HND_USER_HOME), { code: 'ENOENT' });
  const json = JSON.parse(await item.run(cwd, ['setup', '--dry-run', '--json']));
  assert.deepEqual(Object.keys(json).sort(), ['dryRun', 'operations']);
  assert.equal(json.dryRun, true);
  assert.ok(json.operations.length > 0);
  assert.deepEqual(Object.keys(json.operations[0]).sort(), ['action', 'agent', 'changed', 'component', 'path', 'reason']);
  await item.run(cwd, ['setup']);
  const repeatedPreview = await item.run(cwd, ['setup', '--dry-run']);
  assert.equal(repeatedPreview, 'Preview: no changes needed.\n');
  assert.doesNotMatch(repeatedPreview, /Would save/u);
  assert.deepEqual(JSON.parse(await item.run(cwd, ['setup', '--json'])), { dryRun: false, operations: [] });
});

test('uninstall distinguishes absent HND settings from successful removal and dry-run', async (t) => {
  const item = await fixture(t);
  const cwd = await item.repository('project');
  assert.equal(await item.run(cwd, ['uninstall']), 'No settings to remove.\n');
  await item.run(cwd, ['setup']);
  const preview = await item.run(cwd, ['uninstall', '--dry-run']);
  assert.match(preview, /^Preview: files will not be changed\./u);
  assert.match(preview, /Would remove/u);
  assert.ok(await fs.stat(path.join(cwd, '.cursor', 'rules', '50-hnd.mdc')));
  const removed = await item.run(cwd, ['uninstall']);
  assert.match(removed, /^Settings removed\./u);
  assert.doesNotMatch(removed, /setup completed/u);
  assert.equal(await item.run(cwd, ['uninstall']), 'No settings to remove.\n');
});

test('setup reports an unregistered project separately from already-complete shared setup', async (t) => {
  const item = await fixture(t);
  const cwd = await item.repository('unregistered', { registered: false });
  const first = await item.run(cwd, ['setup']);
  assert.match(first, /Cursor rules skipped: project not registered/u);
  assert.match(first, /Setup: run hnd init, then hnd setup/u);
  await assert.rejects(fs.stat(path.join(cwd, '.cursor', 'rules', '50-hnd.mdc')), { code: 'ENOENT' });
  const repeated = await item.run(cwd, ['setup']);
  assert.match(repeated, /^Shared settings are already configured/u);
  assert.match(repeated, /Cursor rules skipped/u);
  assert.doesNotMatch(repeated, /^Already configured/u);
});

test('setup outside Git explains the skipped project scope and how to complete it', async (t) => {
  const item = await fixture(t);
  const output = await item.run(item.root, ['setup', '--dry-run']);
  assert.match(output, /Cursor rules skipped: not in a Git project/u);
  assert.match(output, /Setup: run hnd init in a Git project, then hnd setup/u);
  assert.doesNotMatch(output, /this Git repository is not registered/u);
});

test('explicit Claude-only setup does not imply Cursor project configuration was checked', async (t) => {
  const item = await fixture(t);
  const output = await item.run(item.root, ['setup', '--agents', 'claude']);
  assert.match(output, /^Setup complete\./u);
  assert.equal(await item.run(item.root, ['setup', '--agents', 'claude']), 'Already configured.\n');
  assert.doesNotMatch(output, /Cursor|Project only/u);
});

test('Korean setup guides distinguish completion, previews, and empty uninstall', async (t) => {
  const item = await fixture(t);
  const cwd = await item.repository('project');
  const preview = await item.run(cwd, ['setup', '--dry-run'], 'ko');
  assert.match(preview, /미리보기: 파일은 변경하지 않습니다/u);
  assert.match(preview, /저장 예정/u);
  await item.run(cwd, ['setup'], 'ko');
  assert.equal(await item.run(cwd, ['setup'], 'ko'), '이미 설정되어 있습니다.\n');
  await item.run(cwd, ['uninstall'], 'ko');
  assert.equal(await item.run(cwd, ['uninstall'], 'ko'), '제거할 설정이 없습니다.\n');
});
