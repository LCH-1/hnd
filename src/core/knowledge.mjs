import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { DEFAULT_MAX_CONTEXT_BYTES, STATE_SCHEMA_VERSION } from '../constants.mjs';
import { statePaths } from '../paths.mjs';
import { CoreError } from './errors.mjs';
import {
  listFiles,
  readJson,
  removeFile,
  withFileLock,
  writeJsonAtomic,
} from './fs.mjs';
import {
  getRepository,
  resolveRepository,
} from './repositories.mjs';
import {
  initializeState,
  isUuid,
  isoNow,
  validateEnvironmentLabel,
  validatePortableEnvironmentLabel,
} from './state.mjs';
import { searchKnowledgeIndex } from './knowledge-index.mjs';

const MAX_TITLE_CHARS = 200;
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 48;
const MAX_BODY_BYTES = DEFAULT_MAX_CONTEXT_BYTES * 8;
export const KNOWLEDGE_SCOPES = Object.freeze(['global', 'repo', 'env']);
export const KNOWLEDGE_TYPES = Object.freeze([
  'note', 'decision', 'solution', 'failure', 'caution', 'command',
  'architecture', 'runbook',
]);
export const KNOWLEDGE_STATES = Object.freeze([
  'verified', 'review_needed', 'contradicted', 'retired', 'superseded',
]);
export const KNOWLEDGE_APPROVALS = Object.freeze(['approved', 'pending', 'rejected']);
export const KNOWLEDGE_RELATIONS = Object.freeze([
  'related', 'supersedes', 'contradicts', 'causes', 'resolves',
]);
const MAX_SOURCES = 20;
const MAX_RELATIONSHIPS = 20;
const MAX_HISTORY = 20;
const KNOWLEDGE_MERGE_JOURNAL_SCHEMA_VERSION = 1;
const KNOWLEDGE_MERGE_JOURNAL_FILENAME = 'knowledge-merge-journal.json';

function requireText(value, field, { maxChars, maxBytes, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new CoreError('INVALID_KNOWLEDGE', `${field} must be text without NUL bytes`);
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) {
    throw new CoreError('INVALID_KNOWLEDGE', `${field} must not be empty`);
  }
  if (maxChars && [...normalized].length > maxChars) {
    throw new CoreError('INVALID_KNOWLEDGE', `${field} is too long`);
  }
  if (maxBytes && Buffer.byteLength(normalized) > maxBytes) {
    throw new CoreError('INVALID_KNOWLEDGE', `${field} exceeds ${maxBytes} bytes`);
  }
  return normalized;
}

function normalizeTags(value = []) {
  if (!Array.isArray(value)) {
    throw new CoreError('INVALID_KNOWLEDGE', 'tags must be an array');
  }
  const tags = [];
  const seen = new Set();
  for (const source of value) {
    const tag = requireText(source, 'tag', { maxChars: MAX_TAG_CHARS });
    const key = tag.normalize('NFKC').toLocaleLowerCase('und');
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS) {
    throw new CoreError('INVALID_KNOWLEDGE', `A note may have at most ${MAX_TAGS} tags`);
  }
  return tags;
}

function enumValue(value, allowed, field, fallback) {
  const normalized = value ?? fallback;
  if (!allowed.includes(normalized)) {
    throw new CoreError('INVALID_KNOWLEDGE', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return normalized;
}

function normalizeSources(value = []) {
  if (!Array.isArray(value) || value.length > MAX_SOURCES) {
    throw new CoreError('INVALID_KNOWLEDGE', `sources must contain at most ${MAX_SOURCES} items`);
  }
  return value.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new CoreError('INVALID_KNOWLEDGE', `sources[${index}] must be an object`);
    }
    const kind = enumValue(
      source.kind,
      ['file', 'commit', 'session', 'url', 'person', 'import'],
      `sources[${index}].kind`,
      'file',
    );
    return {
      kind,
      ref: requireText(source.ref, `sources[${index}].ref`, { maxChars: 1000 }),
      label: source.label === undefined
        ? null
        : requireText(source.label, `sources[${index}].label`, { maxChars: 200 }),
      hash: source.hash === undefined || source.hash === null
        ? null
        : requireText(source.hash, `sources[${index}].hash`, { maxChars: 128 }),
      commit: source.commit === undefined || source.commit === null
        ? null
        : requireText(source.commit, `sources[${index}].commit`, { maxChars: 128 }),
    };
  });
}

