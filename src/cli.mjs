import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { UsageError, optionBoolean, optionList, optionString, parseArgs } from './args.mjs';
import { HELP, HELP_TOPIC_NAMES, helpFor } from './cli-help.mjs';
import {
  cliLanguage,
  ct,
  languageState,
  normalizeLanguage,
  saveLanguagePreference,
  useCliLanguage,
} from './cli-i18n.mjs';
import {
  AGENTS,
  DEFAULT_ENVIRONMENT,
  DEFAULT_MAX_CONTEXT_BYTES,
  VERSION,
} from './constants.mjs';
import { createCore } from './core/index.mjs';
import {
  buildAdapterOperations,
  hookOutputObject,
  inspectAdapters,
  renderHookOutput,
} from './adapters/index.mjs';
import {
  CURSOR_LIVE_CONTEXT_SESSION_ENV,
  recordLiveContextDelivery,
  renderLiveContextSnapshot,
} from './core/live-context.mjs';
import { applyOperations, summarizeOperations } from './fs-operations.mjs';
import { editText, readStdin, readTextInput } from './input.mjs';
import {
  MaterializeError,
  materializeCursor,
  planCursorDematerialization,
  planCursorMaterialization,
  renderCursorRule,
} from './materialize.mjs';
import { writeJson } from './presentation.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultBinPath = path.resolve(moduleDirectory, '..', 'bin', 'hnd.mjs');
const defaultSkillSource = path.resolve(
  moduleDirectory,
  '..',
  'assets',
  'hnd-handoff',
  'SKILL.md',
);

const commonOptions = ['cwd', 'json', 'help'];

const commandAliases = Object.freeze({
  rule: 'policy',
  work: 'handoff',
  sync: 'remote',
  knowledge: 'know',
});

const handoffCommandAliases = Object.freeze({
  new: 'start',
  use: 'select',
  done: 'close',
});

const policyScopeAliases = Object.freeze({
  all: 'global',
  pc: 'local',
});

function resolveAlias(value, aliases) {
  return aliases[value] ?? value;
}

