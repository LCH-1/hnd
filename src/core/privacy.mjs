import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';

import { repositoryPaths, statePaths } from '../paths.mjs';
import { CoreError } from './errors.mjs';
import { listFiles, pathExists, readJson, removeFile, withFileLock, writeJsonAtomic } from './fs.mjs';
import { resolveRepositoryBinding } from './repositories.mjs';
import { assertRepositoryId, isoNow, isUuid } from './state.mjs';
import { workSessionKey } from './work-session.mjs';

const SECRET_PATTERNS = [
  ['private_key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|$)/gu],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/gu],
  ['ai_api_key', /\bsk-(?:proj-|ant-[A-Za-z0-9]+-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gu],
  ['aws_access_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{20,}(?![A-Za-z0-9-])/gu],
  ['hnd_credential', /\bhnd[ediscfa]_[A-Za-z0-9_-]{40,64}(?![A-Za-z0-9_-])/gu],
  ['hnd_recovery_code', /\bhndr_[A-Za-z0-9_-]{24,64}(?![A-Za-z0-9_-])/gu],
  ['hnd_connection_code', /\bhndj_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{12}(?![A-Za-z0-9_-])/gu],
  ['hnd_vault_key', /\bhnd-vault-v1:[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu],
  ['bearer_token', /\bBearer[ \t]+[A-Za-z0-9._~+/-]{24,}={0,2}/giu],
];
const SAFE_LOCATION_FIELDS = new Set([
  'title', 'body', 'tags', 'sources', 'ref', 'label', 'hash', 'commit', 'history',
  'before', 'notes', 'decisions', 'currentState', 'objective', 'nextSteps', 'changes',
  'path', 'from', 'lastCommit', 'content', 'text', 'message', 'prompt',
]);
const SOURCE_KINDS = new Set(['session', 'file', 'checkpoint']);
const POLICY_FIELDS = new Set(['enabled', 'excludePaths', 'excludeSources', 'retentionDays']);
const DEFAULT_POLICY = Object.freeze({
  enabled: true, excludePaths: Object.freeze([]), excludeSources: Object.freeze([]), retentionDays: null,
});
const DERIVED_KNOWLEDGE_CACHE_PATHS = Object.freeze([
  'cache/knowledge-fts.sqlite',
  'cache/knowledge-fts.sqlite-wal',
  'cache/knowledge-fts.sqlite-shm',
  'cache/knowledge-vectors.json',
]);

function textFindings(text, location) {
  const findings = [];
  for (const [type, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ type, location, line: text.slice(0, match.index).split('\n').length });
    }
  }
  return findings;
}

/** Diagnostics contain categories and positions only, never matched bytes. */
export function scanSensitive(value) {
  const findings = [];
  const visited = new WeakSet();
  function visit(item, location) {
    if (typeof item === 'string') {
      findings.push(...textFindings(item, location));
    } else if (item && typeof item === 'object' && !visited.has(item)) {
      visited.add(item);
      for (const [index, [key, child]] of Object.entries(item).entries()) {
        // Arbitrary object keys may themselves be secrets. Never echo them in
        // an error path; known schema fields still give useful locations.
        const segment = Array.isArray(item) ? key : SAFE_LOCATION_FIELDS.has(key) ? key : `field-${index}`;
        findings.push(...textFindings(key, `${location}/${segment}`));
        visit(child, `${location}/${segment}`);
      }
    }
  }
  visit(value, '$');
  return findings;
}

export function assertNoSensitive(value, { allowSensitive = false } = {}) {
  if (typeof allowSensitive !== 'boolean') throw new CoreError('INVALID_PRIVACY_POLICY', 'allowSensitive must be boolean');
  const findings = scanSensitive(value);
  if (findings.length && !allowSensitive) {
    throw new CoreError(
      'SENSITIVE_CONTENT',
      'Possible credentials or a private key were found. Remove them before saving, or explicitly allow sensitive storage.',
      { findings },
    );
  }
  return findings;
}

export function redactSensitiveText(value) {
  const text = String(value ?? '');
  const findings = textFindings(text, '$');
  let redacted = text;
  for (const [type, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, `[REDACTED:${type}]`);
  }
  return { text: redacted, findings };
}

function validateGlob(value) {
  if (typeof value !== 'string' || !value || value.length > 256
    || /[\\\u0000-\u001f]/u.test(value) || value.startsWith('/') || /^[A-Za-z]:/u.test(value)
    || value.split('/').some((part) => !part || part === '..' || part === '.')) {
    throw new CoreError('INVALID_PRIVACY_POLICY', 'Exclusions must be repository-relative glob patterns without traversal');
  }
  return value;
}

function normalizePolicy(value, { partial = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !POLICY_FIELDS.has(key))) {
    throw new CoreError('INVALID_PRIVACY_POLICY', 'Unsupported collection policy fields');
  }
  const policy = partial ? { ...value } : { ...DEFAULT_POLICY, ...value };
  if (Object.hasOwn(policy, 'enabled') && typeof policy.enabled !== 'boolean') {
    throw new CoreError('INVALID_PRIVACY_POLICY', 'enabled must be boolean');
  }
  if (Object.hasOwn(policy, 'retentionDays') && policy.retentionDays !== null
    && (!Number.isSafeInteger(policy.retentionDays) || policy.retentionDays < 1 || policy.retentionDays > 36500)) {
    throw new CoreError('INVALID_PRIVACY_POLICY', 'retentionDays must be null or an integer from 1 to 36500');
  }
  if (Object.hasOwn(policy, 'excludePaths')) {
    if (!Array.isArray(policy.excludePaths) || policy.excludePaths.length > 100) {
      throw new CoreError('INVALID_PRIVACY_POLICY', 'excludePaths must contain at most 100 patterns');
    }
    policy.excludePaths = [...new Set(policy.excludePaths.map(validateGlob))];
  }
  if (Object.hasOwn(policy, 'excludeSources')) {
    if (!Array.isArray(policy.excludeSources) || policy.excludeSources.some((kind) => !SOURCE_KINDS.has(kind))) {
      throw new CoreError('INVALID_PRIVACY_POLICY', 'excludeSources supports session, file, and checkpoint');
    }
    policy.excludeSources = [...new Set(policy.excludeSources)];
  }
  return policy;
}

function validPrivacyState(value) {
  if (!value || value.schemaVersion !== 1 || !value.projects || !value.sessions
    || Array.isArray(value.projects) || Array.isArray(value.sessions)
    || typeof value.projects !== 'object' || typeof value.sessions !== 'object') return false;
  try {
    for (const [key, policy] of Object.entries(value.projects)) {
      if (!isUuid(key)) return false;
      normalizePolicy(policy, { partial: true });
    }
    for (const [key, policy] of Object.entries(value.sessions)) {
      const [repoId, sessionKey] = key.split(':');
      if (!isUuid(repoId) || !/^[a-f0-9]{64}$/u.test(sessionKey ?? '') || key !== `${repoId}:${sessionKey}`) return false;
      normalizePolicy(policy, { partial: true });
    }
    return true;
  } catch {
    return false;
  }
}

async function privacyState(env) {
  if (!await assertLocalDirectory(statePaths(env).home, statePaths(env).home)) {
    return { schemaVersion: 1, projects: {}, sessions: {} };
  }
  return await readJson(path.join(statePaths(env).home, 'privacy.json'), {
    optional: true, validate: validPrivacyState,
  }) ?? { schemaVersion: 1, projects: {}, sessions: {} };
}

async function assertLocalDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CoreError('UNSAFE_STATE_PATH', 'Privacy data must remain inside HND state');
  }
  let current = root;
  for (const segment of ['', ...(relative ? relative.split(path.sep) : [])]) {
    if (segment) current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new CoreError('UNSAFE_STATE_PATH', 'Privacy state directory must not be a symbolic link');
    }
  }
  return true;
}

