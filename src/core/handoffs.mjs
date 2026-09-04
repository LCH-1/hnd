import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  DEFAULT_MAX_CONTEXT_BYTES,
  DEFAULT_STALE_HOURS,
  STATE_SCHEMA_VERSION,
} from '../constants.mjs';
import { normalizeFsPath, repositoryPaths, statePaths } from '../paths.mjs';
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
  linkRepository,
  listRepositories,
  resolveRepository,
} from './repositories.mjs';
import {
  initializeRepositoryDirectory,
  initializeState,
  isUuid,
  isoNow,
  readConfig,
  validateHandoffSelections,
} from './state.mjs';

const ARRAY_FIELDS = Object.freeze([
  'decisions',
  'failedApproaches',
  'changedFiles',
  'validation',
  'nextSteps',
  'openQuestions',
  'notes',
]);
const PATCH_FIELDS = Object.freeze(['objective', 'currentState', ...ARRAY_FIELDS, 'staleHours']);
const HANDOFF_PRIORITIES = Object.freeze(['urgent', 'high', 'normal', 'low']);
const HANDOFF_WORKFLOW_STATUSES = Object.freeze(['todo', 'in_progress', 'blocked', 'done']);
const EXTENDED_PATCH_FIELDS = Object.freeze([
  'priority', 'workflowStatus', 'dependencies', 'parentId', 'claimedBy',
  'claimExpiresAt', 'blockedReason', 'unblockCriteria',
]);
const ALL_PATCH_FIELDS = Object.freeze([...PATCH_FIELDS, ...EXTENDED_PATCH_FIELDS]);
const MAX_HISTORY = 50;
const MAX_HANDOFF_TEXT_BYTES = DEFAULT_MAX_CONTEXT_BYTES - (8 * 1024);

function validHandoff(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.schemaVersion === STATE_SCHEMA_VERSION &&
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
    (value.claimExpiresAt === undefined || value.claimExpiresAt === null || typeof value.claimExpiresAt === 'string') &&
    (value.blockedReason === undefined || typeof value.blockedReason === 'string') &&
    (value.unblockCriteria === undefined || typeof value.unblockCriteria === 'string') &&
    (value.history === undefined || (Array.isArray(value.history) && value.history.length <= MAX_HISTORY)) &&
    ARRAY_FIELDS.every(
      (field) => Array.isArray(value[field]) && value[field].every((item) => typeof item === 'string'),
    )
  );
}

function requireText(
  value,
  field,
  { max = 8_000, allowEmpty = false, singleLine = false } = {},
) {
  if (typeof value !== 'string') {
    throw new CoreError('INVALID_HANDOFF', `${field} must be text`, { field });
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) {
    throw new CoreError('INVALID_HANDOFF', `${field} is required`, { field });
  }
  if (
    normalized.length > max ||
    normalized.includes('\0') ||
    (singleLine && /[\r\n]/.test(normalized))
  ) {
    throw new CoreError('INVALID_HANDOFF', `${field} is invalid or too long`, {
      field,
      max,
    });
  }
  return normalized;
}

function validateHandoffId(id) {
  if (id !== undefined && !isUuid(id)) {
    throw new CoreError('INVALID_HANDOFF_ID', `Invalid handoff id: ${id}`, { id });
  }
  return id;
}

function textArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new CoreError('INVALID_HANDOFF', `${field} must be an array of text`, { field });
  }
  return value.map((item, index) =>
    requireText(item, `${field}[${index}]`, { max: 8_000 }),
  );
}

function validateStaleHours(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 24 * 3650) {
    throw new CoreError('INVALID_HANDOFF', 'staleHours must be a positive number', {
      staleHours: value,
    });
  }
  return value;
}

function addHours(iso, hours) {
  return new Date(new Date(iso).getTime() + hours * 60 * 60 * 1000).toISOString();
}

function clockTime(clock) {
  return new Date(isoNow(clock)).getTime();
}

