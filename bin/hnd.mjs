#!/usr/bin/env node

import { launcherMain } from '../src/launcher.mjs';

launcherMain(process.argv.slice(2)).catch((error) => {
  const message = error?.message || String(error);
  process.stderr.write(`hnd: ${message}\n`);
  if (process.env.HND_DEBUG && error?.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