async function privacyIdentity(options) {
  const env = options.env ?? process.env;
  const repoId = options.repoId ? assertRepositoryId(options.repoId)
    : (await resolveRepositoryBinding({ ...options, env })).repository.id;
  return { env, repoId, sessionKey: workSessionKey({ ...options, env }) };
}

export async function getPrivacyPolicy(options = {}) {
  const identity = await privacyIdentity(options);
  const state = await privacyState(identity.env);
  const project = normalizePolicy(state.projects[identity.repoId] ?? {});
  const session = normalizePolicy(identity.sessionKey ? state.sessions[`${identity.repoId}:${identity.sessionKey}`] ?? {} : {});
  const durations = [project.retentionDays, session.retentionDays].filter((days) => days !== null);
  return {
    repoId: identity.repoId,
    sessionKey: identity.sessionKey,
    enabled: project.enabled && session.enabled,
    excludePaths: [...new Set([...project.excludePaths, ...session.excludePaths])],
    excludeSources: [...new Set([...project.excludeSources, ...session.excludeSources])],
    retentionDays: durations.length ? Math.min(...durations) : null,
    project,
    session,
    scope: 'local_hnd_state_only',
  };
}

/** Caller uses the core state lock; this small lock also protects direct calls. */
export async function setPrivacyPolicy({ scope = 'project', policy, ...options } = {}) {
  if (!['project', 'session'].includes(scope)) throw new CoreError('INVALID_PRIVACY_POLICY', 'Scope must be project or session');
  const identity = await privacyIdentity(options);
  if (scope === 'session' && !identity.sessionKey) {
    throw new CoreError('WORK_SESSION_REQUIRED', 'Session-scoped collection settings require an identified agent session');
  }
  const patch = normalizePolicy(policy, { partial: true });
  await privacyState(identity.env);
  await withFileLock(path.join(statePaths(identity.env).locks, 'privacy-policy.lock'), async () => {
    const state = await privacyState(identity.env);
    const collection = scope === 'project' ? state.projects : state.sessions;
    const key = scope === 'project' ? identity.repoId : `${identity.repoId}:${identity.sessionKey}`;
    collection[key] = { ...collection[key], ...patch };
    await writeJsonAtomic(path.join(statePaths(identity.env).home, 'privacy.json'), state);
  });
  return getPrivacyPolicy({ ...options, ...identity });
}

