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
import { CoreError } from './errors.mjs';
import { validCheckpointRecord as validCheckpoint } from '../shared/record-merge.mjs';

const AGENT_NAMES = new Set(['claude', 'codex', 'cursor', 'manual', 'unknown']);

function checkpointKey(git) {
  const identity = git.branch === null ? 'detached' : `branch\0${git.branch}`;
  return createHash('sha256').update(identity).digest('hex');
}

export { validCheckpointRecord as validCheckpoint } from '../shared/record-merge.mjs';

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
  stateLock = (callback) => callback(),
  inspectGit = inspectGitProgress,
} = {}) {
  if (!AGENT_NAMES.has(agent)) throw new TypeError(`Unsupported checkpoint agent: ${agent}`);
  sessionKey = workSessionKey({ sessionKey, sessionId, agent, env });
  const prepared = await stateLock(async () => {
    const resolved = await resolveRepositoryBinding({ cwd, env, clock });
    if (resolved.git.available === false) return { skipped: resolved.git.unavailableReason };
    const policy = await getPrivacyPolicy({ repoId: resolved.repository.id, sessionKey, env });
    if (!collectionAllowed({ policy, sourceKind: 'checkpoint' })) return { skipped: 'collection_disabled' };
    const key = checkpointKey(resolved.git);
    const previous = await readJson(checkpointPath(resolved.repository.id, key, env), { optional: true, validate: validCheckpoint });
    return { resolved, key, previous };
  });
  if (prepared.skipped) return { changed: false, checkpoint: null, skipped: true, reason: prepared.skipped, path: null };

  // Git may scan a large worktree. Other projects must be able to read their
  // rules while that runs. Recheck binding and privacy before committing.
  const captured = await inspectGit(prepared.resolved.git.root, { maxChanges: 10_000 });
  return stateLock(async () => {
    const resolved = await resolveRepositoryBinding({ cwd, env, clock });
    if (resolved.repository.id !== prepared.resolved.repository.id || resolved.git.root !== prepared.resolved.git.root) {
      throw new CoreError('CHECKPOINT_RETRY_REQUIRED', 'Project binding changed during Git inspection; retry checkpoint capture.');
    }
    const policy = await getPrivacyPolicy({ repoId: resolved.repository.id, sessionKey, env });
    if (!collectionAllowed({ policy, sourceKind: 'checkpoint' })) {
      return { changed: false, checkpoint: null, skipped: true, reason: 'collection_disabled', path: null };
    }
    const progress = filteredProgress(captured, policy);
    const key = checkpointKey(captured);
    if (key !== prepared.key || key !== checkpointKey(resolved.git)) {
      return { changed: false, checkpoint: null, skipped: true, reason: 'branch_changed_during_capture', path: null };
    }
    const repositories = await initializeRepositoryDirectory(resolved.repository.id, env);
    const file = checkpointPath(resolved.repository.id, key, env);
    const lock = path.join(statePaths(env).locks, `checkpoint-${resolved.repository.id}-${key}.lock`);
    return withFileLock(lock, async () => {
      const previous = await readJson(file, { optional: true, validate: validCheckpoint });
      if (key === prepared.key && previous?.fingerprint !== prepared.previous?.fingerprint) {
        return { changed: false, checkpoint: previous, skipped: true, reason: 'concurrent_checkpoint', path: file };
      }
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
  if (!repoId || !git || git.available === false) return null;
  const policy = await getPrivacyPolicy({ repoId, sessionKey, sessionId, agent, env });
  if (!collectionAllowed({ policy, sourceKind: 'checkpoint' })) return null;
  const key = checkpointKey(git);
  const checkpoint = await readJson(checkpointPath(repoId, key, env), {
    optional: true,
    validate: validCheckpoint,
  });
  return checkpoint ? { ...checkpoint, ...filteredProgress(checkpoint, policy) } : null;
}
