import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from '../constants.mjs';
import { agentPaths, statePaths } from '../paths.mjs';
import {
  AdapterConfigError,
  AdapterConflictError,
  HND_CHECKPOINT_STATUS,
  HND_HOOK_STATUS,
  HND_RULE_REFRESH_STATUS,
  MANAGED_SKILL_MARKER,
  createHookCommands,
  isManagedSkill,
  makeRemoveOperation,
  makeWriteOperation,
  parseJsonDocument,
  quotePosixArgument,
  quoteWindowsArgument,
  readIfPresent,
  serializeJsonDocument,
} from './common.mjs';
import {
  CLAUDE_EVENT,
  CLAUDE_MATCHER,
  CLAUDE_PROMPT_EVENT,
  claudeAdapter,
  claudeHookOutputObject,
  createClaudeHook,
  formatClaudeHookOutput,
  inspectClaudeHook,
  installClaudeHook,
  isManagedClaudeHook,
  uninstallClaudeHook,
} from './claude.mjs';
import {
  CODEX_EVENT,
  CODEX_MATCHER,
  CODEX_PROMPT_EVENT,
  codexAdapter,
  codexHookOutputObject,
  createCodexHook,
  formatCodexHookOutput,
  inspectCodexHook,
  installCodexHook,
  isManagedCodexHook,
  uninstallCodexHook,
} from './codex.mjs';
import {
  CURSOR_EVENT,
  CURSOR_PROMPT_EVENT,
  createCursorHook,
  cursorAdapter,
  cursorHookOutputObject,
  formatCursorHookOutput,
  inspectCursorHook,
  installCursorHook,
  isManagedCursorHook,
  uninstallCursorHook,
} from './cursor.mjs';

export {
  AdapterConfigError,
  AdapterConflictError,
  CLAUDE_EVENT,
  CLAUDE_MATCHER,
  CLAUDE_PROMPT_EVENT,
  CODEX_EVENT,
  CODEX_MATCHER,
  CODEX_PROMPT_EVENT,
  CURSOR_EVENT,
  CURSOR_PROMPT_EVENT,
  HND_CHECKPOINT_STATUS,
  HND_HOOK_STATUS,
  HND_RULE_REFRESH_STATUS,
  MANAGED_SKILL_MARKER,
  claudeAdapter,
  claudeHookOutputObject,
  codexAdapter,
  codexHookOutputObject,
  createClaudeHook,
  createCodexHook,
  createCursorHook,
  createHookCommands,
  cursorAdapter,
  cursorHookOutputObject,
  formatClaudeHookOutput,
  formatCodexHookOutput,
  formatCursorHookOutput,
  inspectClaudeHook,
  inspectCodexHook,
  inspectCursorHook,
  installClaudeHook,
  installCodexHook,
  installCursorHook,
  isManagedClaudeHook,
  isManagedCodexHook,
  isManagedCursorHook,
  quotePosixArgument,
  quoteWindowsArgument,
  uninstallClaudeHook,
  uninstallCodexHook,
  uninstallCursorHook,
};

export const ADAPTERS = Object.freeze({
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
});

const DEFAULT_BIN_PATH = fileURLToPath(new URL('../../bin/hnd.mjs', import.meta.url));
const DEFAULT_SKILL_PATH = fileURLToPath(
  new URL('../../assets/hnd-handoff/SKILL.md', import.meta.url),
);

export function getAdapter(agent) {
  const adapter = ADAPTERS[agent];
  if (!adapter) throw new TypeError(`Unsupported agent: ${agent}`);
  return adapter;
}

function normalizeAgents(agents = AGENTS) {
  const values = typeof agents === 'string' ? agents.split(',') : [...agents];
  const normalized = values.map((value) => String(value).trim()).filter(Boolean);
  if (normalized.includes('all')) return [...AGENTS];
  for (const agent of normalized) getAdapter(agent);
  return [...new Set(normalized)];
}

function configPathFor(agent, paths) {
  return agent === 'claude' ? paths.claude.settings : paths[agent].hooks;
}

function resolvePortablePath(value) {
  const string = String(value);
  if (path.isAbsolute(string) || /^[a-z]:[\\/]/i.test(string) || /^\\\\/.test(string)) {
    return string;
  }
  return path.resolve(string);
}

function resolveRuntime(agent, options) {
  const paths = options.paths ?? agentPaths(options.env);
  const binPath = resolvePortablePath(options.binPath ?? DEFAULT_BIN_PATH);
  const commands = createHookCommands(agent, {
    execPath: options.execPath ?? process.execPath,
    binPath,
    platform: options.platform ?? process.platform,
    execPathWindows: options.execPathWindows,
    binPathWindows: options.binPathWindows === undefined
      ? undefined
      : resolvePortablePath(options.binPathWindows),
    stateHome: statePaths(options.env).home,
    stateHomeWindows: options.stateHomeWindows === undefined
      ? undefined
      : resolvePortablePath(options.stateHomeWindows),
  });
  return {
    adapter: getAdapter(agent),
    commands,
    configPath: configPathFor(agent, paths),
    skillPath: paths[agent].skill,
  };
}

