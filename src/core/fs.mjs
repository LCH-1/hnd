import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { CoreError } from './errors.mjs';

const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIRECTORY_MODE = 0o700;
const LOCK_INITIALIZATION_GRACE_MS = 1_000;
const MAX_LOCK_PID = 0x7fffffff;
const activeLockOwners = new Set();

async function assertManagedDirectoryChain(trustedRoot, target) {
  const root = path.resolve(trustedRoot);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CoreError(
      'UNSAFE_STATE_PATH',
      `State directory escapes its trusted root: ${resolved}`,
      { path: resolved, trustedRoot: root },
    );
  }

  const segments = relative === '' ? [] : relative.split(path.sep);
  let current = root;
  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) current = path.join(current, segments[index - 1]);
    let metadata;
    try {
      metadata = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT' && index > 0) return false;
      if (error.code === 'ENOENT') {
        throw new CoreError(
          'UNSAFE_STATE_PATH',
          `Trusted state root does not exist: ${root}`,
          { path: resolved, trustedRoot: root },
          { cause: error },
        );
      }
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new CoreError(
        'UNSAFE_STATE_PATH',
        `State directory chain contains a symbolic link or non-directory: ${current}`,
        { path: resolved, component: current, trustedRoot: root },
      );
    }
  }
  return true;
}

export async function ensureDirectory(
  directory,
  mode = DEFAULT_DIRECTORY_MODE,
  { trustedRoot } = {},
) {
  const resolved = path.resolve(directory);
  if (trustedRoot !== undefined) {
    await assertManagedDirectoryChain(trustedRoot, resolved);
  }
  let metadata;
  try {
    metadata = await fs.lstat(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(resolved, { recursive: true, mode });
    metadata = await fs.lstat(resolved);
  }
  if (trustedRoot !== undefined) {
    // Recheck every managed component after recursive creation. This closes
    // prepared intermediate-symlink escapes while deliberately allowing
    // platform/automount symlinks above the explicit state root.
    const complete = await assertManagedDirectoryChain(trustedRoot, resolved);
    if (!complete) {
      throw new CoreError(
        'UNSAFE_STATE_PATH',
        `State directory chain changed during creation: ${resolved}`,
        { path: resolved, trustedRoot: path.resolve(trustedRoot) },
      );
    }
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new CoreError(
      'UNSAFE_STATE_PATH',
      `State directory must be a real directory: ${resolved}`,
      { path: resolved },
    );
  }

  // Anchor permission changes to the directory we inspected. O_NOFOLLOW keeps
  // a last-component swap from turning chmod into a write through a symlink.
  if (process.platform !== 'win32') {
    let handle;
    try {
      const noFollow = fsConstants.O_NOFOLLOW || 0;
      const directoryOnly = fsConstants.O_DIRECTORY || 0;
      handle = await fs.open(resolved, fsConstants.O_RDONLY | noFollow | directoryOnly);
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isDirectory()) {
        throw new CoreError(
          'UNSAFE_STATE_PATH',
          `State directory changed while opening: ${resolved}`,
          { path: resolved },
        );
      }
      await handle.chmod(mode);
    } catch (error) {
      if (error instanceof CoreError) throw error;
      if (error.code === 'ELOOP' || error.code === 'ENOTDIR') {
        throw new CoreError(
          'UNSAFE_STATE_PATH',
          `Refusing to use a symbolic-link state directory: ${resolved}`,
          { path: resolved },
          { cause: error },
        );
      }
      if (error.code !== 'EPERM' && error.code !== 'ENOTSUP') throw error;
    } finally {
      await handle?.close();
    }
  } else {
    try {
      await fs.chmod(resolved, mode);
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'ENOTSUP') throw error;
    }
  }
  return directory;
}

