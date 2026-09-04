import { composeEffectiveContext } from './compose.mjs';
import { captureCheckpoint, getCheckpoint } from './checkpoints.mjs';
import { withStateLock } from './mutation-lock.mjs';
import {
  closeHandoff,
  HANDOFF_ARRAY_FIELDS,
  listHandoffs,
  selectHandoff,
  showHandoff,
  startHandoff,
  updateHandoff,
} from './handoffs.mjs';
import { getPolicy, listPolicies, removePolicy, setPolicy } from './policies.mjs';
import {
  addRuleRecord,
  listRuleRecords,
  removeRuleRecord,
  setManualRule,
  updateRuleRecord,
} from './rule-records.mjs';
import {
  addKnowledge,
  getKnowledge,
  listKnowledge,
  findKnowledgeDuplicates,
  mergeKnowledge,
  relevantKnowledge,
  removeKnowledge,
  searchKnowledge,
  updateKnowledge,
} from './knowledge.mjs';
import {
  getRepository,
  getRepositoryEnvironment,
  linkRepository,
  listBindings,
  listRepositories,
  registerRepository,
  resolveRepositoryBinding,
  resolveRepository,
  setRepositoryEnvironment,
  unlinkRepositoryPath,
} from './repositories.mjs';
import {
  getAutoSave,
  getAutoSync,
  initializeState,
  readConfig,
  setAutoSave,
  setAutoSync,
  updateConfig,
} from './state.mjs';

function withDefaults(options, defaults, { cwd = false } = {}) {
  const result = { ...options, env: defaults.env, clock: defaults.clock };
  if (cwd && result.cwd === undefined) result.cwd = defaults.cwd;
  return result;
}

function mutationOptions(options, defaults) {
  const source = { ...options };
  const patch = { ...(source.patch || {}) };
  const append = { ...(source.append || {}) };
  for (const field of [
    'objective', 'currentState', 'staleHours', 'priority', 'workflowStatus',
    'dependencies', 'parentId', 'claimedBy', 'claimExpiresAt',
    'blockedReason', 'unblockCriteria',
  ]) {
    if (source[field] !== undefined) patch[field] = source[field];
    delete source[field];
  }
  for (const field of HANDOFF_ARRAY_FIELDS) {
    if (source[field] !== undefined) append[field] = source[field];
    delete source[field];
  }
  source.patch = patch;
  source.append = append;
  if (source.cwd === undefined && source.repoId === undefined) source.cwd = defaults.cwd;
  return { ...source, env: defaults.env, clock: defaults.clock };
}

function knowledgeOptions(options, defaults, { currentRepository = false } = {}) {
  const scope = options.scope === 'all' ? 'global' : options.scope;
  return withDefaults(options, defaults, {
    cwd: currentRepository && ['repo', 'env'].includes(scope) && !options.repoId,
  });
}

const OPTIONAL_REPOSITORY_ERRORS = new Set([
  'NOT_GIT_REPOSITORY',
  'REPOSITORY_NOT_FOUND',
  'REPOSITORY_NOT_REGISTERED',
  'REPOSITORY_LINK_REQUIRED',
  'REPOSITORY_AMBIGUOUS',
  'NO_REPOSITORY',
]);

async function validatePolicyCandidate(candidate, defaults) {
  let repoId = candidate.repoId;
  if (!repoId) {
    try {
      const resolved = await resolveRepository({
        cwd: defaults.cwd,
        env: defaults.env,
        clock: defaults.clock,
        create: false,
      });
      repoId = resolved.repository.id;
    } catch (error) {
      if (!OPTIONAL_REPOSITORY_ERRORS.has(error?.code)) throw error;
    }
  }
  const options = {
    env: defaults.env,
    clock: defaults.clock,
    createRepository: false,
    policyOverrides: { [candidate.scope]: candidate.content },
  };
  if (repoId) options.repoId = repoId;
  if (candidate.environment) options.environment = candidate.environment;
  await composeEffectiveContext(options);
}

async function validateHandoffCandidate(candidate, defaults) {
  if (candidate.status !== 'active') return;
  await composeEffectiveContext({
    repoId: candidate.repoId,
    env: defaults.env,
    clock: defaults.clock,
    createRepository: false,
    handoffOverride: candidate,
  });
}

/**
 * Bound local core used by the CLI. Raw functions are exported below for tests
 * and integrations that prefer explicit env/cwd/clock parameters.
 */
