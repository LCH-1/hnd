import path from 'node:path';

import {
  readJson,
  removeFile,
  withFileLock,
  writeJsonAtomic,
} from '../core/fs.mjs';
import { statePaths } from '../paths.mjs';
import {
  reconcileRemoteAutomatically,
  remoteSyncConfigured,
  remoteSyncConflictResolved,
} from '../remote-cli.mjs';

export const AUTO_SYNC_PENDING_SCHEMA_VERSION = 1;
export const AUTO_SYNC_PENDING_FILENAME = 'auto-sync-pending.json';

const RETRY_REASONS = new Set([
  'offline',
  'timeout',
  'server_unavailable',
  'concurrent_update',
  'busy',
]);
const ATTENTION_REASONS = new Set([
  'conflict',
  'authentication',
  'integrity',
  'schema',
  'local_state',
  'remote_error',
]);
const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const TIMEOUT_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ETIMEDOUT',
  'ERR_OPERATION_ABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

function pendingPath(env) {
  return path.join(statePaths(env).cache, AUTO_SYNC_PENDING_FILENAME);
}

function lockPath(env) {
  return path.join(statePaths(env).locks, 'auto-sync.lock');
}

function isoNow(clock = Date) {
  const source = typeof clock === 'function' ? clock() : clock.now();
  const date = source instanceof Date ? source : new Date(source);
  if (Number.isNaN(date.getTime())) throw new TypeError('clock returned an invalid date');
  return date.toISOString();
}

function validPending(value) {
  const allowedKeys = new Set([
    'schemaVersion',
    'pending',
    'kind',
    'reason',
    'attempts',
    'firstPendingAt',
    'lastAttemptAt',
    'conflicts',
  ]);
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowedKeys.has(key))
    && value.schemaVersion === AUTO_SYNC_PENDING_SCHEMA_VERSION
    && value.pending === true
    && ['retry', 'attention'].includes(value.kind)
    && (
      (value.kind === 'retry' && RETRY_REASONS.has(value.reason))
      || (value.kind === 'attention' && ATTENTION_REASONS.has(value.reason))
    )
    && Number.isSafeInteger(value.attempts)
    && value.attempts >= 1
    && typeof value.firstPendingAt === 'string'
    && typeof value.lastAttemptAt === 'string'
    && (value.conflicts === undefined || (
      Number.isSafeInteger(value.conflicts) && value.conflicts >= 1
    ))
  );
}

export async function readAutoSyncPending({ env = process.env } = {}) {
  return readJson(pendingPath(env), { optional: true, validate: validPending });
}

async function replacePending({ env, clock, kind, reason, conflicts }) {
  let current = null;
  try {
    current = await readAutoSyncPending({ env });
  } catch {
    // This file contains status only. Replace a malformed status envelope with
    // a safe attention marker without copying its contents into output/logs.
  }
  const timestamp = isoNow(clock);
  const next = {
    schemaVersion: AUTO_SYNC_PENDING_SCHEMA_VERSION,
    pending: true,
    kind,
    reason,
    attempts: (current?.attempts ?? 0) + 1,
    firstPendingAt: current?.firstPendingAt ?? timestamp,
    lastAttemptAt: timestamp,
    ...(Number.isSafeInteger(conflicts) && conflicts > 0 ? { conflicts } : {}),
  };
  await writeJsonAtomic(pendingPath(env), next);
  return Object.freeze(next);
}

export async function clearAutoSyncPending({ env = process.env } = {}) {
  await removeFile(pendingPath(env));
  return Object.freeze({ cleared: true });
}

function errorChain(error) {
  const values = [];
  let current = error;
  while (current && values.length < 6 && !values.includes(current)) {
    values.push(current);
    current = current.cause;
  }
  return values;
}

function classifyFailure(error) {
  const chain = errorChain(error);
  const names = new Set(chain.map((item) => item?.name).filter(Boolean));
  const codes = new Set(chain.map((item) => item?.code).filter(Boolean));
  const status = chain.find((item) => Number.isInteger(item?.status))?.status;

  if (
    names.has('TimeoutError')
    || names.has('AbortError')
    || [...codes].some((code) => TIMEOUT_ERROR_CODES.has(code))
  ) {
    return Object.freeze({ kind: 'retry', reason: 'timeout' });
  }
  if ([...codes].some((code) => NETWORK_ERROR_CODES.has(code))) {
    return Object.freeze({ kind: 'retry', reason: 'offline' });
  }
  if (status === 401 || status === 403) {
    return Object.freeze({ kind: 'attention', reason: 'authentication' });
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return Object.freeze({ kind: 'retry', reason: 'server_unavailable' });
  }
  if (codes.has('STATE_BUSY')) {
    return Object.freeze({ kind: 'retry', reason: 'busy' });
  }

  // Messages are used only for classification and are never persisted or
  // returned. These errors do not currently carry stable machine codes.
  const message = chain.map((item) => String(item?.message ?? '')).join(' ');
  if (codes.has('REMOTE_CONFLICT') && /rollback|integrity|does not match/i.test(message)) {
    return Object.freeze({ kind: 'attention', reason: 'integrity' });
  }
  if (codes.has('REMOTE_CONFLICT')) {
    return Object.freeze({ kind: 'retry', reason: 'concurrent_update' });
  }
  if (/authentication failed|encrypted snapshot|etag.*match|integrity|digest mismatch/i.test(message)) {
    return Object.freeze({ kind: 'attention', reason: 'integrity' });
  }
  if (/schema|malformed snapshot|valid json|unsupported.*snapshot/i.test(message)) {
    return Object.freeze({ kind: 'attention', reason: 'schema' });
  }
  if (Number.isInteger(status)) {
    return Object.freeze({ kind: 'attention', reason: 'remote_error' });
  }
  return Object.freeze({ kind: 'attention', reason: 'local_state' });
}

