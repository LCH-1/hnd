import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyNpmUpdate, npmCliCandidates } from '../src/update/npm.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-npm-update-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'global with spaces');
  const modules = process.platform === 'win32' ? 'node_modules' : path.join('lib', 'node_modules');
  const packageRoot = path.join(prefix, modules, '@lch-1', 'hnd');
  const npmRoot = path.join(root, 'tools', modules, 'npm');
  const toolBin = process.platform === 'win32' ? path.join(root, 'tools') : path.join(root, 'tools', 'bin');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.mkdir(path.join(npmRoot, 'bin'), { recursive: true });
  await fs.writeFile(path.join(npmRoot, 'bin', 'npm-cli.js'), '');
  await fs.writeFile(path.join(npmRoot, 'package.json'), JSON.stringify({ name: 'npm' }));
  const writeVersion = (version) => fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@lch-1/hnd', version }));
  await writeVersion('0.2.4');
  const env = { PATH: toolBin, HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user') };
  return { prefix, packageRoot, writeVersion, env, execPath: path.join(toolBin, 'node'), latestVersion: '0.2.5' };
}

test('npm updates the exact active global installation using node, fixed package and registry, with no shell or elevation', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const result = await applyNpmUpdate({ ...f, run: async (command, args, options) => {
    calls.push(args);
    assert.equal(command, f.execPath);
    assert.match(args[0], /npm-cli\.js$/);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.cwd, os.tmpdir());
    assert.ok(options.timeout <= 45_000);
    assert.doesNotMatch([command, ...args].join(' '), /sudo|cmd\.exe|powershell/);
    if (args[1] === 'prefix') return { stdout: `${f.prefix}\n` };
    assert.deepEqual(args.slice(1, 4), ['install', '--global', '@lch-1/hnd@0.2.5']);
    assert.equal(args[args.indexOf('--prefix') + 1], f.prefix);
    assert.ok(args.includes('--ignore-scripts'));
    assert.ok(args.includes('--engine-strict'));
    assert.ok(args.includes('--registry=https://registry.npmjs.org/'));
    assert.ok(args.includes('--@lch-1:registry=https://registry.npmjs.org/'));
    await f.writeVersion('0.2.5');
    return { stdout: 'changed 1 package' };
  } });
  assert.equal(calls.length, 2);
  assert.deepEqual(result, { status: 'updated', previousVersion: '0.2.4', version: '0.2.5' });
});

test('npm failure is bounded and sanitized, including permissions, timeouts and failed verification', async (t) => {
  const f = await fixture(t);
  for (const [error, reason] of [
    [Object.assign(new Error('secret'), { code: 'EACCES' }), 'permission'],
    [Object.assign(new Error('secret'), { code: 1, stderr: 'EACCES private token' }), 'permission'],
    [Object.assign(new Error('secret'), { killed: true }), 'timeout'],
    [Object.assign(new Error('secret'), { code: 'ENETUNREACH' }), 'install_failed'],
    [null, 'verification_failed'],
  ]) {
    const result = await applyNpmUpdate({ ...f, run: async (_command, args) => {
      if (args[1] === 'prefix') return { stdout: f.prefix };
      if (error) throw error;
      return { stdout: 'success without replacing package' };
    } });
    assert.deepEqual(result, { status: 'failed', reason });
    assert.doesNotMatch(JSON.stringify(result), /secret|private token/);
  }
});

test('source checkouts, invalid versions, npm links and different prefixes never trigger installation', async (t) => {
  const f = await fixture(t);
  for (const latestVersion of [null, '0.2.5\n', '1.0.0;command']) {
    assert.equal((await applyNpmUpdate({ ...f, latestVersion, run: () => assert.fail('unexpected npm call') })).status, 'skipped');
  }
  await fs.writeFile(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: 'hnd', version: '0.2.4', private: true }));
  assert.deepEqual(await applyNpmUpdate({ ...f, run: () => assert.fail('unexpected npm call') }), { status: 'skipped', reason: 'not_global' });
  await f.writeVersion('0.2.4');
  const otherPrefix = path.join(f.prefix, 'other');
  const otherPackage = path.join(otherPrefix, process.platform === 'win32' ? 'node_modules' : path.join('lib', 'node_modules'), '@lch-1', 'hnd');
  await fs.mkdir(otherPackage, { recursive: true });
  await fs.writeFile(path.join(otherPackage, 'package.json'), JSON.stringify({ name: '@lch-1/hnd', version: '0.2.4' }));
  assert.deepEqual(await applyNpmUpdate({ ...f, run: async (_command, args) => {
    assert.equal(args[1], 'prefix');
    return { stdout: otherPrefix };
  } }), { status: 'skipped', reason: 'not_global' });
  if (process.platform !== 'win32') {
    const link = path.join(f.prefix, 'linked');
    await fs.symlink(f.packageRoot, link);
    assert.deepEqual(await applyNpmUpdate({ ...f, packageRoot: link, run: () => assert.fail('unexpected npm call') }), { status: 'skipped', reason: 'not_global' });
  }
});

test('parallel sessions perform one npm installation and never downgrade a newer installed package', async (t) => {
  const f = await fixture(t);
  let installs = 0;
  const run = async (_command, args) => {
    if (args[1] === 'prefix') return { stdout: f.prefix };
    installs++;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await f.writeVersion('0.2.5');
    return { stdout: '' };
  };
  const results = await Promise.all([applyNpmUpdate({ ...f, run }), applyNpmUpdate({ ...f, run })]);
  assert.equal(installs, 1);
  assert.deepEqual(results.map((value) => value.status).sort(), ['current', 'updated']);
  await f.writeVersion('0.3.0');
  assert.deepEqual(await applyNpmUpdate({ ...f, run }), { status: 'current', version: '0.3.0' });
  assert.equal(installs, 1);
});

test('Windows npm lookup supports spaces and resolves JavaScript instead of invoking a cmd shell', () => {
  const candidates = npmCliCandidates({
    platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe',
    env: { Path: 'C:\\Users\\Alice\\AppData\\Roaming\\npm;.;relative' },
  });
  assert.ok(candidates.includes('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'));
  assert.ok(candidates.includes('C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js'));
  assert.equal(candidates.some((entry) => /\.cmd$|relative/.test(entry)), false);
});
