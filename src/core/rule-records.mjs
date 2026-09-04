import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { STATE_SCHEMA_VERSION } from '../constants.mjs';
import { repositoryPaths, statePaths } from '../paths.mjs';
import { CoreError } from './errors.mjs';
import { listFiles, readJson, removeFile, withFileLock, writeJsonAtomic } from './fs.mjs';
import { getRepository, listRepositories, resolveRepository } from './repositories.mjs';
import {
  initializeRepositoryDirectory,
  initializeState,
  isUuid,
  isoNow,
  readConfig,
  updateConfig,
  validateEnvironmentLabel,
} from './state.mjs';

export const RULE_RECORD_SCOPES = Object.freeze(['global', 'repo', 'env']);
export const RULE_RECORD_STATUSES = Object.freeze(['draft', 'active']);
export const RULE_RECORD_ACTIVATIONS = Object.freeze(['always', 'manual']);

function text(value, field, { max = 16_000, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new CoreError('INVALID_RULE_RECORD', `${field} must be text`);
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new CoreError('INVALID_RULE_RECORD', `${field} is required`);
  if (normalized.length > max) throw new CoreError('INVALID_RULE_RECORD', `${field} is too long`);
  return normalized;
}

function enumValue(value, allowed, field, fallback) {
  const selected = value ?? fallback;
  if (!allowed.includes(selected)) {
    throw new CoreError('INVALID_RULE_RECORD', `${field} must be ${allowed.join(', ')}`);
  }
  return selected;
}

function patterns(value = [], field) {
  if (!Array.isArray(value) || value.length > 50) {
    throw new CoreError('INVALID_RULE_RECORD', `${field} must contain at most 50 patterns`);
  }
  return [...new Set(value.map((item) => text(item, field, { max: 512 })))];
}

export function validateRuleRecord(value) {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === STATE_SCHEMA_VERSION
    && isUuid(value.id)
    && RULE_RECORD_SCOPES.includes(value.scope)
    && (value.scope === 'global' ? value.repoId === null : isUuid(value.repoId))
    && (value.scope === 'env' ? typeof value.environment === 'string' : value.environment === null)
    && typeof value.title === 'string'
    && typeof value.content === 'string'
    && RULE_RECORD_STATUSES.includes(value.status)
    && RULE_RECORD_ACTIVATIONS.includes(value.activation)
    && Array.isArray(value.paths) && value.paths.every((item) => typeof item === 'string')
    && Array.isArray(value.files) && value.files.every((item) => typeof item === 'string')
    && Array.isArray(value.history)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
  );
}

async function location({ scope = 'global', repoId, cwd, environment, env, clock }) {
  const selectedScope = enumValue(scope, RULE_RECORD_SCOPES, 'scope', 'global');
  const state = await initializeState({ env, clock });
  if (selectedScope === 'global') {
    return { scope: selectedScope, repoId: null, environment: null, directory: state.rules };
  }
  const resolved = repoId
    ? { repository: await getRepository({ repoId, env, clock }), environment: null }
    : await resolveRepository({ cwd, env, clock });
  const repo = await initializeRepositoryDirectory(resolved.repository.id, env);
  const selectedEnvironment = selectedScope === 'env'
    ? validateEnvironmentLabel(environment ?? resolved.environment)
    : null;
  return {
    scope: selectedScope,
    repoId: resolved.repository.id,
    environment: selectedEnvironment,
    directory: repo.rules,
  };
}

async function readDirectory(directory) {
  const files = await listFiles(directory, { suffix: '.json' });
  return Promise.all(files.map(async (file) => {
    const value = await readJson(file, { validate: validateRuleRecord });
    if (path.basename(file) !== `${value.id}.json`) {
      throw new CoreError('STATE_CORRUPT', `Rule record is stored in the wrong location: ${file}`);
    }
    return value;
  }));
}

