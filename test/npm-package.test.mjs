import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { VERSION as RUNTIME_VERSION } from '../src/constants.mjs';
import { LAUNCHER_VERSION } from '../src/launcher-version.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildScript = path.join(projectRoot, 'scripts', 'build-npm-package.sh');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-npm-package-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function walkFiles(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(root, absolute));
    else result.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
  return result.sort();
}

async function clientModuleClosure(packageDirectory) {
  const entry = path.join(packageDirectory, 'bin/hnd.mjs');
  const pending = [entry];
  const visited = new Set();
  const relativeModule = /(["'])(\.{1,2}\/[^"'\n]+\.mjs)\1/gu;
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(relativeModule)) {
      const dependency = path.resolve(path.dirname(file), match[2]);
      const relative = path.relative(packageDirectory, dependency);
      assert.ok(
        relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `module import escapes package: ${match[2]}`,
      );
      const metadata = await fs.lstat(dependency);
      assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
      pending.push(dependency);
    }
  }
  return [...visited]
    .map((file) => path.relative(packageDirectory, file).split(path.sep).join('/'))
    .sort();
}

test('npm package is public client-only and installs as a global hnd command', async (t) => {
  const root = await temporaryDirectory(t);
  const packageDirectory = path.join(root, 'package');
  const rootPackage = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json')));
  const allowlistedFiles = (await fs.readFile(
    path.join(projectRoot, 'assets/npm-source-files.txt'),
    'utf8',
  )).trim().split('\n').sort();

  await execFileAsync('sh', [buildScript, packageDirectory], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });

  const metadata = JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json')));
  assert.equal(rootPackage.private, true);
  assert.equal(metadata.name, '@lch-1/hnd');
  assert.equal(metadata.version, rootPackage.version);
  assert.equal(metadata.version, LAUNCHER_VERSION);
  assert.notEqual(metadata.version, RUNTIME_VERSION);
  assert.equal(metadata.private, undefined);
  assert.deepEqual(metadata.bin, { hnd: 'bin/hnd.mjs' });
  assert.deepEqual(metadata.engines, { node: '>=24.12.0' });
  assert.deepEqual(metadata.os, ['win32', 'darwin', 'linux']);
  assert.deepEqual(metadata.publishConfig, {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
  });
  assert.equal(metadata.scripts, undefined);
  assert.equal(metadata.dependencies, undefined);
  assert.equal(metadata.devDependencies, undefined);
  assert.equal(metadata.optionalDependencies, undefined);
  assert.equal(metadata.peerDependencies, undefined);

  const files = await walkFiles(packageDirectory);
  assert.deepEqual(
    files,
    [...allowlistedFiles, 'README.md', 'package.json'].sort(),
    'published package must exactly match the reviewed client allowlist',
  );
  assert.deepEqual(
    files.filter((file) => file.endsWith('.mjs')),
    await clientModuleClosure(packageDirectory),
    'every published module must be reachable from the hnd command',
  );
  for (const required of [
    'LICENSE',
    'README.md',
    'assets/hnd-handoff/SKILL.md',
    'assets/release-public-key.pem',
    'bin/hnd.mjs',
    'src/cli.mjs',
    'src/remote-cli.mjs',
    'src/sync/client.mjs',
    'src/sync/constants.mjs',
  ]) {
    assert.ok(files.includes(required), `package is missing ${required}`);
  }
  for (const forbidden of [
    'MANIFEST.json',
    'assets/connector-launcher.mjs',
    'install.ps1',
    'install.sh',
    'src/sync/server.mjs',
    'src/sync/store.mjs',
    'src/sync/index.mjs',
  ]) {
    assert.equal(files.includes(forbidden), false, `package includes ${forbidden}`);
  }
  assert.equal(files.some((file) => file.startsWith('src/server/')), false);
  assert.equal(files.some((file) => file.startsWith('src/web/')), false);
  assert.equal(files.some((file) => file.startsWith('src/browser/')), false);

  const dryRun = await execFileAsync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageDirectory,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const dryRunResult = JSON.parse(dryRun.stdout);
  assert.equal(dryRunResult.length, 1);
  assert.equal(dryRunResult[0].name, '@lch-1/hnd');
  const packedFiles = dryRunResult[0].files.map(({ path: file }) => file);
  assert.ok(packedFiles.includes('bin/hnd.mjs'));
  assert.ok(
    packedFiles.includes('assets/release-public-key.pem'),
    'published launcher must include its pinned release verification key',
  );
  assert.equal(packedFiles.some((file) => /(?:^|\/)(?:server|web|browser)(?:\/|$)/.test(file)), false);
  assert.equal(packedFiles.some((file) => /(?:install\.(?:ps1|sh)|connector-launcher\.mjs)$/.test(file)), false);

  const packDirectory = path.join(root, 'pack');
  const prefix = path.join(root, 'prefix');
  await fs.mkdir(packDirectory);
  const packed = await execFileAsync('npm', ['pack', '--json', '--pack-destination', packDirectory], {
    cwd: packageDirectory,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const [{ filename }] = JSON.parse(packed.stdout);
  const tarball = path.join(packDirectory, filename);
  await execFileAsync('npm', [
    'install', '--global', '--ignore-scripts', '--offline', '--prefix', prefix, tarball,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const installedCommand = process.platform === 'win32'
    ? path.join(prefix, 'hnd.cmd')
    : path.join(prefix, 'bin', 'hnd');
  const launcherSmokeEnvironment = {
    ...process.env,
    HND_HOME: path.join(root, 'launcher-version-state'),
    HND_USER_HOME: path.join(root, 'launcher-version-user'),
    HND_DISABLE_AUTO_UPDATE: '1',
  };
  const version = await execFileAsync(installedCommand, ['--version'], {
    cwd: root,
    env: launcherSmokeEnvironment,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(version.stdout.trim(), RUNTIME_VERSION);

  const help = await execFileAsync(installedCommand, ['--help'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...launcherSmokeEnvironment,
      LANG: 'ko_KR.UTF-8',
      LC_ALL: '',
      LC_MESSAGES: '',
    },
  });
  assert.match(help.stdout, /평소에 필요한 명령:/u);

  const repository = path.join(root, 'repository');
  const userHome = path.join(root, 'user');
  const connectorHome = path.join(root, 'hnd-home');
  await fs.mkdir(repository);
  await execFileAsync('git', ['init', '--quiet', repository]);
  const smokeEnvironment = {
    ...process.env,
    HND_HOME: connectorHome,
    HND_USER_HOME: userHome,
  };
  await execFileAsync(installedCommand, ['init', '--cwd', repository, '--env', 'test'], {
    cwd: repository,
    env: smokeEnvironment,
    encoding: 'utf8',
    timeout: 10_000,
  });
  const setupDryRun = await execFileAsync(installedCommand, ['setup', '--cwd', repository, '--dry-run'], {
    cwd: repository,
    env: smokeEnvironment,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.match(setupDryRun.stdout, /would write/u);
});
