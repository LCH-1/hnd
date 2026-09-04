import { createHash } from 'node:crypto';
import path from 'node:path';

import { readJson, removeFile, writeJsonAtomic } from '../core/fs.mjs';
import { withStateLock } from '../core/mutation-lock.mjs';
import { statePaths } from '../paths.mjs';
import { snapshotDigest } from '../remote-cli.mjs';
import { captureSyncSnapshot } from './capture.mjs';
import { autoSync } from './auto.mjs';

const MARKER_SCHEMA_VERSION = 1;
const MARKER_FILENAME = 'auto-sync-hook.json';
const SAME_SESSION_MAX_AGE_MS = 5 * 60_000;
const ANONYMOUS_END_MAX_AGE_MS = 15_000;

function markerPath(env) {
  return path.join(statePaths(env).cache, MARKER_FILENAME);
}

function nowDate(clock = Date) {
  const source = typeof clock === 'function' ? clock() : clock.now();
  const date = source instanceof Date ? source : new Date(source);
  if (Number.isNaN(date.getTime())) throw new TypeError('clock returned an invalid date');
  return date;
}

function validMarker(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).every((key) => [
      'schemaVersion',
      'sessionHash',
      'snapshotDigest',
      'succeededAt',
    ].includes(key))
    && value.schemaVersion === MARKER_SCHEMA_VERSION
    && (value.sessionHash === null || /^[a-f0-9]{64}$/.test(value.sessionHash))
    && /^[a-f0-9]{64}$/.test(value.snapshotDigest)
    && typeof value.succeededAt === 'string'
  );
}

function sessionHash(agent, payload) {
  const candidate = [
    payload?.session_id,
    payload?.sessionId,
    payload?.conversation_id,
    payload?.conversationId,
    payload?.thread_id,
    payload?.threadId,
  ].find((value) => (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !value.includes('\0')
  ));
  if (!candidate) return null;
  return createHash('sha256').update(`${agent}\0${candidate}`).digest('hex');
}

async function currentSnapshotDigest(env) {
  const snapshot = await withStateLock(
    () => captureSyncSnapshot(statePaths(env).home),
    { env },
  );
  return snapshotDigest(snapshot);
}

export async function readHookSyncMarker({ env = process.env } = {}) {
  return readJson(markerPath(env), { optional: true, validate: validMarker });
}

async function endAlreadyCovered({ agent, payload, env, clock }) {
  let marker;
  try {
    marker = await readHookSyncMarker({ env });
  } catch {
    return false;
  }
  if (!marker) return false;
  const age = nowDate(clock).getTime() - Date.parse(marker.succeededAt);
  if (!Number.isFinite(age) || age < 0) return false;
  const currentSessionHash = sessionHash(agent, payload);
  if (currentSessionHash && marker.sessionHash !== currentSessionHash) return false;
  const maxAge = currentSessionHash ? SAME_SESSION_MAX_AGE_MS : ANONYMOUS_END_MAX_AGE_MS;
  if (age > maxAge) return false;
  try {
    return await currentSnapshotDigest(env) === marker.snapshotDigest;
  } catch {
    return false;
  }
}

async function rememberSuccessfulStop({ agent, payload, env, clock }) {
  try {
    await writeJsonAtomic(markerPath(env), {
      schemaVersion: MARKER_SCHEMA_VERSION,
      sessionHash: sessionHash(agent, payload),
      snapshotDigest: await currentSnapshotDigest(env),
      succeededAt: nowDate(clock).toISOString(),
    });
  } catch {
    // This marker is only a network de-duplication optimization. A failed write
    // means SessionEnd safely retries instead of risking a missed sync.
  }
}

/**
 * Runs lifecycle synchronization without ever changing a vendor hook's output.
 * Stop success is remembered so the immediately-following SessionEnd can avoid
 * a duplicate network round trip; a deferred Stop deliberately leaves no marker.
 */
export async function syncForHook({
  agent,
  phase,
  payload = {},
  env = process.env,
  clock = Date,
  timeoutMs = phase === 'end' ? 500 : phase === 'prompt' ? 750 : 1_000,
  lockTimeoutMs = 200,
  reconcile,
  fetchImpl,
} = {}) {
  if (!['claude', 'codex', 'cursor'].includes(agent)) {
    throw new TypeError(`Unsupported hook agent: ${agent}`);
  }
  if (!['start', 'prompt', 'stop', 'end'].includes(phase)) {
    throw new TypeError(`Unsupported hook phase: ${phase}`);
  }
  if (phase === 'end' && await endAlreadyCovered({ agent, payload, env, clock })) {
    return Object.freeze({
      status: 'skipped',
      synced: true,
      pending: false,
      reason: 'stop_already_synced',
    });
  }

  const result = await autoSync({
    env,
    clock,
    timeoutMs,
    lockTimeoutMs,
    maxConflictRetries: 1,
    reconcile,
    fetchImpl,
  });
  if (phase === 'stop' && result.status === 'synced') {
    await rememberSuccessfulStop({ agent, payload, env, clock });
  } else if (phase === 'stop') {
    // A stale success marker must never suppress SessionEnd's fallback retry
    // after this Stop was deferred or required attention.
    await removeFile(markerPath(env)).catch(() => {});
  }
  return result;
}
