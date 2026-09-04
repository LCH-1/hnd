import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { normalizeFsPath } from '../paths.mjs';
import { CoreError } from './errors.mjs';

const execFileAsync = promisify(execFile);

async function runGit(cwd, args, { optional = false, trim = true } = {}) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return trim ? stdout.trim() : stdout;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new CoreError('GIT_UNAVAILABLE', 'git executable was not found', undefined, {
        cause: error,
      });
    }
    if (optional) return null;
    throw new CoreError(
      'GIT_COMMAND_FAILED',
      `git ${args.join(' ')} failed`,
      { cwd, args, stderr: error.stderr?.trim() || undefined },
      { cause: error },
    );
  }
}

function stripGitSuffix(value) {
  return value.replace(/\/+$/, '').replace(/\.git$/i, '');
}

/**
 * Makes SSH/HTTPS forms of the same remote comparable without treating a root
 * commit as authoritative repository identity.
 */
export function normalizeRemoteUrl(value, { basePath = process.cwd() } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const remote = value.trim();

  // SCP-like SSH URL: git@example.com:owner/repository.git
  const scp = remote.match(/^(?:[^/@:\s]+@)?(\[[^\]]+\]|[^/:\s]+):(.+)$/);
  if (scp && !remote.includes('://') && !/^[a-zA-Z]:[\\/]/.test(remote)) {
    const host = scp[1].replace(/^\[|\]$/g, '').toLowerCase();
    const pathname = stripGitSuffix(scp[2].replace(/^\/+/, ''));
    return `${host}/${pathname}`;
  }

  let parsed;
  try {
    parsed = new URL(remote);
  } catch {
    const local = path.isAbsolute(remote)
      ? remote
      : path.resolve(basePath, remote);
    return `file:${normalizeFsPath(stripGitSuffix(local))}`;
  }

  if (parsed.protocol === 'file:') {
    try {
      return `file:${normalizeFsPath(stripGitSuffix(fileURLToPath(parsed)))}`;
    } catch {
      return null;
    }
  }

  const host = parsed.hostname.toLowerCase();
  let port = parsed.port;
  if (
    (parsed.protocol === 'https:' && port === '443') ||
    (parsed.protocol === 'http:' && port === '80') ||
    (parsed.protocol === 'ssh:' && port === '22')
  ) {
    port = '';
  }
  const authority = port ? `${host}:${port}` : host;
  const pathname = stripGitSuffix(decodeURIComponent(parsed.pathname).replace(/^\/+/, ''));
  return `${authority}/${pathname}`;
}

async function readRemotes(root) {
  const namesSource = await runGit(root, ['remote'], { optional: true });
  if (!namesSource) return [];
  const names = namesSource.split(/\r?\n/).filter(Boolean);
  const remotes = [];

  for (const name of names) {
    const urlsSource = await runGit(root, ['remote', 'get-url', '--all', name], {
      optional: true,
    });
    if (!urlsSource) continue;
    for (const url of urlsSource.split(/\r?\n/).filter(Boolean)) {
      const normalized = normalizeRemoteUrl(url, { basePath: root });
      if (normalized && !remotes.some((item) => item.normalized === normalized)) {
        remotes.push({ name, url, normalized });
      }
    }
  }
  return remotes;
}

async function resolveGitRoot(cwd) {
  const requestedPath = path.resolve(cwd);
  let accessiblePath;
  try {
    accessiblePath = await fs.realpath(requestedPath);
  } catch (error) {
    throw new CoreError(
      'PATH_UNAVAILABLE',
      `Cannot access path: ${requestedPath}`,
      { path: requestedPath },
      { cause: error },
    );
  }

  const topLevel = await runGit(accessiblePath, ['rev-parse', '--show-toplevel'], {
    optional: true,
  });
  if (!topLevel) {
    throw new CoreError('NOT_GIT_REPOSITORY', `Not inside a Git repository: ${requestedPath}`, {
      path: requestedPath,
    });
  }
  return normalizeFsPath(await fs.realpath(topLevel));
}

