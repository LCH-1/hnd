import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { statePaths } from '../paths.mjs';
import { CoreError } from './errors.mjs';
import { readJson, withFileLock, writeJsonAtomic } from './fs.mjs';
import { listHandoffs, normalizePlannedFiles, renewHandoffClaims } from './handoffs.mjs';
import { resolveRepository } from './repositories.mjs';
import { isUuid, isoNow } from './state.mjs';
import { workSessionKey } from './work-session.mjs';

const MAX_EVENTS = 512;
const MAX_SESSIONS = 512;
const MAX_RECORDS = 2048;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const EVENT_ACTIONS = ['created', 'removed', 'closed', 'released', 'taken-over', 'claimed', 'claim-expired', 'files-planned', 'claim-updated', 'updated'];
const TRACKED_FIELDS = [
  'task', 'objective', 'currentState', 'status', 'workflowStatus', 'priority',
  'dependencies', 'parentId', 'claimedBy', 'claimSessionKey', 'claimExpiresAt', 'claimActive',
  'plannedFiles', 'changedFiles', 'blockedReason', 'unblockCriteria', 'decisions',
  'failedApproaches', 'validation', 'nextSteps', 'openQuestions', 'notes', 'history',
];

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function cachePath(repoId, env) {
  if (!isUuid(repoId)) throw new CoreError('INVALID_REPOSITORY_ID', 'A repository UUID is required');
  return path.join(statePaths(env).cache, `work-events-${repoId}.json`);
}

function cacheLock(repoId, env) {
  cachePath(repoId, env);
  return path.join(statePaths(env).locks, `work-events-${repoId}.lock`);
}

function validCache(value) {
  return Boolean(value && value.schemaVersion === 1 && isUuid(value.epoch)
    && Number.isSafeInteger(value.sequence) && value.sequence >= 0 && value.sequence < Number.MAX_SAFE_INTEGER - MAX_RECORDS
    && value.records && typeof value.records === 'object' && !Array.isArray(value.records)
    && Object.keys(value.records).length <= MAX_RECORDS
    && Object.entries(value.records).every(([id, record]) => isUuid(id) && record && record.fields
      && ['active', 'closed'].includes(record.status)
      && TRACKED_FIELDS.every((field) => /^[a-f0-9]{64}$/u.test(record.fields[field])))
    && Array.isArray(value.events) && value.events.length <= MAX_EVENTS
    && value.events.every((event, index) => event && Number.isSafeInteger(event.sequence) && event.sequence > 0
      && event.sequence <= value.sequence && event.id === `${value.epoch}:${event.sequence}`
      && isUuid(event.workId) && Number.isFinite(Date.parse(event.at)) && Array.isArray(event.fields)
      && EVENT_ACTIONS.includes(event.action)
      && (event.actorSessionKey === null || /^[a-f0-9]{64}$/u.test(event.actorSessionKey))
      && (index === 0 || value.events[index - 1].sequence < event.sequence)
      && event.fields.every((field) => TRACKED_FIELDS.includes(field)))
    && value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)
    && Object.keys(value.sessions).length <= MAX_SESSIONS
    && Object.entries(value.sessions).every(([key, session]) => /^[a-f0-9]{64}$/u.test(key) && session
      && Number.isSafeInteger(session.cursor) && session.cursor >= 0 && session.cursor <= value.sequence
      && Array.isArray(session.acknowledged) && session.acknowledged.length <= MAX_EVENTS
      && session.acknowledged.every(Number.isSafeInteger)
      && Array.isArray(session.offered) && session.offered.length <= MAX_EVENTS && session.offered.every(Number.isSafeInteger)
      && Array.isArray(session.ownedIds) && session.ownedIds.length <= MAX_RECORDS
      && session.ownedIds.every(isUuid) && Number.isFinite(Date.parse(session.updatedAt))));
}

