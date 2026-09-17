import path from 'node:path';

import { statePaths } from '../paths.mjs';
import { CoreError } from './errors.mjs';
import { pathExists, withFileLock } from './fs.mjs';

export function restoreJournalPath(env = process.env) {
  return path.join(statePaths(env).cache, 'restore-journal.json');
}

/**
 * Serializes CLI-visible state reads/mutations with multi-file sync restores.
 * Specialized locks still protect their own read/modify/write records; this
 * outer lock provides a consistent generation boundary across those records.
 */
// A live holder refreshes the lease every staleMs/3, so this bound does not cut
// long operations short — PID liveness and the heartbeat both have to lapse
// before a lease is reclaimed. What it does bound is how long the lock stays
// poisoned after an unclean kill, which is the only case that reaches it.
const STATE_LOCK_STALE_MS = 60_000;

export function withStateLock(
  callback,
  {
    env = process.env,
    timeoutMs = 15_000,
    staleMs = STATE_LOCK_STALE_MS,
    allowRestoreJournal = false,
  } = {},
) {
  return withFileLock(
    path.join(statePaths(env).locks, 'state-generation.lock'),
    async () => {
      const journal = restoreJournalPath(env);
      if (!allowRestoreJournal && await pathExists(journal)) {
        throw new CoreError(
          'STATE_RECOVERY_REQUIRED',
          'An interrupted sync restore must be recovered before state can be read; run hnd sync pull again',
          { path: journal },
        );
      }
      return callback();
    },
    { timeoutMs, staleMs },
  );
}
