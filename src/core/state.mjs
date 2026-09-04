import path from 'node:path';

import { DEFAULT_STALE_HOURS, STATE_SCHEMA_VERSION } from '../constants.mjs';
import { repositoryPaths, statePaths } from '../paths.mjs';
import {
  ensureDirectory,
  readJson,
  withFileLock,
  writeJsonAtomic,
} from './fs.mjs';
import { CoreError } from './errors.mjs';

const WINDOWS_RESERVED_ENVIRONMENT_STEMS = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

export function isoNow(clock = Date) {
  const value = typeof clock === 'function' ? clock() : clock.now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('clock returned an invalid date');
  }
  return date.toISOString();
}

export function validateEnvironmentLabel(value, { optional = false } = {}) {
  if ((value === null || value === undefined || value === '') && optional) return null;
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?$/.test(value)
  ) {
    throw new CoreError(
      'INVALID_ENVIRONMENT',
      'Environment must be 1-64 letters, numbers, dots, underscores, or hyphens',
      { environment: value },
    );
  }
  return value;
}

/**
 * Rejects labels that cannot become a regular `<label>.md` filename on
 * Windows. Keep this separate from the syntax validator so an older state
 * created on a case-sensitive host can still be read, updated, or removed
 * long enough for the user to migrate it.
 */
export function validatePortableEnvironmentLabel(value) {
  const label = validateEnvironmentLabel(value);
  const windowsStem = label.split('.', 1)[0].toUpperCase();
  if (WINDOWS_RESERVED_ENVIRONMENT_STEMS.has(windowsStem)) {
    throw new CoreError(
      'UNPORTABLE_ENVIRONMENT',
      `Environment name is reserved by Windows and cannot be synchronized safely: ${label}`,
      { environment: label },
    );
  }
  return label;
}

export function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function assertRepositoryId(repoId) {
  if (!isUuid(repoId)) {
    throw new CoreError('INVALID_REPOSITORY_ID', `Invalid repository id: ${repoId}`, {
      repoId,
    });
  }
  return repoId;
}

function validVersionedObject(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.schemaVersion === STATE_SCHEMA_VERSION
  );
}

export function validateConfig(value) {
  return (
    validVersionedObject(value) &&
    (value.activeEnvironment === null || typeof value.activeEnvironment === 'string') &&
    (value.autoSave === undefined || typeof value.autoSave === 'boolean') &&
    (value.autoSync === undefined || typeof value.autoSync === 'boolean') &&
    (value.language === undefined || ['auto', 'ko', 'en'].includes(value.language)) &&
    (
      value.ruleTest === undefined
      || value.ruleTest === null
      || (
        typeof value.ruleTest === 'object'
        && !Array.isArray(value.ruleTest)
        && typeof value.ruleTest.token === 'string'
        && /^[a-f0-9]{8}$/.test(value.ruleTest.token)
        && isUuid(value.ruleTest.repoId)
        && typeof value.ruleTest.environment === 'string'
        && typeof value.ruleTest.createdAt === 'string'
        && typeof value.ruleTest.expiresAt === 'string'
      )
    ) &&
    Number.isFinite(value.staleHours) &&
    value.staleHours > 0
  );
}

export function validateRepositoryIndex(value) {
  return (
    validVersionedObject(value) &&
    value.repositories &&
    typeof value.repositories === 'object' &&
    !Array.isArray(value.repositories) &&
    Object.entries(value.repositories).every(
      ([id, repository]) =>
        isUuid(id) &&
        repository &&
        typeof repository === 'object' &&
        repository.schemaVersion === STATE_SCHEMA_VERSION &&
        repository.id === id &&
        typeof repository.name === 'string' &&
        Array.isArray(repository.remoteAliases) &&
        repository.remoteAliases.every((item) => typeof item === 'string') &&
        Array.isArray(repository.rootCommits) &&
        repository.rootCommits.every((item) => typeof item === 'string'),
    )
  );
}

export function validateBindings(value) {
  return (
    validVersionedObject(value) &&
    value.bindings &&
    typeof value.bindings === 'object' &&
    !Array.isArray(value.bindings) &&
    Object.entries(value.bindings).every(
      ([root, binding]) =>
        typeof root === 'string' &&
        binding &&
        typeof binding === 'object' &&
        isUuid(binding.repoId) &&
        binding.root === root &&
        (
          binding.environment === undefined ||
          binding.environment === null ||
          typeof binding.environment === 'string'
        ),
    )
  );
}

export function validateHandoffSelections(value) {
  return (
    validVersionedObject(value) &&
    value.selections &&
    typeof value.selections === 'object' &&
    !Array.isArray(value.selections) &&
    Object.values(value.selections).every(
      (selection) =>
        selection &&
        typeof selection === 'object' &&
        isUuid(selection.repoId) &&
        isUuid(selection.handoffId) &&
        typeof selection.worktree === 'string' &&
        (selection.branch === null || typeof selection.branch === 'string') &&
        typeof selection.selectedAt === 'string',
    )
  );
}