function globExpression(glob) {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      index += 1;
      if (glob[index + 1] === '/') { index += 1; pattern += '(?:.*/)?'; }
      else pattern += '.*';
    } else if (character === '*') pattern += '[^/]*';
    else if (character === '?') pattern += '[^/]';
    else pattern += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(`^${pattern}$`, 'u');
}

export function collectionAllowed({ policy = DEFAULT_POLICY, sourceKind, relativePath } = {}) {
  if (!policy.enabled || policy.excludeSources.includes(sourceKind)) return false;
  if (relativePath !== undefined) {
    if (typeof relativePath !== 'string' || relativePath.startsWith('/') || relativePath.includes('\\')
      || relativePath.split('/').includes('..') || /^[A-Za-z]:/u.test(relativePath)) return false;
    if (scanSensitive(relativePath).length) return false;
    if (policy.excludePaths.some((glob) => globExpression(glob).test(relativePath))) return false;
  }
  return true;
}

function retentionSessionMatches(entry, sessionKey) {
  if (!sessionKey) return true;
  return entry.sessionKey === sessionKey
    || entry.history?.at(-1)?.sessionKey === sessionKey
    || entry.sources?.some((source) => source.kind === 'session' && source.ref === `hnd-session:${sessionKey}`);
}

async function retentionReferences(paths, repositories) {
  const work = new Set();
  const knowledge = new Set();
  if (await assertLocalDirectory(paths.home, repositories.handoffs)) {
    for (const file of await listFiles(repositories.handoffs, { suffix: '.json' })) {
      const entry = await readJson(file);
      if (entry.status !== 'active') continue;
      if (isUuid(entry.parentId)) work.add(entry.parentId);
      for (const id of entry.dependencies ?? []) if (isUuid(id)) work.add(id);
    }
  }
  if (await assertLocalDirectory(paths.home, paths.knowledge)) {
    for (const file of await listFiles(paths.knowledge, { suffix: '.json' })) {
      const entry = await readJson(file);
      for (const relation of entry.relationships ?? []) {
        if (isUuid(relation.targetId) && relation.targetId !== entry.id) knowledge.add(relation.targetId);
      }
    }
  }
  return { work, knowledge };
}