function normalizeRelationships(value = []) {
  if (!Array.isArray(value) || value.length > MAX_RELATIONSHIPS) {
    throw new CoreError(
      'INVALID_KNOWLEDGE',
      `relationships must contain at most ${MAX_RELATIONSHIPS} items`,
    );
  }
  return value.map((relationship, index) => {
    if (!relationship || typeof relationship !== 'object' || Array.isArray(relationship)) {
      throw new CoreError('INVALID_KNOWLEDGE', `relationships[${index}] must be an object`);
    }
    return {
      type: enumValue(
        relationship.type,
        KNOWLEDGE_RELATIONS,
        `relationships[${index}].type`,
        'related',
      ),
      targetId: isUuid(relationship.targetId)
        ? relationship.targetId
        : (() => { throw new CoreError('INVALID_KNOWLEDGE', 'relationship targetId must be a UUID'); })(),
    };
  });
}

function normalizeFeedback(value = {}) {
  const result = {};
  for (const key of ['helpful', 'wrong', 'irrelevant']) {
    const count = value?.[key] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new CoreError('INVALID_KNOWLEDGE', `feedback.${key} must be a non-negative integer`);
    }
    result[key] = count;
  }
  return result;
}

function validSource(source) {
  return source && typeof source === 'object' && !Array.isArray(source)
    && ['file', 'commit', 'session', 'url', 'person', 'import'].includes(source.kind)
    && typeof source.ref === 'string'
    && (source.label === null || typeof source.label === 'string')
    && (source.hash === null || typeof source.hash === 'string')
    && (source.commit === null || typeof source.commit === 'string');
}

function validHistory(history) {
  return Array.isArray(history) && history.length <= MAX_HISTORY && history.every((item) => (
    item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.at === 'string' && typeof item.action === 'string'
    && (item.actor === null || typeof item.actor === 'string')
    && (item.deviceId === null || typeof item.deviceId === 'string')
    && (item.agent === null || typeof item.agent === 'string')
    && (item.before === null || (typeof item.before === 'object' && !Array.isArray(item.before)))
  ));
}

export function validateKnowledgeEntry(value) {
  const scope = value?.scope ?? 'global';
  const repoId = value?.repoId ?? null;
  const environment = value?.environment ?? null;
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).every((key) => [
      'schemaVersion', 'id', 'title', 'body', 'tags', 'scope', 'repoId',
      'environment', 'type', 'state', 'pinned', 'sources', 'relationships',
      'feedback', 'approval', 'history', 'createdAt', 'updatedAt',
    ].includes(key))
    && value.schemaVersion === STATE_SCHEMA_VERSION
    && isUuid(value.id)
    && typeof value.title === 'string'
    && value.title.length > 0
    && typeof value.body === 'string'
    && Array.isArray(value.tags)
    && value.tags.every((tag) => typeof tag === 'string')
    && (value.type === undefined || KNOWLEDGE_TYPES.includes(value.type))
    && (value.state === undefined || KNOWLEDGE_STATES.includes(value.state))
    && (value.pinned === undefined || typeof value.pinned === 'boolean')
    && (value.sources === undefined || (Array.isArray(value.sources) && value.sources.every(validSource)))
    && (value.relationships === undefined || (
      Array.isArray(value.relationships)
      && value.relationships.every((item) => (
        KNOWLEDGE_RELATIONS.includes(item?.type) && isUuid(item?.targetId)
      ))
    ))
    && (value.feedback === undefined || (
      value.feedback && typeof value.feedback === 'object'
      && ['helpful', 'wrong', 'irrelevant'].every((key) => Number.isSafeInteger(value.feedback[key]) && value.feedback[key] >= 0)
    ))
    && (value.approval === undefined || KNOWLEDGE_APPROVALS.includes(value.approval))
    && (value.history === undefined || validHistory(value.history))
    && KNOWLEDGE_SCOPES.includes(scope)
    && (
      (scope === 'global' && repoId === null && environment === null)
      || (scope === 'repo' && isUuid(repoId) && environment === null)
      || (
        scope === 'env'
        && isUuid(repoId)
        && typeof environment === 'string'
        && environment.length > 0
      )
    )
    && Number.isFinite(Date.parse(value.createdAt))
    && Number.isFinite(Date.parse(value.updatedAt))
  );
}

