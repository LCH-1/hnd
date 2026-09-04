import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export class OperationConflictError extends Error {
  constructor(filePath) {
    super(`Refusing to overwrite a file that changed while planning: ${filePath}`);
    this.name = 'OperationConflictError';
    this.code = 'OPERATION_CONFLICT';
    this.path = filePath;
  }
}

async function readIfPresent(filePath) {
  let handle;
  try {
    const metadata = await fs.lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new OperationConflictError(filePath);
    }
    const noFollow = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW || 0);
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
    ) {
      throw new OperationConflictError(filePath);
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.code === 'ELOOP') throw new OperationConflictError(filePath);
    throw error;
  } finally {
    await handle?.close();
  }
}

function contentHash(content) {
  if (content === undefined) return null;
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function atomicWrite(filePath, content, mode, expected) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: mode ?? 0o600 });
    if (mode !== undefined) await fs.chmod(temporary, mode);
    if (contentHash(await readIfPresent(filePath)) !== contentHash(expected)) {
      throw new OperationConflictError(filePath);
    }
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function applyOperations(operations, { dryRun = false } = {}) {
  const results = [];
  for (const operation of operations) {
    if (!operation || !['write', 'remove'].includes(operation.kind)) {
      throw new TypeError('Unsupported file operation.');
    }

    const current = await readIfPresent(operation.path);
    if (
      Object.hasOwn(operation, 'previous')
      && contentHash(current) !== contentHash(operation.previous)
    ) {
      throw new OperationConflictError(operation.path);
    }

    const changed = operation.kind === 'write'
      ? current !== operation.content
      : current !== undefined;
    const result = { ...operation, changed, dryRun };
    delete result.content;
    delete result.previous;
    results.push(result);
    if (!changed || dryRun) continue;

    if (operation.kind === 'write') {
      await atomicWrite(operation.path, operation.content, operation.mode, current);
    } else {
      if (contentHash(await readIfPresent(operation.path)) !== contentHash(current)) {
        throw new OperationConflictError(operation.path);
      }
      await fs.rm(operation.path, { force: true });
    }
  }
  return results;
}

export function summarizeOperations(results) {
  return results.map((result) => ({
    agent: result.agent,
    component: result.component,
    action: result.kind,
    path: result.path,
    changed: result.changed,
    reason: result.reason,
  }));
}
