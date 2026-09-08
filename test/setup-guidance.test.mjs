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

test('setup explains project-specific and shared-user files across two projects', async (t) => {
  const item = await fixture(t);
  const first = await item.repository('first');
  const second = await item.repository('second');
  const firstOutput = await item.run(first, ['setup']);
  assert.match(firstOutput, /HND setup completed/u);
  assert.match(firstOutput, /Project only — current Git repository/u);
  assert.match(firstOutput, /Shared user settings — all projects run by this user on this PC/u);
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
  assert.match(secondOutput, /Identical files are not written again/u);
  assert.deepEqual(await Promise.all(commonFiles.map((file) => fs.readFile(file, 'utf8'))), before);

  const repeated = await item.run(second, ['setup']);
  assert.match(repeated, /^Setup is already complete\. No changes needed\./u);
  assert.doesNotMatch(repeated, /No managed files found|Saved|approve the changed/u);
  assert.match(repeated, /Check setup: hnd doctor --agents claude,codex,cursor/u);
});

test('setup dry-run describes future work and preserves the JSON contract without writing files', async (t) => {
  const item = await fixture(t);
  const cwd = await item.repository('project');
  const preview = await item.run(cwd, ['setup', '--dry-run']);
  assert.match(preview, /^Preview: no files were changed\./u);
  assert.match(preview, /HND settings would be applied/u);
  assert.match(preview, /Would save/u);
  assert.doesNotMatch(preview, /HND setup completed|approve the changed/u);
  await assert.rejects(fs.stat(path.join(cwd, '.cursor', 'rules', '50-hnd.mdc')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(item.env.HND_USER_HOME), { code: 'ENOENT' });
  const json = JSON.parse(await item.run(cwd, ['setup', '--dry-run', '--json']));
  assert.deepEqual(Object.keys(json).sort(), ['dryRun', 'operations']);
  assert.equal(json.dryRun, true);
  assert.ok(json.operations.length > 0);
  assert.deepEqual(Object.keys(json.operations[0]).sort(), ['action', 'agent', 'changed', 'component', 'path', 'reason']);
  await item.run(cwd, ['setup']);
  const repeatedPreview = await item.run(cwd, ['setup', '--dry-run']);
  assert.match(repeatedPreview, /Preview: no files were changed/u);
  assert.match(repeatedPreview, /Setup is already complete/u);
  assert.doesNotMatch(repeatedPreview, /Would save/u);
  assert.deepEqual(JSON.parse(await item.run(cwd, ['setup', '--json'])), { dryRun: false, operations: [] });
});

test('uninstall distinguishes absent HND settings from successful removal and dry-run', async (t) => {
  const item = await fixture(t);
  const cwd = await item.repository('project');
  assert.equal(await item.run(cwd, ['uninstall']), 'No HND-managed settings found. Nothing to uninstall.\n');
  await item.run(cwd, ['setup']);
  const preview = await item.run(cwd, ['uninstall', '--dry-run']);
  assert.match(preview, /HND settings would be removed/u);
  assert.match(preview, /Would remove/u);
  assert.ok(await fs.stat(path.join(cwd, '.cursor', 'rules', '50-hnd.mdc')));
  const removed = await item.run(cwd, ['uninstall']);
  assert.match(removed, /^HND settings removed\. Other user settings were preserved\./u);
  assert.doesNotMatch(removed, /setup completed/u);
  assert.equal(await item.run(cwd, ['uninstall']), 'No HND-managed settings found. Nothing to uninstall.\n');
});

test('setup reports an unregistered project separately from already-complete shared setup', async (t) => {
  const item = await fixture(t);
  const cwd = await item.repository('unregistered', { registered: false });
  const first = await item.run(cwd, ['setup']);
  assert.match(first, /Project-specific Cursor rules were skipped: this Git repository is not registered/u);
  assert.match(first, /Next: register this project with hnd init, then run hnd setup/u);
  await assert.rejects(fs.stat(path.join(cwd, '.cursor', 'rules', '50-hnd.mdc')), { code: 'ENOENT' });
  const repeated = await item.run(cwd, ['setup']);
  assert.match(repeated, /^Shared user setup is already complete/u);
  assert.match(repeated, /Project-specific Cursor rules were skipped/u);
  assert.doesNotMatch(repeated, /^Setup is already complete/u);
});

test('setup outside Git explains the skipped project scope and how to complete it', async (t) => {
  const item = await fixture(t);
  const output = await item.run(item.root, ['setup', '--dry-run']);
  assert.match(output, /Project-specific Cursor rules were skipped: the current path is not a Git repository/u);
  assert.match(output, /Next: run hnd init in a Git project, then run hnd setup/u);
  assert.doesNotMatch(output, /this Git repository is not registered/u);
});

test('explicit Claude-only setup does not imply Cursor project configuration was checked', async (t) => {
  const item = await fixture(t);
  const output = await item.run(item.root, ['setup', '--agents', 'claude']);
  assert.match(output, /Hooks and skills are shared user settings/u);
  assert.match(output, /Check setup: hnd doctor --agents claude/u);
  assert.doesNotMatch(output, /Cursor|Project only/u);
});

test('Korean setup guides distinguish completion, previews, and empty uninstall', async (t) => {
  const item = await fixture(t);
  const cwd = await item.repository('project');
  const preview = await item.run(cwd, ['setup', '--dry-run'], 'ko');
  assert.match(preview, /미리보기: 파일을 변경하지 않았습니다/u);
  assert.match(preview, /프로젝트 전용 — 현재 Git 저장소/u);
  assert.match(preview, /사용자 공통 — 이 PC의 같은 사용자로 실행하는 모든 프로젝트/u);
  assert.match(preview, /저장 예정/u);
  await item.run(cwd, ['setup'], 'ko');
  assert.match(await item.run(cwd, ['setup'], 'ko'), /^설정이 이미 완료되어 변경할 내용이 없습니다/u);
  await item.run(cwd, ['uninstall'], 'ko');
  assert.equal(await item.run(cwd, ['uninstall'], 'ko'), '제거할 HND 관리 설정이 없습니다.\n');
});
