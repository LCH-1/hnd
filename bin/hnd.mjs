#!/usr/bin/env node

import { suppressSqliteExperimentalWarning } from '../src/node-warnings.mjs';

suppressSqliteExperimentalWarning();

// The launcher graph imports node:sqlite. A static import would load it before
// the warning filter above is installed.
const { launcherMain } = await import('../src/launcher.mjs');

launcherMain(process.argv.slice(2)).catch((error) => {
  const message = error?.message || String(error);
  process.stderr.write(`hnd: ${message}\n`);
  if (process.env.HND_DEBUG && error?.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
