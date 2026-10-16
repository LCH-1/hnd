import { validateSyncSnapshot } from './capture.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { VERSION } from '../constants.mjs';
import { statePaths } from '../paths.mjs';
import { operationDeadline, readJson, readText, writeJsonAtomic } from '../core/fs.mjs';
import { validateBindings, validateConfig, validateEnvironmentLabel, validateRepositoryIndex, isUuid } from '../core/state.mjs';
import { validatePolicyContextBudget } from '../core/compose.mjs';
import { validateKnowledgeEntry } from '../core/knowledge.mjs';
import { validateRuleRecord } from '../core/rule-records.mjs';
import { effectiveAppSettings, validAppSettings } from '../shared/app-settings.mjs';
import { validHandoffRecord, validCheckpointRecord } from '../shared/record-merge.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true });

function invalid(relativePath) {
  const error = new Error(`Invalid synced state schema or record identity: ${relativePath}`);
  error.code = 'SYNC_STATE_INVALID';
  throw error;
}

/** Validate domain records at publication/restore boundaries, in addition to
 * the transport envelope. Opaque attachments remain supported by capture. */
export function validateSyncedState(snapshot) {
  const validated = validateSyncSnapshot(snapshot);
  for (const file of validated.files) {
    if (!file.path.endsWith('.json')) continue;
    let value;
    try { value = JSON.parse(decoder.decode(file.contents)); }
    catch { invalid(file.path); }
    if (file.path === 'repositories.json') {
      if (!validateRepositoryIndex(value)) invalid(file.path);
      continue;
    }
    if (file.path === 'app-settings.json') {
      if (!validAppSettings(value)) invalid(file.path);
      continue;
    }
    let match = /^repositories\/([^/]+)\/repository\.json$/.exec(file.path);
    if (match) {
      if (!isUuid(match[1]) || !value || value.id !== match[1]
        || !validateRepositoryIndex({ schemaVersion: 1, repositories: { [match[1]]: value } })) invalid(file.path);
      continue;
    }
    match = /^repositories\/([^/]+)\/(handoffs|archive)\/([^/]+)\.json$/.exec(file.path);
    if (match) {
      if (!validHandoffRecord(value) || value.repoId !== match[1] || value.id !== match[3]
        || value.status !== (match[2] === 'archive' ? 'closed' : 'active')) invalid(file.path);
      continue;
    }
    match = /^repositories\/([^/]+)\/checkpoints\/([^/]+)\.json$/.exec(file.path);
    if (match) {
      if (!validCheckpointRecord(value) || value.repoId !== match[1] || value.key !== match[2]
        || !Number.isFinite(Date.parse(value.capturedAt))) invalid(file.path);
      continue;
    }
    match = /^knowledge\/(?:archive\/)?([^/]+)\.json$/.exec(file.path);
    if (match) {
      if (!validateKnowledgeEntry(value) || value.id !== match[1]) invalid(file.path);
      continue;
    }
    match = /^(rules|repositories\/([^/]+)\/rules)\/([^/]+)\.json$/.exec(file.path);
    if (match && (!validateRuleRecord(value) || value.id !== match[3]
      || (match[2] ? value.repoId !== match[2] || value.scope === 'global'
        : value.scope !== 'global'))) invalid(file.path);
  }
  return validated;
}

function isPolicyInput(relativePath) {
  return ['policies/global.md', 'app-settings.json', 'repositories.json'].includes(relativePath)
    || /^rules\/[^/]+\.json$/.test(relativePath)
    || /^repositories\/[^/]+\/(?:repository\.json|policy\.md|environments\/[^/]+\.md|rules\/[^/]+\.json)$/.test(relativePath);
}

/** Render mandatory policy combinations directly from one immutable input set.
 * No temporary state, Git inspection, checkpoint rendering or repeated disk
 * reads are needed while a restore holds the shared state lock. */
