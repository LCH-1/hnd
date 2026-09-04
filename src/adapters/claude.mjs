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

export const CLAUDE_EVENT = 'SessionStart';
export const CLAUDE_MATCHER = 'startup|resume|clear|compact|fork';
export const CLAUDE_PROMPT_EVENT = 'UserPromptSubmit';
export const CLAUDE_STOP_EVENT = 'Stop';
export const CLAUDE_END_EVENT = 'SessionEnd';
export const CLAUDE_PRECOMPACT_EVENT = 'PreCompact';

export function createClaudeHook(commands) {
  return {
    type: 'command',
    command: commands.start.host,
    timeout: 5,
    statusMessage: HND_HOOK_STATUS,
  };
}

export function createClaudePromptHook(commands) {
  return {
    type: 'command',
    command: commands.prompt.host,
    timeout: 2,
    statusMessage: HND_RULE_REFRESH_STATUS,
  };
}

export function createClaudeCheckpointHook(commands, phase) {
  if (!['stop', 'end', 'precompact'].includes(phase)) throw new TypeError(`Unsupported hook phase: ${phase}`);
  return {
    type: 'command',
    command: commands[phase].host,
    timeout: 5,
    statusMessage: HND_CHECKPOINT_STATUS,
  };
}

export function isManagedClaudeHook(handler, commands, phase = 'start') {
  const expected = commands[phase].host;
  const marker = phase === 'start'
    ? HND_HOOK_STATUS
    : phase === 'prompt' ? HND_RULE_REFRESH_STATUS : HND_CHECKPOINT_STATUS;
  return isPlainObject(handler)
    && handler.type === 'command'
    && (
      handler.command === expected
      || (
        handler.statusMessage === marker
        && isHndHookCommand(handler.command, 'claude', phase)
      )
    );
}

function installEvent(config, { commands, filePath, eventName, phase, matcher }) {
  const handler = phase === 'start'
    ? createClaudeHook(commands)
    : phase === 'prompt'
      ? createClaudePromptHook(commands)
      : createClaudeCheckpointHook(commands, phase);
  const group = { hooks: [handler] };
  if (matcher !== undefined) group.matcher = matcher;
  return installNestedHandler(config, {
    agent: 'claude',
    filePath,
    eventName,
    isManaged: (candidate) => isManagedClaudeHook(candidate, commands, phase),
    group,
  }).value;
}

export function installClaudeHook(config, { commands, filePath = '<memory>' }) {
  let output = installEvent(config, {
    commands,
    filePath,
    eventName: CLAUDE_EVENT,
    phase: 'start',
    matcher: CLAUDE_MATCHER,
  });
  output = installEvent(output, {
    commands,
    filePath,
    eventName: CLAUDE_PROMPT_EVENT,
    phase: 'prompt',
  });
  output = installEvent(output, {
    commands,
    filePath,
    eventName: CLAUDE_STOP_EVENT,
    phase: 'stop',
  });
  output = installEvent(output, {
    commands,
    filePath,
    eventName: CLAUDE_PRECOMPACT_EVENT,
    phase: 'precompact',
  });
  return installEvent(output, {
    commands,
    filePath,
    eventName: CLAUDE_END_EVENT,
    phase: 'end',
  });
}

export function uninstallClaudeHook(config, { commands, filePath = '<memory>' }) {
  let output = config;
  for (const [eventName, phase] of [
    [CLAUDE_EVENT, 'start'],
    [CLAUDE_PROMPT_EVENT, 'prompt'],
    [CLAUDE_STOP_EVENT, 'stop'],
    [CLAUDE_PRECOMPACT_EVENT, 'precompact'],
    [CLAUDE_END_EVENT, 'end'],
  ]) {
    output = stripNestedHandler(output, {
      agent: 'claude',
      filePath,
      eventName,
      isManaged: (candidate) => isManagedClaudeHook(candidate, commands, phase),
    }).value;
  }
  return output;
}

function inspectEvent(config, { commands, eventName, phase, matcher }) {
  const expected = phase === 'start'
    ? createClaudeHook(commands)
    : phase === 'prompt'
      ? createClaudePromptHook(commands)
      : createClaudeCheckpointHook(commands, phase);
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
      if (isManagedClaudeHook(handler, commands, phase)) matches.push({ group, handler });
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

export function inspectClaudeHook(config, { commands }) {
  const checks = [
    inspectEvent(config, {
      commands,
      eventName: CLAUDE_EVENT,
      phase: 'start',
      matcher: CLAUDE_MATCHER,
    }),
    inspectEvent(config, { commands, eventName: CLAUDE_PROMPT_EVENT, phase: 'prompt' }),
    inspectEvent(config, { commands, eventName: CLAUDE_STOP_EVENT, phase: 'stop' }),
    inspectEvent(config, { commands, eventName: CLAUDE_PRECOMPACT_EVENT, phase: 'precompact' }),
    inspectEvent(config, { commands, eventName: CLAUDE_END_EVENT, phase: 'end' }),
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

export function claudeHookOutputObject(context, eventName = CLAUDE_EVENT) {
  if (typeof context !== 'string') throw new TypeError('Hook context must be a string.');
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

export function formatClaudeHookOutput(context, eventName = CLAUDE_EVENT) {
  return `${JSON.stringify(claudeHookOutputObject(context, eventName))}\n`;
}

export const claudeAdapter = Object.freeze({
  agent: 'claude',
  eventName: CLAUDE_EVENT,
  eventNames: Object.freeze([
    CLAUDE_EVENT,
    CLAUDE_PROMPT_EVENT,
    CLAUDE_STOP_EVENT,
    CLAUDE_PRECOMPACT_EVENT,
    CLAUDE_END_EVENT,
  ]),
  installHook: installClaudeHook,
  uninstallHook: uninstallClaudeHook,
  inspectHook: inspectClaudeHook,
  formatHookOutput: formatClaudeHookOutput,
  hookOutputObject: claudeHookOutputObject,
});
