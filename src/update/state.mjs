import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readJson, writeJsonAtomic } from '../core/fs.mjs';
import { statePaths } from '../paths.mjs';

const POINTER_SCHEMA_VERSION = 1;
const UPDATE_STATE_SCHEMA_VERSION = 1;

export function runtimePaths(env = process.env) {
  const state = statePaths(env);
  return Object.freeze({
    root: state.runtime,
    releases: state.runtimeReleases,
    current: state.runtimeCurrent,
    previous: state.runtimePrevious,
    updateState: state.runtimeUpdateState,
    lock: state.runtimeUpdateLock,
  });
}

export function validRuntimePointer(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.schemaVersion === POINTER_SCHEMA_VERSION
    && Number.isSafeInteger(value.sequence)
    && value.sequence >= 1
    && typeof value.version === 'string'
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)
    && typeof value.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(value.sha256);
}

export async function readRuntimePointer(kind, env = process.env) {
  const file = kind === 'previous' ? runtimePaths(env).previous : runtimePaths(env).current;
  return readJson(file, { optional: true, validate: validRuntimePointer });
}

export function runtimeDirectory(pointer, env = process.env) {
  if (!validRuntimePointer(pointer)) throw new Error('Runtime pointer is invalid');
  return path.join(runtimePaths(env).releases, pointer.sha256);
}

export async function runtimeReady(pointer, env = process.env) {
  if (!validRuntimePointer(pointer)) return false;
  const root = runtimeDirectory(pointer, env);
  try {
    const [rootStat, markerStat, entryStat] = await Promise.all([
      fs.lstat(root),
      fs.lstat(path.join(root, '.complete')),
      fs.lstat(path.join(root, 'src', 'cli.mjs')),
    ]);
    if (!(rootStat.isDirectory() && !rootStat.isSymbolicLink()
      && markerStat.isFile() && !markerStat.isSymbolicLink()
      && markerStat.size > 0 && markerStat.size <= 64 * 1024
      && entryStat.isFile() && !entryStat.isSymbolicLink())) return false;
    const marker = JSON.parse(await fs.readFile(path.join(root, '.complete'), 'utf8'));
    if (
      marker?.schemaVersion !== 1
      || !validRuntimePointer(marker.release)
      || marker.release.sha256 !== pointer.sha256
      || marker.release.sequence !== pointer.sequence
      || marker.release.version !== pointer.version
      || !Array.isArray(marker.files)
      || marker.files.length < 1
      || marker.files.length > 128
    ) return false;
    const seen = new Set();
    let totalBytes = 0;
    for (const file of marker.files) {
      if (
        !file
        || typeof file.path !== 'string'
        || file.path.includes('\\')
        || file.path.startsWith('/')
        || file.path.split('/').some((part) => !part || part === '.' || part === '..')
        || !Number.isSafeInteger(file.size)
        || file.size < 0
        || file.size > 4 * 1024 * 1024
        || !/^[a-f0-9]{64}$/.test(file.sha256 || '')
      ) return false;
      const folded = file.path.toLowerCase();
      if (seen.has(folded)) return false;
      seen.add(folded);
      totalBytes += file.size;
      if (totalBytes > 8 * 1024 * 1024) return false;
      const candidate = path.resolve(root, ...file.path.split('/'));
      const relative = path.relative(root, candidate);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
      const metadata = await fs.lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.size) return false;
      const contents = await fs.readFile(candidate);
      if (createHash('sha256').update(contents).digest('hex') !== file.sha256) return false;
    }
    return seen.has('src/cli.mjs');
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

export async function readUpdateState(env = process.env) {
  const fallback = {
    schemaVersion: UPDATE_STATE_SCHEMA_VERSION,
    origins: {},
    lastError: null,
  };
  const value = await readJson(runtimePaths(env).updateState, { optional: true });
  if (!value) return fallback;
  if (
    value.schemaVersion !== UPDATE_STATE_SCHEMA_VERSION
    || !value.origins
    || typeof value.origins !== 'object'
    || Array.isArray(value.origins)
  ) throw new Error('Connector update state is invalid');
  return value;
}

export async function writeUpdateState(value, env = process.env) {
  await writeJsonAtomic(runtimePaths(env).updateState, value, { mode: 0o600 });
}

export function originUpdateState(state, origin) {
  const current = state.origins[origin];
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return { highestSequence: 0, lastCheckedAt: null, installed: null, quarantine: [] };
  }
  return {
    highestSequence: Number.isSafeInteger(current.highestSequence) ? current.highestSequence : 0,
    lastCheckedAt: typeof current.lastCheckedAt === 'string' ? current.lastCheckedAt : null,
    installed: validRuntimePointer(current.installed) ? current.installed : null,
    quarantine: Array.isArray(current.quarantine)
      ? current.quarantine.filter((item) => Number.isSafeInteger(item) && item >= 1)
      : [],
  };
}

export async function activateRuntime(pointer, env = process.env) {
  if (!validRuntimePointer(pointer)) throw new Error('Runtime pointer is invalid');
  const paths = runtimePaths(env);
  const current = await readRuntimePointer('current', env);
  if (current && current.sha256 !== pointer.sha256) {
    await writeJsonAtomic(paths.previous, current, { mode: 0o600 });
  }
  await writeJsonAtomic(paths.current, pointer, { mode: 0o600 });
}

export async function rollbackRuntime(env = process.env) {
  const paths = runtimePaths(env);
  const [current, previous] = await Promise.all([
    readRuntimePointer('current', env),
    readRuntimePointer('previous', env),
  ]);
  if (!previous || !await runtimeReady(previous, env)) {
    throw new Error('No verified previous connector runtime is available');
  }
  await writeJsonAtomic(paths.current, previous, { mode: 0o600 });
  if (current) await writeJsonAtomic(paths.previous, current, { mode: 0o600 });
  return { current: previous, rolledBack: current };
}