function decorateHandoff(handoff, clock = Date) {
  const stale =
    handoff.status === 'active' &&
    typeof handoff.staleAt === 'string' &&
    clockTime(clock) >= new Date(handoff.staleAt).getTime();
  return {
    ...structuredClone(handoff),
    priority: handoff.priority ?? 'normal',
    workflowStatus: handoff.status === 'closed' ? 'done' : handoff.workflowStatus ?? 'in_progress',
    dependencies: handoff.dependencies ?? [],
    parentId: handoff.parentId ?? null,
    claimedBy: handoff.claimedBy ?? null,
    claimExpiresAt: handoff.claimExpiresAt ?? null,
    blockedReason: handoff.blockedReason ?? '',
    unblockCriteria: handoff.unblockCriteria ?? '',
    history: handoff.history ?? [],
    stale,
  };
}

function priorityValue(value = 'normal') {
  if (!HANDOFF_PRIORITIES.includes(value)) {
    throw new CoreError('INVALID_HANDOFF', `priority must be ${HANDOFF_PRIORITIES.join(', ')}`);
  }
  return value;
}

function workflowValue(value = 'in_progress') {
  if (!HANDOFF_WORKFLOW_STATUSES.includes(value)) {
    throw new CoreError('INVALID_HANDOFF', `workflowStatus must be ${HANDOFF_WORKFLOW_STATUSES.join(', ')}`);
  }
  return value;
}

function idList(value, field = 'dependencies') {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || !value.every(isUuid)) {
    throw new CoreError('INVALID_HANDOFF', `${field} must be a list of UUIDs`);
  }
  return [...new Set(value)];
}

function auditRecord(action, at, { actor, agent, sessionId, before = null } = {}) {
  return {
    at,
    action,
    actor: actor ? String(actor).slice(0, 200) : null,
    agent: agent ? String(agent).slice(0, 80) : null,
    sessionId: sessionId ? String(sessionId).slice(0, 256) : null,
    before,
  };
}

function summarize(handoff) {
  return {
    id: handoff.id,
    repoId: handoff.repoId,
    task: handoff.task,
    branch: handoff.branch,
    worktree: handoff.worktree,
    updatedAt: handoff.updatedAt,
  };
}

function assertHandoffSize(handoff) {
  const fields = [handoff.task, handoff.objective, handoff.currentState];
  for (const name of ARRAY_FIELDS) fields.push(...handoff[name]);
  const bytes = Buffer.byteLength(fields.join('\n'));
  if (bytes > MAX_HANDOFF_TEXT_BYTES) {
    throw new CoreError(
      'HANDOFF_TOO_LARGE',
      `Handoff text is ${bytes} bytes; limit is ${MAX_HANDOFF_TEXT_BYTES} bytes`,
      { bytes, maxBytes: MAX_HANDOFF_TEXT_BYTES },
    );
  }
}

function selectionKey(git) {
  const identity = `${normalizeFsPath(git.worktree)}\0${git.branch ?? `@${git.head ?? 'detached'}`}`;
  return createHash('sha256').update(identity).digest('hex');
}

async function readSelections(env) {
  return readJson(statePaths(env).handoffSelections, {
    validate: validateHandoffSelections,
  });
}

async function selectedHandoffId(git, env) {
  if (!git) return null;
  const selections = await readSelections(env);
  const selection = selections.selections[selectionKey(git)];
  return selection?.handoffId ?? null;
}

async function persistSelection({ git, repoId, handoffId, env, clock }) {
  if (!git) return;
  const state = statePaths(env);
  await withFileLock(path.join(state.locks, 'handoff-selections.lock'), async () => {
    const selections = await readSelections(env);
    const key = selectionKey(git);
    if (handoffId === null) {
      delete selections.selections[key];
    } else {
      selections.selections[key] = {
        repoId,
        handoffId,
        worktree: normalizeFsPath(git.worktree),
        branch: git.branch,
        selectedAt: isoNow(clock),
      };
    }
    await writeJsonAtomic(state.handoffSelections, selections);
  });
}

async function resolveRepoAndGit({
  repoId,
  cwd,
  env,
  clock,
  requireGit = false,
  repository,
  git,
}) {
  if (repository) {
    if (requireGit && !git) {
      throw new CoreError('WORKTREE_REQUIRED', 'This operation requires Git checkout context');
    }
    return { repository, git: git ?? null };
  }
  if (repoId && cwd) {
    // Passing both is an explicit confirmation that this checkout belongs to repoId.
    const linked = await linkRepository({ repoId, cwd, env, clock });
    return { repository: linked.repository, git: linked.git };
  }
  if (repoId) {
    const repository = await getRepository({ repoId, env, clock });
    if (requireGit) {
      throw new CoreError('WORKTREE_REQUIRED', 'This operation requires cwd for Git context');
    }
    return { repository, git: null };
  }
  if (!cwd) {
    throw new CoreError('REPOSITORY_REQUIRED', 'Provide repoId or cwd');
  }
  const resolved = await resolveRepository({ cwd, env, clock });
  return { repository: resolved.repository, git: resolved.git };
}