export async function initializeState({ env = process.env, clock = Date } = {}) {
  const paths = statePaths(env);
  try {
    // Existing state is a read-only fast path for session-start hooks.
    await Promise.all([
      readJson(paths.config, { validate: validateConfig }),
      readJson(paths.repoIndex, { validate: validateRepositoryIndex }),
      readJson(paths.bindings, { validate: validateBindings }),
      readJson(paths.handoffSelections, { validate: validateHandoffSelections }),
    ]);
    // New managed collections must also be created for state initialized by an
    // earlier HND release. The trusted-root check rejects a prepared symlink.
    await ensureDirectory(paths.knowledge, undefined, { trustedRoot: paths.home });
    return paths;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  // Establish and validate the managed root before touching descendants. This
  // prevents a prepared child symlink from redirecting concurrent mkdir/chmod
  // work outside HND_HOME.
  await ensureDirectory(paths.home);
  await Promise.all([
    ensureDirectory(path.dirname(paths.globalPolicy), undefined, { trustedRoot: paths.home }),
    ensureDirectory(paths.repositories, undefined, { trustedRoot: paths.home }),
    ensureDirectory(paths.knowledge, undefined, { trustedRoot: paths.home }),
    ensureDirectory(paths.blobs, undefined, { trustedRoot: paths.home }),
    ensureDirectory(paths.secrets, undefined, { trustedRoot: paths.home }),
    ensureDirectory(paths.cache, undefined, { trustedRoot: paths.home }),
    ensureDirectory(paths.locks, undefined, { trustedRoot: paths.home }),
  ]);

  const now = isoNow(clock);
  await Promise.all([
    writeJsonAtomic(
      paths.config,
      {
        schemaVersion: STATE_SCHEMA_VERSION,
        activeEnvironment: null,
        autoSave: true,
        autoSync: true,
        language: 'auto',
        ruleTest: null,
        staleHours: DEFAULT_STALE_HOURS,
        createdAt: now,
        updatedAt: now,
      },
      { overwrite: false },
    ),
    writeJsonAtomic(
      paths.repoIndex,
      { schemaVersion: STATE_SCHEMA_VERSION, repositories: {} },
      { overwrite: false },
    ),
    writeJsonAtomic(
      paths.bindings,
      { schemaVersion: STATE_SCHEMA_VERSION, bindings: {} },
      { overwrite: false },
    ),
    writeJsonAtomic(
      paths.handoffSelections,
      { schemaVersion: STATE_SCHEMA_VERSION, selections: {} },
      { overwrite: false },
    ),
  ]);

  // Refuse silently incompatible or partially written state.
  await Promise.all([
    readJson(paths.config, { validate: validateConfig }),
    readJson(paths.repoIndex, { validate: validateRepositoryIndex }),
    readJson(paths.bindings, { validate: validateBindings }),
    readJson(paths.handoffSelections, { validate: validateHandoffSelections }),
  ]);
  return paths;
}

export async function initializeRepositoryDirectory(repoId, env = process.env) {
  assertRepositoryId(repoId);
  const state = statePaths(env);
  const paths = repositoryPaths(repoId, env);
  await ensureDirectory(state.home);
  await ensureDirectory(state.repositories, undefined, { trustedRoot: state.home });
  await ensureDirectory(paths.root, undefined, { trustedRoot: state.home });
  await Promise.all([
    ensureDirectory(paths.environments, undefined, { trustedRoot: state.home }),
    ensureDirectory(paths.handoffs, undefined, { trustedRoot: state.home }),
    ensureDirectory(paths.archive, undefined, { trustedRoot: state.home }),
    ensureDirectory(paths.checkpoints, undefined, { trustedRoot: state.home }),
  ]);
  return paths;
}

export async function readConfig(options = {}) {
  const paths = await initializeState(options);
  return readJson(paths.config, { validate: validateConfig });
}

export async function updateConfig(patch, { env = process.env, clock = Date } = {}) {
  const paths = await initializeState({ env, clock });
  return withFileLock(path.join(paths.locks, 'config.lock'), async () => {
    const current = await readJson(paths.config, { validate: validateConfig });
    const next = {
      ...current,
      ...patch,
      schemaVersion: STATE_SCHEMA_VERSION,
      createdAt: current.createdAt,
      updatedAt: isoNow(clock),
    };
    if (!validateConfig(next)) {
      throw new CoreError('INVALID_CONFIG', 'Configuration update is invalid', { patch });
    }
    await writeJsonAtomic(paths.config, next);
    return next;
  });
}

export async function getActiveEnvironment(options = {}) {
  const config = await readConfig(options);
  return config.activeEnvironment;
}

export async function setActiveEnvironment(
  environment,
  { env = process.env, clock = Date } = {},
) {
  const activeEnvironment = validateEnvironmentLabel(environment, { optional: true });
  const config = await updateConfig({ activeEnvironment }, { env, clock });
  return { environment: config.activeEnvironment, updatedAt: config.updatedAt };
}

export async function getAutoSave(options = {}) {
  const config = await readConfig(options);
  return config.autoSave !== false;
}

export async function setAutoSave(enabled, { env = process.env, clock = Date } = {}) {
  if (typeof enabled !== 'boolean') {
    throw new CoreError('INVALID_CONFIG', 'autoSave must be true or false', { autoSave: enabled });
  }
  const config = await updateConfig({ autoSave: enabled }, { env, clock });
  return { enabled: config.autoSave, updatedAt: config.updatedAt };
}

export async function getAutoSync(options = {}) {
  const config = await readConfig(options);
  return config.autoSync !== false;
}

export async function setAutoSync(enabled, { env = process.env, clock = Date } = {}) {
  if (typeof enabled !== 'boolean') {
    throw new CoreError('INVALID_CONFIG', 'autoSync must be true or false', { autoSync: enabled });
  }
  const config = await updateConfig({ autoSync: enabled }, { env, clock });
  return { enabled: config.autoSync, updatedAt: config.updatedAt };
}
