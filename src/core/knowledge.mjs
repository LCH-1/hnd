import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

const MAX_TITLE_CHARS = 200;
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 48;
const MAX_BODY_BYTES = DEFAULT_MAX_CONTEXT_BYTES * 8;
export const KNOWLEDGE_SCOPES = Object.freeze(['global', 'repo', 'env']);

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
      'environment', 'createdAt', 'updatedAt',
    ].includes(key))
    && value.schemaVersion === STATE_SCHEMA_VERSION
    && isUuid(value.id)
    && typeof value.title === 'string'
    && value.title.length > 0
    && typeof value.body === 'string'
    && Array.isArray(value.tags)
    && value.tags.every((tag) => typeof tag === 'string')
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

async function readAll(env, clock) {
  const state = await initializeState({ env, clock });
  const files = await listFiles(state.knowledge, { suffix: '.json' });
  return Promise.all(files.map((file) => readEntry(file, path.basename(file, '.json'))));
}

function publicEntry(entry) {
  return structuredClone(entry);
}

export async function addKnowledge({
  title,
  body = '',
  tags = [],
  scope = 'global',
  repoId,
  cwd,
  environment,
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
    ...location,
    createdAt: now,
    updatedAt: now,
  };
  await withFileLock(path.join(state.locks, 'knowledge.lock'), async () => {
    await writeJsonAtomic(notePath(state.knowledge, entry.id), entry, { overwrite: false });
  });
  return publicEntry(entry);
}

export async function getKnowledge({ id, env = process.env, clock = Date } = {}) {
  const state = await initializeState({ env, clock });
  try {
    return publicEntry(await readEntry(notePath(state.knowledge, id), id));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CoreError('KNOWLEDGE_NOT_FOUND', `Knowledge entry not found: ${id}`);
    }
    throw error;
  }
}

export async function listKnowledge({
  tag,
  scope,
  repoId,
  cwd,
  environment,
  env = process.env,
  clock = Date,
} = {}) {
  const requestedTag = tag === undefined
    ? null
    : requireText(tag, 'tag', { maxChars: MAX_TAG_CHARS }).normalize('NFKC').toLocaleLowerCase('und');
  const entries = await readAll(env, clock);
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
    .filter((entry) => requestedTag === null || entry.tags.some(
      (entryTag) => entryTag.normalize('NFKC').toLocaleLowerCase('und') === requestedTag,
    ))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .map(publicEntry);
}

function searchable(value) {
  return value.normalize('NFKC').toLocaleLowerCase('und');
}

export async function searchKnowledge({
  query,
  tag,
  scope,
  repoId,
  cwd,
  environment,
  env = process.env,
  clock = Date,
} = {}) {
  const normalizedQuery = requireText(query, 'query', { maxChars: 500 });
  const terms = searchable(normalizedQuery).split(/\s+/u).filter(Boolean);
  const entries = await listKnowledge({ tag, scope, repoId, cwd, environment, env, clock });
  return entries
    .map((entry) => {
      const title = searchable(entry.title);
      const body = searchable(entry.body);
      const tags = searchable(entry.tags.join(' '));
      if (!terms.every((term) => title.includes(term) || body.includes(term) || tags.includes(term))) {
        return null;
      }
      const score = terms.reduce((total, term) => (
        total + (title.includes(term) ? 8 : 0) + (tags.includes(term) ? 4 : 0) + (body.includes(term) ? 1 : 0)
      ), 0);
      return { ...publicEntry(entry), score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt));
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
  env = process.env,
  clock = Date,
} = {}) {
  const state = await initializeState({ env, clock });
  return withFileLock(path.join(state.locks, 'knowledge.lock'), async () => {
    const current = await getKnowledge({ id, env, clock });
    if (
      title === undefined
      && body === undefined
      && tags === undefined
      && scope === undefined
      && repoId === undefined
      && environment === undefined
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
      ...location,
      updatedAt: isoNow(clock),
    };
    await writeJsonAtomic(notePath(state.knowledge, id), entry);
    return publicEntry(entry);
  });
}

export async function removeKnowledge({ id, env = process.env, clock = Date } = {}) {
  const state = await initializeState({ env, clock });
  return withFileLock(path.join(state.locks, 'knowledge.lock'), async () => ({
    id,
    removed: await removeFile(notePath(state.knowledge, id)),
  }));
}
