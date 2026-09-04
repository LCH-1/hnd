import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { STATE_SCHEMA_VERSION } from '../constants.mjs';
import { normalizeFsPath, repositoryPaths, statePaths } from '../paths.mjs';
import { detectGitCheckout, detectGitRepository } from './git.mjs';
import { CoreError } from './errors.mjs';
import {
  readJson,
  withFileLock,
  writeJsonAtomic,
} from './fs.mjs';
import {
  assertRepositoryId,
  getActiveEnvironment,
  initializeRepositoryDirectory,
  initializeState,
  isoNow,
  validateEnvironmentLabel,
  validateBindings,
  validateRepositoryIndex,
} from './state.mjs';

function clone(value) {
  return structuredClone(value);
}

function publicGit(git) {
  return {
    root: git.root,
    worktree: git.worktree,
    commonDirectory: git.commonDirectory,
    branch: git.branch,
    head: git.head,
    rootCommits: [...git.rootCommits],
    shallow: git.shallow,
    // Git remote URLs may contain embedded credentials. Only expose the
    // credential-free identity form through CLI/API results and errors.
    remotes: git.remotes.map((remote) => ({
      name: remote.name,
      normalized: remote.normalized,
    })),
  };
}

function observedRemoteAliases(git) {
  // Only the checkout's primary remote is identity evidence. A fork commonly has
  // the original repository as `upstream`; treating every remote as identity
  // would silently apply the upstream repository's private policy to the fork.
  const origins = git.remotes.filter((remote) => remote.name === 'origin');
  const candidates = origins.length > 0
    ? origins
    : new Set(git.remotes.map((remote) => remote.name)).size === 1
      ? git.remotes
      : [];
  return candidates.map((remote) => remote.normalized).filter(Boolean);
}

function mergeUnique(first = [], second = []) {
  return [...new Set([...first, ...second])].sort();
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function makeMetadata(repoId, git, now, name) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    id: repoId,
    name: name || path.basename(git.root),
    remoteAliases: observedRemoteAliases(git),
    rootCommits: git.shallow ? [] : [...git.rootCommits],
    createdAt: now,
    updatedAt: now,
  };
}

function updateMetadata(metadata, git, now, name) {
  const nextName = name || metadata.name;
  const remoteAliases = mergeUnique(metadata.remoteAliases, observedRemoteAliases(git));
  const rootCommits = git.shallow
    ? metadata.rootCommits
    : mergeUnique(metadata.rootCommits, git.rootCommits);
  if (
    nextName === metadata.name
    && arraysEqual(remoteAliases, metadata.remoteAliases)
    && arraysEqual(rootCommits, metadata.rootCommits)
  ) {
    return metadata;
  }
  return { ...metadata, name: nextName, remoteAliases, rootCommits, updatedAt: now };
}

async function readStores(env) {
  const paths = statePaths(env);
  const [index, bindings] = await Promise.all([
    readJson(paths.repoIndex, { validate: validateRepositoryIndex }),
    readJson(paths.bindings, { validate: validateBindings }),
  ]);
  return { paths, index, bindings };
}

async function persistMetadata(metadata, index, env) {
  const repoPaths = await initializeRepositoryDirectory(metadata.id, env);
  index.repositories[metadata.id] = clone(metadata);
  // repositories.json is canonical. Publish the per-repository mirror first,
  // then atomically advance the canonical index so a crash cannot make the
  // index reference metadata that was never written.
  await writeJsonAtomic(repoPaths.metadata, metadata);
  await writeJsonAtomic(statePaths(env).repoIndex, index);
}