async function readCache(repoId, env) {
  try {
    const state = await readJson(cachePath(repoId, env), { optional: true, validate: validCache });
    return { state, reset: false };
  } catch (error) {
    // A corrupt advisory cache must not prevent policy delivery. The new epoch
    // explicitly invalidates old acknowledgement tokens and reports the reset.
    if (!['STATE_CORRUPT', 'INVALID_JSON'].includes(error.code)) throw error;
    return { state: null, reset: true };
  }
}

function snapshotRecord(record) {
  return {
    status: record.status,
    claimSessionKey: record.claimSessionKey ?? null,
    claimActive: Boolean(record.claimActive),
    fields: Object.fromEntries(TRACKED_FIELDS.map((field) => [field, digest(record[field])])),
  };
}

function pruneSessions(sessions, sessionKey, now) {
  const cutoff = Date.parse(now) - MAX_AGE_MS;
  return Object.fromEntries(Object.entries(sessions)
    .filter(([, session]) => Date.parse(session.updatedAt) >= cutoff)
    .sort((left, right) => Number(right[0] === sessionKey) - Number(left[0] === sessionKey)
      || right[1].updatedAt.localeCompare(left[1].updatedAt) || left[0].localeCompare(right[0]))
    .slice(0, MAX_SESSIONS));
}

function eventAction(before, after, fields) {
  if (!before) return 'created';
  if (!after) return 'removed';
  if (before.status !== after.status && after.status === 'closed') return 'closed';
  if (before.claimSessionKey !== after.claimSessionKey) {
    return !after.claimSessionKey ? 'released' : before.claimSessionKey ? 'taken-over' : 'claimed';
  }
  if (before.claimActive && !after.claimActive) return 'claim-expired';
  if (fields.includes('plannedFiles')) return 'files-planned';
  if (fields.includes('claimExpiresAt') && fields.every((field) => ['claimExpiresAt', 'history'].includes(field))) return 'claim-updated';
  return 'updated';
}

function observe(state, records, now) {
  const sorted = [...records].sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active')
    || String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.id.localeCompare(right.id));
  const selected = sorted.slice(0, MAX_RECORDS);
  const snapshots = Object.fromEntries(selected.map((record) => [record.id, snapshotRecord(record)]));
  if (!state) return {
    schemaVersion: 1, epoch: randomUUID(), sequence: 0, records: snapshots, events: [], sessions: {},
  };
  const currentRecords = new Map(records.map((record) => [record.id, record]));
  for (const id of new Set([...Object.keys(state.records), ...Object.keys(snapshots)])) {
    const before = state.records[id];
    const after = snapshots[id];
    // Bounded-snapshot eviction is not a work deletion.
    if (!after && currentRecords.has(id)) continue;
    const fields = !before || !after ? [] : TRACKED_FIELDS.filter((field) => before.fields[field] !== after.fields[field]);
    if (before && after && fields.length === 0) continue;
    const action = eventAction(before, after, fields);
    const actor = action !== 'claim-expired' && (!before || fields.includes('history'))
      ? currentRecords.get(id)?.history?.at(-1)?.sessionKey : null;
    state.sequence += 1;
    state.events.push({
      id: `${state.epoch}:${state.sequence}`, sequence: state.sequence, at: now, workId: id,
      action, fields,
      actorSessionKey: /^[a-f0-9]{64}$/u.test(actor ?? '') ? actor : null,
    });
  }
  state.records = snapshots;
  state.events = state.events.filter((event) => Date.parse(event.at) >= Date.parse(now) - MAX_AGE_MS).slice(-MAX_EVENTS);
  const retained = new Set(state.events.map((event) => event.sequence));
  for (const session of Object.values(state.sessions)) {
    session.acknowledged = session.acknowledged.filter((sequence) => retained.has(sequence));
    session.offered = session.offered.filter((sequence) => retained.has(sequence));
  }
  return state;
}

