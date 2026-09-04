import { createHash, timingSafeEqual } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  atomicWriteFile,
  ensurePrivateDirectory,
  safeJoin,
} from './io.mjs';

export const SYNC_SNAPSHOT_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_CAPTURE_FILE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_CAPTURE_TOTAL_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_CAPTURE_FILES = 4096;

const GLOBAL_POLICY_PATH = 'policies/global.md';
const REPOSITORY_INDEX_PATH = 'repositories.json';
const REPOSITORIES_PREFIX = 'repositories/';
const KNOWLEDGE_PREFIX = 'knowledge/';
const RULES_PREFIX = 'rules/';
const SNAPSHOT_KEYS = new Set(['schemaVersion', 'files']);
const SNAPSHOT_FILE_KEYS = new Set(['path', 'encoding', 'bytes', 'sha256', 'content']);

function hasOnlyKeys(value, allowed) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function compareCodePoints(left, right) {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  while (true) {
    const leftStep = leftIterator.next();
    const rightStep = rightIterator.next();
    if (leftStep.done || rightStep.done) {
      if (leftStep.done && rightStep.done) return 0;
      return leftStep.done ? -1 : 1;
    }
    const difference = leftStep.value.codePointAt(0) - rightStep.value.codePointAt(0);
    if (difference !== 0) return difference;
  }
}

function portablePathCollisionKey(value) {
  // Use canonical decomposition plus locale-independent default case mappings.
  // The upper/lower round trip catches multi-character folds such as ß/SS and
  // final-sigma variants that plain toLowerCase() alone would miss.
  return value
    .normalize('NFD')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFD');
}

function assertNoPortablePathCollisions(paths) {
  const filesByKey = new Map();
  const directoriesByKey = new Map();
  for (const relativePath of paths) {
    const key = portablePathCollisionKey(relativePath);
    const collidingFile = filesByKey.get(key);
    const collidingDescendant = directoriesByKey.get(key);
    if (collidingFile || collidingDescendant) {
      throw new Error(
        `Portable snapshot path collision after case folding or Unicode normalization: ${collidingFile ?? collidingDescendant} and ${relativePath}`,
      );
    }

    let separator = key.indexOf('/');
    while (separator !== -1) {
      const directoryKey = key.slice(0, separator);
      const collidingParent = filesByKey.get(directoryKey);
      if (collidingParent) {
        throw new Error(
          `Portable snapshot path collision after case folding or Unicode normalization: ${collidingParent} and ${relativePath}`,
        );
      }
      if (!directoriesByKey.has(directoryKey)) directoriesByKey.set(directoryKey, relativePath);
      separator = key.indexOf('/', separator + 1);
    }
    filesByKey.set(key, relativePath);
  }
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    throw new Error('Invalid snapshot file path');
  }
  if (value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)) {
    throw new Error('Invalid snapshot file path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Snapshot file path traversal is not allowed');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value) throw new Error('Snapshot file path is not canonical');
  if (
    normalized !== GLOBAL_POLICY_PATH
    && normalized !== REPOSITORY_INDEX_PATH
    && !normalized.startsWith(REPOSITORIES_PREFIX)
    && !normalized.startsWith(KNOWLEDGE_PREFIX)
    && !normalized.startsWith(RULES_PREFIX)
  ) {
    throw new Error(`Snapshot path is outside the sync allowlist: ${normalized}`);
  }
  return normalized;
}

async function readCaptureFile(absolutePath, relativePath, limits) {
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Sync source must be a regular file: ${relativePath}`);
  }
  if (metadata.size > limits.maxFileBytes) {
    throw new Error(`Sync source exceeds per-file limit: ${relativePath}`);
  }
  const contents = await readFile(absolutePath);
  if (contents.byteLength > limits.maxFileBytes) {
    throw new Error(`Sync source exceeds per-file limit: ${relativePath}`);
  }
  return Object.freeze({
    path: normalizeRelativePath(relativePath),
    encoding: 'base64',
    bytes: contents.byteLength,
    sha256: digest(contents),
    content: contents.toString('base64'),
  });
}

async function walkManagedDirectory(directory, relativeDirectory, limits, output, label) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symlink`);
  }

  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareCodePoints(left.name, right.name));
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || entry.name.includes('/') || entry.name.includes('\\')) {
      throw new Error(`Invalid ${label} entry name`);
    }
    const absolute = path.join(directory, entry.name);
    const relative = `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed in sync snapshots: ${relative}`);
    }
    if (entry.isDirectory()) {
      await walkManagedDirectory(absolute, relative, limits, output, label);
    } else if (entry.isFile()) {
      const captured = await readCaptureFile(absolute, relative, limits);
      if (captured) output.push(captured);
    } else {
      throw new Error(`Unsupported filesystem entry in sync source: ${relative}`);
    }
  }
}