async function readHandoffFiles(directory, expectedRepoId, expectedStatus) {
  const files = await listFiles(directory, { suffix: '.json' });
  return Promise.all(
    files.map(async (file) => {
      const handoff = await readJson(file, { validate: validHandoff });
      if (
        path.basename(file) !== `${handoff.id}.json` ||
        handoff.repoId !== expectedRepoId ||
        handoff.status !== expectedStatus
      ) {
        throw new CoreError('STATE_CORRUPT', `Handoff is stored in the wrong location: ${file}`, {
          path: file,
          id: handoff.id,
          repoId: handoff.repoId,
          status: handoff.status,
        });
      }
      return handoff;
    }),
  );
}

async function listForRepository(repoId, status, env) {
  const paths = repositoryPaths(repoId, env);
  const values = [];
  if (status === 'active' || status === 'all') {
    values.push(...(await readHandoffFiles(paths.handoffs, repoId, 'active')));
  }
  if (status === 'closed' || status === 'all') {
    values.push(...(await readHandoffFiles(paths.archive, repoId, 'closed')));
  }
  const unique = new Map();
  for (const value of values) unique.set(value.id, value);
  return [...unique.values()].filter((value) => status === 'all' || value.status === status);
}

function validateStatus(status) {
  if (!['active', 'closed', 'all'].includes(status)) {
    throw new CoreError('INVALID_HANDOFF_STATUS', `Invalid handoff status: ${status}`, {
      status,
    });
  }
  return status;
}

export async function listHandoffs({
  repoId,
  cwd,
  status = 'active',
  task,
  env = process.env,
  clock = Date,
} = {}) {
  validateStatus(status);
  await initializeState({ env, clock });
  let repositories;
  if (repoId || cwd) {
    const resolved = await resolveRepoAndGit({ repoId, cwd, env, clock });
    repositories = [resolved.repository];
  } else {
    repositories = await listRepositories({ env, clock });
  }

  const groups = await Promise.all(
    repositories.map((repository) => listForRepository(repository.id, 'all', env)),
  );
  const all = groups.flat();
  const completed = new Set(all.filter((item) => item.status === 'closed').map((item) => item.id));
  return all
    .filter((handoff) => status === 'all' || handoff.status === status)
    .filter((handoff) => task === undefined || handoff.task === task)
    .map((handoff) => {
      const decorated = decorateHandoff(handoff, clock);
      decorated.ready = decorated.status === 'active'
        && decorated.workflowStatus !== 'blocked'
        && decorated.dependencies.every((id) => completed.has(id));
      return decorated;
    })
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    );
}

async function selectActiveHandoff({ id, task, repository, git, env, clock, required = true }) {
  validateHandoffId(id);
  const active = await listForRepository(repository.id, 'active', env);
  let candidates = active;
  if (id) candidates = candidates.filter((handoff) => handoff.id === id);
  if (task !== undefined) candidates = candidates.filter((handoff) => handoff.task === task);

  if (!id && git) {
    const worktreeMatches = candidates.filter((handoff) => handoff.worktree === git.worktree);
    if (worktreeMatches.length > 0) {
      const worktreeBranchMatches = worktreeMatches.filter(
        (handoff) => handoff.branch === git.branch,
      );
      candidates = worktreeBranchMatches.length > 0 ? worktreeBranchMatches : worktreeMatches;
    } else if (git.branch) {
      const branchMatches = candidates.filter((handoff) => handoff.branch === git.branch);
      if (branchMatches.length > 0) candidates = branchMatches;
    }

    if (!id && task === undefined) {
      const selectedId = await selectedHandoffId(git, env);
      const selected = candidates.find((handoff) => handoff.id === selectedId);
      if (selected) candidates = [selected];
    }
  }

  if (candidates.length === 0) {
    if (!required) return null;
    throw new CoreError('HANDOFF_NOT_FOUND', 'No matching active handoff', {
      repoId: repository.id,
      id,
      task,
    });
  }
  if (candidates.length > 1) {
    throw new CoreError('HANDOFF_AMBIGUOUS', 'Multiple active handoffs match; provide id or task', {
      candidates: candidates.map(summarize),
    });
  }
  const selected = decorateHandoff(candidates[0], clock);
  const completed = new Set(
    (await listForRepository(repository.id, 'closed', env)).map((item) => item.id),
  );
  selected.ready = selected.workflowStatus !== 'blocked'
    && selected.dependencies.every((dependency) => completed.has(dependency));
  return selected;
}

