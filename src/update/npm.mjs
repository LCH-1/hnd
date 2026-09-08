import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { withFileLock } from '../core/fs.mjs';
import { versionAtLeast } from './manifest.mjs';
import { isVersion } from './registry.mjs';
import { runtimePaths } from './state.mjs';

const execFileAsync = promisify(execFile);
export const NPM_UPDATE_COMMAND = 'npm install --global @lch-1/hnd@latest';

export function npmCliCandidates({ env, execPath, platform }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const directories = [...searchPath.split(paths.delimiter), paths.dirname(execPath)]
    .filter((directory) => paths.isAbsolute(directory));
  return [...new Set(directories.flatMap((directory) => [
    paths.join(directory, 'npm'),
    paths.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    paths.resolve(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]))];
}

async function resolveNpmCli(options) {
  for (const candidate of npmCliCandidates(options)) {
    try {
      const resolved = await fs.realpath(candidate);
      if (path.basename(resolved) !== 'npm-cli.js' || !(await fs.stat(resolved)).isFile()) continue;
      const metadata = JSON.parse(await fs.readFile(path.resolve(resolved, '..', '..', 'package.json'), 'utf8'));
      if (metadata.name === 'npm') return resolved;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    }
  }
  return null;
}

async function installedPackage(packageRoot) {
  const metadata = await fs.lstat(packageRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
  const file = path.join(packageRoot, 'package.json');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) return null;
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  return value.name === '@lch-1/hnd' && !value.private && isVersion(value.version) ? value : null;
}

function failureReason(error) {
  // Never return npm stdout/stderr: it may contain registry credentials or
  // private configuration. Only a small, predictable reason reaches the CLI.
  if (['EACCES', 'EPERM'].includes(error.code) || /\b(?:EACCES|EPERM)\b/.test(error.stderr ?? '')) return 'permission';
  if (error.code === 'STATE_BUSY') return 'busy';
  if (error.killed || error.code === 'ETIMEDOUT') return 'timeout';
  return 'install_failed';
}

export async function applyNpmUpdate({
  latestVersion, packageRoot, env = process.env, execPath = process.execPath,
  platform = process.platform, run = execFileAsync, timeoutMs = 45_000,
} = {}) {
  if (!isVersion(latestVersion)) return { status: 'skipped', reason: 'check_failed' };
  try {
    // A source checkout, npm link or npx/local installation must never cause an
    // unrelated global package to be installed or overwritten.
    if (!await installedPackage(packageRoot)) return { status: 'skipped', reason: 'not_global' };
    const npmCli = await resolveNpmCli({ env, execPath, platform });
    if (!npmCli) return { status: 'skipped', reason: 'npm_missing' };
    const options = {
      env, cwd: os.tmpdir(), encoding: 'utf8', maxBuffer: 64 * 1024,
      timeout: 5_000, windowsHide: true, shell: false,
    };
    const { stdout } = await run(execPath, [npmCli, 'prefix', '--global'], options);
    const prefix = stdout.trim();
    if (!path.isAbsolute(prefix) || /[\r\n\0]/.test(prefix)) return { status: 'skipped', reason: 'not_global' };
    const globalRoot = platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
    const target = path.join(globalRoot, '@lch-1', 'hnd');
    if ((await fs.lstat(path.dirname(target))).isSymbolicLink()
      || !await installedPackage(target)
      || await fs.realpath(target) !== await fs.realpath(packageRoot)) {
      return { status: 'skipped', reason: 'not_global' };
    }
    return await withFileLock(path.join(runtimePaths(env).root, 'npm-update.lock'), async () => {
      const before = await installedPackage(target);
      if (!before) return { status: 'skipped', reason: 'not_global' };
      // Another session may have already completed this update while waiting.
      if (versionAtLeast(before.version, latestVersion)) return { status: 'current', version: before.version };
      await run(execPath, [npmCli, 'install', '--global', `@lch-1/hnd@${latestVersion}`,
        '--prefix', prefix,
        '--registry=https://registry.npmjs.org/', '--@lch-1:registry=https://registry.npmjs.org/',
        '--ignore-scripts', '--engine-strict', '--no-audit', '--no-fund', '--no-progress',
        '--fetch-retries=0', '--fetch-timeout=15000',
      ], { ...options, timeout: timeoutMs });
      const after = await installedPackage(target);
      if (!after || !versionAtLeast(after.version, latestVersion)) {
        return { status: 'failed', reason: 'verification_failed' };
      }
      return { status: 'updated', previousVersion: before.version, version: after.version };
    }, { timeoutMs: 5_000, staleMs: 120_000 });
  } catch (error) {
    return { status: 'failed', reason: failureReason(error) };
  }
}