export async function captureSyncSnapshot(homeDirectory, options = {}) {
  const home = path.resolve(homeDirectory);
  const limits = {
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_CAPTURE_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_CAPTURE_TOTAL_BYTES,
  };
  if (!Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes < 1) {
    throw new Error('maxFileBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(limits.maxTotalBytes) || limits.maxTotalBytes < 1) {
    throw new Error('maxTotalBytes must be a positive safe integer');
  }

  let homeMetadata;
  try {
    homeMetadata = await lstat(home);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (homeMetadata && (!homeMetadata.isDirectory() || homeMetadata.isSymbolicLink())) {
    throw new Error('Sync home must be a real directory, not a symlink');
  }

  const files = [];
  await assertNoSymlinkComponents(home, GLOBAL_POLICY_PATH);
  const globalPolicy = await readCaptureFile(
    safeJoin(home, 'policies', 'global.md'),
    GLOBAL_POLICY_PATH,
    limits,
  );
  if (globalPolicy) files.push(globalPolicy);
  await assertNoSymlinkComponents(home, REPOSITORY_INDEX_PATH);
  const repositoryIndex = await readCaptureFile(
    safeJoin(home, 'repositories.json'),
    REPOSITORY_INDEX_PATH,
    limits,
  );
  if (repositoryIndex) files.push(repositoryIndex);
  await walkManagedDirectory(
    safeJoin(home, 'repositories'),
    'repositories',
    limits,
    files,
    'repositories',
  );
  await walkManagedDirectory(
    safeJoin(home, 'knowledge'),
    'knowledge',
    limits,
    files,
    'knowledge',
  );
  await walkManagedDirectory(
    safeJoin(home, 'rules'),
    'rules',
    limits,
    files,
    'rules',
  );

  assertNoPortablePathCollisions(files.map((file) => file.path));
  files.sort((left, right) => compareCodePoints(left.path, right.path));
  if (files.length > (options.maxFiles ?? DEFAULT_MAX_CAPTURE_FILES)) {
    throw new Error('Sync snapshot contains too many files');
  }
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > limits.maxTotalBytes) {
    throw new Error(`Sync snapshot exceeds ${limits.maxTotalBytes} byte limit`);
  }
  return Object.freeze({
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    files: Object.freeze(files),
  });
}

function decodeBase64Strict(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid base64 snapshot content');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('Non-canonical base64 snapshot content');
  return decoded;
}

export function validateSyncSnapshot(snapshot, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_CAPTURE_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_CAPTURE_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_CAPTURE_FILES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new Error('maxFileBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) {
    throw new Error('maxTotalBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error('maxFiles must be a positive safe integer');
  }
  if (
    !hasOnlyKeys(snapshot, SNAPSHOT_KEYS)
    || snapshot.schemaVersion !== SYNC_SNAPSHOT_SCHEMA_VERSION
    || !Array.isArray(snapshot.files)
  ) {
    throw new Error('Unsupported or malformed sync snapshot');
  }
  if (snapshot.files.length > maxFiles) throw new Error('Sync snapshot contains too many files');

  const seen = new Set();
  const decodedFiles = snapshot.files.map((file) => {
    if (!hasOnlyKeys(file, SNAPSHOT_FILE_KEYS) || file.encoding !== 'base64') {
      throw new Error('Unsupported or malformed snapshot file');
    }
    const relativePath = normalizeRelativePath(file.path);
    if (seen.has(relativePath)) throw new Error(`Duplicate snapshot path: ${relativePath}`);
    seen.add(relativePath);
    const contents = decodeBase64Strict(file.content);
    if (contents.byteLength > maxFileBytes || file.bytes !== contents.byteLength) {
      throw new Error(`Invalid size for snapshot file: ${relativePath}`);
    }
    const actualHash = Buffer.from(digest(contents), 'hex');
    const claimedHash = /^[a-f0-9]{64}$/.test(file.sha256 || '')
      ? Buffer.from(file.sha256, 'hex')
      : Buffer.alloc(0);
    if (claimedHash.byteLength !== actualHash.byteLength || !timingSafeEqual(actualHash, claimedHash)) {
      throw new Error(`Digest mismatch for snapshot file: ${relativePath}`);
    }
    return Object.freeze({ path: relativePath, contents });
  });
  assertNoPortablePathCollisions(decodedFiles.map((file) => file.path));
  decodedFiles.sort((left, right) => compareCodePoints(left.path, right.path));
  for (let index = 1; index < decodedFiles.length; index += 1) {
    if (decodedFiles[index].path.startsWith(`${decodedFiles[index - 1].path}/`)) {
      throw new Error('Snapshot contains a file/directory path collision');
    }
  }
  const totalBytes = decodedFiles.reduce((sum, file) => sum + file.contents.byteLength, 0);
  if (totalBytes > maxTotalBytes) throw new Error(`Sync snapshot exceeds ${maxTotalBytes} byte limit`);
  return Object.freeze({ files: Object.freeze(decodedFiles), totalBytes });
}

async function assertNoSymlinkComponents(home, relativePath) {
  let current = home;
  const segments = relativePath.split('/');
  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) current = safeJoin(current, segments[index - 1]);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing to restore through symlink: ${current}`);
    }
    const isTarget = index === segments.length;
    if ((!isTarget && !metadata.isDirectory()) || (isTarget && !metadata.isFile())) {
      throw new Error(`Restore target has an incompatible filesystem type: ${current}`);
    }
  }
}

async function removeEmptyRepositoryDirectories(home) {
  const repositories = safeJoin(home, 'repositories');
  async function visit(directory, isRoot) {
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Managed repository path is not a real directory: ${directory}`);
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`Symlink appeared during restore: ${entry.name}`);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), false);
    }
    if (!isRoot && (await readdir(directory)).length === 0) {
      await rmdir(directory);
    }
  }
  await visit(repositories, true);
}

