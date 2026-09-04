import fs from 'node:fs/promises';
import path from 'node:path';

import { MANAGED_SKILL_MARKER } from '../adapters/common.mjs';
import { readJson, readText, writeTextAtomic } from '../core/fs.mjs';
import { agentPaths } from '../paths.mjs';
import {
  runtimeDirectory as runtimeDirectoryForPointer,
  runtimeReady,
  validRuntimePointer,
} from './state.mjs';

const MAX_SKILL_BYTES = 256 * 1024;

function validCompletionMarker(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 3
    && Object.hasOwn(value, 'schemaVersion')
    && Object.hasOwn(value, 'release')
    && Object.hasOwn(value, 'files')
    && value.schemaVersion === 1
    && validRuntimePointer(value.release)
    && Array.isArray(value.files);
}

async function readReleaseSkill(runtimeDirectory, env) {
  if (typeof runtimeDirectory !== 'string' || !path.isAbsolute(runtimeDirectory)) {
    throw new Error('Connector runtime directory is invalid');
  }
  const root = path.resolve(runtimeDirectory);
  const marker = await readJson(path.join(root, '.complete'), {
    validate: validCompletionMarker,
  });
  if (path.resolve(runtimeDirectoryForPointer(marker.release, env)) !== root) {
    throw new Error('Connector runtime directory does not match its verified release');
  }
  if (!await runtimeReady(marker.release, env)) {
    throw new Error('Connector runtime completion marker or file integrity is invalid');
  }
  const source = path.join(root, 'assets', 'hnd-handoff', 'SKILL.md');
  const [rootMetadata, sourceMetadata] = await Promise.all([
    fs.lstat(root),
    fs.lstat(source),
  ]);
  if (
    !rootMetadata.isDirectory()
    || rootMetadata.isSymbolicLink()
    || !sourceMetadata.isFile()
    || sourceMetadata.isSymbolicLink()
    || sourceMetadata.size > MAX_SKILL_BYTES
  ) throw new Error('Connector runtime skill is unsafe');
  const content = await fs.readFile(source, 'utf8');
  if (!content.includes(MANAGED_SKILL_MARKER)) {
    throw new Error('Connector runtime skill has no managed marker');
  }
  return content;
}

export async function refreshManagedSkills(runtimeDirectory, env = process.env) {
  const desired = await readReleaseSkill(runtimeDirectory, env);
  const paths = agentPaths(env);
  const updated = [];
  for (const agent of ['claude', 'codex', 'cursor']) {
    const target = paths[agent].skill;
    const current = await readText(target, { optional: true });
    // Never install a new integration or take over an unmanaged file during a
    // background update. Initial setup remains an explicit user action.
    if (current === null || !current.includes(MANAGED_SKILL_MARKER) || current === desired) {
      continue;
    }
    await writeTextAtomic(target, desired, { mode: 0o600 });
    updated.push(Object.freeze({ agent, path: target }));
  }
  return Object.freeze(updated);
}