function notePath(directory, id) {
  if (!isUuid(id)) throw new CoreError('INVALID_KNOWLEDGE_ID', `Invalid knowledge id: ${id}`);
  return path.join(directory, `${id}.json`);
}

async function readEntry(file, expectedId) {
  const entry = await readJson(file, { validate: validateKnowledgeEntry });
  if (entry.id !== expectedId || path.basename(file) !== `${entry.id}.json`) {
    throw new CoreError('STATE_CORRUPT', `Knowledge entry is stored in the wrong location: ${file}`);
  }
  return normalizeStoredScope(entry);
}

function normalizeKnowledgeScope(value = 'global') {
  const scope = value === 'all' ? 'global' : value;
  if (!KNOWLEDGE_SCOPES.includes(scope)) {
    throw new CoreError(
      'INVALID_KNOWLEDGE_SCOPE',
      `Knowledge scope must be all, repo, or env: ${value}`,
      { scope: value, allowed: ['all', 'repo', 'env'] },
    );
  }
  return scope;
}

function normalizeStoredScope(entry) {
  return {
    ...entry,
    scope: entry.scope ?? 'global',
    repoId: entry.repoId ?? null,
    environment: entry.environment ?? null,
    type: entry.type ?? 'note',
    state: entry.state ?? 'verified',
    pinned: entry.pinned === true,
    sources: entry.sources ?? [],
    relationships: entry.relationships ?? [],
    feedback: entry.feedback ?? { helpful: 0, wrong: 0, irrelevant: 0 },
    approval: entry.approval ?? 'approved',
    history: entry.history ?? [],
  };
}

function historySnapshot(entry) {
  return Object.fromEntries([
    'title', 'body', 'tags', 'scope', 'repoId', 'environment', 'type', 'state',
    'pinned', 'sources', 'relationships', 'feedback', 'approval',
  ].map((key) => [key, structuredClone(entry[key])]));
}

function historyRecord({ at, action, actor, deviceId, agent, before = null } = {}) {
  return {
    at,
    action,
    actor: actor ? String(actor).slice(0, 200) : null,
    deviceId: deviceId ? String(deviceId).slice(0, 200) : null,
    agent: agent ? String(agent).slice(0, 80) : null,
    before,
  };
}

async function resolveKnowledgeScope({
  scope = 'global',
  repoId,
  cwd,
  environment,
  env,
  clock,
  createRepository = true,
} = {}) {
  const normalizedScope = normalizeKnowledgeScope(scope);
  if (normalizedScope === 'global') {
    return { scope: normalizedScope, repoId: null, environment: null };
  }

  let resolvedRepoId;
  let selectedEnvironment;
  if (repoId) {
    const repository = await getRepository({ repoId, env, clock });
    resolvedRepoId = repository.id;
  } else {
    if (!cwd) {
      throw new CoreError(
        'REPOSITORY_REQUIRED',
        'Repository or environment knowledge requires repoId or cwd',
      );
    }
    const resolved = await resolveRepository({
      cwd,
      env,
      clock,
      create: createRepository,
    });
    resolvedRepoId = resolved.repository.id;
    selectedEnvironment = resolved.environment;
  }

  if (normalizedScope === 'repo') {
    return { scope: normalizedScope, repoId: resolvedRepoId, environment: null };
  }
  const label = validateEnvironmentLabel(environment ?? selectedEnvironment);
  validatePortableEnvironmentLabel(label);
  return { scope: normalizedScope, repoId: resolvedRepoId, environment: label };
}

async function readAllUnlocked(state) {
  const files = await listFiles(state.knowledge, { suffix: '.json' });
  return Promise.all(files.map((file) => readEntry(file, path.basename(file, '.json'))));
}

function publicEntry(entry) {
  return structuredClone(entry);
}

