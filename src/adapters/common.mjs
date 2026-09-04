import fs from 'node:fs/promises';

export const HND_HOOK_STATUS = 'hnd: loading policy and active handoff';
export const HND_RULE_REFRESH_STATUS = 'hnd: checking for updated rules';
export const HND_CHECKPOINT_STATUS = 'hnd: saving automatic progress';
export const MANAGED_SKILL_MARKER = '<!-- hnd-managed-skill: hnd-handoff -->';

export class AdapterConfigError extends Error {
  constructor(agent, filePath, message, options = {}) {
    super(`${agent} configuration at ${filePath}: ${message}`, options);
    this.name = 'AdapterConfigError';
    this.code = 'ADAPTER_CONFIG_ERROR';
    this.agent = agent;
    this.path = filePath;
  }
}

export class AdapterConflictError extends Error {
  constructor(agent, filePath, message) {
    super(`${agent} configuration conflict at ${filePath}: ${message}`);
    this.name = 'AdapterConflictError';
    this.code = 'ADAPTER_CONFLICT';
    this.agent = agent;
    this.path = filePath;
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function cloneJson(value) {
  return structuredClone(value);
}

export function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeCommandValue(value, label) {
  const string = String(value);
  if (string.length === 0) throw new TypeError(`${label} must not be empty.`);
  if (string.includes('\0') || string.includes('\r') || string.includes('\n')) {
    throw new TypeError(`${label} must not contain NUL or newlines.`);
  }
  return string;
}

export function quotePosixArgument(value) {
  const string = safeCommandValue(value, 'POSIX command argument');
  return `'${string.replaceAll("'", `'"'"'`)}'`;
}

// This follows the CommandLineToArgvW quoting rules used by Node on Windows.
// File names cannot contain a double quote, but handling it here also keeps this
// helper safe for non-path arguments.
export function quoteWindowsArgument(value) {
  const string = safeCommandValue(value, 'Windows command argument');
  let quoted = '"';
  let backslashes = 0;
  for (const character of string) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat((backslashes * 2) + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes);
    quoted += character;
    backslashes = 0;
  }
  quoted += '\\'.repeat(backslashes * 2);
  return `${quoted}"`;
}

export function createHookCommands(agent, {
  execPath = process.execPath,
  binPath,
  platform = process.platform,
  execPathWindows = execPath,
  binPathWindows = binPath,
  stateHome,
  stateHomeWindows = stateHome,
} = {}) {
  if (!['claude', 'codex', 'cursor'].includes(agent)) {
    throw new TypeError(`Unsupported agent: ${agent}`);
  }
  if (!binPath) throw new TypeError('binPath is required.');

  const make = (phase) => {
    const posixArguments = [execPath, binPath];
    const codexWindowsPathLookup = platform === 'win32' && agent === 'codex';
    const windowsArguments = [
      codexWindowsPathLookup ? 'node' : execPathWindows,
      binPathWindows,
    ];
    if (stateHome !== undefined) posixArguments.push('--state-home', stateHome);
    if (stateHomeWindows !== undefined) windowsArguments.push('--state-home', stateHomeWindows);
    posixArguments.push('hook', agent);
    windowsArguments.push('hook', agent);
    // Keep the original SessionStart command stable for installed-version compatibility.
    if (phase !== 'start') {
      posixArguments.push(phase);
      windowsArguments.push(phase);
    }
    const posix = posixArguments.map(quotePosixArgument).join(' ');
    // Codex wraps the complete Windows hook command in another pair of quotes
    // before handing it to cmd.exe. Starting that command with a quoted path
    // such as "C:\Program Files\nodejs\node.exe" can consequently be parsed as
    // the executable `"C:\Program`. Resolve Node through PATH for Codex and keep
    // its first token unquoted; every path-bearing argument remains quoted.
    const windows = windowsArguments.map((argument, index) => (
      codexWindowsPathLookup && index === 0
        ? argument
        : quoteWindowsArgument(argument)
    )).join(' ');
    return Object.freeze({
      posix,
      windows,
      host: platform === 'win32' ? windows : posix,
    });
  };
  const start = make('start');
  const prompt = make('prompt');
  const stop = make('stop');
  const end = make('end');
  return Object.freeze({
    ...start,
    start,
    prompt,
    stop,
    end,
  });
}

export function isHndHookCommand(command, agent, phase) {
  if (typeof command !== 'string' || !['claude', 'codex', 'cursor'].includes(agent)) {
    return false;
  }
  const phases = phase === undefined ? ['start', 'prompt', 'stop', 'end'] : [phase];
  const suffixes = phases.flatMap((value) => {
    if (value === 'start') return [`'hook' '${agent}'`, `"hook" "${agent}"`];
    return [
      `'hook' '${agent}' '${value}'`,
      `"hook" "${agent}" "${value}"`,
    ];
  });
  // npm installs call bin/hnd.mjs directly. Standalone installers from the
  // pre-npm distribution called hnd/launcher.mjs (POSIX) or
  // hnd/connector/launcher.mjs (Windows). Recognize both managed layouts so a
  // later `hnd setup` replaces stale launcher hooks instead of duplicating
  // every session event.
  const managedEntry = /(?:^|[\\/])(?:hnd\.mjs|hnd(?:[\\/]connector)?[\\/]launcher\.mjs)(?:'|")?\s/i;
  return managedEntry.test(command)
    && suffixes.some((suffix) => command.endsWith(suffix));
}

function detectJsonFormat(content) {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? content.slice(1) : content;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const multiline = /\r?\n/.test(body);
  const indentMatch = body.match(/\r?\n([ \t]+)["}]/);
  const indent = multiline ? (indentMatch?.[1] ?? '  ') : null;
  const trailingNewline = /(?:\r\n|\n)$/.test(body);
  return { bom, eol, indent, trailingNewline };
}

export function parseJsonDocument(content, { agent, filePath }) {
  if (content === undefined) {
    return {
      value: {},
      format: { bom: '', eol: '\n', indent: '  ', trailingNewline: true },
      exists: false,
    };
  }

  const format = detectJsonFormat(content);
  const body = format.bom ? content.slice(1) : content;
  let value;
  try {
    value = JSON.parse(body);
  } catch (cause) {
    throw new AdapterConfigError(agent, filePath, 'invalid JSON; refusing to overwrite it', { cause });
  }
  if (!isPlainObject(value)) {
    throw new AdapterConfigError(agent, filePath, 'the document root must be a JSON object');
  }
  return { value, format, exists: true };
}

export function serializeJsonDocument(value, format) {
  let body = JSON.stringify(value, null, format.indent);
  if (format.eol !== '\n') body = body.replaceAll('\n', format.eol);
  if (format.trailingNewline) body += format.eol;
  return `${format.bom}${body}`;
}

export async function readIfPresent(filePath, readFile = fs.readFile) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function makeWriteOperation({
  path,
  content,
  previous,
  agent,
  component,
  reason,
}) {
  return {
    kind: 'write',
    path,
    content,
    previous,
    mode: 0o600,
    agent,
    component,
    reason,
  };
}

export function makeRemoveOperation({ path, previous, agent, component, reason }) {
  return {
    kind: 'remove',
    path,
    previous,
    agent,
    component,
    reason,
  };
}

export function isManagedSkill(content) {
  return typeof content === 'string' && content.includes(MANAGED_SKILL_MARKER);
}

export function removeEmptyHookContainers(config, eventName) {
  if (!isPlainObject(config.hooks)) return config;
  if (Array.isArray(config.hooks[eventName]) && config.hooks[eventName].length === 0) {
    delete config.hooks[eventName];
  }
  if (Object.keys(config.hooks).length === 0) delete config.hooks;
  return config;
}

export function stripNestedHandler(config, {
  agent,
  filePath,
  eventName,
  isManaged,
}) {
  const output = cloneJson(config);
  if (output.hooks === undefined) return { value: output, removed: 0 };
  if (!isPlainObject(output.hooks)) {
    throw new AdapterConfigError(agent, filePath, '"hooks" must be a JSON object');
  }
  const groups = output.hooks[eventName];
  if (groups === undefined) return { value: output, removed: 0 };
  if (!Array.isArray(groups)) {
    throw new AdapterConfigError(agent, filePath, `"hooks.${eventName}" must be an array`);
  }

  let removed = 0;
  output.hooks[eventName] = groups.flatMap((group) => {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
      throw new AdapterConfigError(
        agent,
        filePath,
        `every hooks.${eventName} entry must contain a "hooks" array`,
      );
    }
    if (group.hooks.some((handler) => !isPlainObject(handler))) {
      throw new AdapterConfigError(
        agent,
        filePath,
        `every hooks.${eventName} handler must be a JSON object`,
      );
    }
    const kept = group.hooks.filter((handler) => {
      if (!isManaged(handler)) return true;
      removed += 1;
      return false;
    });
    if (kept.length > 0) return [{ ...group, hooks: kept }];

    // A matcher group with only the managed handler is hnd-owned. Keep an
    // otherwise-empty user group when it has extra metadata we do not know.
    const extraKeys = Object.keys(group).filter((key) => !['matcher', 'hooks'].includes(key));
    return extraKeys.length > 0 ? [{ ...group, hooks: [] }] : [];
  });
  removeEmptyHookContainers(output, eventName);
  return { value: output, removed };
}

export function installNestedHandler(config, options) {
  const stripped = stripNestedHandler(config, options);
  const output = stripped.value;
  if (output.hooks === undefined) output.hooks = {};
  if (!isPlainObject(output.hooks)) {
    throw new AdapterConfigError(options.agent, options.filePath, '"hooks" must be a JSON object');
  }
  if (output.hooks[options.eventName] === undefined) output.hooks[options.eventName] = [];
  output.hooks[options.eventName].push(options.group);
  return { value: output, replaced: stripped.removed };
}

export function collectNestedHandlers(config, eventName) {
  if (!isPlainObject(config?.hooks) || !Array.isArray(config.hooks[eventName])) return [];
  return config.hooks[eventName].flatMap((group) => (
    isPlainObject(group) && Array.isArray(group.hooks) ? group.hooks : []
  ));
}
