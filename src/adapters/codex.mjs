import {
  HND_CHECKPOINT_STATUS,
  HND_HOOK_STATUS,
  HND_RULE_REFRESH_STATUS,
  collectNestedHandlers,
  installNestedHandler,
  isHndHookCommand,
  isPlainObject,
  jsonEquals,
  stripNestedHandler,
} from './common.mjs';

export const CODEX_EVENT = 'SessionStart';
export const CODEX_MATCHER = 'startup|resume|clear|compact';
export const CODEX_PROMPT_EVENT = 'UserPromptSubmit';
export const CODEX_STOP_EVENT = 'Stop';
export const CODEX_END_EVENT = 'SessionEnd';

export function createCodexHook(commands) {
  return {
    type: 'command',
    // Keep `command` executable on the current host as well as providing the
    // Codex-specific Windows override. This remains compatible with current
    // Codex releases and also fails safely on releases that ignore
    // `commandWindows`.
    command: commands.start.host,
    commandWindows: commands.start.windows,
    timeout: 10,
    statusMessage: HND_HOOK_STATUS,
    // hnd enforces its own 32 KiB composition cap.
    additionalContextLimit: 0,
  };
}

export function createCodexPromptHook(commands) {
  return {
    type: 'command',
    command: commands.prompt.host,
    commandWindows: commands.prompt.windows,
    timeout: 5,
    statusMessage: HND_RULE_REFRESH_STATUS,
    additionalContextLimit: 0,
  };
}

export function createCodexCheckpointHook(commands, phase) {
  if (!['stop', 'end'].includes(phase)) throw new TypeError(`Unsupported hook phase: ${phase}`);
  return {
    type: 'command',
    command: commands[phase].host,
    commandWindows: commands[phase].windows,
    timeout: phase === 'end' ? 3 : 10,
    statusMessage: HND_CHECKPOINT_STATUS,
  };
}

export function isManagedCodexHook(handler, commands, phase = 'start') {
  if (!isPlainObject(handler) || handler.type !== 'command') return false;
  const expected = commands[phase];
  const exactPosix = handler.command === expected.posix;
  const exactWindows = handler.commandWindows === expected.windows;
  const marker = phase === 'start'
    ? HND_HOOK_STATUS
    : phase === 'prompt' ? HND_RULE_REFRESH_STATUS : HND_CHECKPOINT_STATUS;
  const labeledLegacy = handler.statusMessage === marker && (
    isHndHookCommand(handler.command, 'codex', phase)
    || isHndHookCommand(handler.commandWindows, 'codex', phase)
  );
  return exactPosix || exactWindows || labeledLegacy;
}

function installEvent(config, { commands, filePath, eventName, phase, matcher }) {
  const handler = phase === 'start'
    ? createCodexHook(commands)
    : phase === 'prompt'
      ? createCodexPromptHook(commands)
      : createCodexCheckpointHook(commands, phase);
  const group = { hooks: [handler] };
  if (matcher !== undefined) group.matcher = matcher;
  return installNestedHandler(config, {
    agent: 'codex',
    filePath,
    eventName,
    isManaged: (candidate) => isManagedCodexHook(candidate, commands, phase),
    group,
  }).value;
}

export function installCodexHook(config, { commands, filePath = '<memory>' }) {
  let output = installEvent(config, {
    commands,
    filePath,
    eventName: CODEX_EVENT,
    phase: 'start',
    matcher: CODEX_MATCHER,
  });
  output = installEvent(output, {
    commands,
    filePath,
    eventName: CODEX_PROMPT_EVENT,
    phase: 'prompt',
  });
  output = installEvent(output, {
    commands,
    filePath,
    eventName: CODEX_STOP_EVENT,
    phase: 'stop',
  });
  return installEvent(output, {
    commands,
    filePath,
    eventName: CODEX_END_EVENT,
    phase: 'end',
  });
}