export function findWorkFileConflicts(records, { sessionKey = null } = {}) {
  const paths = new Map();
  for (const record of records.filter((entry) => entry.status === 'active')) {
    const recordPaths = new Map(normalizePlannedFiles(record.plannedFiles).map((file) => [file, new Set(['planned'])]));
    for (const candidate of record.changedFiles ?? []) {
      let file;
      try {
        [file] = normalizePlannedFiles([candidate]);
      } catch (error) {
        // changedFiles predates structured file intentions and may contain
        // free-form descriptions. Invalid legacy paths are not collection failures.
        if (error.code === 'INVALID_WORK_FILES') continue;
        throw error;
      }
      if (!recordPaths.has(file)) recordPaths.set(file, new Set());
      recordPaths.get(file).add('changed');
    }
    for (const [file, sources] of recordPaths) {
      if (!paths.has(file)) paths.set(file, []);
      paths.get(file).push({
        workId: record.id, sessionKey: record.claimSessionKey ?? null,
        claimActive: Boolean(record.claimActive), claimExpiresAt: record.claimExpiresAt ?? null,
        sources: [...sources],
      });
    }
  }
  return [...paths.entries()].filter(([, works]) => works.length > 1)
    .map(([file, works]) => ({ file, works, affectsSession: Boolean(sessionKey && works.some((work) => work.sessionKey === sessionKey)), advisory: true }))
    .sort((left, right) => Number(right.affectsSession) - Number(left.affectsSession) || left.file.localeCompare(right.file));
}

async function repositoryId(options) {
  if (options.repoId) return options.repoId;
  const resolved = await resolveRepository({ cwd: options.cwd, env: options.env, clock: options.clock });
  return resolved.repository.id;
}

/** Raw functions: callers sharing a state restore boundary must hold withStateLock. */
export async function inspectWorkCoordination({
  repoId, cwd, sessionKey, sessionId, agent, workRecords, limit = 20, env = process.env, clock = Date,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENTS) throw new CoreError('INVALID_WORK_EVENT_LIMIT', 'limit must be between 1 and 512');
  sessionKey = workSessionKey({ sessionKey, sessionId, agent, env });
  repoId = await repositoryId({ repoId, cwd, env, clock });
  const records = workRecords ?? await listHandoffs({ repoId, status: 'all', env, clock });
  const now = isoNow(clock);
  return withFileLock(cacheLock(repoId, env), async () => {
    const loaded = await readCache(repoId, env);
    const state = observe(loaded.state, records, now);
    state.sessions = pruneSessions(state.sessions, sessionKey, now);
    const baseline = Boolean(sessionKey && !state.sessions[sessionKey]);
    if (baseline) state.sessions[sessionKey] = {
      cursor: state.sequence, acknowledged: [], offered: [], ownedIds: [], updatedAt: now,
    };
    const session = state.sessions[sessionKey];
    const oldest = state.events[0]?.sequence ?? state.sequence + 1;
    const gap = session && session.cursor < oldest - 1 ? { from: session.cursor + 1, to: oldest - 1 } : null;
    const pending = session ? state.events.filter((event) => event.sequence > session.cursor && !session.acknowledged.includes(event.sequence)) : [];
    const events = pending.slice(0, limit);
    if (session) {
      session.updatedAt = now;
      session.offered = [...new Set([...session.offered, ...events.map((event) => event.sequence)])].slice(-MAX_EVENTS);
      session.offeredGap = gap;
      // Previewing a takeover must not erase the ownership history before the
      // next heartbeat can report its loss. Heartbeat consumes lost IDs below.
      session.ownedIds = [...new Set([
        ...session.ownedIds,
        ...records.filter((record) => record.status === 'active' && record.claimSessionKey === sessionKey).map((record) => record.id),
      ])].slice(-MAX_RECORDS);
    }
    state.sessions = pruneSessions(state.sessions, sessionKey, now);
    await writeJsonAtomic(cachePath(repoId, env), state);
    return {
      repoId, sessionKey, conflicts: findWorkFileConflicts(records, { sessionKey }), events,
      eventCursor: { epoch: state.epoch, cursor: session?.cursor ?? state.sequence, latest: state.sequence },
      gap, baseline, cacheReset: loaded.reset, pendingCount: pending.length,
      snapshotTruncated: records.length > MAX_RECORDS,
    };
  });
}