export async function startHandoff({
  repoId,
  cwd = process.cwd(),
  task,
  objective,
  currentState = '',
  staleHours,
  priority = 'normal',
  workflowStatus = 'in_progress',
  dependencies = [],
  parentId = null,
  claimedBy = null,
  claimHours = 2,
  blockedReason = '',
  unblockCriteria = '',
  actor,
  agent,
  sessionId,
  validate,
  env = process.env,
  clock = Date,
  ...arrays
} = {}) {
  const taskValue = requireText(task, 'task', { max: 200, singleLine: true });
  const objectiveValue = requireText(objective, 'objective');
  const currentStateValue = requireText(currentState, 'currentState', {
    allowEmpty: true,
  });
  const resolved = await resolveRepoAndGit({
    repoId,
    cwd,
    env,
    clock,
    requireGit: true,
  });
  const repoPaths = await initializeRepositoryDirectory(resolved.repository.id, env);
  const state = statePaths(env);

  return withFileLock(
    path.join(state.locks, `handoffs-${resolved.repository.id}.lock`),
    async () => {
      const active = await listForRepository(resolved.repository.id, 'active', env);
      const duplicate = active.find(
        (handoff) =>
          handoff.task === taskValue &&
          handoff.worktree === resolved.git.worktree &&
          handoff.branch === resolved.git.branch,
      );
      if (duplicate) {
        throw new CoreError('HANDOFF_EXISTS', 'An active handoff already exists for this task', {
          handoff: summarize(duplicate),
        });
      }

      const config = staleHours === undefined ? await readConfig({ env, clock }) : null;
      const hours = validateStaleHours(
        staleHours === undefined ? config?.staleHours || DEFAULT_STALE_HOURS : staleHours,
      );
      const now = isoNow(clock);
      const handoff = {
        schemaVersion: STATE_SCHEMA_VERSION,
        id: randomUUID(),
        repoId: resolved.repository.id,
        status: 'active',
        task: taskValue,
        objective: objectiveValue,
        currentState: currentStateValue,
        priority: priorityValue(priority),
        workflowStatus: workflowValue(workflowStatus),
        dependencies: idList(dependencies),
        parentId: parentId === null ? null : validateHandoffId(parentId),
        claimedBy: claimedBy ? requireText(claimedBy, 'claimedBy', { max: 200, singleLine: true }) : null,
        claimExpiresAt: claimedBy ? addHours(now, Number(claimHours) || 2) : null,
        blockedReason: requireText(blockedReason, 'blockedReason', { allowEmpty: true, max: 4_000 }),
        unblockCriteria: requireText(unblockCriteria, 'unblockCriteria', { allowEmpty: true, max: 4_000 }),
        ...Object.fromEntries(ARRAY_FIELDS.map((field) => [field, textArray(arrays[field], field)])),
        worktree: resolved.git.worktree,
        branch: resolved.git.branch,
        head: resolved.git.head,
        staleHours: hours,
        staleAt: addHours(now, hours),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        history: [auditRecord('created', now, { actor, agent, sessionId })],
      };
      assertHandoffSize(handoff);
      if (validate !== undefined) {
        if (typeof validate !== 'function') throw new TypeError('validate must be a function');
        await validate(decorateHandoff(handoff, clock));
      }
      await writeJsonAtomic(path.join(repoPaths.handoffs, `${handoff.id}.json`), handoff);
      await persistSelection({
        git: resolved.git,
        repoId: resolved.repository.id,
        handoffId: handoff.id,
        env,
        clock,
      });
      return decorateHandoff(handoff, clock);
    },
  );
}

