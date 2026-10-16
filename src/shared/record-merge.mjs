// Pure record contracts and merge rules shared by the browser and connector.
const HANDOFF_PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const HANDOFF_WORKFLOW_STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
const ARRAY_FIELDS = ['decisions', 'failedApproaches', 'changedFiles', 'validation', 'nextSteps', 'openQuestions', 'notes'];
const AGENT_NAMES = new Set(['claude', 'codex', 'cursor', 'manual', 'unknown']);
const isUuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function validPlannedPath(value) {
  if (typeof value !== 'string' || !value.length || value.length > 512
    || value !== value.trim() || /[\x00-\x1f\x7f]/u.test(value)
    || /^[\\/]/u.test(value) || /^[a-z]:/iu.test(value) || /[\\/]$/u.test(value)) return false;
  const parts = value.replaceAll('\\', '/').split('/');
  return !parts.includes('..') && parts.some((part) => part && part !== '.');
}
export function validHandoffRecord(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.schemaVersion === 1 &&
    isUuid(value.id) &&
    isUuid(value.repoId) &&
    ['active', 'closed'].includes(value.status) &&
    typeof value.task === 'string' &&
    typeof value.objective === 'string' &&
    typeof value.currentState === 'string' &&
    typeof value.worktree === 'string' &&
    (value.branch === null || typeof value.branch === 'string') &&
    Number.isFinite(value.staleHours) &&
    typeof value.staleAt === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.priority === undefined || HANDOFF_PRIORITIES.includes(value.priority)) &&
    (value.workflowStatus === undefined || HANDOFF_WORKFLOW_STATUSES.includes(value.workflowStatus)) &&
    (value.dependencies === undefined || (
      Array.isArray(value.dependencies) && value.dependencies.every(isUuid)
    )) &&
    (value.parentId === undefined || value.parentId === null || isUuid(value.parentId)) &&
    (value.claimedBy === undefined || value.claimedBy === null || typeof value.claimedBy === 'string') &&
    (value.claimExpiresAt === undefined || value.claimExpiresAt === null || (typeof value.claimExpiresAt === 'string' && Number.isFinite(Date.parse(value.claimExpiresAt)))) &&
    (value.claimSessionKey === undefined || value.claimSessionKey === null || /^[a-f0-9]{64}$/.test(value.claimSessionKey)) &&
    (value.blockedReason === undefined || typeof value.blockedReason === 'string') &&
    (value.unblockCriteria === undefined || typeof value.unblockCriteria === 'string') &&
    (value.history === undefined || (Array.isArray(value.history) && value.history.length <= 50)) &&
    (value.plannedFiles === undefined || (Array.isArray(value.plannedFiles)
      && value.plannedFiles.length <= 64 && value.plannedFiles.every(validPlannedPath))) &&
    ARRAY_FIELDS.every(
      (field) => Array.isArray(value[field]) && value[field].every((item) => typeof item === 'string'),
    )
  );
}

function validChange(value) {
  return value
    && typeof value === 'object'
    && typeof value.code === 'string'
    && value.code.length === 2
    && typeof value.path === 'string'
    && (value.from === undefined || typeof value.from === 'string');
}

export function validCheckpointRecord(value) {
  return value
    && typeof value === 'object'
    && value.schemaVersion === 1
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

export function canonicalRecord(value) {
  if (Array.isArray(value)) return value.map(canonicalRecord);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalRecord(value[key])]));
}
function equal(left, right) {
  return JSON.stringify(canonicalRecord(left)) === JSON.stringify(canonicalRecord(right));
}
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function isHeartbeatOnly(base, side) {
  const withoutLease = (value) => Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'history' && key !== 'claimExpiresAt'));
  if (!equal(withoutLease(base), withoutLease(side))) return false;
  if (!Number.isFinite(Date.parse(base.claimExpiresAt))
    || !Number.isFinite(Date.parse(side.claimExpiresAt))
    || Date.parse(side.claimExpiresAt) < Date.parse(base.claimExpiresAt)) return false;
  const before = base.history ?? [];
  const after = side.history ?? [];
  for (let overlap = Math.min(before.length, after.length); overlap >= 0; overlap -= 1) {
    if (before.length && !overlap) continue;
    if (!equal(before.slice(before.length - overlap), after.slice(0, overlap))) continue;
    if (after.slice(overlap).every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
      && entry.action === 'claim_renewed' && entry.sessionKey === base.claimSessionKey
      && Number.isFinite(Date.parse(entry.at)))) return true;
  }
  return false;
}

export function mergeHandoffRecords(base, local, remote) {
  if (![base, local, remote].every(validHandoffRecord)
    || ![local, remote].every((value) => value.id === base.id && value.repoId === base.repoId)) return null;
  if (base.status !== 'active' || !base.claimSessionKey || !base.claimedBy || ![local, remote].every((value) =>
    value.status === base.status && value.claimSessionKey === base.claimSessionKey
      && value.claimedBy === base.claimedBy
      && Number.isFinite(Date.parse(value.claimExpiresAt)))) return null;
  for (const side of [local, remote]) {
    if (Date.parse(side.claimExpiresAt) >= Date.parse(base.claimExpiresAt)) continue;
    // Older retained local state may predate the common checkpoint. Its exact
    // audit prefix proves this is an old lease, rather than a fresh shortening.
    const history = side.history ?? [];
    if (!(Date.parse(side.updatedAt) < Date.parse(base.updatedAt)) || !history.length
      || history.length > (base.history ?? []).length
      || !history.every((entry, index) => equal(entry, base.history[index]))) return null;
  }
  const localHeartbeat = isHeartbeatOnly(base, local);
  const remoteHeartbeat = isHeartbeatOnly(base, remote);
  if (!localHeartbeat && !remoteHeartbeat) return null;
  const substantive = localHeartbeat ? remote : local;
  const history = [...new Map([...(local.history ?? []), ...(remote.history ?? [])]
    .map((entry) => [JSON.stringify(canonicalRecord(entry)), entry])).values()];
  // Preserve a deterministic order for concurrent renewals and bounded audit retention.
  if (!history.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && Number.isFinite(Date.parse(entry.at)))) return null;
  history.sort((left, right) => Date.parse(left.at) - Date.parse(right.at)
    || compare(JSON.stringify(canonicalRecord(left)), JSON.stringify(canonicalRecord(right))));
  const value = {
    ...substantive,
    claimExpiresAt: Date.parse(local.claimExpiresAt) >= Date.parse(remote.claimExpiresAt)
      ? local.claimExpiresAt : remote.claimExpiresAt,
    history: history.slice(-50),
  };
  if (!validHandoffRecord(value)) return null;
  return { value, conflicted: false };
}

// Checkpoints are replaceable observations, not competing policy decisions.
// Select one complete record deterministically; never combine HEAD/file facts.
export function mergeCheckpointRecords(base, local, remote) {
  const records = [base, local, remote].filter((value) => value !== null && value !== undefined);
  if (!records.length || !records.every(validCheckpointRecord)
    || records.some((value) => value.repoId !== records[0].repoId || value.key !== records[0].key
      || value.branch !== records[0].branch || !Number.isFinite(Date.parse(value.capturedAt)))) return null;
  const candidates = [local, remote].filter(Boolean);
  if (!candidates.length) return { value: null, conflicted: false };
  candidates.sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt)
    || compare(JSON.stringify(canonicalRecord(left)), JSON.stringify(canonicalRecord(right))));
  return { value: structuredClone(candidates.at(-1)), conflicted: false };
}