export async function acknowledgeWorkEvents({
  repoId, sessionKey, sessionId, agent, epoch, eventIds = [], gapThrough, env = process.env, clock = Date,
} = {}) {
  sessionKey = workSessionKey({ sessionKey, sessionId, agent, env });
  if (!sessionKey) throw new CoreError('WORK_SESSION_REQUIRED', 'A session identity is required to acknowledge work events');
  if (!Array.isArray(eventIds) || eventIds.length > MAX_EVENTS || !eventIds.every((id) => typeof id === 'string')) {
    throw new CoreError('INVALID_WORK_EVENT_ACK', 'eventIds must be a bounded list of event IDs');
  }
  return withFileLock(cacheLock(repoId, env), async () => {
    const { state } = await readCache(repoId, env);
    if (!state || state.epoch !== epoch) throw new CoreError('WORK_EVENT_EPOCH_CHANGED', 'Work event history changed; inspect the current baseline before acknowledging');
    const session = state.sessions[sessionKey];
    if (!session) throw new CoreError('WORK_EVENT_SESSION_REQUIRED', 'Inspect this session before acknowledging events');
    const events = [...new Set(eventIds)].map((id) => state.events.find((event) => event.id === id));
    if (events.some((event) => !event || !session.offered.includes(event.sequence))) {
      throw new CoreError('INVALID_WORK_EVENT_ACK', 'Only events offered to this session can be acknowledged');
    }
    let acknowledgedGap = null;
    if (gapThrough !== undefined) {
      if (!Number.isSafeInteger(gapThrough) || gapThrough !== session.offeredGap?.to) {
        throw new CoreError('INVALID_WORK_EVENT_ACK', 'Only the explicitly offered gap can be acknowledged');
      }
      acknowledgedGap = session.offeredGap;
      session.cursor = Math.max(session.cursor, gapThrough);
      session.offeredGap = null;
    }
    session.acknowledged = [...new Set([...session.acknowledged, ...events.map((event) => event.sequence)])];
    while (session.acknowledged.includes(session.cursor + 1)) session.cursor += 1;
    session.acknowledged = session.acknowledged.filter((sequence) => sequence > session.cursor);
    session.updatedAt = isoNow(clock);
    await writeJsonAtomic(cachePath(repoId, env), state);
    return { repoId, sessionKey, epoch, acknowledgedEventIds: events.map((event) => event.id), acknowledgedGap, cursor: session.cursor };
  });
}

export async function heartbeatWorkSession(options = {}) {
  const env = options.env ?? process.env;
  const clock = options.clock ?? Date;
  const sessionKey = workSessionKey({ ...options, env });
  if (!sessionKey) throw new CoreError('WORK_SESSION_REQUIRED', 'A session identity is required for a work heartbeat');
  const repoId = await repositoryId({ ...options, env, clock });
  const { state } = await readCache(repoId, env);
  const expectedOwnedIds = state?.sessions[sessionKey]?.ownedIds ?? [];
  const result = await renewHandoffClaims({ ...options, repoId, sessionKey, expectedOwnedIds, env, clock });
  const coordination = await inspectWorkCoordination({ ...options, repoId, sessionKey, env, clock });
  if (result.lost.length) {
    await withFileLock(cacheLock(repoId, env), async () => {
      const current = (await readCache(repoId, env)).state;
      const session = current?.sessions[sessionKey];
      if (!session) return;
      const lostIds = new Set(result.lost.map((record) => record.id));
      session.ownedIds = session.ownedIds.filter((id) => !lostIds.has(id));
      await writeJsonAtomic(cachePath(repoId, env), current);
    });
  }
  return { ...result, coordination };
}