export async function validatePolicySnapshot(snapshot, env = process.env) {
  const state = statePaths(env);
  const files = validateSyncedState(snapshot).files.filter((file) => isPolicyInput(file.path));
  const local = [];
  for (const name of ['config.json', 'bindings.json', 'local-override.md']) {
    const text = await readText(path.join(state.home, name), { optional: true });
    if (text !== null) local.push({ path: name, contents: Buffer.from(text) });
  }
  const hash = createHash('sha256').update(`policy-preflight-v3\0${VERSION}\0`);
  for (const file of [...files, ...local]) hash.update(JSON.stringify([file.path, file.contents.toString('base64')]));
  const digest = hash.digest('hex');
  const cachePath = path.join(state.cache, 'policy-preflight.json');
  const cache = await readJson(cachePath, { optional: true }).catch(() => null);
  if (cache?.schemaVersion === 1 && cache.digest === digest) return;
  const inputs = new Map([...files, ...local].map((file) => [file.path, file.contents.toString('utf8')]));
  const json = (name, fallback, validate) => {
    if (!inputs.has(name)) return fallback;
    let value;
    try { value = JSON.parse(inputs.get(name)); } catch { invalid(name); }
    if (validate && !validate(value)) invalid(name);
    return value;
  };
  const config = json('config.json', {}, validateConfig);
  const bindings = Object.values(json('bindings.json', { bindings: {} }, validateBindings).bindings);
  const appSettings = effectiveAppSettings(json('app-settings.json', {}), config);
  const repositories = new Map(Object.entries(json('repositories.json', { repositories: {} }).repositories));
  const globalRules = [];
  const projectRules = new Map();
  const projectEnvironments = new Map();
  const environmentPolicies = new Map();
  const addEnvironment = (id, label) => {
    if (label == null || label === '') return;
    validateEnvironmentLabel(label);
    if (!projectEnvironments.has(id)) projectEnvironments.set(id, new Set());
    projectEnvironments.get(id).add(label);
  };
  for (const file of files) {
    let match = /^repositories\/([^/]+)\/repository\.json$/.exec(file.path);
    if (match && !repositories.has(match[1])) repositories.set(match[1], json(file.path));
    match = /^repositories\/([^/]+)\/environments\/([^/]+)\.md$/.exec(file.path);
    if (match) {
      addEnvironment(match[1], match[2]);
      // getPolicy resolves environment filenames without regard to case.
      // Keep that same contract when combining named rules with legacy files.
      environmentPolicies.set(`${match[1]}/${match[2].toLowerCase()}`, inputs.get(file.path));
    }
    if (!/^(?:rules|repositories\/[^/]+\/rules)\/[^/]+\.json$/.test(file.path)) continue;
    const rule = json(file.path);
    if (rule.scope === 'global') globalRules.push(rule);
    else {
      if (!projectRules.has(rule.repoId)) projectRules.set(rule.repoId, []);
      projectRules.get(rule.repoId).push(rule);
      if (rule.scope === 'env') addEnvironment(rule.repoId, rule.environment);
    }
  }
  for (const binding of bindings) addEnvironment(binding.repoId, binding.environment);
  if (config.ruleTest) addEnvironment(config.ruleTest.repoId, config.ruleTest.environment);
  const sharedPolicies = { global: inputs.get('policies/global.md'), local: inputs.get('local-override.md') };
  const deadlineAt = operationDeadline();
  const check = (options) => {
    if (deadlineAt !== null && Date.now() >= deadlineAt) throw new DOMException('Policy validation deadline exceeded', 'TimeoutError');
    validatePolicyContextBudget({ ...options, config, appSettings });
  };
  check({ policies: sharedPolicies, records: globalRules });
  for (const [id, repository] of repositories) {
    const records = [...globalRules, ...(projectRules.get(id) ?? [])];
    const environments = new Set([null, config.activeEnvironment ?? null, ...(projectEnvironments.get(id) ?? [])]);
    for (const environment of environments) {
      if (environment !== null) validateEnvironmentLabel(environment);
      check({ repository, environment, records, policies: { ...sharedPolicies,
        repo: inputs.get(`repositories/${id}/policy.md`),
        env: environment === null ? undefined : environmentPolicies.get(`${id}/${environment.toLowerCase()}`),
      } });
    }
  }
  // A successful check is authoritative even when its optional cache is full,
  // unwritable or occupied by an unexpected directory.
  await writeJsonAtomic(cachePath, { schemaVersion: 1, digest }).catch(() => {});
}
