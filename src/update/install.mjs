import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { ensureDirectory } from '../core/fs.mjs';
import { validateConnectorBundle } from './manifest.mjs';
import {
  activateRuntime,
  runtimeDirectory,
  runtimePaths,
  runtimeReady,
} from './state.mjs';

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function writeReleaseFile(root, file) {
  const target = path.resolve(root, ...file.path.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Connector file escapes its release directory: ${file.path}`);
  }
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await fs.open(target, 'wx', file.mode);
    await handle.writeFile(file.content);
    await handle.sync();
    await handle.close();
    handle = null;
    if (process.platform !== 'win32') await fs.chmod(target, file.mode);
  } finally {
    await handle?.close();
  }
}

export async function smokeConnectorRuntime(directory, {
  execPath = process.execPath,
  timeoutMs = 10_000,
} = {}) {
  const entrypoint = path.join(directory, 'src', 'cli.mjs');
  const url = pathToFileURL(entrypoint).href;
  await new Promise((resolve, reject) => {
    const child = spawn(execPath, [
      '--input-type=module',
      '--eval',
      `const module = await import(${JSON.stringify(url)}); if (typeof module.main !== 'function') process.exit(2);`,
    ], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Connector runtime smoke test timed out'));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Connector runtime smoke test failed (${signal || code})`));
    });
  });
}

export async function installConnectorBundle(manifest, bundleBytes, {
  env = process.env,
  smoke = smokeConnectorRuntime,
} = {}) {
  const bundle = validateConnectorBundle(bundleBytes, manifest);
  const paths = runtimePaths(env);
  await ensureDirectory(paths.root, 0o700);
  await ensureDirectory(paths.releases, 0o700, { trustedRoot: paths.root });
  const pointer = Object.freeze({
    schemaVersion: 1,
    sequence: manifest.sequence,
    version: manifest.version,
    sha256: manifest.bundle.sha256,
  });
  const releaseDirectory = runtimeDirectory(pointer, env);

  if (await runtimeReady(pointer, env)) {
    await activateRuntime(pointer, env);
    return { installed: false, reused: true, pointer, directory: releaseDirectory };
  }

  const staging = path.join(paths.root, `.staging-${process.pid}-${randomUUID()}`);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    for (const file of bundle.files) await writeReleaseFile(staging, file);
    await smoke(staging);
    const marker = path.join(staging, '.complete');
    const markerHandle = await fs.open(marker, 'wx', 0o600);
    try {
      await markerHandle.writeFile(`${JSON.stringify({
        schemaVersion: 1,
        release: pointer,
        files: bundle.files.map(({ path: filePath, size, sha256 }) => ({
          path: filePath,
          size,
          sha256,
        })),
      })}\n`, 'utf8');
      await markerHandle.sync();
    } finally {
      await markerHandle.close();
    }
    await syncDirectory(staging);
    if (!await runtimeReady(pointer, env)) {
      try {
        const existing = await fs.lstat(releaseDirectory);
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          throw new Error('Existing connector release path is unsafe');
        }
        const rejected = path.join(
          paths.root,
          `.rejected-${pointer.sha256}-${randomUUID()}`,
        );
        await fs.rename(releaseDirectory, rejected);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    try {
      await fs.rename(staging, releaseDirectory);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code) || !await runtimeReady(pointer, env)) {
        throw error;
      }
    }
    await syncDirectory(paths.releases);
    await activateRuntime(pointer, env);
    return { installed: true, reused: false, pointer, directory: releaseDirectory };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
