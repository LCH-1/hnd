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
export function withStateLock(
  callback,
  {
    env = process.env,
    timeoutMs = 15_000,
    staleMs = 5 * 60_000,
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