export function createCore({ env = process.env, cwd = process.cwd(), clock = Date } = {}) {
  const defaults = { env, cwd, clock };
  const locked = (callback) => withStateLock(callback, { env });
  return Object.freeze({
    init: () => initializeState({ env, clock }),
    config: Object.freeze({
      get: () => locked(() => readConfig({ env, clock })),
      update: (patch) => locked(() => updateConfig(patch, { env, clock })),
    }),
    auto: Object.freeze({
      get: () => locked(() => getAutoSave({ env, clock })),
      set: (enabled) => locked(() => setAutoSave(enabled, { env, clock })),
      capture: (options = {}) => locked(() => captureCheckpoint({
        ...options,
        cwd: options.cwd ?? cwd,
        env,
        clock,
      })),
      show: (options = {}) => locked(async () => {
        const resolved = await resolveRepositoryBinding({
          cwd: options.cwd ?? cwd,
          env,
          clock,
        });
        return getCheckpoint({ repoId: resolved.repository.id, git: resolved.git, env });
      }),
    }),
    sync: Object.freeze({
      // Sync is also responsible for recovering an interrupted restore journal,
      // so reading this independent config flag must not require the state lock.
      get: () => getAutoSync({ env, clock }),
      set: (enabled) => setAutoSync(enabled, { env, clock }),
    }),
    env: Object.freeze({
      get: () => locked(() => getRepositoryEnvironment({ cwd, env, clock })),
      set: (environment) => locked(
        () => setRepositoryEnvironment(environment, { cwd, env, clock }),
      ),
    }),
    repo: Object.freeze({
      resolve: (options = {}) =>
        locked(() => resolveRepository(withDefaults(options, defaults, { cwd: true }))),
      register: (options = {}) =>
        locked(() => registerRepository(withDefaults(options, defaults, { cwd: true }))),
      link: (options = {}) => locked(
        () => linkRepository(withDefaults(options, defaults, { cwd: true })),
      ),
      unlink: (options = {}) =>
        locked(() => unlinkRepositoryPath(withDefaults(options, defaults, { cwd: true }))),
      get: (repoIdOrOptions) =>
        locked(() => getRepository(
          withDefaults(
            typeof repoIdOrOptions === 'string'
              ? { repoId: repoIdOrOptions }
              : repoIdOrOptions || {},
            defaults,
          ),
        )),
      list: () => locked(() => listRepositories({ env, clock })),
      bindings: () => locked(() => listBindings({ env, clock })),
    }),
    policy: Object.freeze({
      get: (options = {}) =>
        locked(() => getPolicy(
          withDefaults(options, defaults, {
            cwd: ['repo', 'env'].includes(options.scope) && !options.repoId,
          }),
        )),
      set: (options = {}) => {
        const resolved = withDefaults(options, defaults, {
            cwd: ['repo', 'env'].includes(options.scope) && !options.repoId,
          });
        return locked(() => setPolicy({
          ...resolved,
          validate: (candidate) => validatePolicyCandidate(candidate, defaults),
        }));
      },
      remove: (options = {}) =>
        locked(() => removePolicy(
          withDefaults(options, defaults, {
            cwd: ['repo', 'env'].includes(options.scope) && !options.repoId,
          }),
        )),
      list: (options = {}) =>
        locked(() => listPolicies(
          withDefaults(options, defaults, {
            cwd: !options.repoId && options.currentRepository !== false,
          }),
        )),
    }),
    ruleRecord: Object.freeze({
      add: (options = {}) => locked(() => addRuleRecord(withDefaults({ actor: 'cli', ...options }, defaults, {
        cwd: ['repo', 'env'].includes(options.scope) && !options.repoId,
      }))),
      list: (options = {}) => locked(() => listRuleRecords(withDefaults(options, defaults, {
        cwd: options.currentRepository !== false && !options.repoId,
      }))),
      update: (options = {}) => locked(() => updateRuleRecord(withDefaults({ actor: 'cli', ...options }, defaults))),
      remove: (options = {}) => locked(() => removeRuleRecord(withDefaults(options, defaults))),
      invoke: (id, enabled = true) => locked(() => setManualRule({ id, enabled, env, clock })),
    }),
    handoff: Object.freeze({
      start: (options = {}) => locked(() => startHandoff({
        ...withDefaults({ actor: 'cli', ...options }, defaults, { cwd: true }),
        validate: (candidate) => validateHandoffCandidate(candidate, defaults),
      })),
      update: (options = {}) => locked(() => updateHandoff({
        ...mutationOptions({ actor: 'cli', ...options }, defaults),
        validate: (candidate) => validateHandoffCandidate(candidate, defaults),
      })),
      show: (options = {}) =>
        locked(() => showHandoff(
          withDefaults(options, defaults, { cwd: options.repoId === undefined }),
        )),
      close: (options = {}) => locked(
        () => closeHandoff(mutationOptions({ actor: 'cli', ...options }, defaults)),
      ),
      select: (options = {}) =>
        locked(() => selectHandoff(
          withDefaults(options, defaults, { cwd: options.repoId === undefined }),
        )),
      list: (options = {}) =>
        locked(() => listHandoffs(
          withDefaults({
            ...options,
            status:
              Object.hasOwn(options, 'status') && options.status === undefined
                ? 'all'
                : options.status,
          }, defaults, {
            cwd: options.repoId === undefined && options.allRepositories !== true,
          }),
        )),
    }),
    knowledge: Object.freeze({
      add: (options = {}) => locked(() => addKnowledge(
        knowledgeOptions({ actor: 'cli', ...options }, defaults, { currentRepository: true }),
      )),
      get: (options = {}) => locked(() => getKnowledge(withDefaults(options, defaults))),
      list: (options = {}) => locked(() => listKnowledge(
        knowledgeOptions(options, defaults, { currentRepository: true }),
      )),
      search: (options = {}) => locked(() => searchKnowledge(
        knowledgeOptions(options, defaults, { currentRepository: true }),
      )),
      relevant: (options = {}) => locked(() => relevantKnowledge(
        knowledgeOptions(options, defaults, { currentRepository: false }),
      )),
      update: (options = {}) => locked(() => updateKnowledge(
        knowledgeOptions({ actor: 'cli', ...options }, defaults, { currentRepository: true }),
      )),
      remove: (options = {}) => locked(() => removeKnowledge(withDefaults(options, defaults))),
      duplicates: (options = {}) => locked(() => findKnowledgeDuplicates(withDefaults(options, defaults))),
      merge: (options = {}) => locked(() => mergeKnowledge(withDefaults({ actor: 'cli', ...options }, defaults))),
    }),
    compose: (options = {}) =>
      locked(() => composeEffectiveContext(
        withDefaults(options, defaults, { cwd: options.globalOnly !== true && !options.repoId }),
      )),
  });
}