function bindingFor(git, repoId, now, existing) {
  const binding = {
    repoId,
    root: git.root,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  if (existing && Object.hasOwn(existing, 'environment')) {
    binding.environment = existing.environment;
  }
  return binding;
}

async function persistBinding(git, repoId, bindings, env, now) {
  const key = normalizeFsPath(git.root);
  const current = bindings.bindings[key];
  if (current?.repoId === repoId && current.root === git.root) return false;
  bindings.bindings[key] = bindingFor(git, repoId, now, bindings.bindings[key]);
  await writeJsonAtomic(statePaths(env).bindings, bindings);
  return true;
}

function matchingRepositories(index, predicate) {
  return Object.values(index.repositories).filter(predicate);
}

function hasSharedRootEvidence(metadata, git) {
  if (git.shallow || metadata.rootCommits.length === 0 || git.rootCommits.length === 0) {
    return false;
  }
  const observedRoots = new Set(git.rootCommits);
  return metadata.rootCommits.some((commit) => observedRoots.has(commit));
}

/** Resolve only an existing path binding; never scans history/remotes or writes state. */
export async function resolveRepositoryBinding({
  cwd = process.cwd(),
  env = process.env,
  clock = Date,
} = {}) {
  await initializeState({ env, clock });
  const git = await detectGitCheckout(cwd);
  const { index, bindings } = await readStores(env);
  const binding = bindings.bindings[normalizeFsPath(git.root)];
  if (!binding) {
    throw new CoreError(
      'REPOSITORY_NOT_REGISTERED',
      'This checkout has no local hnd binding; start an AI session or run hnd init',
      { root: git.root },
    );
  }
  const metadata = index.repositories[binding.repoId];
  if (!metadata) {
    throw new CoreError(
      'STATE_CORRUPT',
      `Repository binding points to missing repository: ${binding.repoId}`,
      { binding, path: statePaths(env).bindings },
    );
  }
  return {
    repository: clone(metadata),
    git,
    match: 'binding-cache',
    environment: Object.hasOwn(binding, 'environment')
      ? binding.environment
      : undefined,
  };
}

function summarizeCandidate(metadata) {
  return {
    id: metadata.id,
    name: metadata.name,
    remoteAliases: [...metadata.remoteAliases],
    rootCommits: [...metadata.rootCommits],
  };
}

export async function resolveRepository({
  cwd = process.cwd(),
  create = true,
  env = process.env,
  clock = Date,
  name,
} = {}) {
  await initializeState({ env, clock });
  const git = await detectGitRepository(cwd);
  const state = statePaths(env);

  return withFileLock(path.join(state.locks, 'repositories.lock'), async () => {
    const { index, bindings } = await readStores(env);
    const bindingKey = normalizeFsPath(git.root);
    const bound = bindings.bindings[bindingKey];
    const now = isoNow(clock);

    if (bound) {
      const metadata = index.repositories[bound.repoId];
      if (!metadata) {
        throw new CoreError(
          'STATE_CORRUPT',
          `Repository binding points to missing repository: ${bound.repoId}`,
          { binding: bound, path: state.bindings },
        );
      }
      const updated = updateMetadata(metadata, git, now, name);
      if (updated !== metadata) await persistMetadata(updated, index, env);
      await persistBinding(git, updated.id, bindings, env, now);
      return {
        repository: clone(updated),
        git: publicGit(git),
        match: 'binding',
        environment: Object.hasOwn(bound, 'environment')
          ? bound.environment
          : undefined,
      };
    }

    const observedAliases = new Set(observedRemoteAliases(git));
    const remoteMatches = matchingRepositories(index, (metadata) =>
      metadata.remoteAliases.some((remote) => observedAliases.has(remote)),
    );
    if (remoteMatches.length > 1) {
      throw new CoreError(
        'REPOSITORY_AMBIGUOUS',
        'Multiple registered repositories match this Git remote',
        { candidates: remoteMatches.map(summarizeCandidate), git: publicGit(git) },
      );
    }
    if (remoteMatches.length === 1) {
      const matched = remoteMatches[0];
      if (!hasSharedRootEvidence(matched, git)) {
        throw new CoreError(
          'REPOSITORY_LINK_REQUIRED',
          'The Git remote matches a registered repository but shared history could not be verified; link it explicitly to avoid a spoofed remote applying private policy',
          {
            candidates: remoteMatches.map(summarizeCandidate),
            git: publicGit(git),
            reason: git.shallow ? 'shallow-checkout' : 'history-mismatch',
          },
        );
      }
      const updated = updateMetadata(matched, git, now, name);
      if (updated !== matched) await persistMetadata(updated, index, env);
      await persistBinding(git, updated.id, bindings, env, now);
      return {
        repository: clone(updated),
        git: publicGit(git),
        match: 'remote',
        environment: undefined,
      };
    }

    // A root commit is useful evidence, but forks share it. Never auto-link on it.
    const observedRoots = new Set(git.shallow ? [] : git.rootCommits);
    const fingerprintMatches = matchingRepositories(index, (metadata) =>
      metadata.rootCommits.some((commit) => observedRoots.has(commit)),
    );
    if (fingerprintMatches.length > 0) {
      throw new CoreError(
        'REPOSITORY_LINK_REQUIRED',
        'Repository history matches existing entries; choose one explicitly to avoid linking a fork',
        { candidates: fingerprintMatches.map(summarizeCandidate), git: publicGit(git) },
      );
    }

    if (!create) {
      throw new CoreError('REPOSITORY_NOT_REGISTERED', 'Repository is not registered', {
        git: publicGit(git),
      });
    }

    const repoId = randomUUID();
    const metadata = makeMetadata(repoId, git, now, name);
    await persistMetadata(metadata, index, env);
    await persistBinding(git, repoId, bindings, env, now);
    return {
      repository: clone(metadata),
      git: publicGit(git),
      match: 'created',
      environment: undefined,
    };
  });
}

/** Returns the environment selected for this checkout, with legacy fallback. */
export async function getRepositoryEnvironment({
  cwd = process.cwd(),
  env = process.env,
  clock = Date,
} = {}) {
  const resolved = await resolveRepositoryBinding({ cwd, env, clock });
  if (resolved.environment !== undefined) return resolved.environment;
  return getActiveEnvironment({ env, clock });
}

/** Stores an environment on the local checkout binding, never device-wide. */
export async function setRepositoryEnvironment(
  environment,
  { cwd = process.cwd(), env = process.env, clock = Date } = {},
) {
  const selected = validateEnvironmentLabel(environment, { optional: true });
  await initializeState({ env, clock });
  const git = await detectGitCheckout(cwd);
  const state = statePaths(env);
  return withFileLock(path.join(state.locks, 'repositories.lock'), async () => {
    const { bindings } = await readStores(env);
    const key = normalizeFsPath(git.root);
    const binding = bindings.bindings[key];
    if (!binding) {
      throw new CoreError(
        'REPOSITORY_NOT_REGISTERED',
        'This checkout has no local hnd binding; start an AI session or run hnd init first',
        { root: git.root },
      );
    }
    bindings.bindings[key] = {
      ...binding,
      environment: selected,
      updatedAt: isoNow(clock),
    };
    await writeJsonAtomic(state.bindings, bindings);
    return { environment: selected, updatedAt: bindings.bindings[key].updatedAt };
  });
}

/** Explicitly creates a distinct repository identity, including for a fork. */
export async function registerRepository({
  cwd = process.cwd(),
  env = process.env,
  clock = Date,
  name,
  allowRemoteCollision = false,
} = {}) {
  await initializeState({ env, clock });
  const git = await detectGitRepository(cwd);
  const state = statePaths(env);

  return withFileLock(path.join(state.locks, 'repositories.lock'), async () => {
    const { index, bindings } = await readStores(env);
    const bindingKey = normalizeFsPath(git.root);
    const bound = bindings.bindings[bindingKey];
    if (bound) {
      throw new CoreError('REPOSITORY_ALREADY_BOUND', 'Checkout already has a repository identity', {
        root: git.root,
        repoId: bound.repoId,
      });
    }

    const aliases = new Set(observedRemoteAliases(git));
    const remoteMatches = matchingRepositories(index, (metadata) =>
      metadata.remoteAliases.some((remote) => aliases.has(remote)),
    );
    if (remoteMatches.length > 0 && !allowRemoteCollision) {
      throw new CoreError(
        'REPOSITORY_REMOTE_COLLISION',
        'The primary remote already identifies a repository; link it instead or confirm a collision',
        { candidates: remoteMatches.map(summarizeCandidate), git: publicGit(git) },
      );
    }

    const now = isoNow(clock);
    const metadata = makeMetadata(randomUUID(), git, now, name);
    await persistMetadata(metadata, index, env);
    await persistBinding(git, metadata.id, bindings, env, now);
    return { repository: clone(metadata), git: publicGit(git), match: 'created-explicitly' };
  });
}

export async function linkRepository({
  repoId,
  cwd = process.cwd(),
  env = process.env,
  clock = Date,
  name,
  force = false,
} = {}) {
  assertRepositoryId(repoId);
  await initializeState({ env, clock });
  const git = await detectGitRepository(cwd);
  const state = statePaths(env);

  return withFileLock(path.join(state.locks, 'repositories.lock'), async () => {
    const { index, bindings } = await readStores(env);
    const metadata = index.repositories[repoId];
    if (!metadata) {
      throw new CoreError('REPOSITORY_NOT_FOUND', `Unknown repository: ${repoId}`, { repoId });
    }

    const key = normalizeFsPath(git.root);
    const current = bindings.bindings[key];
    if (current && current.repoId !== repoId) {
      throw new CoreError(
        'BINDING_CONFLICT',
        `Path is already linked to repository ${current.repoId}`,
        { path: git.root, currentRepoId: current.repoId, requestedRepoId: repoId },
      );
    }

    const observedAliases = new Set(observedRemoteAliases(git));
    const observedRoots = new Set(git.shallow ? [] : git.rootCommits);
    const hasIdentityEvidence = (
      metadata.remoteAliases.some((alias) => observedAliases.has(alias))
      || metadata.rootCommits.some((commit) => observedRoots.has(commit))
    );
    if (current?.repoId !== repoId && !hasIdentityEvidence && force !== true) {
      throw new CoreError(
        'REPOSITORY_LINK_UNRELATED',
        'This checkout has no remote or history evidence for the requested repository; use force only after verifying the repository ID',
        {
          root: git.root,
          repoId,
          candidates: [summarizeCandidate(metadata)],
        },
      );
    }

    const now = isoNow(clock);
    const updated = updateMetadata(metadata, git, now, name);
    if (updated !== metadata) await persistMetadata(updated, index, env);
    await persistBinding(git, repoId, bindings, env, now);
    return { repository: clone(updated), git: publicGit(git), match: 'linked' };
  });
}

export async function getRepository({ repoId, env = process.env, clock = Date } = {}) {
  assertRepositoryId(repoId);
  await initializeState({ env, clock });
  const index = await readJson(statePaths(env).repoIndex, {
    validate: validateRepositoryIndex,
  });
  const repository = index.repositories[repoId];
  if (!repository) {
    throw new CoreError('REPOSITORY_NOT_FOUND', `Unknown repository: ${repoId}`, { repoId });
  }
  return clone(repository);
}

export async function listRepositories({ env = process.env, clock = Date } = {}) {
  await initializeState({ env, clock });
  const index = await readJson(statePaths(env).repoIndex, {
    validate: validateRepositoryIndex,
  });
  return Object.values(index.repositories)
    .map(clone)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export async function listBindings({ env = process.env, clock = Date } = {}) {
  await initializeState({ env, clock });
  const bindings = await readJson(statePaths(env).bindings, { validate: validateBindings });
  return Object.values(bindings.bindings)
    .map(clone)
    .sort((left, right) => left.root.localeCompare(right.root));
}

export async function unlinkRepositoryPath({
  cwd = process.cwd(),
  env = process.env,
  clock = Date,
} = {}) {
  await initializeState({ env, clock });
  const git = await detectGitRepository(cwd);
  const state = statePaths(env);
  return withFileLock(path.join(state.locks, 'repositories.lock'), async () => {
    const bindings = await readJson(state.bindings, { validate: validateBindings });
    const key = normalizeFsPath(git.root);
    const existing = bindings.bindings[key];
    if (!existing) return { removed: false, root: git.root, repoId: null };
    delete bindings.bindings[key];
    await writeJsonAtomic(state.bindings, bindings);
    return { removed: true, root: git.root, repoId: existing.repoId };
  });
}

export async function readRepositoryMetadataFile(repoId, env = process.env) {
  // Read from the canonical index rather than the recoverable on-disk mirror.
  return getRepository({ repoId, env });
}
