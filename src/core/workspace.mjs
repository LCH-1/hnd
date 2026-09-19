import fs from 'node:fs/promises';
import path from 'node:path';

import { normalizeFsPath, statePaths } from '../paths.mjs';
import { CoreError } from './errors.mjs';
import { readJson } from './fs.mjs';
import { detectGitCheckout, detectGitRepository } from './git.mjs';
import { validateBindings } from './state.mjs';

async function hasGitMarker(directory) {
  try {
    await fs.lstat(path.join(directory, '.git'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Includes worktree/submodule .git files, even when Git cannot be executed. */
export async function findGitBoundary(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    if (await hasGitMarker(current)) return current;
    if (path.dirname(current) === current) return null;
  }
}

/** Resolve a workspace without creating files or changing repository identity. */
export async function detectWorkspace(cwd, { env = process.env, fast = false } = {}) {
  let requested;
  try {
    requested = normalizeFsPath(await fs.realpath(cwd));
    if (!(await fs.stat(requested)).isDirectory()) {
      throw new CoreError('PATH_UNAVAILABLE', `Not a directory: ${requested}`);
    }
  } catch (cause) {
    throw new CoreError('PATH_UNAVAILABLE', `Cannot access workspace: ${cwd}`, { path: cwd }, { cause });
  }

  let unavailableReason;
  try {
    const git = await (fast ? detectGitCheckout(requested) : detectGitRepository(requested));
    return Object.freeze({ ...git, available: true });
  } catch (error) {
    if (!['GIT_UNAVAILABLE', 'NOT_GIT_REPOSITORY'].includes(error.code)) throw error;
    unavailableReason = error.code;
  }

  const store = await readJson(statePaths(env).bindings, { optional: true, validate: validateBindings });
  let root = requested;
  for (let current = requested; ; current = path.dirname(current)) {
    // Never inherit an outer project's private rules across a nested Git root.
    if (await hasGitMarker(current) || store?.bindings[current]) {
      root = current;
      break;
    }
    if (path.dirname(current) === current) break;
  }
  return Object.freeze({
    root,
    worktree: root,
    commonDirectory: null,
    branch: null,
    head: null,
    rootCommits: [],
    shallow: false,
    remotes: [],
    available: false,
    unavailableReason,
  });
}