function knowledgeMergeJournalPath(state) {
  return path.join(state.locks, KNOWLEDGE_MERGE_JOURNAL_FILENAME);
}

function validKnowledgeMergeJournal(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 4
    && value.schemaVersion === KNOWLEDGE_MERGE_JOURNAL_SCHEMA_VERSION
    && value.kind === 'knowledge-merge'
    && validateKnowledgeEntry(value.target)
    && validateKnowledgeEntry(value.source)
    && value.target.id !== value.source.id
    && value.source.state === 'superseded'
    && Array.isArray(value.target.relationships)
    && value.target.relationships.some((relationship) => (
      relationship.type === 'supersedes' && relationship.targetId === value.source.id
    ))
    && Array.isArray(value.source.relationships)
    && value.source.relationships.some((relationship) => (
      relationship.type === 'related' && relationship.targetId === value.target.id
    ))
  );
}

function relationshipsWithRequiredLink(relationships, required) {
  const withoutRequired = relationships.filter((relationship) => (
    relationship.type !== required.type || relationship.targetId !== required.targetId
  ));
  return [
    ...withoutRequired.slice(0, MAX_RELATIONSHIPS - 1),
    required,
  ];
}

async function recoverKnowledgeMerge(state) {
  const journalFile = knowledgeMergeJournalPath(state);
  const journal = await readJson(journalFile, {
    optional: true,
    validate: validKnowledgeMergeJournal,
  });
  if (!journal) return false;
  await writeJsonAtomic(notePath(state.knowledge, journal.target.id), journal.target);
  await writeJsonAtomic(notePath(state.knowledge, journal.source.id), journal.source);
  await removeFile(journalFile);
  return true;
}

async function withKnowledgeLock(state, callback) {
  return withFileLock(path.join(state.locks, 'knowledge.lock'), async () => {
    await recoverKnowledgeMerge(state);
    return callback();
  });
}

export async function withKnowledgeSnapshotLock(homeDirectory, callback) {
  const home = path.resolve(homeDirectory);
  return withKnowledgeLock({
    knowledge: path.join(home, 'knowledge'),
    locks: path.join(home, 'locks'),
  }, callback);
}

async function getKnowledgeUnlocked(state, id) {
  try {
    return publicEntry(await readEntry(notePath(state.knowledge, id), id));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CoreError('KNOWLEDGE_NOT_FOUND', `Knowledge entry not found: ${id}`);
    }
    throw error;
  }
}

export async function addKnowledge({
  title,
  body = '',
  tags = [],
  scope = 'global',
  repoId,
  cwd,
  environment,
  type = 'note',
  state: knowledgeState = 'verified',
  pinned = false,
  sources = [],
  relationships = [],
  approval = 'approved',
  actor,
  deviceId,
  agent,
  env = process.env,
  clock = Date,
} = {}) {
  const state = await initializeState({ env, clock });
  const location = await resolveKnowledgeScope({
    scope,
    repoId,
    cwd,
    environment,
    env,
    clock,
  });
  const now = isoNow(clock);
  const entry = {
    schemaVersion: STATE_SCHEMA_VERSION,
    id: randomUUID(),
    title: requireText(title, 'title', { maxChars: MAX_TITLE_CHARS }),
    body: requireText(body, 'body', { maxBytes: MAX_BODY_BYTES, allowEmpty: true }),
    tags: normalizeTags(tags),
    type: enumValue(type, KNOWLEDGE_TYPES, 'type', 'note'),
    state: enumValue(knowledgeState, KNOWLEDGE_STATES, 'state', 'verified'),
    pinned: Boolean(pinned),
    sources: normalizeSources(sources),
    relationships: normalizeRelationships(relationships),
    feedback: normalizeFeedback(),
    approval: enumValue(approval, KNOWLEDGE_APPROVALS, 'approval', 'approved'),
    history: [historyRecord({ at: now, action: approval === 'pending' ? 'suggested' : 'created', actor, deviceId, agent })],
    ...location,
    createdAt: now,
    updatedAt: now,
  };
  await withKnowledgeLock(state, async () => {
    await writeJsonAtomic(notePath(state.knowledge, entry.id), entry, { overwrite: false });
  });
  return publicEntry(entry);
}

