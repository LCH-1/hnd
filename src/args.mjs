export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

export function parseArgs(argv) {
  const positionals = [];
  const options = Object.create(null);
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (!token.startsWith('--') || token === '--') {
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf('=');
    const rawName = token.slice(2, equals === -1 ? undefined : equals);
    if (!rawName) throw new UsageError('Empty option name.');
    const name = rawName.replaceAll('-', '_');
    let value;
    if (equals !== -1) {
      value = token.slice(equals + 1);
    } else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
      value = argv[index + 1];
      index += 1;
    } else {
      value = true;
    }

    if (options[name] === undefined) {
      options[name] = value;
    } else if (Array.isArray(options[name])) {
      options[name].push(value);
    } else {
      options[name] = [options[name], value];
    }
  }
  return { positionals, options };
}

export function optionList(value) {
  if (value === undefined || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

export function optionString(options, name, fallback) {
  const value = options[name];
  if (value === undefined) return fallback;
  if (value === true || Array.isArray(value)) {
    throw new UsageError(`--${name.replaceAll('_', '-')} requires one value.`);
  }
  return String(value);
}

export function optionBoolean(options, name, fallback = false) {
  const value = options[name];
  if (value === undefined) return fallback;
  if (value === true) return true;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new UsageError(`--${name.replaceAll('_', '-')} must be true or false.`);
}
