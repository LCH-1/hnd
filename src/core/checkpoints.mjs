import path from 'node:path';
import { createHash } from 'node:crypto';

import { STATE_SCHEMA_VERSION } from '../constants.mjs';
import { repositoryPaths, statePaths } from '../paths.mjs';
import { inspectGitProgress } from './git.mjs';
import { readJson, withFileLock, writeJsonAtomic } from './fs.mjs';
import { initializeRepositoryDirectory, isoNow, isUuid } from './state.mjs';
import { resolveRepositoryBinding } from './repositories.mjs';
import { collectionAllowed, getPrivacyPolicy, redactSensitiveText } from './privacy.mjs';
import { workSessionKey } from './work-session.mjs';

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
    && (value.sessionKey === undefined || value.sessionKey === null || /^[a-f0-9]{64}$/u.test(value.sessionKey))
    && typeof value.fingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(value.fingerprint)
    && typeof value.capturedAt === 'string';
}

function checkpointPath(repoId, key, env) {
  return path.join(repositoryPaths(repoId, env).checkpoints, `${key}.json`);
}

function filteredProgress(progress, policy) {
  const changes = progress.changes.filter((change) => (
    collectionAllowed({ policy, sourceKind: 'file', relativePath: change.path })
    && (change.from === undefined || collectionAllowed({ policy, sourceKind: 'file', relativePath: change.from }))
  )).map((change) => ({ ...change }));
  const totalChanges = changes.length === progress.changes.length ? progress.totalChanges : changes.length;
  const visible = {
    branch: progress.branch === null ? null : redactSensitiveText(progress.branch).text,
    head: progress.head,
    lastCommit: redactSensitiveText(progress.lastCommit).text,
    dirty: totalChanges > 0,
    totalChanges,
    truncated: progress.truncated || changes.length > 500,
    changes: changes.slice(0, 500),
  };
  return { ...visible, fingerprint: createHash('sha256').update(JSON.stringify(visible)).digest('hex') };
}

export async function captureCheckpoint({
  cwd = process.cwd(),
  agent = 'unknown',
  env = process.env,
  clock = Date,
  sessionKey,
  sessionId,
} = {}) {
  if (!AGENT_NAMES.has(agent)) throw new TypeError(`Unsupported checkpoint agent: ${agent}`);
  const resolved = await resolveRepositoryBinding({ cwd, env, clock });
  sessionKey = workSessionKey({ sessionKey, sessionId, agent, env });
  const policy = await getPrivacyPolicy({ repoId: resolved.repository.id, sessionKey, env });
  if (!collectionAllowed({ policy, sourceKind: 'checkpoint' })) {
    return { changed: false, checkpoint: null, skipped: true, reason: 'collection_disabled', path: null };
  }
  const captured = await inspectGitProgress(resolved.git.root, { maxChanges: 10_000 });
  const progress = filteredProgress(captured, policy);
  const key = checkpointKey(captured);
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
      sessionKey,
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
  sessionKey,
  sessionId,
  agent,
} = {}) {
  if (!repoId || !git) return null;
  const policy = await getPrivacyPolicy({ repoId, sessionKey, sessionId, agent, env });
  if (!collectionAllowed({ policy, sourceKind: 'checkpoint' })) return null;
  const key = checkpointKey(git);
  const checkpoint = await readJson(checkpointPath(repoId, key, env), {
    optional: true,
    validate: validCheckpoint,
  });
  return checkpoint ? { ...checkpoint, ...filteredProgress(checkpoint, policy) } : null;
}