export function uninstallCodexHook(config, { commands, filePath = '<memory>' }) {
  let output = config;
  for (const [eventName, phase] of [
    [CODEX_EVENT, 'start'],
    [CODEX_PROMPT_EVENT, 'prompt'],
    [CODEX_STOP_EVENT, 'stop'],
    [CODEX_END_EVENT, 'end'],
  ]) {
    output = stripNestedHandler(output, {
      agent: 'codex',
      filePath,
      eventName,
      isManaged: (candidate) => isManagedCodexHook(candidate, commands, phase),
    }).value;
  }
  return output;
}

function inspectEvent(config, { commands, eventName, phase, matcher }) {
  const expected = phase === 'start'
    ? createCodexHook(commands)
    : phase === 'prompt'
      ? createCodexPromptHook(commands)
      : createCodexCheckpointHook(commands, phase);
  const marker = phase === 'start'
    ? HND_HOOK_STATUS
    : phase === 'prompt' ? HND_RULE_REFRESH_STATUS : HND_CHECKPOINT_STATUS;
  const groups = isPlainObject(config?.hooks) && Array.isArray(config.hooks[eventName])
    ? config.hooks[eventName]
    : [];
  const matches = [];
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
    for (const handler of group.hooks) {
      if (isManagedCodexHook(handler, commands, phase)) matches.push({ group, handler });
    }
  }
  const conflictingMarker = matches.length === 0
    && collectNestedHandlers(config, eventName).some((handler) => (
      isPlainObject(handler) && handler.statusMessage === marker
    ));
  if (conflictingMarker) return { status: 'conflict', eventName };
  if (matches.length === 0) return { status: 'missing', eventName };
  if (matches.length !== 1) return { status: 'duplicate', eventName, count: matches.length };
  const [match] = matches;
  const matcherMatches = matcher === undefined
    ? match.group.matcher === undefined
    : match.group.matcher === matcher;
  if (!matcherMatches || !jsonEquals(match.handler, expected)) {
    return { status: 'outdated', eventName };
  }
  return { status: 'ok', eventName };
}

export function inspectCodexHook(config, { commands }) {
  const checks = [
    inspectEvent(config, {
      commands,
      eventName: CODEX_EVENT,
      phase: 'start',
      matcher: CODEX_MATCHER,
    }),
    inspectEvent(config, { commands, eventName: CODEX_PROMPT_EVENT, phase: 'prompt' }),
    inspectEvent(config, { commands, eventName: CODEX_STOP_EVENT, phase: 'stop' }),
    inspectEvent(config, { commands, eventName: CODEX_END_EVENT, phase: 'end' }),
  ];
  const failed = checks.find((check) => check.status !== 'ok');
  if (!failed) {
    return { status: 'ok', level: 'ok', message: 'The hnd session hooks are installed.' };
  }
  const level = ['conflict', 'duplicate'].includes(failed.status) ? 'error' : 'warning';
  const message = failed.status === 'conflict'
    ? `An hnd-labeled ${failed.eventName} hook has an unexpected command.`
    : failed.status === 'duplicate'
      ? `Found ${failed.count} hnd ${failed.eventName} hooks; setup will consolidate them.`
      : `The hnd ${failed.eventName} hook is ${failed.status}.`;
  return { status: failed.status, level, message };
}

export function codexHookOutputObject(context, eventName = CODEX_EVENT) {
  if (typeof context !== 'string') throw new TypeError('Hook context must be a string.');
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

export function formatCodexHookOutput(context, eventName = CODEX_EVENT) {
  return `${JSON.stringify(codexHookOutputObject(context, eventName))}\n`;
}

export const codexAdapter = Object.freeze({
  agent: 'codex',
  eventName: CODEX_EVENT,
  eventNames: Object.freeze([
    CODEX_EVENT,
    CODEX_PROMPT_EVENT,
    CODEX_STOP_EVENT,
    CODEX_END_EVENT,
  ]),
  installHook: installCodexHook,
  uninstallHook: uninstallCodexHook,
  inspectHook: inspectCodexHook,
  formatHookOutput: formatCodexHookOutput,
  hookOutputObject: codexHookOutputObject,
});
