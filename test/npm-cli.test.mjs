import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { useCliLanguage } from '../src/cli-i18n.mjs';
import { runNpmCommand } from '../src/update/npm-cli.mjs';
import { LAUNCHER_LATEST_URL } from '../src/update/registry.mjs';

function captureStream() {
  let value = '';
  return { write(chunk) { value += String(chunk); return true; }, value: () => value };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-npm-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'global with spaces', 'node_modules', '@lch-1', 'hnd');
  const launcher = path.join(packageRoot, 'bin', 'hnd.mjs');
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.writeFile(launcher, '');
  const writeVersion = (version) => fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@lch-1/hnd', version }));
  await writeVersion('0.1.8');
  let binPath = launcher;
  if (process.platform !== 'win32') {
    binPath = path.join(root, 'hnd');
    await fs.symlink(launcher, binPath);
  }
  const env = {
    HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user'),
    LANG: 'ko_KR.UTF-8', HND_DISABLE_AUTO_UPDATE: '1',
  };
  await useCliLanguage(env);
  const stdout = captureStream();
  const stderr = captureStream();
  const fetchImpl = async (url, options) => {
    assert.equal(url, LAUNCHER_LATEST_URL);
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    return Response.json({ name: '@lch-1/hnd', version: '0.2.5' });
  };
  return { root, packageRoot, binPath, env, stdout, stderr, fetchImpl, writeVersion };
}

test('npm CLI reads the actual launcher version and works outside an initialized project', async (t) => {
  const f = await fixture(t);
  let checks = 0;
  t.mock.method(globalThis, 'fetch', (...args) => { checks++; return f.fetchImpl(...args); });
  for (const args of [['npm', 'version', '--json'], ['npm', '--json']]) {
    const stdout = captureStream();
    await main(args, { ...f, cwd: f.root, stdout });
    const result = JSON.parse(stdout.value());
    assert.equal(result.launcherVersion, '0.1.8');
    assert.equal(result.launcherLatestVersion, '0.2.5');
    assert.equal(result.launcherUpdate.status, 'update_available');
    assert.equal(result.npmInstall, undefined);
  }
  assert.equal(checks, 2);
  await assert.rejects(fs.stat(f.env.HND_HOME), { code: 'ENOENT' });
});

test('npm update targets the permanent launcher and reports the verified installed version', async (t) => {
  const f = await fixture(t);
  let installs = 0;
  const execPath = '/test/node';
  const result = await runNpmCommand('update', {
    ...f, execPath,
    npmUpdate: async (options) => {
      installs++;
      assert.equal(options.packageRoot, await fs.realpath(f.packageRoot));
      assert.equal(options.latestVersion, '0.2.5');
      assert.equal(options.env, f.env);
      assert.equal(options.execPath, execPath);
      await f.writeVersion('0.2.5');
      return { status: 'updated', previousVersion: '0.1.8', version: '0.2.5' };
    },
  });
  assert.equal(installs, 1);
  assert.equal(result.launcherVersion, '0.2.5');
  assert.equal(result.launcherUpdate.status, 'current');
  assert.match(f.stdout.value(), /npm 패키지 업데이트 완료: 0\.1\.8 → 0\.2\.5/);
  assert.match(f.stderr.value(), /업데이트하고 있습니다/);
  assert.doesNotMatch(f.stdout.value(), /HND 실행 버전|서버|스킬/);
});

test('current and newer npm packages skip installation and JSON mode omits progress text', async (t) => {
  const f = await fixture(t);
  for (const [version, status] of [['0.2.5', 'current'], ['0.3.0', 'ahead']]) {
    await f.writeVersion(version);
    const stdout = captureStream();
    const result = await runNpmCommand('update', {
      ...f, stdout, jsonOutput: true,
      npmUpdate: () => assert.fail('must not reinstall or downgrade'),
    });
    assert.equal(result.launcherUpdate.status, status);
    assert.deepEqual(result.npmInstall, { status: 'current', version });
    assert.deepEqual(JSON.parse(stdout.value()), result);
  }
  assert.equal(f.stderr.value(), '');
});

test('offline version checks retain the installed version and updates fail without installing', async (t) => {
  const f = await fixture(t);
  const options = {
    ...f,
    fetchImpl: async () => { throw new Error('offline'); },
    npmUpdate: () => assert.fail('must not install without verified release metadata'),
  };
  const result = await runNpmCommand('version', options);
  assert.equal(result.launcherVersion, '0.1.8');
  assert.equal(result.launcherUpdate.status, 'check_failed');
  assert.match(f.stdout.value(), /로컬 버전: 0\.1\.8\n최신 버전: 확인 불가/);
  assert.match(f.stdout.value(), /다시 확인: hnd npm version/);
  const stdout = captureStream();
  await assert.rejects(runNpmCommand('update', { ...options, stdout, jsonOutput: true }), { exitCode: 1 });
  const failure = JSON.parse(stdout.value());
  assert.deepEqual(failure.npmInstall, { status: 'skipped', reason: 'check_failed' });
  assert.equal(f.stderr.value(), '');
});

test('npm installation failures give an actionable reason and a nonzero exit code', async (t) => {
  const f = await fixture(t);
  for (const [reason, label] of [
    ['permission', '권한 부족'], ['not_global', '전역 npm 설치본이 아님'],
    ['npm_missing', 'npm을 찾을 수 없음'], ['busy', '다른 업데이트가 진행 중'],
    ['timeout', '시간 초과'], ['verification_failed', '설치 확인 실패'],
  ]) {
    const stdout = captureStream();
    await assert.rejects(runNpmCommand('update', {
      ...f, stdout, npmUpdate: async () => ({ status: 'failed', reason }),
    }), { exitCode: 1 });
    assert.ok(stdout.value().includes(label));
    assert.match(stdout.value(), /npm install --global @lch-1\/hnd@latest/);
    assert.doesNotMatch(stdout.value(), /최신 버전입니다|업데이트 완료/);
  }
});

test('npm update handles another session finishing first and preserves English output', async (t) => {
  const f = await fixture(t);
  await useCliLanguage({ ...f.env, LANG: 'en_US.UTF-8' });
  const result = await runNpmCommand('update', {
    ...f, npmUpdate: async () => ({ status: 'current', version: '0.3.0' }),
  });
  assert.equal(result.launcherVersion, '0.3.0');
  assert.equal(result.launcherUpdate.status, 'ahead');
  assert.match(f.stdout.value(), /ahead of the public version/);
  assert.match(f.stderr.value(), /Updating the npm package/);
});

test('npm help and invalid arguments do not perform network checks or npm installations', async (t) => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected network call'));
  for (const args of [['npm', 'help'], ['npm', '--help'], ['help', 'npm']]) {
    const stdout = captureStream();
    await main(args, { ...f, cwd: f.root, stdout });
    assert.match(stdout.value(), /hnd npm update \[--json\]/);
  }
  for (const args of [
    ['npm', 'install'], ['npm', 'update', 'another-package'],
    ['npm', 'version', '--registry', 'https://example.invalid'],
  ]) {
    await assert.rejects(main(args, { ...f, cwd: f.root }), { exitCode: 2 });
  }
});

test('npm update refuses to install globally when the invoked command is a source checkout', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: 'hnd', version: '0.1.8', private: true }));
  t.mock.method(globalThis, 'fetch', f.fetchImpl);
  await assert.rejects(main(['npm', 'update', '--json'], { ...f, cwd: f.root }), { exitCode: 1 });
  assert.deepEqual(JSON.parse(f.stdout.value()).npmInstall, { status: 'skipped', reason: 'not_global' });
  assert.equal(f.stderr.value(), '');
});
