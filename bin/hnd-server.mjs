#!/usr/bin/env node

import { serverMain } from '../src/sync/server.mjs';

serverMain(process.argv.slice(2)).then((server) => {
  if (!server?.close || !server?.httpServer?.listening) return;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } catch (error) {
      process.stderr.write(`hnd-server: graceful shutdown failed: ${error?.message || error}\n`);
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}).catch((error) => {
  process.stderr.write(`hnd-server: ${error?.message || error}\n`);
  process.exitCode = 1;
});
