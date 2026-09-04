import path from 'node:path';

import { DEFAULT_MAX_CONTEXT_BYTES, POLICY_SCOPES } from '../constants.mjs';
import { repositoryPaths } from '../paths.mjs';
import { CoreError } from './errors.mjs';
import {
  fileMetadata,
  listFiles,
  readText,
  removeFile,
  writeTextAtomic,
} from './fs.mjs';
import { getRepository, resolveRepository } from './repositories.mjs';
import {
  getActiveEnvironment,
  initializeRepositoryDirectory,
  initializeState,
  validateEnvironmentLabel,
  validatePortableEnvironmentLabel,
} from './state.mjs';

function environmentCollisionKey(value) {
  return value.toLowerCase();
}

async function environmentPolicyEntries(directory) {
  const files = await listFiles(directory, { suffix: '.md' });
  const entries = files.map((file) => ({
    environment: path.basename(file, '.md'),
    file,
  }));
  const byPortableName = new Map();
  for (const entry of entries) {
    const key = environmentCollisionKey(entry.environment);
    const previous = byPortableName.get(key);
    if (previous && previous.environment !== entry.environment) {
      const environments = [previous.environment, entry.environment]
        .sort((left, right) => left.localeCompare(right));
      throw new CoreError(
        'ENVIRONMENT_CASE_COLLISION',
        `Environment policy names differ only by case: ${environments.join(', ')}`,
        { environments },
      );
    }
    byPortableName.set(key, entry);
  }
  return { entries, byPortableName };
}

async function resolveEnvironmentPolicy(directory, requestedEnvironment) {
  const label = validateEnvironmentLabel(requestedEnvironment);
  const { byPortableName } = await environmentPolicyEntries(directory);
  const existing = byPortableName.get(environmentCollisionKey(label));
  return existing
    ? { ...existing, existing: true }
    : {
        environment: label,
        file: path.join(directory, `${label}.md`),
        existing: false,
      };
}

export function assertPolicyScope(scope) {
  if (!POLICY_SCOPES.includes(scope)) {
    throw new CoreError('INVALID_POLICY_SCOPE', `Invalid policy scope: ${scope}`, {
      scope,
      allowed: [...POLICY_SCOPES],
    });
  }
  return scope;
}

export function validatePolicyContent(content) {
  if (typeof content !== 'string') {
    throw new CoreError('INVALID_POLICY_CONTENT', 'Policy content must be text');
  }
  if (content.includes('\0')) {
    throw new CoreError('INVALID_POLICY_CONTENT', 'Policy content cannot contain NUL bytes');
  }
  const bytes = Buffer.byteLength(content);
  const maxBytes = DEFAULT_MAX_CONTEXT_BYTES - 1024;
  if (bytes > maxBytes) {
    throw new CoreError(
      'POLICY_TOO_LARGE',
      `Policy is ${bytes} bytes; an individual policy may not exceed ${maxBytes} bytes`,
      { bytes, maxBytes },
    );
  }
  return content;
}

async function resolveRepoId({ repoId, cwd, env, clock, createRepository = true }) {
  if (repoId) {
    const repository = await getRepository({ repoId, env, clock });
    return { repoId: repository.id, repository, environment: undefined };
  }
  if (!cwd) {
    throw new CoreError('REPOSITORY_REQUIRED', 'Repository scope requires repoId or cwd');
  }
  const resolved = await resolveRepository({ cwd, env, clock, create: createRepository });
  return {
    repoId: resolved.repository.id,
    repository: resolved.repository,
    environment: resolved.environment,
  };
}

async function locatePolicy({
  scope,
  repoId,
  cwd,
  environment,
  env = process.env,
  clock = Date,
  createRepository = true,
}) {
  assertPolicyScope(scope);
  const state = await initializeState({ env, clock });
  if (scope === 'global') return { scope, file: state.globalPolicy };
  if (scope === 'local') return { scope, file: state.localOverride };

  const resolved = await resolveRepoId({ repoId, cwd, env, clock, createRepository });
  const repo = await initializeRepositoryDirectory(resolved.repoId, env);
  if (scope === 'repo') {
    return { scope, file: repo.policy, ...resolved };
  }

  const selectedEnvironment =
    environment === undefined
      ? resolved.environment === undefined
        ? await getActiveEnvironment({ env, clock })
        : resolved.environment
      : environment;
  if (!selectedEnvironment) {
    throw new CoreError(
      'ENVIRONMENT_REQUIRED',
      'Environment policy requires an environment or an active environment selection',
    );
  }
  const environmentPolicy = await resolveEnvironmentPolicy(
    repo.environments,
    selectedEnvironment,
  );
  return {
    scope,
    ...resolved,
    ...environmentPolicy,
  };
}

async function policyResult(location) {
  const [content, metadata] = await Promise.all([
    readText(location.file, { optional: true }),
    fileMetadata(location.file),
  ]);
  return {
    scope: location.scope,
    repoId: location.repoId || null,
    environment: location.environment || null,
    exists: content !== null,
    content,
    path: location.file,
    bytes: metadata?.size || 0,
    updatedAt: metadata?.updatedAt || null,
  };
}

export async function getPolicy(options = {}) {
  const location = await locatePolicy({ ...options, createRepository: false });
  return policyResult(location);
}

export async function setPolicy({ content, validate, ...options } = {}) {
  validatePolicyContent(content);
  const location = await locatePolicy(options);
  if (location.scope === 'env' && location.existing === false) {
    validatePortableEnvironmentLabel(location.environment);
  }
  if (validate !== undefined) {
    if (typeof validate !== 'function') throw new TypeError('validate must be a function');
    await validate({
      scope: location.scope,
      repoId: location.repoId || null,
      environment: location.environment || null,
      content,
    });
  }
  await writeTextAtomic(location.file, content);
  return policyResult(location);
}

export async function removePolicy(options = {}) {
  const location = await locatePolicy({ ...options, createRepository: false });
  const removed = await removeFile(location.file);
  return {
    scope: location.scope,
    repoId: location.repoId || null,
    environment: location.environment || null,
    removed,
    path: location.file,
  };
}

export async function listPolicies({
  repoId,
  cwd,
  environment,
  env = process.env,
  clock = Date,
  includeMissing = false,
} = {}) {
  await initializeState({ env, clock });
  const locations = [
    await locatePolicy({ scope: 'global', env, clock }),
    await locatePolicy({ scope: 'local', env, clock }),
  ];

  if (repoId || cwd) {
    const resolved = await resolveRepoId({ repoId, cwd, env, clock, createRepository: false });
    const repo = repositoryPaths(resolved.repoId, env);
    locations.splice(1, 0, {
      scope: 'repo',
      file: repo.policy,
      ...resolved,
    });

    if (environment) {
      const environmentPolicy = await resolveEnvironmentPolicy(repo.environments, environment);
      locations.splice(2, 0, {
        scope: 'env',
        ...environmentPolicy,
        ...resolved,
      });
    } else {
      const { entries } = await environmentPolicyEntries(repo.environments);
      for (const entry of entries) {
        locations.splice(locations.length - 1, 0, {
          scope: 'env',
          ...entry,
          ...resolved,
        });
      }
    }
  }

  const results = await Promise.all(locations.map(policyResult));
  return includeMissing ? results : results.filter((policy) => policy.exists);
}

export async function getPolicyPath(options = {}) {
  const location = await locatePolicy(options);
  if (location.scope === 'env' && location.existing === false) {
    validatePortableEnvironmentLabel(location.environment);
  }
  return location.file;
}