function assertOptions(options, allowed) {
  const valid = new Set([...commonOptions, ...allowed]);
  const unknown = Object.keys(options).filter((name) => !valid.has(name));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown option: --${unknown[0].replaceAll('_', '-')}`);
  }
}

function requireValue(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new UsageError(`${label} is required.`);
  }
  return String(value);
}

function listStrings(options, name) {
  return optionList(options[name]).map((value) => {
    if (value === true) {
      throw new UsageError(`--${name.replaceAll('_', '-')} requires a value.`);
    }
    return String(value);
  });
}

function ensureNoExtra(values, usage) {
  if (values.length > 0) throw new UsageError(`Unexpected argument: ${values[0]}\nUsage: ${usage}`);
}

function writeText(stream, value) {
  const source = String(value ?? '');
  stream.write(source.endsWith('\n') ? source : `${source}\n`);
}

function selectAgents(value, { allowAll = true } = {}) {
  const source = value === undefined ? 'all' : value;
  if (source === true || Array.isArray(source)) {
    throw new UsageError('--agents requires a comma-separated value.');
  }
  const requested = String(source).split(',').map((item) => item.trim()).filter(Boolean);
  const expanded = requested.includes('all') && allowAll ? [...AGENTS] : requested;
  const unique = [...new Set(expanded)];
  if (unique.length === 0 || unique.some((agent) => !AGENTS.includes(agent))) {
    throw new UsageError(`Agents must be ${AGENTS.join(', ')}, or all.`);
  }
  if (!allowAll && unique.length !== 1) {
    throw new UsageError(`Choose one agent: ${AGENTS.join(', ')}.`);
  }
  return unique;
}

function policyContent(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : value.content ?? null;
}

function describeRepository(value) {
  const repository = value?.repository ?? value;
  if (!repository) return 'unresolved';
  const name = repository.name || repository.displayName;
  const id = repository.id || repository.repoId;
  return name && id ? `${name} (${id})` : name || id || 'resolved';
}

function handoffSummary(handoff) {
  return `${handoff.task} (${handoff.id})\nStatus: ${handoff.status}\nStale at: ${handoff.staleAt}`;
}

function parseMaxBytes(options) {
  const source = optionString(options, 'max_bytes');
  if (source === undefined) return undefined;
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_MAX_CONTEXT_BYTES) {
    throw new UsageError(`--max-bytes must be an integer from 1 to ${DEFAULT_MAX_CONTEXT_BYTES}.`);
  }
  return value;
}

function findHookCwds(payload, fallback, cursorProjectDirectory) {
  const candidates = [
    payload?.cwd,
    payload?.workspace_root,
    payload?.workspaceRoot,
    payload?.project_dir,
    payload?.projectDir,
    ...(Array.isArray(payload?.workspace_roots) ? payload.workspace_roots : []),
    ...(Array.isArray(payload?.workspaceRoots) ? payload.workspaceRoots : []),
    cursorProjectDirectory,
  ];
  const resolved = candidates
    .filter((candidate) => typeof candidate === 'string' && candidate && !candidate.includes('\0'))
    .map((candidate) => path.resolve(candidate));
  return [...new Set(resolved.length > 0 ? resolved : [path.resolve(fallback)])].slice(0, 16);
}

const optionalMaterializationErrors = new Set([
  'MATERIALIZE_NOT_GIT',
  'NOT_GIT_REPOSITORY',
  'REPOSITORY_NOT_REGISTERED',
]);

function isOptionalMaterializationError(error) {
  return optionalMaterializationErrors.has(error?.code);
}

async function planCurrentCursorMaterialization({
  action = 'install',
  core,
  cwd,
  content,
  optional = false,
} = {}) {
  try {
    if (action === 'uninstall') return planCursorDematerialization({ cwd });
    const effectiveContent = content ?? (await core.compose({ createRepository: false })).content;
    return planCursorMaterialization({ cwd, content: effectiveContent });
  } catch (error) {
    if (optional && isOptionalMaterializationError(error)) {
      return { paths: null, operations: [], skipped: error.code };
    }
    throw error;
  }
}

async function cursorFallbackEnabled({ cwd, env, execPath, binPath }) {
  try {
    const existing = await planCursorDematerialization({ cwd });
    if (existing.operations.length > 0) return true;
  } catch (error) {
    if (isOptionalMaterializationError(error)) return false;
    throw error;
  }
  const adapters = await inspectAdapters({
    agents: ['cursor'],
    env,
    execPath,
    binPath,
    skillSource: defaultSkillSource,
  });
  const hook = adapters[0]?.checks?.find((check) => check.component === 'hook');
  return ['ok', 'outdated', 'duplicate'].includes(hook?.status);
}

async function refreshCursorAfterMutation({ core, cwd, env, execPath, binPath, force = false }) {
  try {
    if (!force && !(await cursorFallbackEnabled({ cwd, env, execPath, binPath }))) {
      return { paths: null, operations: [], skipped: 'CURSOR_FALLBACK_DISABLED' };
    }
    const planned = await planCurrentCursorMaterialization({ core, cwd, optional: true });
    if (planned.operations.length > 0) await applyOperations(planned.operations);
    return planned;
  } catch (cause) {
    throw new MaterializeError(
      'MATERIALIZE_AFTER_MUTATION_FAILED',
      `State was updated, but the Cursor fallback could not be refreshed: ${cause.message}`,
      { causeCode: cause.code, cwd },
      { cause },
    );
  }
}

async function parseHookInput(stdin) {
  if (stdin?.isTTY) return {};
  const source = await readStdin(stdin);
  if (!source.trim()) return {};
  try {
    const payload = JSON.parse(source);
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    // Hook transports differ by version. Invalid input must not block a session.
    return {};
  }
}

async function handlePolicy({
  subcommand,
  rest,
  options,
  core,
  refreshCursor,
  stdin,
  stdout,
  env,
  jsonOutput,
}) {
  if (subcommand === 'list') {
    assertOptions(options, ['environment']);
    ensureNoExtra(rest, 'hnd rule list [--environment LABEL]');
    const result = await core.policy.list({
      environment: optionString(options, 'environment'),
    });
    writeJson(result, stdout);
    return;
  }
  if (subcommand === 'test') {
    const action = rest.shift() ?? 'show';
    assertOptions(options, []);
    ensureNoExtra(rest, 'hnd rule test <start|show|stop>');
    if (action === 'start') {
      const resolved = await core.repo.resolve({ create: true });
      const environment = await core.env.get();
      if (!environment) throw new UsageError('Select an environment first: hnd env set LABEL');
      const token = Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, '0');
      const createdAt = new Date().toISOString();
      const ruleTest = {
        token,
        repoId: resolved.repository.id,
        environment,
        createdAt,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
      await core.config.update({ ruleTest });
      await refreshCursor({ force: true });
      const result = {
        active: true,
        repository: resolved.repository,
        environment,
        expiresAt: ruleTest.expiresAt,
        prompts: {
          all: `HND-GLOBAL-${token}`,
          repo: `HND-PROJECT-${token}`,
          env: `HND-ENV-${token}`,
        },
        expected: {
          all: `HND-GLOBAL-OK-${token}`,
          repo: `HND-PROJECT-OK-${token}`,
          env: `HND-ENV-OK-${token}`,
        },
      };
      if (jsonOutput) writeJson(result, stdout);
      else writeText(stdout, cliLanguage() === 'ko' ? [
        '현재 프로젝트와 환경에 1시간짜리 임시 룰 테스트를 켰습니다.',
        '현재 훅이 설치된 세션은 다음 입력 직전에 변경된 최신 Live Context를 받습니다.',
        '아래 입력을 하나씩 정확히 보내세요:',
        `all     ${result.prompts.all}  →  ${result.expected.all}`,
        `repo    ${result.prompts.repo}  →  ${result.expected.repo}`,
        `env     ${result.prompts.env}  →  ${result.expected.env}`,
        '',
        '새 일회성 세션으로도 빠르게 확인할 수 있습니다:',
        `claude -p '${result.prompts.all}'`,
        `codex exec --ephemeral '${result.prompts.all}'`,
        '테스트 후 제거: hnd rule test stop',
      ].join('\n') : [
        'Temporary rule test enabled for this project and environment (expires in 1 hour).',
        'A running session with current hooks receives the latest changed Live Context before its next prompt.',
        'Send each prompt exactly:',
        `all     ${result.prompts.all}  →  ${result.expected.all}`,
        `repo    ${result.prompts.repo}  →  ${result.expected.repo}`,
        `env     ${result.prompts.env}  →  ${result.expected.env}`,
        '',
        'You can also run a quick check in a fresh one-shot session:',
        `claude -p '${result.prompts.all}'`,
        `codex exec --ephemeral '${result.prompts.all}'`,
        'After testing: hnd rule test stop',
      ].join('\n'));
      return;
    }
    if (action === 'stop') {
      await core.config.update({ ruleTest: null });
      await refreshCursor({ force: true });
      if (jsonOutput) writeJson({ active: false }, stdout);
      else writeText(stdout, cliLanguage() === 'ko'
        ? '임시 룰 테스트를 제거했습니다. 저장된 실제 룰은 바뀌지 않았습니다.'
        : 'Temporary rule test removed. Your saved rules were not changed.');
      return;
    }
    if (action === 'show') {
      const test = (await core.config.get()).ruleTest;
      const active = Boolean(test && Date.parse(test.expiresAt) > Date.now());
      const result = active ? {
        active,
        repositoryId: test.repoId,
        environment: test.environment,
        expiresAt: test.expiresAt,
        prompts: {
          all: `HND-GLOBAL-${test.token}`,
          repo: `HND-PROJECT-${test.token}`,
          env: `HND-ENV-${test.token}`,
        },
        expected: {
          all: `HND-GLOBAL-OK-${test.token}`,
          repo: `HND-PROJECT-OK-${test.token}`,
          env: `HND-ENV-OK-${test.token}`,
        },
      } : { active: false };
      if (jsonOutput) writeJson(result, stdout);
      else writeText(stdout, active
        ? [
          cliLanguage() === 'ko'
            ? '현재 훅이 설치된 세션은 다음 입력 직전에 변경된 최신 Live Context를 받습니다.'
            : 'A running session with current hooks receives the latest changed Live Context before its next prompt.',
          `all     ${result.prompts.all}  →  ${result.expected.all}`,
          `repo    ${result.prompts.repo}  →  ${result.expected.repo}`,
          `env     ${result.prompts.env}  →  ${result.expected.env}`,
          `${cliLanguage() === 'ko' ? '제거' : 'Stop'}: hnd rule test stop`,
        ].join('\n')
        : cliLanguage() === 'ko'
          ? '실행 중인 임시 룰 테스트가 없습니다. 시작: hnd rule test start'
          : 'No temporary rule test is active. Start one with: hnd rule test start');
      return;
    }
    throw new UsageError('Usage: hnd rule test <start|show|stop>');
  }
  const scope = resolveAlias(requireValue(rest.shift(), 'Policy scope'), policyScopeAliases);
  if (!['global', 'repo', 'env', 'local'].includes(scope)) {
    throw new UsageError('Rule scope must be all, repo, env, or pc (global/local also work).');
  }
  ensureNoExtra(rest, `hnd rule ${subcommand} <scope>`);
  const environment = optionString(options, 'environment');
  if (environment !== undefined && scope !== 'env') {
    throw new UsageError('--environment is valid only for env policy scope.');
  }

  if (subcommand === 'set') {
    assertOptions(options, ['text', 'file', 'stdin', 'environment']);
    const content = await readTextInput(options, { stream: stdin });
    const result = await core.policy.set({ scope, content, environment });
    await refreshCursor();
    if (jsonOutput) writeJson(result, stdout);
    else writeText(stdout, `Set ${scope} policy (${Buffer.byteLength(content)} bytes).`);
    return;
  }
  if (subcommand === 'show') {
    assertOptions(options, ['environment']);
    const result = await core.policy.get({ scope, environment });
    if (jsonOutput) writeJson(result, stdout);
    else {
      const content = policyContent(result);
      writeText(stdout, content ?? `No ${scope} policy is set.`);
    }
    return;
  }
  if (subcommand === 'edit') {
    assertOptions(options, ['environment']);
    const current = await core.policy.get({ scope, environment });
    const content = await editText(policyContent(current) ?? '', { env, label: `hnd-${scope}` });
    const result = await core.policy.set({ scope, content, environment });
    await refreshCursor();
    if (jsonOutput) writeJson(result, stdout);
    else writeText(stdout, `Updated ${scope} policy (${Buffer.byteLength(content)} bytes).`);
    return;
  }
  if (subcommand === 'remove') {
    assertOptions(options, ['environment']);
    const result = await core.policy.remove({ scope, environment });
    await refreshCursor();
    if (jsonOutput) writeJson(result, stdout);
    else writeText(stdout, result?.removed === false ? `No ${scope} policy was set.` : `Removed ${scope} policy.`);
    return;
  }
  throw new UsageError('Rule command must be list, set, show, edit, remove, or test.');
}

function handoffFields(options) {
  return {
    currentState: optionString(options, 'current'),
    decisions: listStrings(options, 'decision'),
    failedApproaches: listStrings(options, 'rejected'),
    changedFiles: listStrings(options, 'changed_file'),
    validation: listStrings(options, 'check'),
    nextSteps: listStrings(options, 'next'),
    openQuestions: listStrings(options, 'question'),
    notes: listStrings(options, 'note'),
  };
}

const handoffWriteOptions = [
  'goal', 'current', 'decision', 'rejected', 'changed_file', 'check', 'next', 'question',
  'note', 'stale_hours',
];

function staleHoursOption(options) {
  const source = optionString(options, 'stale_hours');
  if (source === undefined) return undefined;
  const value = Number(source);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError('--stale-hours must be a positive number.');
  }
  return value;
}

async function handleHandoff({ subcommand, rest, options, core, refreshCursor, stdout, jsonOutput }) {
  subcommand = resolveAlias(subcommand, handoffCommandAliases);
  if (subcommand === 'start') {
    assertOptions(options, handoffWriteOptions);
    const task = requireValue(rest.shift(), 'Task');
    ensureNoExtra(rest, 'hnd work new TASK --goal TEXT');
    const objective = optionString(options, 'goal');
    const fields = handoffFields(options);
    const result = await core.handoff.start({
      task,
      objective: requireValue(objective, '--goal'),
      ...fields,
      staleHours: staleHoursOption(options),
    });
    await refreshCursor();
    if (jsonOutput) writeJson(result, stdout);
    else writeText(stdout, `Started ${handoffSummary(result)}`);
    return;
  }

  if (subcommand === 'save') {
    assertOptions(options, [...handoffWriteOptions, 'id']);
    const task = rest.shift();
    ensureNoExtra(rest, 'hnd work save [TASK] [fields]');
    const fields = handoffFields(options);
    const patch = {};
    const objective = optionString(options, 'goal');
    if (objective !== undefined) patch.objective = objective;
    if (fields.currentState !== undefined) patch.currentState = fields.currentState;
    const staleHours = staleHoursOption(options);
    if (staleHours !== undefined) patch.staleHours = staleHours;
    const append = Object.fromEntries(
      Object.entries(fields).filter(([key, value]) => key !== 'currentState' && value.length > 0),
    );
    if (Object.keys(patch).length === 0 && Object.keys(append).length === 0) {
      throw new UsageError('Provide at least one handoff field to save.');
    }
    const result = await core.handoff.update({
      id: optionString(options, 'id'),
      task,
      patch,
      append,
    });
    await refreshCursor();
    if (jsonOutput) writeJson(result, stdout);
    else writeText(stdout, `Saved ${handoffSummary(result)}`);
    return;
  }

  if (subcommand === 'show') {
    assertOptions(options, ['id']);
    const task = rest.shift();
    ensureNoExtra(rest, 'hnd work show [TASK]');
    const result = await core.handoff.show({ id: optionString(options, 'id'), task });
    if (jsonOutput) writeJson(result, stdout);
    else writeJson(result, stdout);
    return;
  }

  if (subcommand === 'list') {
    assertOptions(options, ['all']);
    ensureNoExtra(rest, 'hnd work list [--all]');
    const status = optionBoolean(options, 'all') ? undefined : 'active';
    const result = await core.handoff.list({ status });
    if (jsonOutput) writeJson(result, stdout);
    else if (result.length === 0) writeText(stdout, 'No handoffs found.');
    else writeText(stdout, result.map((item) => `${item.status.padEnd(7)} ${item.task.padEnd(24)} ${item.id}`).join('\n'));
    return;
  }

  if (subcommand === 'close') {
    assertOptions(options, ['id']);
    const task = rest.shift();
    ensureNoExtra(rest, 'hnd work done [TASK]');
    const result = await core.handoff.close({ id: optionString(options, 'id'), task });
    await refreshCursor();
    if (jsonOutput) writeJson(result, stdout);
    else writeText(stdout, `Closed ${result.task} (${result.id}).`);
    return;
  }
  if (subcommand === 'select') {
    assertOptions(options, ['id']);
    const task = rest.shift();
    ensureNoExtra(rest, 'hnd work use [TASK] [--id ID]');
    const id = optionString(options, 'id');
    if (!task && !id) throw new UsageError('Provide a task or --id to select.');
    const result = await core.handoff.select({ id, task });
    await refreshCursor();
    if (jsonOutput) writeJson(result, stdout);
    else writeText(stdout, `Selected ${result.task} (${result.id}) for this checkout and branch.`);
    return;
  }
  throw new UsageError('Work command must be new, save, show, list, use, or done.');
}

function hasTextInput(options) {
  return ['text', 'file', 'stdin'].some((name) => options[name] !== undefined);
}

function knowledgeScopeOption(options) {
  const value = optionString(options, 'scope');
  if (value === undefined) return undefined;
  const scope = resolveAlias(value, policyScopeAliases);
  if (!['global', 'repo', 'env'].includes(scope)) {
    throw new UsageError('Knowledge scope must be all, repo, or env.');
  }
  return scope;
}

function knowledgeLocation(entry) {
  if (entry.scope === 'env') return `env:${entry.environment}`;
  if (entry.scope === 'repo') return 'repo';
  return 'all';
}

async function handleKnowledge({ subcommand, rest, options, core, refreshCursor, stdin, stdout, jsonOutput }) {
  if (subcommand === 'add') {
    assertOptions(options, ['text', 'file', 'stdin', 'tag', 'scope', 'repo_id', 'environment']);
    const title = requireValue(rest.shift(), 'Title');
    ensureNoExtra(rest, 'hnd know add TITLE [--scope all|repo|env] [--environment LABEL]');
    const body = hasTextInput(options) ? await readTextInput(options, { stream: stdin }) : '';
    const result = await core.knowledge.add({
      title,
      body,
      tags: listStrings(options, 'tag'),
      scope: knowledgeScopeOption(options),
      repoId: optionString(options, 'repo_id'),
      environment: optionString(options, 'environment'),
    });
    await refreshCursor();
    if (jsonOutput) writeJson(result, stdout);
    else writeText(stdout, `Saved [${knowledgeLocation(result)}] ${result.title} (${result.id}).`);
    return;
  }
  if (subcommand === 'find') {
    assertOptions(options, ['tag', 'scope', 'repo_id', 'environment']);
    const query = requireValue(rest.shift(), 'Search query');
    ensureNoExtra(rest, 'hnd know find QUERY [--scope all|repo|env] [--environment LABEL]');
    const result = await core.knowledge.search({
      query,
      tag: optionString(options, 'tag'),
      scope: knowledgeScopeOption(options),
      repoId: optionString(options, 'repo_id'),
      environment: optionString(options, 'environment'),
    });
    if (jsonOutput) writeJson(result, stdout);
    else if (result.length === 0) writeText(stdout, 'No knowledge found.');
    else writeText(stdout, result.map((item) => `[${knowledgeLocation(item)}]\t${item.title}\t${item.id}\t${item.tags.join(',')}`).join('\n'));
    return;
  }
  if (subcommand === 'list') {
    assertOptions(options, ['tag', 'scope', 'repo_id', 'environment']);
    ensureNoExtra(rest, 'hnd know list [--scope all|repo|env] [--environment LABEL]');
    const result = await core.knowledge.list({
      tag: optionString(options, 'tag'),
      scope: knowledgeScopeOption(options),
      repoId: optionString(options, 'repo_id'),
      environment: optionString(options, 'environment'),
    });
    if (jsonOutput) writeJson(result, stdout);
    else if (result.length === 0) writeText(stdout, 'No knowledge saved.');
    else writeText(stdout, result.map((item) => `[${knowledgeLocation(item)}]\t${item.title}\t${item.id}\t${item.tags.join(',')}`).join('\n'));
    return;
  }
  if (subcommand === 'show') {
    assertOptions(options, []);
    const id = requireValue(rest.shift(), 'Knowledge ID');
    ensureNoExtra(rest, 'hnd know show ID');
    const result = await core.knowledge.get({ id });
    if (jsonOutput) writeJson(result, stdout);
    else writeText(stdout, `# ${result.title}\n\n${result.body}${result.tags.length ? `\n\nTags: ${result.tags.join(', ')}` : ''}`);
    return;
  }
  if (subcommand === 'edit') {
    assertOptions(options, [
      'title', 'text', 'file', 'stdin', 'tag', 'clear_tags',
      'scope', 'repo_id', 'environment',
    ]);
    const id = requireValue(rest.shift(), 'Knowledge ID');
    ensureNoExtra(rest, 'hnd know edit ID [--title TITLE] [--text TEXT | --file PATH | --stdin] [--tag TAG]');
    if (options.tag !== undefined && optionBoolean(options, 'clear_tags')) {
      throw new UsageError('Choose --tag or --clear-tags, not both.');
    }
    const patch = {
      id,
      title: optionString(options, 'title'),
      body: hasTextInput(options) ? await readTextInput(options, { stream: stdin }) : undefined,
      tags: optionBoolean(options, 'clear_tags')
        ? []
        : options.tag === undefined ? undefined : listStrings(options, 'tag'),
      scope: knowledgeScopeOption(options),
      repoId: optionString(options, 'repo_id'),
      environment: optionString(options, 'environment'),
    };
    const result = await core.knowledge.update(patch);
    await refreshCursor();
    if (jsonOutput) writeJson(result, stdout);
    else writeText(stdout, `Updated ${result.title} (${result.id}).`);
    return;
  }
  if (subcommand === 'remove') {
    assertOptions(options, []);
    const id = requireValue(rest.shift(), 'Knowledge ID');
    ensureNoExtra(rest, 'hnd know remove ID');
    const result = await core.knowledge.remove({ id });
    await refreshCursor();
    if (jsonOutput) writeJson(result, stdout);
    else writeText(stdout, result.removed ? `Removed ${id}.` : `Knowledge entry not found: ${id}`);
    return;
  }
  throw new UsageError('Know command must be add, find, list, show, edit, or remove.');
}