export async function restoreSyncSnapshot(homeDirectory, snapshot, options = {}) {
  // Decode, validate every digest, enforce the allowlist, and check every size
  // before the first filesystem mutation.
  const validated = validateSyncSnapshot(snapshot, options);
  const home = path.resolve(homeDirectory);
  for (const file of validated.files) {
    await assertNoSymlinkComponents(home, file.path);
  }
  const currentSnapshot = options.prune === false
    ? null
    : await captureSyncSnapshot(home, options);
  const desiredPaths = new Set(validated.files.map((file) => file.path));
  const stalePaths = currentSnapshot
    ? currentSnapshot.files
      .map((file) => file.path)
      .filter((relativePath) => !desiredPaths.has(relativePath))
    : [];

  if (options.dryRun) {
    return Object.freeze({
      written: Object.freeze(validated.files.map((file) => file.path)),
      removed: Object.freeze(stalePaths),
      bytes: validated.totalBytes,
      dryRun: true,
    });
  }

  await ensurePrivateDirectory(home);
  const written = [];
  for (const file of validated.files) {
    const target = safeJoin(home, ...file.path.split('/'));
    await atomicWriteFile(target, file.contents, { maxBytes: options.maxFileBytes ?? DEFAULT_MAX_CAPTURE_FILE_BYTES });
    written.push(file.path);
  }
  const removed = [];
  for (const relativePath of stalePaths) {
    const target = safeJoin(home, ...relativePath.split('/'));
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing to prune non-regular managed path: ${relativePath}`);
    }
    await unlink(target);
    removed.push(relativePath);
  }
  if (options.prune !== false) {
    await removeEmptyRepositoryDirectories(home);
  }
  return Object.freeze({
    written: Object.freeze(written),
    removed: Object.freeze(removed),
    bytes: validated.totalBytes,
    dryRun: false,
  });
}

export const captureSnapshot = captureSyncSnapshot;
export const restoreSnapshot = restoreSyncSnapshot;