async function loadSkillContent(options) {
  const readFile = options.readFile ?? fs.readFile;
  const content = options.skillContent
    ?? await readFile(options.skillSource ?? DEFAULT_SKILL_PATH, 'utf8');
  if (!isManagedSkill(content)) {
    throw new TypeError('The hnd handoff skill is missing its managed marker.');
  }
  return content;
}

function skillInstallOperation(agent, skillPath, current, desired) {
  if (current === desired) return undefined;
  if (current !== undefined && !isManagedSkill(current)) {
    throw new AdapterConflictError(
      agent,
      skillPath,
      'an unmanaged skill already uses the hnd-handoff name; move it before setup',
    );
  }
  return makeWriteOperation({
    path: skillPath,
    content: desired,
    previous: current,
    agent,
    component: 'skill',
    reason: current === undefined ? 'Install the hnd-handoff skill.' : 'Update the hnd-handoff skill.',
  });
}

export async function planAgentInstall(agent, options = {}) {
  const runtime = resolveRuntime(agent, options);
  const readFile = options.readFile ?? fs.readFile;
  const [currentConfig, currentSkill, desiredSkill] = await Promise.all([
    readIfPresent(runtime.configPath, { agent, readFile }),
    readIfPresent(runtime.skillPath, { agent, readFile }),
    loadSkillContent(options),
  ]);
  const document = parseJsonDocument(currentConfig, {
    agent,
    filePath: runtime.configPath,
  });
  const inspection = runtime.adapter.inspectHook(document.value, runtime);
  if (inspection.status === 'conflict') {
    throw new AdapterConflictError(agent, runtime.configPath, inspection.message);
  }
  const nextValue = inspection.status === 'ok'
    ? document.value
    : runtime.adapter.installHook(document.value, {
      commands: runtime.commands,
      filePath: runtime.configPath,
    });
  const nextConfig = serializeJsonDocument(nextValue, document.format);
  const operations = [];
  if (nextConfig !== currentConfig) {
    operations.push(makeWriteOperation({
      path: runtime.configPath,
      content: nextConfig,
      previous: currentConfig,
      agent,
      component: 'hook',
      reason: currentConfig === undefined
        ? 'Install the hnd session context and automatic checkpoint hooks.'
        : 'Merge the hnd session context and automatic checkpoint hooks into existing configuration.',
    }));
  }
  const skillOperation = skillInstallOperation(agent, runtime.skillPath, currentSkill, desiredSkill);
  if (skillOperation) operations.push(skillOperation);
  return operations;
}

export async function planInstall(options = {}) {
  const operations = [];
  for (const agent of normalizeAgents(options.agents)) {
    operations.push(...await planAgentInstall(agent, options));
  }
  return operations;
}

export async function planAgentUninstall(agent, options = {}) {
  const runtime = resolveRuntime(agent, options);
  const readFile = options.readFile ?? fs.readFile;
  const [currentConfig, currentSkill] = await Promise.all([
    readIfPresent(runtime.configPath, { agent, readFile }),
    readIfPresent(runtime.skillPath, { agent, readFile }),
  ]);
  const operations = [];

  if (currentConfig !== undefined) {
    const document = parseJsonDocument(currentConfig, {
      agent,
      filePath: runtime.configPath,
    });
    const nextValue = runtime.adapter.uninstallHook(document.value, {
      commands: runtime.commands,
      filePath: runtime.configPath,
    });
    const nextConfig = serializeJsonDocument(nextValue, document.format);
    if (nextConfig !== currentConfig) {
      operations.push(makeWriteOperation({
        path: runtime.configPath,
        content: nextConfig,
        previous: currentConfig,
        agent,
        component: 'hook',
        reason: 'Remove only the hnd session context and automatic checkpoint hooks.',
      }));
    }
  }

  if (isManagedSkill(currentSkill)) {
    operations.push(makeRemoveOperation({
      path: runtime.skillPath,
      previous: currentSkill,
      agent,
      component: 'skill',
      reason: 'Remove the hnd-managed handoff skill.',
    }));
  }
  return operations;
}

export async function planUninstall(options = {}) {
  const operations = [];
  for (const agent of normalizeAgents(options.agents)) {
    operations.push(...await planAgentUninstall(agent, options));
  }
  return operations;
}