export async function getKnowledge({ id, env = process.env, clock = Date } = {}) {
  const state = await initializeState({ env, clock });
  return withKnowledgeLock(state, () => getKnowledgeUnlocked(state, id));
}

async function listKnowledgeUnlocked({
  tag,
  scope,
  repoId,
  cwd,
  environment,
  type,
  state: knowledgeState,
  approval,
  pinned,
  env = process.env,
  clock = Date,
}, state) {
  const requestedTag = tag === undefined
    ? null
    : requireText(tag, 'tag', { maxChars: MAX_TAG_CHARS }).normalize('NFKC').toLocaleLowerCase('und');
  const entries = await readAllUnlocked(state);
  const requestedScope = scope === undefined ? null : normalizeKnowledgeScope(scope);
  let requestedRepoId = repoId ?? null;
  if (!requestedRepoId && cwd) {
    const resolved = await resolveRepository({ cwd, env, clock, create: false });
    requestedRepoId = resolved.repository.id;
  }
  const requestedEnvironment = environment === undefined
    ? null
    : validateEnvironmentLabel(environment);
  return entries
    .filter((entry) => requestedScope === null || entry.scope === requestedScope)
    .filter((entry) => requestedRepoId === null || entry.repoId === requestedRepoId)
    .filter((entry) => requestedEnvironment === null || entry.environment === requestedEnvironment)
    .filter((entry) => type === undefined || entry.type === type)
    .filter((entry) => knowledgeState === undefined || entry.state === knowledgeState)
    .filter((entry) => approval === undefined || entry.approval === approval)
    .filter((entry) => pinned === undefined || entry.pinned === Boolean(pinned))
    .filter((entry) => requestedTag === null || entry.tags.some(
      (entryTag) => entryTag.normalize('NFKC').toLocaleLowerCase('und') === requestedTag,
    ))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .map(publicEntry);
}

export async function listKnowledge(options = {}) {
  const env = options.env === undefined ? process.env : options.env;
  const clock = options.clock === undefined ? Date : options.clock;
  const state = await initializeState({ env, clock });
  return withKnowledgeLock(
    state,
    () => listKnowledgeUnlocked({ ...options, env, clock }, state),
  );
}

function searchable(value) {
  return value.normalize('NFKC').toLocaleLowerCase('und');
}

async function searchKnowledgeUnlocked({
  query,
  tag,
  scope,
  repoId,
  cwd,
  environment,
  env = process.env,
  clock = Date,
  limit = 100,
}, state) {
  const normalizedQuery = requireText(query, 'query', { maxChars: 500 });
  const entries = await listKnowledgeUnlocked(
    { tag, scope, repoId, cwd, environment, env, clock },
    state,
  );
  const allEntries = await readAllUnlocked(state);
  const allowed = new Map(entries.map((entry) => [entry.id, entry]));
  let matches;
  try {
    matches = searchKnowledgeIndex({ entries: allEntries, query: normalizedQuery, env, limit: Math.max(limit * 4, 100) });
  } catch {
    matches = [];
  }
  const ranked = matches
    .filter((match) => allowed.has(match.id))
    .map((match) => ({ ...publicEntry(allowed.get(match.id)), score: -Number(match.rank || 0) }));
  if (ranked.length > 0) return ranked.slice(0, limit);

  // FTS is token based. Keep a portable substring fallback for unsegmented CJK
  // phrases and for hosts where a damaged derived index had to be ignored.
  const terms = searchable(normalizedQuery).split(/\s+/u).filter(Boolean);
  return entries.map((entry) => {
    const title = searchable(entry.title);
    const body = searchable(entry.body);
    const tags = searchable(entry.tags.join(' '));
    if (!terms.every((term) => title.includes(term) || body.includes(term) || tags.includes(term))) return null;
    const score = terms.reduce((total, term) => (
      total + (title.includes(term) ? 8 : 0) + (tags.includes(term) ? 4 : 0) + (body.includes(term) ? 1 : 0)
    ), 0);
    return { ...publicEntry(entry), score };
  }).filter(Boolean).sort((left, right) => right.score - left.score).slice(0, limit);
}

