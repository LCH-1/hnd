import path from 'node:path';
import { APP_SETTINGS_DEFAULTS, APP_SETTINGS_PATH, effectiveAppSettings, validAppSettings } from '../shared/app-settings.mjs';
import { statePaths } from '../paths.mjs';
import { readJson, withFileLock, writeJsonAtomic } from './fs.mjs';

export async function readAppSettings({ env = process.env, localConfig = {} } = {}) {
  const stored = await readJson(path.join(statePaths(env).home, APP_SETTINGS_PATH), {
    optional: true, validate: validAppSettings,
  });
  return effectiveAppSettings(stored || {}, localConfig);
}

// Preserve legacy device-only settings until the workspace has adopted shared
// preferences. Afterwards the existing CLI toggles edit that same preference.
export async function updateExistingAppSettings(patch, { env = process.env } = {}) {
  const values = Object.fromEntries(Object.entries(patch).filter(([key]) => Object.hasOwn(APP_SETTINGS_DEFAULTS, key)));
  if (!Object.keys(values).length) return;
  if (!validAppSettings({ ...values, schemaVersion: 1 })) throw new TypeError('Invalid app settings');
  const paths = statePaths(env);
  await withFileLock(path.join(paths.locks, 'app-settings.lock'), async () => {
    const file = path.join(paths.home, APP_SETTINGS_PATH);
    const current = await readJson(file, { optional: true, validate: validAppSettings });
    if (current) await writeJsonAtomic(file, { ...current, ...values });
  });
}