function pendingResult(record, { blocked = false } = {}) {
  return Object.freeze({
    status: record.kind === 'attention' ? 'needs_attention' : 'deferred',
    synced: false,
    pending: true,
    reason: record.reason,
    attempts: record.attempts,
    ...(record.conflicts ? { conflicts: record.conflicts } : {}),
    ...(blocked ? { blocked: true } : {}),
  });
}

async function persistFailure(error, options) {
  const classification = classifyFailure(error);
  try {
    const pending = await replacePending({ ...options, ...classification });
    return pendingResult(pending);
  } catch {
    // Hook callers still fail open when the local disk itself cannot accept a
    // pending marker. No original error text or secret is exposed.
    return Object.freeze({
      status: 'needs_attention',
      synced: false,
      pending: false,
      reason: 'local_state',
    });
  }
}

async function handleAttention(pending, { env, retryAttention, lockTimeoutMs }) {
  if (!pending || pending.kind !== 'attention') return { blocked: false, retried: Boolean(pending) };
  if (retryAttention) {
    await clearAutoSyncPending({ env });
    return { blocked: false, retried: true };
  }
  if (pending.reason === 'conflict') {
    const resolved = await remoteSyncConflictResolved(env, { lockTimeoutMs });
    if (resolved) {
      await clearAutoSyncPending({ env });
      return { blocked: false, retried: true };
    }
  }
  return { blocked: true, result: pendingResult(pending, { blocked: true }) };
}

/**
 * Bitwarden-style best-effort synchronization for lifecycle hooks.
 *
 * The function never throws: transient failures become an atomic retry marker,
 * while conflicts and trust/integrity failures become a blocking attention
 * marker. A conflict marker cannot publish on a later automatic invocation;
 * it clears only after a reviewed manual sync makes local state clean, or an
 * explicit caller passes retryAttention.
 */
export async function autoSync({
  env = process.env,
  timeoutMs = 2_000,
  lockTimeoutMs = 1_000,
  maxConflictRetries = 1,
  retryAttention = false,
  fetchImpl,
  clock = Date,
  reconcile = reconcileRemoteAutomatically,
} = {}) {
  const failureOptions = { env, clock };
  try {
    if (!await remoteSyncConfigured(env)) {
      await clearAutoSyncPending({ env });
      return Object.freeze({
        status: 'not_configured',
        synced: false,
        pending: false,
      });
    }

    return await withFileLock(
      lockPath(env),
      async () => {
        const pending = await readAutoSyncPending({ env });
        const attention = await handleAttention(pending, {
          env,
          retryAttention,
          lockTimeoutMs: Math.min(lockTimeoutMs, 2_000),
        });
        if (attention.blocked) return attention.result;

        const result = await reconcile({
          env,
          timeoutMs,
          lockTimeoutMs,
          maxConflictRetries,
          fetchImpl,
        });
        if (result?.status === 'not_configured') {
          await clearAutoSyncPending({ env });
          return Object.freeze({
            status: 'not_configured',
            synced: false,
            pending: false,
          });
        }
        if (result?.status === 'needs_attention') {
          const recorded = await replacePending({
            env,
            clock,
            kind: 'attention',
            reason: result.reason === 'conflict' ? 'conflict' : 'remote_error',
            conflicts: result.conflicts,
          });
          return pendingResult(recorded);
        }
        if (result?.status !== 'synced') {
          throw new TypeError('Automatic sync returned an invalid status');
        }

        await clearAutoSyncPending({ env });
        return Object.freeze({
          status: 'synced',
          synced: true,
          pending: false,
          retried: attention.retried,
          changed: result.changed === true,
          attempts: Number.isSafeInteger(result.attempts) ? result.attempts : 1,
          conflicts: Number.isSafeInteger(result.conflicts) ? result.conflicts : 0,
        });
      },
      { timeoutMs: lockTimeoutMs, staleMs: 5 * 60_000 },
    );
  } catch (error) {
    return persistFailure(error, failureOptions);
  }
}