export async function listRuleRecords({ repoId, cwd, environment, env = process.env, clock = Date } = {}) {
  const state = await initializeState({ env, clock });
  const values = await readDirectory(state.rules);
  if (repoId || cwd) {
    const resolved = repoId
      ? { repository: await getRepository({ repoId, env, clock }), environment }
      : await resolveRepository({ cwd, env, clock, create: false });
    values.push(...await readDirectory(repositoryPaths(resolved.repository.id, env).rules));
    return values
      .filter((item) => item.scope === 'global' || item.repoId === resolved.repository.id)
      .filter((item) => item.scope !== 'env' || !environment || item.environment === environment)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return values.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function addRuleRecord({
  title, content, scope = 'global', repoId, cwd, environment,
  status = 'active', activation = 'always', paths = [], files = [],
  actor, env = process.env, clock = Date,
} = {}) {
  const resolved = await location({ scope, repoId, cwd, environment, env, clock });
  const now = isoNow(clock);
  const record = {
    schemaVersion: STATE_SCHEMA_VERSION,
    id: randomUUID(),
    title: text(title, 'title', { max: 200 }),
    content: text(content, 'content'),
    scope: resolved.scope,
    repoId: resolved.repoId,
    environment: resolved.environment,
    status: enumValue(status, RULE_RECORD_STATUSES, 'status', 'active'),
    activation: enumValue(activation, RULE_RECORD_ACTIVATIONS, 'activation', 'always'),
    paths: patterns(paths, 'paths'),
    files: patterns(files, 'files'),
    history: [{ at: now, action: 'created', actor: actor || null, before: null }],
    createdAt: now,
    updatedAt: now,
  };
  await withFileLock(path.join(statePaths(env).locks, 'rule-records.lock'), async () => {
    await writeJsonAtomic(path.join(resolved.directory, `${record.id}.json`), record, { overwrite: false });
  });
  return structuredClone(record);
}

export async function updateRuleRecord({ id, patch = {}, actor, env = process.env, clock = Date } = {}) {
  if (!isUuid(id)) throw new CoreError('INVALID_RULE_RECORD', 'Rule id must be a UUID');
  return withFileLock(path.join(statePaths(env).locks, 'rule-records.lock'), async () => {
    const all = await listRuleRecords({ env, clock });
    // Repository records are not returned without a project; inspect known repositories.
    const state = statePaths(env);
    const repositories = await listRepositories({ env, clock });
    for (const repository of repositories) {
      const directory = repositoryPaths(repository.id, env).rules;
      all.push(...await readDirectory(directory));
    }
    const current = all.find((item) => item.id === id);
    if (!current) throw new CoreError('RULE_RECORD_NOT_FOUND', `Rule not found: ${id}`);
    const now = isoNow(clock);
    const next = {
      ...current,
      title: patch.title === undefined ? current.title : text(patch.title, 'title', { max: 200 }),
      content: patch.content === undefined ? current.content : text(patch.content, 'content'),
      status: patch.status === undefined ? current.status : enumValue(patch.status, RULE_RECORD_STATUSES, 'status'),
      activation: patch.activation === undefined ? current.activation : enumValue(patch.activation, RULE_RECORD_ACTIVATIONS, 'activation'),
      paths: patch.paths === undefined ? current.paths : patterns(patch.paths, 'paths'),
      files: patch.files === undefined ? current.files : patterns(patch.files, 'files'),
      history: [...current.history, {
        at: now,
        action: 'updated',
        actor: actor || null,
        before: {
          title: current.title,
          content: current.content,
          status: current.status,
          activation: current.activation,
          paths: current.paths,
          files: current.files,
        },
      }].slice(-50),
      updatedAt: now,
    };
    const directory = current.scope === 'global' ? state.rules : repositoryPaths(current.repoId, env).rules;
    await writeJsonAtomic(path.join(directory, `${id}.json`), next);
    return structuredClone(next);
  });
}

export async function removeRuleRecord({ id, env = process.env, clock = Date } = {}) {
  const all = await listRuleRecords({ env, clock });
  const state = statePaths(env);
  const repositories = await listRepositories({ env, clock });
  for (const repository of repositories) {
    all.push(...await readDirectory(repositoryPaths(repository.id, env).rules));
  }
  const current = all.find((item) => item.id === id);
  if (!current) return { id, removed: false };
  const directory = current.scope === 'global' ? state.rules : repositoryPaths(current.repoId, env).rules;
  return { id, removed: await removeFile(path.join(directory, `${id}.json`)) };
}

export async function setManualRule({ id, enabled, env = process.env, clock = Date } = {}) {
  if (!isUuid(id)) throw new CoreError('INVALID_RULE_RECORD', 'Rule id must be a UUID');
  const config = await readConfig({ env, clock });
  const selected = new Set(config.manualRules || []);
  if (enabled) selected.add(id); else selected.delete(id);
  await updateConfig({ manualRules: [...selected].sort() }, { env, clock });
  return { id, enabled: selected.has(id) };
}

function globExpression(pattern) {
  let result = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      result += '.*';
      index += 1;
    } else if (char === '*') result += '[^/]*';
    else if (char === '?') result += '[^/]';
    else result += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${result}$`, 'u');
}

export function ruleRecordApplies(record, { environment, targetPaths = [], manualRules = [] } = {}) {
  if (record.status !== 'active') return false;
  if (record.scope === 'env' && record.environment !== environment) return false;
  if (record.activation === 'manual' && !manualRules.includes(record.id)) return false;
  const conditions = [...record.paths, ...record.files];
  if (conditions.length === 0 || targetPaths.length === 0) return true;
  return targetPaths.some((target) => conditions.some((pattern) => globExpression(pattern).test(target)));
}