async function handleAdapters({
  action,
  options,
  core,
  cwd,
  env,
  stdout,
  jsonOutput,
  execPath,
  binPath,
}) {
  assertOptions(options, ['agents', 'dry_run']);
  const agents = selectAgents(options.agents);
  const dryRun = optionBoolean(options, 'dry_run');
  const adapterOperations = await buildAdapterOperations({
    agents,
    action,
    env,
    execPath,
    binPath,
    skillSource: defaultSkillSource,
  });
  const materialized = agents.includes('cursor')
    ? await planCurrentCursorMaterialization({
        action,
        core,
        cwd,
        optional: true,
      })
    : { operations: [] };
  const operations = [...materialized.operations, ...adapterOperations];
  const applied = await applyOperations(operations, { dryRun });
  const summary = summarizeOperations(applied);
  if (jsonOutput) writeJson({ dryRun, operations: summary }, stdout);
  else {
    if (summary.length === 0) {
      writeText(stdout, 'No managed files found.');
      return;
    }
    for (const item of summary) {
      const verb = item.changed ? (dryRun ? `would ${item.action}` : item.action) : 'unchanged';
      writeText(stdout, `${verb.padEnd(13)} ${item.path}`);
    }
    if (
      action === 'install'
      && !dryRun
      && summary.some((item) => item.agent === 'codex' && item.component === 'hook' && item.changed)
    ) {
      writeText(stdout, cliLanguage() === 'ko'
        ? 'Codex를 다시 연 뒤 /hooks에서 변경된 HND 훅을 승인하세요.'
        : 'Reopen Codex, then approve the changed HND hooks in /hooks.');
    }
  }
}

