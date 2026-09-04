import { randomBytes } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;

export function assertOpaqueId(value, label = 'identifier') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function safeJoin(root, ...segments) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Path escapes managed directory');
  }
  return resolved;
}

export async function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  let metadata;
  try {
    metadata = await lstat(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Managed path is not a private directory: ${resolved}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(resolved, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    metadata = await lstat(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Managed path is not a private directory: ${resolved}`);
    }
  }
  if (process.platform !== 'win32') {
    await chmod(resolved, PRIVATE_DIRECTORY_MODE);
  }
  return resolved;
}

export async function assertRegularFile(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Managed path is not a regular file: ${filePath}`);
  }
  return metadata;
}

export async function ensurePrivatePermissions(filePath) {
  await assertRegularFile(filePath);
  if (process.platform !== 'win32') {
    await chmod(filePath, PRIVATE_FILE_MODE);
    const metadata = await stat(filePath);
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(`Unable to make file private: ${filePath}`);
    }
  }
}

export async function atomicWriteFile(filePath, contents, options = {}) {
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  if (data.byteLength > maxBytes) {
    throw new Error(`Refusing to write ${data.byteLength} bytes; limit is ${maxBytes}`);
  }

  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  await ensurePrivateDirectory(directory);

  const temporary = path.join(
    directory,
    `.${path.basename(resolved)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, 'wx', options.mode ?? PRIVATE_FILE_MODE);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== 'win32') {
      await chmod(temporary, options.mode ?? PRIVATE_FILE_MODE);
    }
    await rename(temporary, resolved);
    await ensurePrivatePermissions(resolved);

    // Persisting the directory entry is best effort because Windows does not
    // permit fsync on directory handles.
    if (process.platform !== 'win32') {
      let directoryHandle;
      try {
        directoryHandle = await open(directory, 'r');
        await directoryHandle.sync();
      } finally {
        await directoryHandle?.close();
      }
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function createPrivateFile(filePath, contents) {
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(resolved)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, 'wx', PRIVATE_FILE_MODE);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, resolved);
    await unlink(temporary);
    await ensurePrivatePermissions(resolved);
    if (process.platform !== 'win32') {
      let directoryHandle;
      try {
        directoryHandle = await open(directory, 'r');
        await directoryHandle.sync();
      } finally {
        await directoryHandle?.close();
      }
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function readFileLimited(filePath, maxBytes) {
  const metadata = await assertRegularFile(filePath);
  if (metadata.size > maxBytes) {
    throw new Error(`File exceeds ${maxBytes} byte limit: ${filePath}`);
  }
  const contents = await readFile(filePath);
  if (contents.byteLength > maxBytes) {
    throw new Error(`File exceeds ${maxBytes} byte limit: ${filePath}`);
  }
  return contents;
}
