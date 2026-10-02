// Node 24 releases that still mark node:sqlite as experimental print this
// warning on every hnd command. It is not actionable for users, so only this
// exact warning is dropped; every other process warning is left untouched.
const SQLITE_EXPERIMENTAL_MESSAGE = 'SQLite is an experimental feature';

function warningType(warning, typeOrOptions) {
  if (warning instanceof Error) return warning.name;
  if (typeof typeOrOptions === 'string') return typeOrOptions;
  return typeOrOptions?.type;
}

export function isSqliteExperimentalWarning(warning, typeOrOptions) {
  const message = warning instanceof Error ? warning.message : String(warning);
  return warningType(warning, typeOrOptions) === 'ExperimentalWarning'
    && message.startsWith(SQLITE_EXPERIMENTAL_MESSAGE);
}

// Node emits the warning synchronously while loading node:sqlite, before any
// importing module is evaluated. Install this first and load the modules that
// import node:sqlite afterwards with a dynamic import().
export function suppressSqliteExperimentalWarning(target = process) {
  const emitWarning = target.emitWarning;
  target.emitWarning = function emitWarningWithoutSqlite(warning, ...args) {
    if (isSqliteExperimentalWarning(warning, args[0])) return;
    return Reflect.apply(emitWarning, this, [warning, ...args]);
  };
}