/** Minimal checkout context used by latency-sensitive, read-only startup hooks. */
export async function detectGitCheckout(cwd = process.cwd()) {
  const root = await resolveGitRoot(cwd);
  const [branch, head] = await Promise.all([
    runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { optional: true }),
    runGit(root, ['rev-parse', '--verify', 'HEAD'], { optional: true }),
  ]);
  return Object.freeze({
    root,
    worktree: root,
    branch: branch || null,
    head: head || null,
  });
}

export async function detectGitRepository(cwd = process.cwd()) {
  const root = await resolveGitRoot(cwd);
  const branch = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    optional: true,
  });
  const head = await runGit(root, ['rev-parse', '--verify', 'HEAD'], { optional: true });
  const originHead = await runGit(
    root,
    ['rev-parse', '--verify', 'refs/remotes/origin/HEAD'],
    { optional: true },
  );
  const fingerprintReference = originHead ? 'refs/remotes/origin/HEAD' : 'HEAD';
  const rootsSource = head
    ? await runGit(
      root,
      ['rev-list', '--max-parents=0', '--first-parent', fingerprintReference],
      { optional: true },
    )
    : null;
  const rootCommits = rootsSource
    ? [...new Set(rootsSource.split(/\r?\n/).filter(Boolean))].sort()
    : [];
  const shallowSource = await runGit(root, ['rev-parse', '--is-shallow-repository'], {
    optional: true,
  });
  const commonDirectorySource = await runGit(root, ['rev-parse', '--git-common-dir'], {
    optional: true,
  });
  const commonDirectory = commonDirectorySource
    ? normalizeFsPath(
        path.isAbsolute(commonDirectorySource)
          ? commonDirectorySource
          : path.resolve(root, commonDirectorySource),
      )
    : null;

  return Object.freeze({
    root,
    worktree: root,
    commonDirectory,
    branch: branch || null,
    head: head || null,
    rootCommits,
    shallow: shallowSource === 'true',
    remotes: await readRemotes(root),
  });
}

function cleanGitText(value, max = 500) {
  return String(value ?? '')
    .replaceAll('\0', '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function parsePorcelainStatus(source) {
  const records = source ? source.split('\0') : [];
  if (records.at(-1) === '') records.pop();
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 3 || record[2] !== ' ') continue;
    const code = record.slice(0, 2);
    const item = {
      code,
      path: cleanGitText(record.slice(3), 2_000),
    };
    if (code[0] === 'R' || code[0] === 'C') {
      item.from = cleanGitText(records[index + 1], 2_000);
      index += 1;
    }
    if (item.path) changes.push(item);
  }
  return changes;
}

/** Small, content-free Git snapshot suitable for automatic session checkpoints. */
export async function inspectGitProgress(cwd = process.cwd(), { maxChanges = 500 } = {}) {
  if (!Number.isSafeInteger(maxChanges) || maxChanges < 1 || maxChanges > 10_000) {
    throw new TypeError('maxChanges must be an integer from 1 to 10000.');
  }
  const checkout = await detectGitCheckout(cwd);
  const [statusSource, lastCommitSource] = await Promise.all([
    runGit(
      checkout.root,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { trim: false },
    ),
    runGit(checkout.root, ['log', '-1', '--pretty=format:%h %s'], { optional: true }),
  ]);
  const allChanges = parsePorcelainStatus(statusSource);
  const fingerprint = createHash('sha256')
    .update(checkout.branch ?? '@detached')
    .update('\0')
    .update(checkout.head ?? '')
    .update('\0')
    .update(statusSource)
    .digest('hex');
  return Object.freeze({
    ...checkout,
    lastCommit: cleanGitText(lastCommitSource),
    dirty: allChanges.length > 0,
    totalChanges: allChanges.length,
    truncated: allChanges.length > maxChanges,
    changes: Object.freeze(allChanges.slice(0, maxChanges).map(Object.freeze)),
    fingerprint,
  });
}