export const createStore = createCore;

export { CoreError } from './errors.mjs';
export {
  ensureDirectory,
  fileMetadata,
  listFiles,
  moveFile,
  pathExists,
  readJson,
  readText,
  removeFile,
  withFileLock,
  writeJsonAtomic,
  writeTextAtomic,
} from './fs.mjs';
export { detectGitRepository, inspectGitProgress, normalizeRemoteUrl } from './git.mjs';
export { captureCheckpoint, getCheckpoint, validCheckpoint } from './checkpoints.mjs';
export {
  assertRepositoryId,
  getAutoSave,
  getAutoSync,
  getActiveEnvironment,
  initializeRepositoryDirectory,
  initializeState,
  isoNow,
  readConfig,
  setActiveEnvironment,
  setAutoSave,
  setAutoSync,
  validateEnvironmentLabel,
  validatePortableEnvironmentLabel,
} from './state.mjs';
export {
  getRepository,
  getRepositoryEnvironment,
  linkRepository,
  listBindings,
  listRepositories,
  registerRepository,
  resolveRepositoryBinding,
  resolveRepository,
  setRepositoryEnvironment,
  unlinkRepositoryPath,
} from './repositories.mjs';
export {
  assertPolicyScope,
  getPolicy,
  getPolicyPath,
  listPolicies,
  removePolicy,
  setPolicy,
  validatePolicyContent,
} from './policies.mjs';
export {
  addRuleRecord,
  listRuleRecords,
  removeRuleRecord,
  ruleRecordApplies,
  RULE_RECORD_ACTIVATIONS,
  RULE_RECORD_SCOPES,
  RULE_RECORD_STATUSES,
  setManualRule,
  updateRuleRecord,
  validateRuleRecord,
} from './rule-records.mjs';
export {
  closeHandoff,
  findActiveHandoff,
  HANDOFF_ARRAY_FIELDS,
  HANDOFF_PATCH_FIELDS,
  listHandoffs,
  selectHandoff,
  showHandoff,
  startHandoff,
  updateHandoff,
} from './handoffs.mjs';
export {
  addKnowledge,
  getKnowledge,
  KNOWLEDGE_SCOPES,
  KNOWLEDGE_TYPES,
  KNOWLEDGE_STATES,
  KNOWLEDGE_APPROVALS,
  KNOWLEDGE_RELATIONS,
  listKnowledge,
  findKnowledgeDuplicates,
  mergeKnowledge,
  relevantKnowledge,
  removeKnowledge,
  searchKnowledge,
  updateKnowledge,
  validateKnowledgeEntry,
  assessKnowledgeFreshness,
} from './knowledge.mjs';
export { composeEffectiveContext, renderHandoffMarkdown } from './compose.mjs';
export { withStateLock } from './mutation-lock.mjs';