async function handleRemote(context) {
  const { remoteMain } = await import('./remote-cli.mjs');
  return remoteMain(context);
}

async function runHookAutomaticSync({ core, agent, phase, payload, env, stderr }) {
  try {
    if (!await core.sync.get()) {
      return Object.freeze({ status: 'disabled', synced: false, pending: false });
    }
    const { syncForHook } = await import('./sync/hook-sync.mjs');
    const result = await syncForHook({ agent, phase, payload, env });
    if (['start', 'prompt'].includes(phase) && result.status === 'needs_attention') {
      writeText(
        stderr,
        `hnd hook: sync needs attention (${result.reason}); using the local cache. Run hnd sync status.`,
      );
    }
    return result;
  } catch (error) {
    // Lifecycle hooks are fail-open. The local cache remains usable even when
    // configuration or disk status cannot be updated.
    if (['start', 'prompt'].includes(phase)) {
      writeText(
        stderr,
        `hnd hook: automatic sync unavailable (${error.code || error.name || 'ERROR'}); using the local cache.`,
      );
    }
    return Object.freeze({ status: 'deferred', synced: false, pending: true });
  }
}

async function runMutationAutomaticSync({ core, env }) {
  try {
    if (!await core.sync.get()) {
      return Object.freeze({ status: 'disabled', synced: false, pending: false });
    }
    const { autoSync } = await import('./sync/auto.mjs');
    return autoSync({
      env,
      timeoutMs: 2_000,
      lockTimeoutMs: 1_000,
      maxConflictRetries: 1,
    });
  } catch {
    // The local mutation has already committed. A later hook retries the
    // remote operation, so a status-write failure must not roll it back.
    return Object.freeze({ status: 'deferred', synced: false, pending: true });
  }
}

