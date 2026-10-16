import path from 'node:path';

import { statePaths } from '../paths.mjs';
import { CoreError } from './errors.mjs';
import { fileLockDeadline, pathExists, setFileLockDeadline, withFileLock, withFileLockDeadline } from './fs.mjs';

export const withProcessLockDeadline = withFileLockDeadline;

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
// before a lease is reclaimed. Complete leases with a provably dead owner are
// reclaimed by withFileLock after its short initialization grace period.
const STATE_LOCK_STALE_MS = 60_000;
const MINIMUM_LOCK_WAIT_MS = 50;

// A process-wide ceiling on every state-lock wait, set once by a caller that
// runs under an external deadline. Threading a timeout through every call site
// is not enough: the sync and restore paths take this lock from a dozen places,
// and one missed argument is all it takes to be killed mid-operation again.

/** Pass null to clear. Only a process dedicated to one bounded task may set it. */
export function setProcessLockDeadline(deadlineAt) {
  setFileLockDeadline(deadlineAt);
}

export function processLockDeadline() {
  return fileLockDeadline();
}

function boundedTimeout(timeoutMs, now = Date.now()) {
  const processLockDeadlineAt = fileLockDeadline();
  if (processLockDeadlineAt === null) return timeoutMs;
  // Never zero: an uncontended lock should still be taken once the budget is
  // spent, and publishing it costs a single syscall.
  return Math.max(MINIMUM_LOCK_WAIT_MS, Math.min(timeoutMs, processLockDeadlineAt - now));
}

export function withStateLock(
  callback,
  {
    env = process.env,
    timeoutMs = 15_000,
    staleMs = STATE_LOCK_STALE_MS,
    allowRestoreJournal = false,
  } = {},
) {
  timeoutMs = boundedTimeout(timeoutMs);
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
