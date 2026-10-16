import path from 'node:path';

import { withFileLock } from '../core/fs.mjs';
import { statePaths } from '../paths.mjs';

export function withAdapterMutationLock(env, operation, { timeoutMs = 5_000 } = {}) {
  if (typeof operation !== 'function') {
    throw new TypeError('Adapter mutation operation must be a function.');
  }
  return withFileLock(
    path.join(statePaths(env).locks, 'adapter-mutations.lock'),
    operation,
    { timeoutMs },
  );
}