export async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readText(file, { optional = false } = {}) {
  let handle;
  try {
    const metadata = await fs.lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new CoreError('UNSAFE_STATE_PATH', `State path must be a regular file: ${file}`, {
        path: file,
      });
    }
    const noFollow = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW || 0);
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      throw new CoreError('UNSAFE_STATE_PATH', `State path changed while opening: ${file}`, {
        path: file,
      });
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') {
      throw new CoreError(
        'UNSAFE_STATE_PATH',
        `Refusing to read a symbolic link: ${file}`,
        { path: file },
        { cause: error },
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readJson(file, { optional = false, validate } = {}) {
  const source = await readText(file, { optional });
  if (source === null) return null;

  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new CoreError(
      'STATE_CORRUPT',
      `Invalid JSON state file: ${file}`,
      { path: file },
      { cause: error },
    );
  }

  if (validate && !validate(value)) {
    throw new CoreError('STATE_CORRUPT', `Unexpected state shape: ${file}`, {
      path: file,
    });
  }
  return value;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM', 'EACCES'].includes(error.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

/**
 * Atomically replaces a file with fully flushed bytes. When overwrite is false,
 * a hard-link installs the completed temporary file without racing another writer.
 */
export async function writeTextAtomic(
  file,
  value,
  { mode = DEFAULT_FILE_MODE, overwrite = true } = {},
) {
  if (typeof value !== 'string') {
    throw new TypeError('writeTextAtomic value must be a string');
  }

  const directory = path.dirname(file);
  await ensureDirectory(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );

  let handle;
  try {
    handle = await fs.open(temporary, 'wx', mode);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    if (overwrite) {
      await fs.rename(temporary, file);
    } else {
      try {
        await fs.link(temporary, file);
      } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
      } finally {
        await fs.unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
    await syncDirectory(directory);
    return true;
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function writeJsonAtomic(file, value, options = {}) {
  return writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function removeFile(file) {
  try {
    await fs.unlink(file);
    await syncDirectory(path.dirname(file));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function moveFile(source, destination) {
  await ensureDirectory(path.dirname(destination));
  await fs.rename(source, destination);
  await syncDirectory(path.dirname(source));
  if (path.dirname(source) !== path.dirname(destination)) {
    await syncDirectory(path.dirname(destination));
  }
}

export async function listFiles(directory, { suffix } = {}) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && (!suffix || entry.name.endsWith(suffix)))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

export async function fileMetadata(file) {
  try {
    const stat = await fs.stat(file);
    return { size: stat.size, updatedAt: stat.mtime.toISOString() };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameFileIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
  );
}

function sameLockSnapshot(left, right) {
  return Boolean(
    sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
  );
}

function unsafeLockPathError(lockFile, cause) {
  return new CoreError(
    'UNSAFE_STATE_PATH',
    `Lock path must be a regular file: ${lockFile}`,
    { path: lockFile },
    cause ? { cause } : undefined,
  );
}

async function lockPathMatches(lockFile, expectedIdentity = null, compareMetadata = false) {
  const pathIdentity = await fs.lstat(lockFile);
  if (
    !pathIdentity.isFile()
    || pathIdentity.isSymbolicLink()
  ) {
    throw unsafeLockPathError(lockFile);
  }
  if (!expectedIdentity) return true;
  return compareMetadata
    ? sameLockSnapshot(pathIdentity, expectedIdentity)
    : sameFileIdentity(pathIdentity, expectedIdentity);
}

function lockReadFlags() {
  if (process.platform === 'win32') return fsConstants.O_RDONLY;
  return (
    fsConstants.O_RDONLY
    | (fsConstants.O_NOFOLLOW || 0)
    | (fsConstants.O_NONBLOCK || 0)
  );
}

async function publishLockFile(lockFile, owner) {
  const pendingFile = `${lockFile}.${process.pid}.${owner}.pending`;
  let handle;
  try {
    handle = await fs.open(pendingFile, 'wx', DEFAULT_FILE_MODE);
    await handle.writeFile(`${JSON.stringify({
      owner,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    })}\n`);
    await handle.sync();
    try {
      // A hard link publishes the already-complete inode only when the lock
      // name is absent. Unlike open('wx') followed by write(), waiters can
      // never observe an empty, live lock and mistake it for a stale artifact.
      await fs.link(pendingFile, lockFile);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await handle.close();
      handle = null;
      return null;
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    handle = null;
    throw error;
  } finally {
    // Once linked, an open handle keeps the published inode alive. Failure to
    // remove this private staging name must not abandon the actual lock.
    await fs.unlink(pendingFile).catch(() => {});
  }
}

function lockOwnerIsRunning(record) {
  if (
    !Number.isSafeInteger(record?.pid)
    || record.pid <= 0
    || record.pid > MAX_LOCK_PID
  ) return false;
  // A failed release can leave a syntactically valid lock owned by this PID.
  // Process liveness alone would make that artifact permanent until the whole
  // CLI/server process exits, so same-process ownership must also be registered.
  if (record.pid === process.pid) return activeLockOwners.has(record.owner);
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves that the process exists; only ESRCH proves that it
    // does not. Unknown platform errors favor mutual exclusion over recovery.
    return error.code !== 'ESRCH';
  }
}

async function inspectLockFile(lockFile) {
  let handle;
  try {
    await lockPathMatches(lockFile);
    handle = await fs.open(lockFile, lockReadFlags());
    const identity = await handle.stat();
    if (!await lockPathMatches(lockFile, identity)) return null;
    let record = null;
    let source = null;
    if (identity.isFile() && identity.size <= 4 * 1024) {
      try {
        source = await handle.readFile('utf8');
        record = JSON.parse(source);
      } catch {
        // A process may have stopped after creating the file but before
        // completing its owner record. Its mtime still gates stale recovery.
      }
    }
    return { identity, record, source };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw unsafeLockPathError(lockFile, error);
    throw error;
  } finally {
    await handle?.close();
  }
}

function lockSnapshotIsStale(snapshot, staleMs) {
  const hasCompleteOwnerRecord = Boolean(
    typeof snapshot?.record?.owner === 'string'
    && snapshot.record.owner !== ''
    && Number.isSafeInteger(snapshot.record.pid)
    && snapshot.record.pid > 0
    && snapshot.record.pid <= MAX_LOCK_PID
  );
  // O_EXCL publishes an empty inode before its asynchronous owner write can
  // finish. Give incomplete records a minimum initialization window so a very
  // small staleMs cannot steal a lock that is still being created.
  const effectiveStaleMs = hasCompleteOwnerRecord
    ? staleMs
    : Math.max(staleMs, LOCK_INITIALIZATION_GRACE_MS);
  return Boolean(
    snapshot
    && Date.now() - snapshot.identity.mtimeMs > effectiveStaleMs
    && !lockOwnerIsRunning(snapshot.record)
  );
}

async function removeLockSnapshot(lockFile, snapshot) {
  if (!snapshot) return false;
  let currentHandle;
  try {
    await lockPathMatches(lockFile);
    currentHandle = await fs.open(lockFile, lockReadFlags());
    const currentIdentity = await currentHandle.stat();
    if (!sameLockSnapshot(currentIdentity, snapshot.identity)) return false;
    if (snapshot.source !== null) {
      let currentSource;
      try {
        currentSource = await currentHandle.readFile('utf8');
      } catch {
        return false;
      }
      if (currentSource !== snapshot.source) return false;
    }
    const finalIdentity = await currentHandle.stat();
    if (!sameLockSnapshot(finalIdentity, snapshot.identity)) return false;
    if (!await lockPathMatches(lockFile, snapshot.identity, true)) return false;
    // Keep the verified inode open until unlink has completed. Cooperating
    // deleters are serialized, and this avoids widening the final identity-to-
    // unlink window with a handle-close round trip.
    await fs.unlink(lockFile);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (error.code === 'ELOOP') throw unsafeLockPathError(lockFile, error);
    throw error;
  } finally {
    await currentHandle?.close();
  }
}

function startLockHeartbeat(handle, staleMs) {
  // PID liveness is the primary protection against stealing a delayed holder.
  // The heartbeat also makes the lease portable to observers that cannot
  // inspect processes and bounds recovery time after an unclean exit.
  const intervalMs = Math.max(5, Math.min(30_000, Math.floor(staleMs / 3) || 1));
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.then(async () => {
      const now = new Date();
      await handle.utimes(now, now);
    }).catch(() => {
      // A heartbeat failure must not reject the protected operation. A live
      // owner PID still prevents another cooperating process from taking over.
    });
  }, intervalMs);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

async function releaseLockIfOwned(lockFile, owner, heldIdentity) {
  let currentHandle;
  try {
    await lockPathMatches(lockFile);
    currentHandle = await fs.open(lockFile, lockReadFlags());
    const currentIdentity = await currentHandle.stat();
    const source = await currentHandle.readFile('utf8');
    let record;
    try {
      record = JSON.parse(source);
    } catch {
      return false;
    }
    if (
      record?.owner !== owner
      || (heldIdentity && !sameFileIdentity(currentIdentity, heldIdentity))
    ) {
      return false;
    }
    if (!await lockPathMatches(lockFile, currentIdentity)) return false;
    await fs.unlink(lockFile);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (error.code === 'ELOOP') throw unsafeLockPathError(lockFile, error);
    throw error;
  } finally {
    await currentHandle?.close();
  }
}

async function reclaimDeletionGuard(guardFile, staleMs) {
  const observed = await inspectLockFile(guardFile);
  if (!lockSnapshotIsStale(observed, staleMs)) return false;

  // Stale-guard recovery itself is serialized. Without this second, very
  // short-lived lease, two waiters could both inspect the orphan and one could
  // unlink the other's newly-created replacement guard.
  const recoveryFile = `${guardFile}.recovery`;
  const recoveryOwner = randomUUID();
  let recoveryHandle;
  try {
    activeLockOwners.add(recoveryOwner);
    try {
      recoveryHandle = await publishLockFile(recoveryFile, recoveryOwner);
    } catch (error) {
      activeLockOwners.delete(recoveryOwner);
      throw error;
    }
    if (!recoveryHandle) {
      activeLockOwners.delete(recoveryOwner);

      const recovery = await inspectLockFile(recoveryFile);
      if (lockSnapshotIsStale(recovery, staleMs)) {
        // This is the recursion boundary: another recovery lock would need its
        // own recovery lock forever. The inode and owner are therefore checked
        // from one open handle and that handle stays open through unlink. This
        // closes in-process interleaving, although portable filesystems offer
        // no atomic compare-and-unlink against a non-cooperating process.
        await removeLockSnapshot(recoveryFile, recovery);
      }
      return false;
    }

    // Re-read under the recovery lease. The original guard owner may have
    // released it, or another generation may now occupy the path.
    const current = await inspectLockFile(guardFile);
    if (
      !lockSnapshotIsStale(current, staleMs)
      || !sameFileIdentity(current.identity, observed.identity)
      || current.record?.owner !== observed.record?.owner
    ) {
      return false;
    }
    return removeLockSnapshot(guardFile, current);
  } finally {
    if (recoveryHandle) {
      const recoveryIdentity = await recoveryHandle.stat().catch(() => null);
      await recoveryHandle.close().catch(() => {});
      try {
        await releaseLockIfOwned(recoveryFile, recoveryOwner, recoveryIdentity);
      } finally {
        activeLockOwners.delete(recoveryOwner);
      }
    }
  }
}

async function withLockDeletionGuard(lockFile, callback, timeoutMs, staleMs) {
  const guardFile = `${lockFile}.delete`;
  const started = Date.now();
  const owner = randomUUID();
  let handle;
  while (!handle) {
    activeLockOwners.add(owner);
    try {
      handle = await publishLockFile(guardFile, owner);
    } catch (error) {
      activeLockOwners.delete(owner);
      throw error;
    }
    if (handle) break;
    activeLockOwners.delete(owner);
    if (await reclaimDeletionGuard(guardFile, staleMs)) continue;
    if (Date.now() - started >= timeoutMs) {
      throw new CoreError('STATE_BUSY', `Timed out waiting for lock deletion guard: ${lockFile}`, {
        path: lockFile,
      });
    }
    await delay(10);
  }
  const stopHeartbeat = startLockHeartbeat(handle, staleMs);
  try {
    return await callback();
  } finally {
    try {
      await stopHeartbeat();
      const heldIdentity = await handle.stat().catch(() => null);
      await handle.close();
      await releaseLockIfOwned(guardFile, owner, heldIdentity);
    } finally {
      activeLockOwners.delete(owner);
      await handle.close().catch(() => {});
    }
  }
}

/** Short cross-process lock for read/modify/write state updates. */
export async function withFileLock(
  lockFile,
  callback,
  { timeoutMs = 5_000, staleMs = 30_000 } = {},
) {
  await ensureDirectory(path.dirname(lockFile));
  const started = Date.now();
  const owner = randomUUID();
  let handle;

  while (!handle) {
    activeLockOwners.add(owner);
    try {
      handle = await publishLockFile(lockFile, owner);
    } catch (error) {
      activeLockOwners.delete(owner);
      throw error;
    }
    if (!handle) {
      activeLockOwners.delete(owner);

      let removedStale = false;
      await withLockDeletionGuard(lockFile, async () => {
        // Re-read only after serializing every operation that can delete a
        // lock. Heartbeats and PID liveness ensure an active long-running
        // callback is never mistaken for a crashed owner.
        const current = await inspectLockFile(lockFile);
        if (!current) {
          removedStale = true;
          return;
        }
        if (!lockSnapshotIsStale(current, staleMs)) return;
        removedStale = await removeLockSnapshot(lockFile, current);
      }, timeoutMs, staleMs);
      if (removedStale) continue;

      if (Date.now() - started >= timeoutMs) {
        throw new CoreError('STATE_BUSY', `Timed out waiting for state lock: ${lockFile}`, {
          path: lockFile,
        });
      }
      await delay(25);
    }
  }

  const stopHeartbeat = startLockHeartbeat(handle, staleMs);
  try {
    return await callback();
  } finally {
    try {
      await stopHeartbeat();
      let heldIdentity;
      try {
        heldIdentity = await handle.stat();
      } catch {
        // The owner token check still prevents deleting a replacement lock when
        // a platform cannot report a stable file identity.
      }
      await handle.close();
      await withLockDeletionGuard(
        lockFile,
        () => releaseLockIfOwned(lockFile, owner, heldIdentity),
        timeoutMs,
        staleMs,
      );
    } finally {
      activeLockOwners.delete(owner);
      await handle.close().catch(() => {});
    }
  }
}