/** Preview never deletes. Policy and user-authored/approved knowledge are excluded. */
export async function previewRetention(options = {}) {
  const policy = await getPrivacyPolicy(options);
  const env = options.env ?? process.env;
  const paths = statePaths(env);
  const repositories = repositoryPaths(policy.repoId, env);
  const now = isoNow(options.clock ?? Date);
  const items = [];
  if (policy.retentionDays !== null) {
    if (await pathExists(path.join(paths.cache, 'knowledge-merge-journal.json'))) {
      throw new CoreError('STATE_RECOVERY_REQUIRED', 'Recover the interrupted knowledge merge before previewing retention');
    }
    const cutoff = Date.parse(now) - policy.retentionDays * 86_400_000;
    const references = await retentionReferences(paths, repositories);
    for (const [kind, directory] of [
      ['knowledge_candidate', paths.knowledge],
      ['checkpoint', repositories.checkpoints],
      ['closed_work', repositories.archive],
    ]) {
      if (!await assertLocalDirectory(paths.home, directory)) continue;
      for (const file of await listFiles(directory, { suffix: '.json' })) {
        const entry = await readJson(file);
        if (entry.schemaVersion !== 1) continue;
        if (entry.repoId !== policy.repoId || !retentionSessionMatches(entry, policy.sessionKey)) continue;
        if (kind === 'knowledge_candidate' && (entry.state !== 'review_needed' || entry.approval !== 'pending'
          || !entry.tags?.includes('session-suggestion') || !entry.sources?.some((source) => source.kind === 'session'))) continue;
        if (kind === 'closed_work' && entry.status !== 'closed') continue;
        const timestamp = kind === 'checkpoint' ? entry.capturedAt : entry.updatedAt ?? entry.closedAt;
        if (!Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) >= cutoff) continue;
        // Only canonical HND collection filenames are eligible, never arbitrary
        // filesystem paths supplied by callers or embedded in imported records.
        const id = path.basename(file, '.json');
        if (kind === 'checkpoint' ? !/^[a-f0-9]{64}$/u.test(id) : !isUuid(id)) continue;
        if (kind === 'checkpoint' ? entry.key !== id : entry.id !== id) continue;
        if ((kind === 'closed_work' && references.work.has(id))
          || (kind === 'knowledge_candidate' && references.knowledge.has(id))) continue;
        const digest = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
        items.push({ kind, id, path: path.relative(paths.home, file).split(path.sep).join('/'), updatedAt: timestamp, digest });
      }
    }
  }
  items.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const cacheInvalidation = items.some((item) => item.kind === 'knowledge_candidate')
    ? [...DERIVED_KNOWLEDGE_CACHE_PATHS] : [];
  const previewId = createHash('sha256').update(JSON.stringify({
    stateHome: path.resolve(paths.home),
    repoId: policy.repoId, sessionKey: policy.sessionKey, retentionDays: policy.retentionDays, items, cacheInvalidation,
  })).digest('hex');
  return {
    previewId, scope: 'local_hnd_state_only', repoId: policy.repoId, sessionKey: policy.sessionKey,
    retentionDays: policy.retentionDays, count: items.length, items, cacheInvalidation,
    applied: false, remoteCopiesDeleted: false,
    warning: 'Local deletion and rebuildable search-cache invalidation only, not secure erasure. Server revisions, synced devices, provider history, backups, and filesystem recovery copies are not erased and may restore data.',
  };
}

async function applyRetentionPreview(preview, root) {
  // Validate every source and cache target before deleting any of them. The
  // cache filenames are a fixed list, never provided by a caller or record.
  for (const relativePath of [...preview.items.map((item) => item.path), ...preview.cacheInvalidation]) {
    const target = path.join(root, ...relativePath.split('/'));
    await assertLocalDirectory(root, path.dirname(target));
    let metadata;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if (error.code === 'ENOENT' && preview.cacheInvalidation.includes(relativePath)) continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new CoreError('UNSAFE_STATE_PATH', 'Retention target must be a regular managed file');
  }
  // Invalidate first: if the disk refuses cache removal, no source record is
  // deleted while an indexed plaintext copy is known to remain.
  const invalidatedCaches = [];
  for (const relativePath of preview.cacheInvalidation) {
    if (await removeFile(path.join(root, ...relativePath.split('/')))) invalidatedCaches.push(relativePath);
  }
  for (const item of preview.items) await removeFile(path.join(root, ...item.path.split('/')));
  return { ...preview, applied: true, removed: preview.items.map((item) => item.path), invalidatedCaches };
}

/** Must run under the core state lock; the supplied preview is recomputed. */
export async function applyRetention({ previewId, ...options } = {}) {
  if (!/^[a-f0-9]{64}$/u.test(previewId ?? '')) {
    throw new CoreError('RETENTION_PREVIEW_REQUIRED', 'Preview retention first and supply its previewId to apply deletion');
  }
  const paths = statePaths(options.env ?? process.env);
  await assertLocalDirectory(paths.home, paths.home);
  // All supported FTS users open/close their synchronous SQLite handle inside
  // knowledge.lock. Holding it here excludes active HND DB handles, including
  // WAL/SHM writers. Semantic requests release their lock before reacquiring
  // knowledge.lock, so state -> knowledge -> semantic cannot deadlock them.
  return withFileLock(path.join(paths.locks, 'knowledge.lock'), async () => {
    const preview = await previewRetention(options);
    if (preview.previewId !== previewId) {
      throw new CoreError('RETENTION_PREVIEW_STALE', 'The retention preview changed; review a fresh preview before deleting');
    }
    if (!preview.cacheInvalidation.length) return applyRetentionPreview(preview, paths.home);
    return withFileLock(
      path.join(paths.locks, 'semantic-search.lock'),
      () => applyRetentionPreview(preview, paths.home),
      { timeoutMs: 15_000, staleMs: 30_000 },
    );
  });
}
