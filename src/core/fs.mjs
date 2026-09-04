import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { CoreError } from './errors.mjs';

const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIRECTORY_MODE = 0o700;

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

async function releaseLockIfOwned(lockFile, owner, heldIdentity) {
  let currentHandle;
  try {
    const noFollow = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW || 0);
    currentHandle = await fs.open(lockFile, fsConstants.O_RDONLY | noFollow);
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
      || (heldIdentity && (
        currentIdentity.dev !== heldIdentity.dev
        || currentIdentity.ino !== heldIdentity.ino
      ))
    ) {
      return false;
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return false;
    throw error;
  } finally {
    await currentHandle?.close();
  }

  try {
    await fs.unlink(lockFile);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function withLockDeletionGuard(lockFile, callback, timeoutMs) {
  const guardFile = `${lockFile}.delete`;
  const started = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(guardFile, 'wx', DEFAULT_FILE_MODE);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= timeoutMs) {
        throw new CoreError('STATE_BUSY', `Timed out waiting for lock deletion guard: ${lockFile}`, {
          path: lockFile,
        });
      }
      await delay(10);
    }
  }
  try {
    return await callback();
  } finally {
    await handle.close();
    await fs.unlink(guardFile).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
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
    let candidate;
    try {
      candidate = await fs.open(lockFile, 'wx', DEFAULT_FILE_MODE);
      await candidate.writeFile(
        `${JSON.stringify({ owner, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      );
      await candidate.sync();
      handle = candidate;
      candidate = null;
    } catch (error) {
      await candidate?.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;

      let removedStale = false;
      await withLockDeletionGuard(lockFile, async () => {
        try {
          // Re-read only after serializing every operation that can delete a
          // lock. A waiter must never act on a stale stat and unlink a newly
          // acquired owner's file.
          const stat = await fs.stat(lockFile);
          if (Date.now() - stat.mtimeMs > staleMs) {
            await fs.unlink(lockFile);
            removedStale = true;
          }
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError;
          removedStale = true;
        }
      }, timeoutMs);
      if (removedStale) continue;

      if (Date.now() - started >= timeoutMs) {
        throw new CoreError('STATE_BUSY', `Timed out waiting for state lock: ${lockFile}`, {
          path: lockFile,
        });
      }
      await delay(25);
    }
  }

  try {
    return await callback();
  } finally {
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
    );
  }
}
