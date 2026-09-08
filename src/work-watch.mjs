import { setTimeout as delay } from 'node:timers/promises';

import { autoSync } from './sync/auto.mjs';

/** Bound long-running output; a closed/cancelled pipe is not an acknowledgement. */
export async function writeWatchUpdate(stream, update, { signal } = {}) {
  if (signal?.aborted || stream.destroyed) return false;
  if (stream.write(`${JSON.stringify(update)}\n`) !== false) return true;
  if (typeof stream.once !== 'function') throw new TypeError('A backpressured output stream must support drain events');
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', drained);
      stream.off('close', closed);
      stream.off('error', failed);
      signal?.removeEventListener('abort', closed);
    };
    const drained = () => { cleanup(); resolve(true); };
    const closed = () => { cleanup(); resolve(false); };
    const failed = (error) => { cleanup(); reject(error); };
    stream.once('drain', drained);
    stream.once('close', closed);
    stream.once('error', failed);
    signal?.addEventListener('abort', closed, { once: true });
    if (signal?.aborted || stream.destroyed) closed();
  });
}

/** Local/remote work subscription. Observation is not an acknowledgement. */
export async function* watchWork({
  core, heartbeatCore = core, env = process.env, intervalMs = 1_000, syncIntervalMs = 10_000,
  heartbeatIntervalMs = 60_000, sync = false, heartbeat = true,
  once = false, signal, synchronize = autoSync,
} = {}) {
  for (const [name, value, minimum] of [
    ['intervalMs', intervalMs, 100], ['syncIntervalMs', syncIntervalMs, 1_000],
    ['heartbeatIntervalMs', heartbeatIntervalMs, 1_000],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > 3_600_000) {
      throw new TypeError(`${name} must be an integer between ${minimum} and 3600000`);
    }
  }
  let nextSync = 0;
  let nextHeartbeat = 0;
  let lastState = null;
  let syncState = null;
  const seen = new Set();
  while (!signal?.aborted) {
    let lease = null;
    if (heartbeat && Date.now() >= nextHeartbeat) {
      try {
        lease = await heartbeatCore.work.heartbeat();
      } catch (error) {
        if (error.code !== 'WORK_SESSION_REQUIRED') throw error;
        heartbeat = false;
        lease = { renewed: [], lost: [], unchanged: [], skipped: 'unidentified_session' };
      }
      nextHeartbeat = Date.now() + heartbeatIntervalMs;
    }
    if (sync && Date.now() >= nextSync) {
      const result = await synchronize({ env, timeoutMs: 2_000, lockTimeoutMs: 500, maxConflictRetries: 1 });
      syncState = { status: result.status, reason: result.reason ?? null, pending: result.pending, synced: result.synced };
      nextSync = Date.now() + syncIntervalMs;
    }
    if (signal?.aborted) return;
    const snapshot = await core.work.inspect({ limit: 512 });
    const events = snapshot.events.filter((event) => !seen.has(event.id));
    const signature = JSON.stringify({
      epoch: snapshot.eventCursor.epoch, latest: snapshot.eventCursor.latest,
      conflicts: snapshot.conflicts, gap: snapshot.gap, sync: syncState,
    });
    if (lastState === null || signature !== lastState || events.length || lease?.renewed?.length || lease?.lost?.length) {
      yield { type: 'work_update', ...snapshot, events, sync: syncState, lease };
      for (const event of events) seen.add(event.id);
      // Retain only IDs still represented by the bounded underlying ledger.
      const retained = new Set(snapshot.events.map((event) => event.id));
      for (const id of seen) if (!retained.has(id)) seen.delete(id);
      lastState = signature;
    }
    if (once) return;
    try {
      await delay(intervalMs, undefined, { signal });
    } catch (error) {
      if (error.name === 'AbortError' && signal?.aborted) return;
      throw error;
    }
  }
}
