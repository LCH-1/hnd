import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAUNCHER_VERSION } from '../launcher-version.mjs';
import { applyConnectorUpdate, recordUpdateError } from './client.mjs';
import { refreshManagedSkills } from './integration.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicKeyPath = path.resolve(moduleDirectory, '..', '..', 'assets', 'release-public-key.pem');

export async function runUpdateWorker({ env = process.env } = {}) {
  try {
    const result = await applyConnectorUpdate({
      env,
      launcherVersion: LAUNCHER_VERSION,
      publicKeyPath,
      timeoutMs: 15_000,
      lockTimeoutMs: 250,
    });
    const refreshedSkills = result.directory
      ? await refreshManagedSkills(result.directory, env)
      : [];
    return { ...result, refreshedSkills };
  } catch (error) {
    // Background updates never block a coding-agent session. Keep the failure
    // locally so `hnd update status` can explain it without noisy hook output.
    await recordUpdateError(error, env).catch(() => {});
    return { installed: false, error: error?.message || String(error) };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runUpdateWorker();
}