export async function searchKnowledge(options = {}) {
  const env = options.env === undefined ? process.env : options.env;
  const clock = options.clock === undefined ? Date : options.clock;
  const state = await initializeState({ env, clock });
  return withKnowledgeLock(
    state,
    () => searchKnowledgeUnlocked({ ...options, env, clock }, state),
  );
}

async function relevantKnowledgeUnlocked({
  query = '', repoId, environment, limit = 5, env = process.env, clock = Date,
}, state) {
  const entries = await readAllUnlocked(state);
  const applicable = entries.filter((entry) => (
    entry.approval === 'approved'
    && !['contradicted', 'retired', 'superseded'].includes(entry.state)
    && (
      entry.scope === 'global'
      || (entry.scope === 'repo' && entry.repoId === repoId)
      || (entry.scope === 'env' && entry.repoId === repoId && entry.environment === environment)
    )
  ));
  const pinnedEntries = applicable.filter((entry) => entry.pinned);
  if (!String(query || '').trim()) return pinnedEntries.slice(0, limit).map(publicEntry);
  let matches = [];
  try {
    const indexed = searchKnowledgeIndex({
      entries,
      query,
      env,
      limit: Math.max(limit * 8, 80),
      // A user prompt contains context words that no one knowledge record is
      // expected to contain in full. Rank any matching terms here; explicit
      // `hnd know find` keeps its stricter all-term semantics.
      match: 'any',
    });
    const allowed = new Map(applicable.map((entry) => [entry.id, entry]));
    matches = indexed.filter((item) => allowed.has(item.id)).map((item) => ({
      ...allowed.get(item.id),
      score:
        -Number(item.rank || 0)
        + (allowed.get(item.id).feedback.helpful * 0.25)
        - (allowed.get(item.id).feedback.wrong * 2)
        - allowed.get(item.id).feedback.irrelevant,
    })).sort((left, right) => right.score - left.score);
  } catch {
    matches = [];
  }
  if (matches.length === 0) {
    const terms = searchable(String(query)).split(/\s+/u).filter((term) => term.length >= 2);
    matches = applicable.map((entry) => {
      const title = searchable(entry.title);
      const body = searchable(entry.body);
      const tags = searchable(entry.tags.join(' '));
      const score = terms.reduce((total, term) => (
        total
        + (title.includes(term) ? 8 : 0)
        + (tags.includes(term) ? 4 : 0)
        + (body.includes(term) ? 1 : 0)
      ), 0) + (entry.feedback.helpful * 0.25)
        - (entry.feedback.wrong * 2)
        - entry.feedback.irrelevant;
      return score > 0 ? { ...entry, score } : null;
    }).filter(Boolean).sort((left, right) => right.score - left.score);
  }
  const selected = new Map();
  for (const entry of [...pinnedEntries, ...matches]) {
    if (!selected.has(entry.id)) selected.set(entry.id, publicEntry(entry));
    if (selected.size >= limit) break;
  }
  return [...selected.values()];
}

export async function relevantKnowledge(options = {}) {
  const env = options.env === undefined ? process.env : options.env;
  const clock = options.clock === undefined ? Date : options.clock;
  const state = await initializeState({ env, clock });
  return withKnowledgeLock(
    state,
    () => relevantKnowledgeUnlocked({ ...options, env, clock }, state),
  );
}

export async function assessKnowledgeFreshness(entry, { root } = {}) {
  const result = publicEntry(entry);
  const fileSources = result.sources.filter((source) => source.kind === 'file' && source.hash);
  if (!root || fileSources.length === 0) return { ...result, freshness: 'unknown' };
  const repositoryRoot = path.resolve(root);
  for (const source of fileSources) {
    const absolute = path.resolve(repositoryRoot, source.ref);
    const relative = path.relative(repositoryRoot, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ...result, freshness: 'review_needed', staleSource: source.ref };
    }
    try {
      const contents = await readFile(absolute);
      const actual = createHash('sha256').update(contents).digest('hex');
      if (actual !== source.hash) {
        return { ...result, freshness: 'review_needed', staleSource: source.ref };
      }
    } catch {
      return { ...result, freshness: 'review_needed', staleSource: source.ref };
    }
  }
  return { ...result, freshness: 'current' };
}

