import path from 'node:path';
import { createHash } from 'node:crypto';

import { STATE_SCHEMA_VERSION } from '../constants.mjs';
import { repositoryPaths, statePaths } from '../paths.mjs';
import { inspectGitProgress } from './git.mjs';
import { readJson, withFileLock, writeJsonAtomic } from './fs.mjs';
import { initializeRepositoryDirectory, isoNow, isUuid } from './state.mjs';
import { resolveRepositoryBinding } from './repositories.mjs';

const AGENT_NAMES = new Set(['claude', 'codex', 'cursor', 'manual', 'unknown']);

function checkpointKey(git) {
  const identity = git.branch === null ? 'detached' : `branch\0${git.branch}`;
  return createHash('sha256').update(identity).digest('hex');
}

function validChange(value) {
  return value
    && typeof value === 'object'
    && typeof value.code === 'string'
    && value.code.length === 2
    && typeof value.path === 'string'
    && (value.from === undefined || typeof value.from === 'string');
}

export function validCheckpoint(value) {
  return value
    && typeof value === 'object'
    && value.schemaVersion === STATE_SCHEMA_VERSION
    && isUuid(value.repoId)
    && typeof value.key === 'string'
    && /^[a-f0-9]{64}$/.test(value.key)
    && (value.branch === null || typeof value.branch === 'string')
    && (value.head === null || typeof value.head === 'string')
    && typeof value.lastCommit === 'string'
    && typeof value.dirty === 'boolean'
    && Number.isSafeInteger(value.totalChanges)
    && typeof value.truncated === 'boolean'
    && Array.isArray(value.changes)
    && value.changes.every(validChange)
    && AGENT_NAMES.has(value.agent)
    && typeof value.fingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(value.fingerprint)
    && typeof value.capturedAt === 'string';
}

function checkpointPath(repoId, key, env) {
  return path.join(repositoryPaths(repoId, env).checkpoints, `${key}.json`);
}

export async function captureCheckpoint({
  cwd = process.cwd(),
  agent = 'unknown',
  env = process.env,
  clock = Date,
} = {}) {
  if (!AGENT_NAMES.has(agent)) throw new TypeError(`Unsupported checkpoint agent: ${agent}`);
  const resolved = await resolveRepositoryBinding({ cwd, env, clock });
  const progress = await inspectGitProgress(resolved.git.root);
  const key = checkpointKey(progress);
  const repositories = await initializeRepositoryDirectory(resolved.repository.id, env);
  const file = checkpointPath(resolved.repository.id, key, env);
  const lock = path.join(
    statePaths(env).locks,
    `checkpoint-${resolved.repository.id}-${key}.lock`,
  );

  return withFileLock(lock, async () => {
    const previous = await readJson(file, { optional: true, validate: validCheckpoint });
    if (previous?.fingerprint === progress.fingerprint) {
      return { changed: false, checkpoint: previous, path: file };
    }
    const checkpoint = {
      schemaVersion: STATE_SCHEMA_VERSION,
      repoId: resolved.repository.id,
      key,
      branch: progress.branch,
      head: progress.head,
      lastCommit: progress.lastCommit,
      dirty: progress.dirty,
      totalChanges: progress.totalChanges,
      truncated: progress.truncated,
      changes: progress.changes.map((change) => ({ ...change })),
      agent,
      fingerprint: progress.fingerprint,
      capturedAt: isoNow(clock),
    };
    await writeJsonAtomic(file, checkpoint);
    return { changed: true, checkpoint, path: file, directory: repositories.checkpoints };
  });
}

export async function getCheckpoint({
  repoId,
  git,
  env = process.env,
} = {}) {
  if (!repoId || !git) return null;
  const key = checkpointKey(git);
  return readJson(checkpointPath(repoId, key, env), {
    optional: true,
    validate: validCheckpoint,
  });
}