async function ensureHookRepository({ cwd, env }) {
  const hookCore = createCore({ env, cwd });
  const resolved = await hookCore.repo.resolve({ create: true });
  if (resolved.environment === undefined) {
    // Migrate a legacy device-wide selection once, otherwise give each newly
    // encountered checkout its own neutral default.
    const initialEnvironment = (await hookCore.env.get()) ?? DEFAULT_ENVIRONMENT;
    await hookCore.env.set(initialEnvironment);
  }
  return resolved;
}

async function refreshCursorHookRoots({ hookCwds, env, stderr, primaryCwd, primaryContent }) {
  for (const hookCwd of hookCwds) {
    try {
      const content = hookCwd === primaryCwd && typeof primaryContent === 'string'
        ? primaryContent
        : (await createCore({ env, cwd: hookCwd }).compose({
            createRepository: false,
            fastRepository: true,
          })).content;
      await materializeCursor({ cwd: hookCwd, content });
    } catch (error) {
      if (!isOptionalMaterializationError(error)) {
        writeText(stderr, `hnd: Cursor fallback update failed (${error.code || error.name || 'ERROR'}).`);
      }
    }
  }
}

async function mainImpl(argv = process.argv.slice(2), {
  env = process.env,
  cwd = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  execPath = process.execPath,
  binPath = defaultBinPath,
} = {}) {
  const { positionals, options } = parseArgs(argv);
  const command = resolveAlias(positionals.shift(), commandAliases);

  await useCliLanguage(env);

  if (command === 'version' || options.version === true) {
    assertOptions(options, ['version']);
    writeText(stdout, VERSION);
    return;
  }
  const trailingHelp = positionals[0] === 'help';
  if (options.help === true || command === 'help' || command === undefined || trailingHelp) {
    assertOptions(options, []);
    const topic = command === 'help'
      ? positionals.shift()
      : command === undefined
        ? undefined
        : command;
    if (trailingHelp) positionals.shift();
    ensureNoExtra(positionals, 'hnd <project|rule|work|know|sync|setup|advanced> help');
    const selectedHelp = helpFor(topic, cliLanguage());
    if (!selectedHelp) {
      throw new UsageError(
        `${ct('도움말 주제를 찾을 수 없습니다')}: ${topic}\n${ct('사용 가능')}: ${HELP_TOPIC_NAMES.join(', ')}`,
      );
    }
    stdout.write(selectedHelp);
    return;
  }
  const requestedStateHome = optionString(options, 'state_home');
  if (requestedStateHome !== undefined && !path.isAbsolute(requestedStateHome)) {
    throw new UsageError('--state-home must be an absolute path.');
  }
  const runtimeEnv = requestedStateHome === undefined
    ? env
    : { ...env, HND_HOME: requestedStateHome };
  if (runtimeEnv !== env) await useCliLanguage(runtimeEnv);
  const invocationCwd = path.resolve(optionString(options, 'cwd', cwd));
  const jsonOutput = optionBoolean(options, 'json');
  const core = createCore({ env: runtimeEnv, cwd: invocationCwd });
  const refreshCursorOnly = (refreshOptions = {}) => refreshCursorAfterMutation({
    core,
    cwd: invocationCwd,
    env: runtimeEnv,
    execPath,
    binPath,
    ...refreshOptions,
  });
  const refreshCursor = async (refreshOptions = {}) => {
    await runMutationAutomaticSync({ core, env: runtimeEnv });
    return refreshCursorOnly(refreshOptions);
  };

  if (command === 'lang') {
    assertOptions(options, []);
    const action = positionals.shift() ?? 'show';
    if (action === 'show') {
      ensureNoExtra(positionals, 'hnd lang show');
      const result = await languageState(runtimeEnv);
      if (jsonOutput) writeJson(result, stdout);
      else writeText(
        stdout,
        `${ct('언어 설정')}: ${result.preference === 'auto' ? ct('자동 (OS 언어)') : result.preference}\n${ct('현재 언어')}: ${result.language}`,
      );
      return;
    }
    if (action === 'auto') {
      ensureNoExtra(positionals, 'hnd lang auto');
      const result = await saveLanguagePreference('auto', runtimeEnv);
      if (jsonOutput) writeJson(result, stdout);
      else writeText(stdout, ct('언어 설정을 자동으로 변경했습니다.'));
      return;
    }
    if (action === 'set') {
      const requested = positionals.shift();
      ensureNoExtra(positionals, 'hnd lang set <ko|en>');
      const language = normalizeLanguage(requested, { allowAuto: false });
      if (!language) throw new UsageError('Language must be ko or en. Aliases such as kr and ko-KR are accepted.');
      const result = await saveLanguagePreference(language, runtimeEnv);
      if (jsonOutput) writeJson(result, stdout);
      else writeText(stdout, language === 'ko' ? '언어를 한국어로 변경했습니다.' : 'Language changed to English.');
      return;
    }
    throw new UsageError('Usage: hnd lang <show|set ko|set en|auto>');
  }

  if (command === 'init') {
    assertOptions(options, ['env']);
    ensureNoExtra(positionals, 'hnd init [--cwd DIR] [--env LABEL]');
    await core.init();
    const resolved = await core.repo.resolve({ create: true });
    const requestedEnvironment = optionString(options, 'env');
    if (requestedEnvironment !== undefined) {
      await core.env.set(requestedEnvironment);
    } else if (resolved.environment === undefined || resolved.environment === null) {
      await core.env.set((await core.env.get()) ?? DEFAULT_ENVIRONMENT);
    }
    await refreshCursor({ force: true });
    if (jsonOutput) writeJson({ ...resolved, environment: await core.env.get() }, stdout);
    else writeText(stdout, `Initialized ${describeRepository(resolved)}.\nEnvironment: ${(await core.env.get()) ?? 'not selected'}`);
    return;
  }

  if (command === 'status') {
    assertOptions(options, []);
    ensureNoExtra(positionals, 'hnd status');
    const repository = await core.repo.resolve({ create: false });
    const environment = await core.env.get();
    const policies = await core.policy.list({});
    const handoffs = await core.handoff.list({ status: 'active' });
    const autoSave = await core.auto.get();
    const autoSync = await core.sync.get();
    const checkpoint = await core.auto.show();
    const [{ readAutoSyncPending }, { remoteSyncConfigured }] = await Promise.all([
      import('./sync/auto.mjs'),
      import('./remote-cli.mjs'),
    ]);
    const syncPending = await readAutoSyncPending({ env: runtimeEnv });
    const remoteConfigured = await remoteSyncConfigured(runtimeEnv);
    const value = {
      repository,
      environment,
      autoSave,
      autoSync,
      remoteConfigured,
      syncPending,
      checkpoint,
      policies,
      activeHandoffs: handoffs,
    };
    if (jsonOutput) writeJson(value, stdout);
    else writeText(
      stdout,
      `${ct('저장소')}: ${describeRepository(repository)}\n${ct('환경')}: ${environment ?? ct('선택 안 됨')}\n${ct('진행 자동 저장')}: ${autoSave ? ct('켜짐') : ct('꺼짐')}\n${ct('자동 동기화')}: ${autoSync ? ct('켜짐') : ct('꺼짐')}${!remoteConfigured && autoSync ? ` (${ct('PC를 연결한 뒤 시작')})` : ''}${syncPending ? ` (${syncPending.kind}: ${syncPending.reason})` : ''}\n${ct('HND 계정 연결')}: ${remoteConfigured ? ct('완료') : ct('안 됨')}\n${ct('진행 중 작업')}: ${handoffs.length}${remoteConfigured ? '' : `\n${ct('다음 단계')}: hnd sync status`}`,
    );
    return;
  }

  if (command === 'auto') {
    assertOptions(options, []);
    const subcommand = positionals.shift() ?? 'status';
    ensureNoExtra(positionals, 'hnd auto [status|on|off]');
    if (!['status', 'on', 'off'].includes(subcommand)) {
      throw new UsageError('Auto command must be status, on, or off.');
    }
    const result = subcommand === 'status'
      ? { enabled: await core.auto.get() }
      : await core.auto.set(subcommand === 'on');
    if (jsonOutput) writeJson(result, stdout);
    else writeText(stdout, `Automatic progress: ${result.enabled ? 'on' : 'off'}`);
    return;
  }

  if (command === 'repo') {
    const subcommand = positionals.shift();
    if (subcommand === 'list') {
      assertOptions(options, []);
      ensureNoExtra(positionals, 'hnd repo list');
      const result = await core.repo.list();
      writeJson(result, stdout);
      return;
    }
    if (subcommand === 'link') {
      assertOptions(options, ['force']);
      const repoId = requireValue(positionals.shift(), 'Repository ID');
      ensureNoExtra(positionals, 'hnd repo link REPOSITORY_ID');
      const result = await core.repo.link({
        repoId,
        cwd: invocationCwd,
        force: optionBoolean(options, 'force'),
      });
      await refreshCursor({ force: true });
      if (jsonOutput) writeJson(result, stdout);
      else writeText(stdout, `Linked this checkout to ${describeRepository(result)}.`);
      return;
    }
    if (subcommand === 'unlink') {
      assertOptions(options, []);
      ensureNoExtra(positionals, 'hnd repo unlink [--cwd DIR]');
      const result = await core.repo.unlink({ cwd: invocationCwd });
      if (jsonOutput) writeJson(result, stdout);
      else writeText(
        stdout,
        result.removed
          ? `Unlinked ${result.root} from repository ${result.repoId}.`
          : `No repository binding exists for ${result.root}.`,
      );
      return;
    }
    if (subcommand === 'register') {
      assertOptions(options, ['name']);
      ensureNoExtra(positionals, 'hnd repo register [--name NAME]');
      const result = await core.repo.register({ name: optionString(options, 'name') });
      await refreshCursor({ force: true });
      if (jsonOutput) writeJson(result, stdout);
      else writeText(stdout, `Registered a separate repository as ${describeRepository(result)}.`);
      return;
    }
    throw new UsageError('Repo command must be list, register, link, or unlink.');
  }

  if (command === 'env') {
    const subcommand = positionals.shift();
    assertOptions(options, []);
    if (subcommand === 'set') {
      const label = requireValue(positionals.shift(), 'Environment label');
      ensureNoExtra(positionals, 'hnd env set LABEL');
      const result = await core.env.set(label);
      await refreshCursor();
      if (jsonOutput) writeJson(result, stdout);
      else writeText(stdout, `Environment: ${result.environment}`);
      return;
    }
    if (subcommand === 'clear') {
      ensureNoExtra(positionals, 'hnd env clear');
      const result = await core.env.set(null);
      await refreshCursor();
      if (jsonOutput) writeJson(result, stdout);
      else writeText(stdout, 'Environment selection cleared.');
      return;
    }
    if (subcommand === 'show') {
      ensureNoExtra(positionals, 'hnd env show');
      const result = await core.env.get();
      if (jsonOutput) writeJson({ environment: result }, stdout);
      else writeText(stdout, result ?? 'No environment is selected.');
      return;
    }
    throw new UsageError('Env command must be set, show, or clear.');
  }

  if (command === 'policy') {
    const subcommand = positionals.shift();
    return handlePolicy({
      subcommand,
      rest: positionals,
      options,
      core,
      refreshCursor,
      stdin,
      stdout,
      env: runtimeEnv,
      jsonOutput,
    });
  }

  if (command === 'handoff') {
    const subcommand = positionals.shift();
    return handleHandoff({
      subcommand,
      rest: positionals,
      options,
      core,
      refreshCursor,
      stdout,
      jsonOutput,
    });
  }

  if (command === 'know') {
    const subcommand = positionals.shift();
    return handleKnowledge({
      subcommand,
      rest: positionals,
      options,
      core,
      refreshCursor,
      stdin,
      stdout,
      jsonOutput,
    });
  }

  if (command === 'context' || command === 'preview') {
    assertOptions(options, ['agent', 'include_stale', 'max_bytes', 'task', 'handoff_id']);
    ensureNoExtra(positionals, `hnd ${command}`);
    const requested = optionString(options, 'agent', command === 'preview' ? 'all' : undefined);
    const agents = requested === 'all'
      ? [...AGENTS]
      : requested === undefined
        ? []
        : selectAgents(requested, { allowAll: false });
    const result = await core.compose({
      includeStale: optionBoolean(options, 'include_stale'),
      maxBytes: parseMaxBytes(options),
      task: optionString(options, 'task'),
      handoffId: optionString(options, 'handoff_id'),
    });
    if (command === 'preview') {
      const targets = agents.map((agent) => {
        const content = agent === 'cursor'
          ? renderCursorRule(result.content)
          : renderHookOutput(agent, result.content);
        return {
          agent,
          transport: agent === 'cursor' ? 'cursor-rule' : 'session-start-hook',
          bytes: Buffer.byteLength(content),
          content,
        };
      });
      if (jsonOutput) writeJson({ context: result, targets }, stdout);
      else {
        for (const target of targets) {
          if (targets.length > 1) {
            writeText(stdout, `===== ${target.agent} / ${target.transport} (${target.bytes} bytes) =====`);
          }
          stdout.write(target.content);
        }
      }
    } else if (jsonOutput) {
      writeJson(result, stdout);
    } else {
      writeText(stdout, result.content);
    }
    return;
  }

  if (command === 'materialize') {
    assertOptions(options, ['dry_run']);
    ensureNoExtra(positionals, 'hnd materialize [--cwd DIR] [--dry-run]');
    const dryRun = optionBoolean(options, 'dry_run');
    const context = await core.compose({ createRepository: false });
    const result = await materializeCursor({
      cwd: invocationCwd,
      content: context.content,
      dryRun,
    });
    const summary = summarizeOperations(result.results);
    const output = {
      dryRun,
      repository: context.repository,
      bytes: context.bytes,
      path: result.paths.rule,
      operations: summary,
    };
    if (jsonOutput) writeJson(output, stdout);
    else if (summary.length === 0) writeText(stdout, `Cursor fallback is current: ${result.paths.rule}`);
    else {
      for (const item of summary) {
        const verb = item.changed ? (dryRun ? `would ${item.action}` : item.action) : 'unchanged';
        writeText(stdout, `${verb.padEnd(13)} ${item.path}`);
      }
    }
    return;
  }

  if (command === 'hook') {
    assertOptions(options, ['state_home']);
    const agent = requireValue(positionals.shift(), 'Agent');
    const phase = positionals.shift() ?? 'start';
    ensureNoExtra(positionals, 'hnd hook <claude|codex|cursor> [start|prompt|stop|end]');
    if (!AGENTS.includes(agent)) throw new UsageError(`Unknown agent: ${agent}`);
    if (!['start', 'prompt', 'stop', 'end'].includes(phase)) {
      throw new UsageError(`Unknown hook phase: ${phase}`);
    }
    const payload = await parseHookInput(stdin);
    const hookCwds = findHookCwds(
      payload,
      invocationCwd,
      agent === 'cursor' ? runtimeEnv.CURSOR_PROJECT_DIR : undefined,
    );
    if (!['start', 'prompt'].includes(phase)) {
      try {
        if (await core.auto.get()) {
          for (const hookCwd of hookCwds) {
            try {
              const hookCore = createCore({ env: runtimeEnv, cwd: hookCwd });
              await hookCore.auto.capture({ agent });
            } catch (error) {
              if (!optionalMaterializationErrors.has(error?.code)) {
                writeText(
                  stderr,
                  `hnd hook: automatic progress unavailable (${error.code || error.name || 'ERROR'}).`,
                );
              }
            }
          }
        }
      } catch (error) {
        writeText(
          stderr,
          `hnd hook: automatic progress unavailable (${error.code || error.name || 'ERROR'}).`,
        );
      }
      await runHookAutomaticSync({
        core,
        agent,
        phase,
        payload,
        env: runtimeEnv,
        stderr,
      });
      if (agent === 'cursor') {
        await refreshCursorHookRoots({ hookCwds, env: runtimeEnv, stderr });
      }
      // Stop hooks require valid JSON on stdout. SessionEnd output is advisory and can stay empty.
      if (phase === 'stop') stdout.write('{}\n');
      return;
    }
    await runHookAutomaticSync({
      core,
      agent,
      phase,
      payload,
      env: runtimeEnv,
      stderr,
    });
    const hookCwd = hookCwds[0];
    try {
      await ensureHookRepository({ cwd: hookCwd, env: runtimeEnv });
    } catch (error) {
      if (!optionalMaterializationErrors.has(error?.code)) {
        writeText(
          stderr,
          `hnd hook: automatic repository registration unavailable (${error.code || error.name || 'ERROR'}).`,
        );
      }
    }
    let composition = null;
    let content = '';
    let contextAvailable = false;
    let primaryError = null;
    try {
      const hookCore = createCore({ env: runtimeEnv, cwd: hookCwd });
      composition = await hookCore.compose({
        createRepository: false,
        fastRepository: true,
      });
      content = composition.content;
      contextAvailable = true;
    } catch (error) {
      primaryError = error;
      try {
        const hookCore = createCore({ env: runtimeEnv, cwd: hookCwd });
        composition = await hookCore.compose({ globalOnly: true, createRepository: false });
        content = composition.content;
        contextAvailable = true;
      } catch (fallbackError) {
        writeText(
          stderr,
          `hnd hook: context unavailable (${fallbackError.code || fallbackError.name || 'ERROR'}); run hnd doctor.`,
        );
      }
      if (contextAvailable) {
        writeText(
          stderr,
          `hnd hook: repository context unavailable (${primaryError.code || primaryError.name || 'ERROR'}); loaded global/device context only.`,
        );
      }
    }
    let delivery = null;
    if (contextAvailable) {
      try {
        delivery = await recordLiveContextDelivery({
          agent,
          payload,
          composition,
          env: runtimeEnv,
          force: phase === 'start',
        });
      } catch (error) {
        // Hash tracking is an optimization. If it is unavailable, prompt hooks
        // inject/materialize the current complete live snapshot fail-open.
        if (phase === 'prompt') {
          delivery = {
            changed: true,
            content: renderLiveContextSnapshot(composition),
            sessionKey: null,
          };
        }
        writeText(
          stderr,
          `hnd hook: live-context revision tracking unavailable (${error.code || error.name || 'ERROR'}).`,
        );
      }
    }
    if (agent === 'cursor' && contextAvailable && (phase === 'start' || delivery?.changed)) {
      await refreshCursorHookRoots({
        hookCwds,
        env: runtimeEnv,
        stderr,
        primaryCwd: hookCwd,
        primaryContent: phase === 'prompt' ? (delivery?.content ?? content) : content,
      });
    }
    if (phase === 'prompt') {
      if (agent === 'cursor') {
        stdout.write('{"continue":true}\n');
        return;
      }
      if (!delivery?.changed) {
        stdout.write('{}\n');
        return;
      }
      const eventName = 'UserPromptSubmit';
      const rendered = renderHookOutput(agent, delivery?.content ?? content, eventName);
      stdout.write(typeof rendered === 'string' ? rendered : JSON.stringify(rendered));
      return;
    }
    if (agent === 'cursor' && delivery?.sessionKey) {
      const rendered = hookOutputObject(agent, content);
      rendered.env = { [CURSOR_LIVE_CONTEXT_SESSION_ENV]: delivery.sessionKey };
      stdout.write(`${JSON.stringify(rendered)}\n`);
      return;
    }
    const rendered = renderHookOutput(agent, content);
    stdout.write(typeof rendered === 'string' ? rendered : JSON.stringify(rendered));
    return;
  }

  if (command === 'setup' || command === 'uninstall') {
    ensureNoExtra(positionals, `hnd ${command}`);
    return handleAdapters({
      action: command === 'setup' ? 'install' : 'uninstall',
      options,
      core,
      cwd: invocationCwd,
      env: runtimeEnv,
      stdout,
      jsonOutput,
      execPath,
      binPath,
    });
  }

  if (command === 'doctor') {
    assertOptions(options, ['agents']);
    ensureNoExtra(positionals, 'hnd doctor');
    const agents = selectAgents(options.agents);
    const adapters = await inspectAdapters({ agents, env: runtimeEnv, execPath, binPath, skillSource: defaultSkillSource });
    let repository = null;
    let context = null;
    let repositoryError = null;
    try {
      repository = await core.repo.resolve({ create: false });
      context = await core.compose({});
    } catch (error) {
      repositoryError = { code: error.code, message: error.message };
    }
    const result = {
      ok: !repositoryError && adapters.every((item) => item.ok !== false),
      repository,
      environment: await core.env.get(),
      context: context ? { bytes: context.bytes, warnings: context.warnings } : null,
      adapters,
      repositoryError,
    };
    if (jsonOutput) writeJson(result, stdout);
    else writeJson(result, stdout);
    return;
  }

  if (command === 'remote' || command === 'connect') {
    const subcommand = command === 'connect' ? 'connect' : positionals.shift() ?? 'status';
    if (subcommand === 'auto') {
      assertOptions(options, []);
      const action = positionals.shift() ?? 'status';
      ensureNoExtra(positionals, 'hnd sync auto [status|on|off]');
      if (!['status', 'on', 'off'].includes(action)) {
        throw new UsageError('Sync auto command must be status, on, or off.');
      }
      const setting = action === 'status'
        ? { enabled: await core.sync.get() }
        : await core.sync.set(action === 'on');
      const [{ readAutoSyncPending }, { remoteSyncConfigured }] = await Promise.all([
        import('./sync/auto.mjs'),
        import('./remote-cli.mjs'),
      ]);
      const output = {
        enabled: setting.enabled,
        configured: await remoteSyncConfigured(runtimeEnv),
        pending: await readAutoSyncPending({ env: runtimeEnv }),
      };
      if (jsonOutput) writeJson(output, stdout);
      else {
        const pending = output.pending
          ? `${output.pending.kind}: ${output.pending.reason}`
          : '없음';
        writeText(
          stdout,
          `자동 동기화: ${output.enabled ? '켜짐' : '꺼짐'}${!output.configured && output.enabled ? ' (PC를 연결한 뒤 시작)' : ''}\nHND 계정 연결: ${output.configured ? '완료' : '안 됨'}\n대기 작업: ${pending}${output.configured ? '' : '\n다음 단계: hnd sync status'}`,
        );
      }
      return;
    }
    const result = await handleRemote({
      subcommand,
      rest: positionals,
      options,
      env: runtimeEnv,
      cwd: invocationCwd,
      stdin,
      stdout,
      stderr,
      jsonOutput,
    });
    if (['enroll', 'join', 'connect'].includes(subcommand)) {
      await runMutationAutomaticSync({ core, env: runtimeEnv });
    }
    if (['pull', 'merge', 'restore', 'join', 'connect'].includes(subcommand)) await refreshCursorOnly();
    return result;
  }

  throw new UsageError(`Unknown command: ${command}\n\n${HELP}`);
}

function hookInvocation(argv) {
  try {
    const { positionals } = parseArgs(argv);
    const command = resolveAlias(positionals.shift(), commandAliases);
    if (command !== 'hook') return null;
    return {
      agent: positionals.shift() ?? 'unknown',
      phase: positionals.shift() ?? 'start',
    };
  } catch {
    return null;
  }
}

// Lifecycle integration must never make the host agent fail. Most hook work is
// already fail-open internally; this outer boundary also covers startup,
// localization, argument, stream, and unexpected platform errors. The next hook
// retries local capture/sync from the durable cache.
export async function main(argv = process.argv.slice(2), options = {}) {
  const hook = hookInvocation(argv);
  try {
    return await mainImpl(argv, options);
  } catch (error) {
    if (!hook) throw error;
    const stderr = options.stderr ?? process.stderr;
    writeText(
      stderr,
      `hnd hook: ${hook.agent}/${hook.phase} failed open (${error?.code || error?.name || 'ERROR'}): ${error?.message || String(error)}`,
    );
    return undefined;
  }
}