async function normalizeKnowledgeUpdate(current, patch, { env, clock }) {
  const {
    id,
    title,
    body,
    tags,
    scope,
    repoId,
    cwd,
    environment,
    type,
    state: knowledgeState,
    pinned,
    sources,
    relationships,
    approval,
    feedback,
    feedbackKind,
    actor,
    deviceId,
    agent,
  } = patch;
  if (
    title === undefined
    && body === undefined
    && tags === undefined
    && scope === undefined
    && repoId === undefined
    && environment === undefined
    && type === undefined
    && knowledgeState === undefined
    && pinned === undefined
    && sources === undefined
    && relationships === undefined
    && approval === undefined
    && feedback === undefined
    && feedbackKind === undefined
  ) {
    throw new CoreError('INVALID_KNOWLEDGE', 'Provide content or scope fields to update');
  }
  const location = scope === undefined && repoId === undefined && environment === undefined
    ? {
        scope: current.scope,
        repoId: current.repoId,
        environment: current.environment,
      }
    : await resolveKnowledgeScope({
        scope: scope ?? current.scope,
        repoId: repoId ?? current.repoId,
        cwd,
        environment: environment ?? current.environment,
        env,
        clock,
      });
  const entry = {
    ...current,
    title: title === undefined ? current.title : requireText(title, 'title', { maxChars: MAX_TITLE_CHARS }),
    body: body === undefined ? current.body : requireText(body, 'body', { maxBytes: MAX_BODY_BYTES, allowEmpty: true }),
    tags: tags === undefined ? current.tags : normalizeTags(tags),
    type: type === undefined ? current.type : enumValue(type, KNOWLEDGE_TYPES, 'type', 'note'),
    state: knowledgeState === undefined
      ? current.state
      : enumValue(knowledgeState, KNOWLEDGE_STATES, 'state', 'verified'),
    pinned: pinned === undefined ? current.pinned : Boolean(pinned),
    sources: sources === undefined ? current.sources : normalizeSources(sources),
    relationships: relationships === undefined
      ? current.relationships
      : normalizeRelationships(relationships),
    approval: approval === undefined
      ? current.approval
      : enumValue(approval, KNOWLEDGE_APPROVALS, 'approval', 'approved'),
    feedback: feedback === undefined ? current.feedback : normalizeFeedback(feedback),
    ...location,
    updatedAt: isoNow(clock),
  };
  if (feedbackKind !== undefined) {
    const key = enumValue(feedbackKind, ['helpful', 'wrong', 'irrelevant'], 'feedbackKind');
    entry.feedback = { ...entry.feedback, [key]: entry.feedback[key] + 1 };
  }
  entry.history = [
    ...current.history,
    historyRecord({
      at: entry.updatedAt,
      action: feedbackKind ? `feedback:${feedbackKind}` : approval && approval !== current.approval ? approval : 'updated',
      actor,
      deviceId,
      agent,
      before: historySnapshot(current),
    }),
  ].slice(-MAX_HISTORY);
  return entry;
}

export async function updateKnowledge({
  id,
  title,
  body,
  tags,
  scope,
  repoId,
  cwd,
  environment,
  type,
  state: knowledgeState,
  pinned,
  sources,
  relationships,
  approval,
  feedback,
  feedbackKind,
  actor,
  deviceId,
  agent,
  env = process.env,
  clock = Date,
} = {}) {
  const state = await initializeState({ env, clock });
  return withKnowledgeLock(state, async () => {
    const current = await getKnowledgeUnlocked(state, id);
    const entry = await normalizeKnowledgeUpdate(current, {
      id,
      title,
      body,
      tags,
      scope,
      repoId,
      cwd,
      environment,
      type,
      state: knowledgeState,
      pinned,
      sources,
      relationships,
      approval,
      feedback,
      feedbackKind,
      actor,
      deviceId,
      agent,
    }, { env, clock });
    await writeJsonAtomic(notePath(state.knowledge, id), entry);
    return publicEntry(entry);
  });
}

export async function removeKnowledge({ id, env = process.env, clock = Date } = {}) {
  const state = await initializeState({ env, clock });
  return withKnowledgeLock(state, async () => ({
    id,
    removed: await removeFile(notePath(state.knowledge, id)),
  }));
}

