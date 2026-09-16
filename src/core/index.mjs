import { composeEffectiveContext } from './compose.mjs';
import { captureCheckpoint, getCheckpoint } from './checkpoints.mjs';
import { readAppSettings } from './app-settings.mjs';
import { withStateLock } from './mutation-lock.mjs';
import { workSessionKey } from './work-session.mjs';
import { inspectWorkCoordination, acknowledgeWorkEvents, heartbeatWorkSession } from './work-coordination.mjs';
import { getPrivacyPolicy, setPrivacyPolicy, previewRetention, applyRetention, collectionAllowed } from './privacy.mjs';
import {
  addNotifyChannel,
  findNotifyChannel,
  getNotifySettings,
  notifyForEvent,
  removeNotifyChannel,
  updateNotifyChannel,
} from './notify.mjs';
import { automaticSessionCandidate } from './knowledge-transfer.mjs';
import { getSemanticSearchConfig, configureSemanticSearch } from './semantic-search.mjs';
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
  searchKnowledgeDetailed,
  createKnowledgeExperiment,
  listKnowledgeExperiments,
  diffKnowledgeExperiment,
  adoptKnowledgeExperiment,
  updateKnowledge,
} from './knowledge.mjs';
import {
  getRepository,
  getRepositoryEnvironment,
  initializeRepository,
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
  const result = {
    agent: defaults.agent,
    sessionKey: options.sessionId === undefined ? defaults.sessionKey : undefined,
    ...options, env: defaults.env, clock: defaults.clock,
  };
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
    'blockedReason', 'unblockCriteria', 'plannedFiles',
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
  return {
    agent: defaults.agent,
    sessionKey: source.sessionId === undefined ? defaults.sessionKey : undefined,
    ...source, env: defaults.env, clock: defaults.clock,
  };
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
export function createCore({ env = process.env, cwd = process.cwd(), clock = Date, sessionKey, sessionId, agent } = {}) {
  const defaults = { env, cwd, clock, agent, sessionKey: workSessionKey({ sessionKey, sessionId, agent, env }) };
  const locked = (callback) => withStateLock(callback, { env });
  const workMutation = (callback) => locked(async () => {
    const result = await callback();
    try {
      await inspectWorkCoordination({ repoId: result.repoId, sessionKey: defaults.sessionKey, env, clock });
    } catch (error) {
      // Work is already committed. Do not report it as failed or encourage a
      // duplicate mutation when the optional event cache is unavailable.
      return { ...result, warnings: [{ code: 'WORK_EVENT_RECORDING_DEFERRED', reason: error.code ?? error.name }] };
    }
    return result;
  });
  return Object.freeze({
    init: () => initializeState({ env, clock }),
    config: Object.freeze({
      get: () => locked(async () => {
        const config = await readConfig({ env, clock });
        return { ...config, ...await readAppSettings({ env, localConfig: config }) };
      }),
      update: (patch) => locked(() => updateConfig(patch, { env, clock })),
    }),
    auto: Object.freeze({
      get: () => locked(() => getAutoSave({ env, clock })),
      set: (enabled) => locked(() => setAutoSave(enabled, { env, clock })),
      suggest: ({ payload, agent: sourceAgent, sourceSessionId } = {}) => locked(async () => {
        const settings = await readAppSettings({ env, localConfig: await readConfig({ env, clock }) });
        if (!settings.knowledgeSuggestions) return null;
        // A transcript's raw ID is provenance only. The bound agent session
        // controls collection policy; sourceSessionId must never reroute it.
        const policy = await getPrivacyPolicy({ cwd, env, clock, sessionKey: defaults.sessionKey });
        if (!collectionAllowed({ policy, sourceKind: 'session' })) return null;
        const candidate = automaticSessionCandidate(payload, {
          agent: sourceAgent ?? defaults.agent ?? 'unknown',
          sessionId: sourceSessionId,
          sessionKey: defaults.sessionKey,
        });
        if (!candidate) return null;
        const pending = await listKnowledge({ scope: 'repo', repoId: policy.repoId, approval: 'pending', env, clock });
        if (pending.some((entry) => entry.body === candidate.body)) return null;
        return addKnowledge({ ...candidate, repoId: policy.repoId, actor: 'hook', env, clock });
      }),
      capture: (options = {}) => locked(() => captureCheckpoint({
        ...withDefaults(options, defaults, { cwd: true }),
        agent: options.agent ?? defaults.agent ?? 'unknown',
      })),
      show: (options = {}) => locked(async () => {
        const resolved = await resolveRepositoryBinding({
          cwd: options.cwd ?? cwd,
          env,
          clock,
        });
        return getCheckpoint({ ...withDefaults(options, defaults), repoId: resolved.repository.id, git: resolved.git });
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
      init: (options = {}) =>
        locked(() => initializeRepository(withDefaults(options, defaults, { cwd: true }))),
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
    work: Object.freeze({
      inspect: (options = {}) => locked(() => inspectWorkCoordination(withDefaults(options, defaults, { cwd: true }))),
      ack: (options = {}) => locked(() => acknowledgeWorkEvents(withDefaults(options, defaults))),
      heartbeat: (options = {}) => locked(() => heartbeatWorkSession(withDefaults(options, defaults, { cwd: true }))),
    }),
    notify: Object.freeze({
      // Sending is deliberately outside the state lock: a slow webhook must not
      // block a checkpoint or another session's mutation.
      get: () => locked(() => getNotifySettings({ env })),
      add: (options = {}) => locked(() => addNotifyChannel({ ...options, env })),
      update: (options = {}) => locked(() => updateNotifyChannel({ ...options, env })),
      remove: (options = {}) => locked(() => removeNotifyChannel({ ...options, env })),
      find: (options = {}) => locked(() => findNotifyChannel({ ...options, env })),
      send: (options = {}) => notifyForEvent({ ...options, env }),
    }),
    privacy: Object.freeze({
      get: (options = {}) => locked(() => getPrivacyPolicy(withDefaults(options, defaults, { cwd: true }))),
      set: (options = {}) => locked(() => setPrivacyPolicy(withDefaults(options, defaults, { cwd: true }))),
      preview: (options = {}) => locked(() => previewRetention(withDefaults(options, defaults, { cwd: true }))),
      apply: (options = {}) => locked(() => applyRetention(withDefaults(options, defaults, { cwd: true }))),
    }),
    handoff: Object.freeze({
      start: (options = {}) => workMutation(() => startHandoff({
        ...withDefaults({ actor: 'cli', ...options }, defaults, { cwd: true }),
        validate: (candidate) => validateHandoffCandidate(candidate, defaults),
      })),
      update: (options = {}) => workMutation(() => updateHandoff({
        ...mutationOptions({ actor: 'cli', ...options }, defaults),
        validate: (candidate) => validateHandoffCandidate(candidate, defaults),
      })),
      show: (options = {}) =>
        locked(() => showHandoff(
          withDefaults(options, defaults, { cwd: options.repoId === undefined }),
        )),
      close: (options = {}) => workMutation(
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
      // Embedding requests must not hold the global generation lock. Detailed
      // search snapshots/rechecks knowledge under its own lock around I/O.
      searchDetailed: (options = {}) => searchKnowledgeDetailed(knowledgeOptions(options, defaults, { currentRepository: true })),
      semanticConfig: Object.freeze({
        get: () => getSemanticSearchConfig({ env }),
        set: (options = {}) => configureSemanticSearch({ ...options, env }),
      }),
      branch: Object.freeze({
        create: (options = {}) => locked(() => createKnowledgeExperiment(withDefaults(options, defaults, { cwd: true }))),
        list: (options = {}) => locked(() => listKnowledgeExperiments(withDefaults(options, defaults, { cwd: true }))),
        diff: (options = {}) => locked(() => diffKnowledgeExperiment(withDefaults(options, defaults))),
        adopt: (options = {}) => locked(() => adoptKnowledgeExperiment(withDefaults({ actor: 'cli', ...options }, defaults))),
      }),
      add: (options = {}) => locked(() => addKnowledge(
        knowledgeOptions({ actor: 'cli', ...options }, defaults, { currentRepository: true }),
      )),
      get: (options = {}) => locked(() => getKnowledge(withDefaults(options, defaults))),
      list: (options = {}) => locked(() => listKnowledge(
        knowledgeOptions(options, defaults, { currentRepository: true }),
      )),
      search: (options = {}) => options.mode && options.mode !== 'keyword'
        ? searchKnowledgeDetailed(knowledgeOptions(options, defaults, { currentRepository: true })).then((result) => result.items)
        : locked(() => searchKnowledge(knowledgeOptions(options, defaults, { currentRepository: true }))),
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
