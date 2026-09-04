import { createHash } from 'node:crypto';
import {
  SYNC_SNAPSHOT_SCHEMA_VERSION,
  validateSyncSnapshot,
} from './capture.mjs';

const REPOSITORY_INDEX_PATH = 'repositories.json';
const REPOSITORY_METADATA_PATTERN = /^repositories\/[^/]+\/repository\.json$/;
const KNOWLEDGE_ENTRY_PATTERN = /^knowledge\/[0-9a-f-]{36}\.json$/i;
const MISSING = Symbol('missing JSON member');
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function contentsEqual(left, right) {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function createSnapshotFile(relativePath, contents) {
  const copy = Buffer.from(contents);
  return Object.freeze({
    path: relativePath,
    encoding: 'base64',
    bytes: copy.byteLength,
    sha256: createHash('sha256').update(copy).digest('hex'),
    content: copy.toString('base64'),
  });
}

function createConflictSide(relativePath, contents) {
  return contents === null ? null : createSnapshotFile(relativePath, contents);
}

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonEqual(left, right) {
  if (left === MISSING || right === MISSING) return left === right;
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  const leftKeys = Object.keys(left).sort(comparePaths);
  const rightKeys = Object.keys(right).sort(comparePaths);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]));
}

function mergeJsonValue(base, local, remote) {
  if (jsonEqual(local, remote)) return { value: local, conflicted: false };
  if (jsonEqual(local, base)) return { value: remote, conflicted: false };
  if (jsonEqual(remote, base)) return { value: local, conflicted: false };

  if (
    isJsonObject(local)
    && isJsonObject(remote)
    && (base === MISSING || isJsonObject(base))
  ) {
    const keys = new Set([
      ...(base === MISSING ? [] : Object.keys(base)),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]);
    const result = Object.create(null);
    let conflicted = false;
    for (const key of [...keys].sort(comparePaths)) {
      const merged = mergeJsonValue(
        base !== MISSING && Object.hasOwn(base, key) ? base[key] : MISSING,
        Object.hasOwn(local, key) ? local[key] : MISSING,
        Object.hasOwn(remote, key) ? remote[key] : MISSING,
      );
      conflicted ||= merged.conflicted;
      if (merged.value !== MISSING) result[key] = merged.value;
    }
    return { value: result, conflicted };
  }

  // A true same-key conflict is deliberately local-wins. The caller records
  // all three original file versions so a UI or CLI can resolve it later.
  return { value: local, conflicted: true };
}

function parseJsonObject(contents) {
  if (contents === null) return MISSING;
  try {
    const parsed = JSON.parse(STRICT_UTF8_DECODER.decode(contents));
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isMergeableJsonPath(relativePath) {
  return relativePath === REPOSITORY_INDEX_PATH
    || REPOSITORY_METADATA_PATTERN.test(relativePath)
    || KNOWLEDGE_ENTRY_PATTERN.test(relativePath);
}

function tryMergeJson(relativePath, base, local, remote) {
  if (!isMergeableJsonPath(relativePath) || local === null || remote === null) return null;
  const parsedBase = parseJsonObject(base);
  const parsedLocal = parseJsonObject(local);
  const parsedRemote = parseJsonObject(remote);
  if (
    parsedLocal === null
    || parsedRemote === null
    || (base !== null && parsedBase === null)
  ) {
    return null;
  }
  const merged = mergeJsonValue(parsedBase, parsedLocal, parsedRemote);
  return {
    contents: Buffer.from(`${JSON.stringify(merged.value, null, 2)}\n`, 'utf8'),
    conflicted: merged.conflicted,
  };
}

function toContentsMap(validated) {
  return new Map(validated.files.map((file) => [file.path, file.contents]));
}

/**
 * Pure three-way merge for validated sync snapshots.
 *
 * Conflicts retain the local version in `snapshot`. Each conflict contains
 * canonical snapshot-file records for the three input versions; a deletion is
 * represented by null. JSON metadata files are recursively merged by key and
 * are reported only when the same key has incompatible changes.
 */
export function mergeSyncSnapshots(base, local, remote) {
  const validatedBase = validateSyncSnapshot(base);
  const validatedLocal = validateSyncSnapshot(local);
  const validatedRemote = validateSyncSnapshot(remote);
  const baseFiles = toContentsMap(validatedBase);
  const localFiles = toContentsMap(validatedLocal);
  const remoteFiles = toContentsMap(validatedRemote);
  const paths = new Set([...baseFiles.keys(), ...localFiles.keys(), ...remoteFiles.keys()]);
  const files = [];
  const conflicts = [];

  for (const relativePath of [...paths].sort(comparePaths)) {
    const baseContents = baseFiles.get(relativePath) ?? null;
    const localContents = localFiles.get(relativePath) ?? null;
    const remoteContents = remoteFiles.get(relativePath) ?? null;
    let mergedContents;
    let conflicted = false;

    if (contentsEqual(localContents, remoteContents)) {
      mergedContents = localContents;
    } else if (contentsEqual(localContents, baseContents)) {
      mergedContents = remoteContents;
    } else if (contentsEqual(remoteContents, baseContents)) {
      mergedContents = localContents;
    } else {
      const jsonMerge = tryMergeJson(relativePath, baseContents, localContents, remoteContents);
      if (jsonMerge) {
        mergedContents = jsonMerge.contents;
        conflicted = jsonMerge.conflicted;
      } else {
        mergedContents = localContents;
        conflicted = true;
      }
    }

    if (mergedContents !== null) files.push(createSnapshotFile(relativePath, mergedContents));
    if (conflicted) {
      conflicts.push(Object.freeze({
        path: relativePath,
        base: createConflictSide(relativePath, baseContents),
        local: createConflictSide(relativePath, localContents),
        remote: createConflictSide(relativePath, remoteContents),
      }));
    }
  }

  const snapshot = Object.freeze({
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    files: Object.freeze(files),
  });
  // Revalidate the generated envelope so merged file-count and byte limits are
  // enforced as strictly as they are for every input.
  validateSyncSnapshot(snapshot);
  return Object.freeze({ snapshot, conflicts: Object.freeze(conflicts) });
}
