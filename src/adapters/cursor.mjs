import {
  AdapterConfigError,
  cloneJson,
  isHndHookCommand,
  isPlainObject,
  jsonEquals,
} from './common.mjs';

export const CURSOR_EVENT = 'sessionStart';
export const CURSOR_PROMPT_EVENT = 'beforeSubmitPrompt';
export const CURSOR_STOP_EVENT = 'stop';
export const CURSOR_END_EVENT = 'sessionEnd';

export function createCursorHook(commands, phase = 'start') {
  return {
    type: 'command',
    command: commands[phase].host,
  };
}

export function isManagedCursorHook(handler, commands, phase = 'start') {
  return isPlainObject(handler)
    && (handler.type === undefined || handler.type === 'command')
    && (
      handler.command === commands[phase].host
      || isHndHookCommand(handler.command, 'cursor', phase)
    );
}

function cursorHookArray(config, eventName, { filePath, create }) {
  if (config.version !== undefined && config.version !== 1) {
    throw new AdapterConfigError('cursor', filePath, 'only hooks schema version 1 is supported');
  }
  if (config.hooks === undefined) {
    if (!create) return undefined;
    config.hooks = {};
  }
  if (!isPlainObject(config.hooks)) {
    throw new AdapterConfigError('cursor', filePath, '"hooks" must be a JSON object');
  }
  if (config.hooks[eventName] === undefined) {
    if (!create) return undefined;
    config.hooks[eventName] = [];
  }
  if (!Array.isArray(config.hooks[eventName])) {
    throw new AdapterConfigError('cursor', filePath, `"hooks.${eventName}" must be an array`);
  }
  if (config.hooks[eventName].some((handler) => !isPlainObject(handler))) {
    throw new AdapterConfigError(
      'cursor',
      filePath,
      `every hooks.${eventName} entry must be a JSON object`,
    );
  }
  return config.hooks[eventName];
}

export function installCursorHook(config, { commands, filePath = '<memory>' }) {
  const output = cloneJson(config);
  if (output.version === undefined) output.version = 1;
  for (const [eventName, phase] of [
    [CURSOR_EVENT, 'start'],
    [CURSOR_PROMPT_EVENT, 'prompt'],
    [CURSOR_STOP_EVENT, 'stop'],
    [CURSOR_END_EVENT, 'end'],
  ]) {
    const hooks = cursorHookArray(output, eventName, { filePath, create: true });
    const kept = hooks.filter((handler) => !isManagedCursorHook(handler, commands, phase));
    kept.push(createCursorHook(commands, phase));
    output.hooks[eventName] = kept;
  }
  return output;
}

export function uninstallCursorHook(config, { commands, filePath = '<memory>' }) {
  const output = cloneJson(config);
  for (const [eventName, phase] of [
    [CURSOR_EVENT, 'start'],
    [CURSOR_PROMPT_EVENT, 'prompt'],
    [CURSOR_STOP_EVENT, 'stop'],
    [CURSOR_END_EVENT, 'end'],
  ]) {
    const hooks = cursorHookArray(output, eventName, { filePath, create: false });
    if (!hooks) continue;
    output.hooks[eventName] = hooks.filter(
      (handler) => !isManagedCursorHook(handler, commands, phase),
    );
    if (output.hooks[eventName].length === 0) delete output.hooks[eventName];
  }
  if (isPlainObject(output.hooks) && Object.keys(output.hooks).length === 0) delete output.hooks;
  return output;
}

function inspectEvent(config, { commands, eventName, phase }) {
  const hooks = isPlainObject(config?.hooks) && Array.isArray(config.hooks[eventName])
    ? config.hooks[eventName]
    : [];
  const matches = hooks.filter((handler) => isManagedCursorHook(handler, commands, phase));
  if (matches.length === 0) return { status: 'missing', eventName };
  if (matches.length !== 1) return { status: 'duplicate', eventName, count: matches.length };
  if (!jsonEquals(matches[0], createCursorHook(commands, phase))) {
    return { status: 'outdated', eventName };
  }
  return { status: 'ok', eventName };
}

export function inspectCursorHook(config, { commands }) {
  if (config?.version !== undefined && config.version !== 1) {
    return {
      status: 'invalid',
      level: 'error',
      message: `Unsupported Cursor hooks schema version: ${config.version}`,
    };
  }
  const checks = [
    inspectEvent(config, { commands, eventName: CURSOR_EVENT, phase: 'start' }),
    inspectEvent(config, { commands, eventName: CURSOR_PROMPT_EVENT, phase: 'prompt' }),
    inspectEvent(config, { commands, eventName: CURSOR_STOP_EVENT, phase: 'stop' }),
    inspectEvent(config, { commands, eventName: CURSOR_END_EVENT, phase: 'end' }),
  ];
  const failed = checks.find((check) => check.status !== 'ok');
  if (!failed) {
    return { status: 'ok', level: 'ok', message: 'The hnd session hooks are installed.' };
  }
  const level = failed.status === 'duplicate' ? 'error' : 'warning';
  const message = failed.status === 'duplicate'
    ? `Found ${failed.count} hnd ${failed.eventName} hooks; setup will consolidate them.`
    : `The hnd ${failed.eventName} hook is ${failed.status}.`;
  return { status: failed.status, level, message };
}

export function cursorHookOutputObject(context) {
  if (typeof context !== 'string') throw new TypeError('Hook context must be a string.');
  return { additional_context: context };
}

export function formatCursorHookOutput(context) {
  return `${JSON.stringify(cursorHookOutputObject(context))}\n`;
}

export const cursorAdapter = Object.freeze({
  agent: 'cursor',
  eventName: CURSOR_EVENT,
  eventNames: Object.freeze([
    CURSOR_EVENT,
    CURSOR_PROMPT_EVENT,
    CURSOR_STOP_EVENT,
    CURSOR_END_EVENT,
  ]),
  installHook: installCursorHook,
  uninstallHook: uninstallCursorHook,
  inspectHook: inspectCursorHook,
  formatHookOutput: formatCursorHookOutput,
  hookOutputObject: cursorHookOutputObject,
});