function applyPatch(handoff, patch = {}, append = {}, clock = Date, audit = {}) {
  for (const key of Object.keys(patch)) {
    if (!ALL_PATCH_FIELDS.includes(key)) {
      throw new CoreError('INVALID_HANDOFF_PATCH', `Cannot update handoff field: ${key}`, {
        field: key,
      });
    }
  }
  for (const key of Object.keys(append)) {
    if (!ARRAY_FIELDS.includes(key)) {
      throw new CoreError('INVALID_HANDOFF_PATCH', `Cannot append handoff field: ${key}`, {
        field: key,
      });
    }
  }

  const next = structuredClone(handoff);
  if (patch.objective !== undefined) next.objective = requireText(patch.objective, 'objective');
  if (patch.currentState !== undefined) {
    next.currentState = requireText(patch.currentState, 'currentState', { allowEmpty: true });
  }
  for (const field of ARRAY_FIELDS) {
    if (patch[field] !== undefined) next[field] = textArray(patch[field], field);
    if (append[field] !== undefined) {
      next[field] = [...next[field], ...textArray(append[field], field)];
    }
  }
  if (patch.staleHours !== undefined) next.staleHours = validateStaleHours(patch.staleHours);
  if (patch.priority !== undefined) next.priority = priorityValue(patch.priority);
  if (patch.workflowStatus !== undefined) next.workflowStatus = workflowValue(patch.workflowStatus);
  if (patch.dependencies !== undefined) next.dependencies = idList(patch.dependencies);
  if (patch.parentId !== undefined) next.parentId = patch.parentId === null ? null : validateHandoffId(patch.parentId);
  if (patch.claimedBy !== undefined) {
    next.claimedBy = patch.claimedBy === null || patch.claimedBy === ''
      ? null
      : requireText(patch.claimedBy, 'claimedBy', { max: 200, singleLine: true });
  }
  if (patch.claimExpiresAt !== undefined) {
    next.claimExpiresAt = patch.claimExpiresAt === null ? null : new Date(patch.claimExpiresAt).toISOString();
  }
  for (const field of ['blockedReason', 'unblockCriteria']) {
    if (patch[field] !== undefined) {
      next[field] = requireText(patch[field], field, { allowEmpty: true, max: 4_000 });
    }
  }
  const now = isoNow(clock);
  next.updatedAt = now;
  next.staleAt = addHours(now, next.staleHours);
  delete next.stale;
  next.history = [
    ...(next.history || []),
    auditRecord('updated', now, {
      ...audit,
      before: {
        priority: handoff.priority ?? 'normal',
        workflowStatus: handoff.workflowStatus ?? 'in_progress',
        dependencies: handoff.dependencies ?? [],
        parentId: handoff.parentId ?? null,
        claimedBy: handoff.claimedBy ?? null,
        claimExpiresAt: handoff.claimExpiresAt ?? null,
        blockedReason: handoff.blockedReason ?? '',
        unblockCriteria: handoff.unblockCriteria ?? '',
      },
    }),
  ].slice(-MAX_HISTORY);
  return next;
}

export async function updateHandoff({
  id,
  task,
  repoId,
  cwd,
  patch = {},
  append = {},
  validate,
  actor,
  agent,
  sessionId,
  env = process.env,
  clock = Date,
} = {}) {
  const resolved = await resolveRepoAndGit({ repoId, cwd, env, clock });
  const state = statePaths(env);
  return withFileLock(
    path.join(state.locks, `handoffs-${resolved.repository.id}.lock`),
    async () => {
      const handoff = await selectActiveHandoff({
        id,
        task,
        repository: resolved.repository,
        git: resolved.git,
        env,
        clock,
      });
      const next = applyPatch(handoff, patch, append, clock, { actor, agent, sessionId });
      assertHandoffSize(next);
      if (validate !== undefined) {
        if (typeof validate !== 'function') throw new TypeError('validate must be a function');
        await validate(decorateHandoff(next, clock));
      }
      const file = path.join(repositoryPaths(next.repoId, env).handoffs, `${next.id}.json`);
      await writeJsonAtomic(file, next);
      return decorateHandoff(next, clock);
    },
  );
}