function similarityTokens(entry) {
  const normalized = searchable(`${entry.title} ${entry.body} ${entry.tags.join(' ')}`)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const words = normalized.split(/\s+/u).filter(Boolean);
  if (words.length >= 5) return new Set(words);
  const compact = normalized.replaceAll(' ', '');
  const grams = [];
  for (let index = 0; index < compact.length - 1; index += 1) grams.push(compact.slice(index, index + 2));
  return new Set(grams);
}

async function findKnowledgeDuplicatesUnlocked({
  threshold = 0.65, env = process.env, clock = Date,
}, state) {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new CoreError('INVALID_KNOWLEDGE', 'threshold must be between 0 and 1');
  }
  const entries = (await readAllUnlocked(state)).filter((entry) => (
    entry.approval === 'approved' && !['retired', 'superseded'].includes(entry.state)
  ));
  const sets = new Map(entries.map((entry) => [entry.id, similarityTokens(entry)]));
  const matches = [];
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = sets.get(entries[leftIndex].id);
      const right = sets.get(entries[rightIndex].id);
      const intersection = [...left].filter((token) => right.has(token)).length;
      const union = new Set([...left, ...right]).size || 1;
      const score = intersection / union;
      if (score >= threshold) matches.push({
        score,
        left: publicEntry(entries[leftIndex]),
        right: publicEntry(entries[rightIndex]),
      });
    }
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, 100);
}

export async function findKnowledgeDuplicates(options = {}) {
  const env = options.env === undefined ? process.env : options.env;
  const clock = options.clock === undefined ? Date : options.clock;
  const state = await initializeState({ env, clock });
  return withKnowledgeLock(
    state,
    () => findKnowledgeDuplicatesUnlocked({ ...options, env, clock }, state),
  );
}

export async function mergeKnowledge({
  targetId, sourceId, env = process.env, clock = Date, actor,
} = {}) {
  if (targetId === sourceId) throw new CoreError('INVALID_KNOWLEDGE', 'Choose two different entries');
  const state = await initializeState({ env, clock });
  return withKnowledgeLock(state, async () => {
    const [target, source] = await Promise.all([
      getKnowledgeUnlocked(state, targetId),
      getKnowledgeUnlocked(state, sourceId),
    ]);
    const mergedBody = target.body.includes(source.body)
      ? target.body
      : [target.body, source.body].filter(Boolean).join('\n\n---\n\n');
    const targetRelationship = { type: 'supersedes', targetId: source.id };
    const sourceRelationship = { type: 'related', targetId: target.id };
    const updatedTarget = await normalizeKnowledgeUpdate(target, {
      id: target.id,
      body: mergedBody,
      tags: [...target.tags, ...source.tags],
      sources: [...target.sources, ...source.sources].slice(0, MAX_SOURCES),
      relationships: relationshipsWithRequiredLink(target.relationships, targetRelationship),
      actor,
    }, { env, clock });
    const updatedSource = await normalizeKnowledgeUpdate(source, {
      id: source.id,
      state: 'superseded',
      relationships: relationshipsWithRequiredLink(source.relationships, sourceRelationship),
      actor,
    }, { env, clock });
    const journalFile = knowledgeMergeJournalPath(state);
    const journal = {
      schemaVersion: KNOWLEDGE_MERGE_JOURNAL_SCHEMA_VERSION,
      kind: 'knowledge-merge',
      target: updatedTarget,
      source: updatedSource,
    };
    if (!validKnowledgeMergeJournal(journal)) {
      throw new CoreError(
        'STATE_CORRUPT',
        'Generated knowledge merge journal is inconsistent',
      );
    }
    const journalCreated = await writeJsonAtomic(journalFile, journal, { overwrite: false });
    if (!journalCreated) {
      throw new CoreError(
        'STATE_CORRUPT',
        `Knowledge merge journal already exists: ${journalFile}`,
        { path: journalFile },
      );
    }
    await writeJsonAtomic(notePath(state.knowledge, target.id), updatedTarget);
    await writeJsonAtomic(notePath(state.knowledge, source.id), updatedSource);
    await removeFile(journalFile);
    return publicEntry(updatedTarget);
  });
}