export async function previewAgent(agent, { action = 'install', ...options } = {}) {
  if (!['install', 'uninstall'].includes(action)) {
    throw new TypeError(`Unsupported preview action: ${action}`);
  }
  const operations = action === 'uninstall'
    ? await planAgentUninstall(agent, options)
    : await planAgentInstall(agent, options);
  return operations.map((operation) => ({
    agent: operation.agent,
    component: operation.component,
    action: operation.kind,
    path: operation.path,
    reason: operation.reason,
    before: operation.previous ?? null,
    after: operation.kind === 'write' ? operation.content : null,
  }));
}

export async function previewAdapters({ action = 'install', ...options } = {}) {
  const previews = [];
  for (const agent of normalizeAgents(options.agents)) {
    previews.push(...await previewAgent(agent, { ...options, action }));
  }
  return previews;
}

function diagnostic(agent, component, filePath, result) {
  return {
    agent,
    component,
    path: filePath,
    ...result,
  };
}

export async function doctorAgent(agent, options = {}) {
  const runtime = resolveRuntime(agent, options);
  const readFile = options.readFile ?? fs.readFile;
  const [currentConfig, currentSkill, desiredSkill] = await Promise.all([
    readIfPresent(runtime.configPath, { agent, readFile }),
    readIfPresent(runtime.skillPath, { agent, readFile }),
    loadSkillContent(options),
  ]);
  const checks = [];

  if (currentConfig === undefined) {
    checks.push(diagnostic(agent, 'hook', runtime.configPath, {
      status: 'missing',
      level: 'warning',
      message: 'The agent hooks configuration does not exist.',
    }));
  } else {
    try {
      const document = parseJsonDocument(currentConfig, {
        agent,
        filePath: runtime.configPath,
      });
      // Exercise the merge validation too; inspectHook intentionally focuses on
      // the managed entry and may otherwise overlook a malformed user group.
      runtime.adapter.installHook(document.value, {
        commands: runtime.commands,
        filePath: runtime.configPath,
      });
      checks.push(diagnostic(
        agent,
        'hook',
        runtime.configPath,
        runtime.adapter.inspectHook(document.value, runtime),
      ));
    } catch (error) {
      if (!(error instanceof AdapterConfigError)) throw error;
      checks.push(diagnostic(agent, 'hook', runtime.configPath, {
        status: 'invalid',
        level: 'error',
        message: error.message,
      }));
    }
  }

  let skillResult;
  if (currentSkill === undefined) {
    skillResult = {
      status: 'missing',
      level: 'warning',
      message: 'The hnd-handoff skill is not installed.',
    };
  } else if (!isManagedSkill(currentSkill)) {
    skillResult = {
      status: 'conflict',
      level: 'error',
      message: 'An unmanaged skill occupies the hnd-handoff path.',
    };
  } else if (currentSkill !== desiredSkill) {
    skillResult = {
      status: 'outdated',
      level: 'warning',
      message: 'The hnd-handoff skill differs from the packaged version.',
    };
  } else {
    skillResult = {
      status: 'ok',
      level: 'ok',
      message: 'The hnd-handoff skill is installed.',
    };
  }
  checks.push(diagnostic(agent, 'skill', runtime.skillPath, skillResult));
  return checks;
}

export async function doctorAdapters(options = {}) {
  const checks = [];
  for (const agent of normalizeAgents(options.agents)) {
    checks.push(...await doctorAgent(agent, options));
  }
  return {
    ok: checks.every((check) => check.status === 'ok'),
    checks,
  };
}

export function hookOutputObject(agent, context, eventName) {
  return getAdapter(agent).hookOutputObject(context, eventName);
}

export function formatHookOutput(agent, context, eventName) {
  return getAdapter(agent).formatHookOutput(context, eventName);
}

// Stable facade used by the CLI. Keeping the action in one entry point makes
// setup, uninstall, and dry-run consume the exact same operation planner.
export async function buildAdapterOperations({ action = 'install', ...options } = {}) {
  if (action === 'install' || action === 'setup') return planInstall(options);
  if (action === 'uninstall' || action === 'remove') return planUninstall(options);
  throw new TypeError(`Unsupported adapter action: ${action}`);
}

export async function inspectAdapters(options = {}) {
  const results = [];
  for (const agent of normalizeAgents(options.agents)) {
    const checks = await doctorAgent(agent, options);
    results.push({
      agent,
      ok: checks.every((check) => check.status === 'ok'),
      checks,
    });
  }
  return results;
}

export const renderHookOutput = formatHookOutput;

// Short aliases for CLI wiring.
export const install = planInstall;
export const uninstall = planUninstall;
export const preview = previewAdapters;
export const doctor = doctorAdapters;