export async function showHandoff({
  id,
  task,
  repoId,
  cwd,
  env = process.env,
  clock = Date,
} = {}) {
  validateHandoffId(id);
  const resolved = await resolveRepoAndGit({ repoId, cwd, env, clock });
  if (id) {
    const repoPaths = repositoryPaths(resolved.repository.id, env);
    for (const directory of [repoPaths.handoffs, repoPaths.archive]) {
      const value = await readJson(path.join(directory, `${id}.json`), {
        optional: true,
        validate: validHandoff,
      });
      if (value) return decorateHandoff(value, clock);
    }
    throw new CoreError('HANDOFF_NOT_FOUND', `Unknown handoff: ${id}`, { id });
  }
  return selectActiveHandoff({
    task,
    repository: resolved.repository,
    git: resolved.git,
    env,
    clock,
  });
}

export async function findActiveHandoff({
  id,
  task,
  repoId,
  cwd,
  required = false,
  env = process.env,
  clock = Date,
  repository,
  git,
} = {}) {
  const resolved = await resolveRepoAndGit({ repoId, cwd, env, clock, repository, git });
  return selectActiveHandoff({
    id,
    task,
    repository: resolved.repository,
    git: resolved.git,
    env,
    clock,
    required,
  });
}

export async function selectHandoff({
  id,
  task,
  repoId,
  cwd = process.cwd(),
  env = process.env,
  clock = Date,
} = {}) {
  if (!id && task === undefined) {
    throw new CoreError('HANDOFF_SELECTION_REQUIRED', 'Provide a handoff id or task to select');
  }
  const resolved = await resolveRepoAndGit({ repoId, cwd, env, clock, requireGit: true });
  const state = statePaths(env);
  return withFileLock(
    path.join(state.locks, `handoffs-${resolved.repository.id}.lock`),
    async () => {
      const handoff = await selectActiveHandoff({
        id,
        task,
        repository: resolved.repository,
        git: resolved.git,
        env,
        clock,
      });
      await persistSelection({
        git: resolved.git,
        repoId: resolved.repository.id,
        handoffId: handoff.id,
        env,
        clock,
      });
      return decorateHandoff(handoff, clock);
    },
  );
}

export async function closeHandoff({
  id,
  task,
  repoId,
  cwd,
  patch = {},
  append = {},
  validate,
  actor,
  agent,
  sessionId,
  env = process.env,
  clock = Date,
} = {}) {
  const resolved = await resolveRepoAndGit({ repoId, cwd, env, clock });
  const state = statePaths(env);
  return withFileLock(
    path.join(state.locks, `handoffs-${resolved.repository.id}.lock`),
    async () => {
      const handoff = await selectActiveHandoff({
        id,
        task,
        repository: resolved.repository,
        git: resolved.git,
        env,
        clock,
      });
      const next = applyPatch(handoff, patch, append, clock, { actor, agent, sessionId });
      next.status = 'closed';
      next.workflowStatus = 'done';
      next.closedAt = isoNow(clock);
      next.history[next.history.length - 1].action = 'closed';
      assertHandoffSize(next);
      if (validate !== undefined) {
        if (typeof validate !== 'function') throw new TypeError('validate must be a function');
        await validate(decorateHandoff(next, clock));
      }
      const repoPaths = repositoryPaths(next.repoId, env);
      const activeFile = path.join(repoPaths.handoffs, `${next.id}.json`);
      const archivedFile = path.join(repoPaths.archive, `${next.id}.json`);
      // Publish the closed copy first. If the process stops between these two
      // operations, both files remain individually valid and retrying close is
      // safe. Writing closed state into the active location first would leave
      // a location/status mismatch after a crash.
      await writeJsonAtomic(archivedFile, next);
      await removeFile(activeFile);

      if (resolved.git && await selectedHandoffId(resolved.git, env) === next.id) {
        const remaining = (await listForRepository(next.repoId, 'active', env))
          .filter((candidate) => (
            candidate.worktree === resolved.git.worktree
            && candidate.branch === resolved.git.branch
          ))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        await persistSelection({
          git: resolved.git,
          repoId: next.repoId,
          handoffId: remaining[0]?.id ?? null,
          env,
          clock,
        });
      }
      return decorateHandoff(next, clock);
    },
  );
}

export {
  ARRAY_FIELDS as HANDOFF_ARRAY_FIELDS,
  ALL_PATCH_FIELDS as HANDOFF_PATCH_FIELDS,
  HANDOFF_PRIORITIES,
  HANDOFF_WORKFLOW_STATUSES,
};
