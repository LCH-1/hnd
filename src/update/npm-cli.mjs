import fs from 'node:fs/promises';
import path from 'node:path';

import { cliLanguage } from '../cli-i18n.mjs';
import { applyNpmUpdate } from './npm.mjs';
import { checkLauncherRelease } from './registry.mjs';
import { describeLauncherUpdate, formatNpmUpdateReport } from './report.mjs';

export async function runNpmCommand(action, {
  env = process.env,
  execPath = process.execPath,
  binPath,
  stdout = process.stdout,
  stderr = process.stderr,
  jsonOutput = false,
  fetchImpl = fetch,
  npmUpdate = applyNpmUpdate,
} = {}) {
  const ko = cliLanguage() === 'ko';
  // A downloaded runtime has its own package version. Read the permanent
  // launcher instead, resolving the symlink created by a global npm install.
  const packageRoot = path.resolve(path.dirname(await fs.realpath(binPath)), '..');
  const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const result = {
    launcherVersion: metadata.version,
    ...await checkLauncherRelease({ fetchImpl }),
  };
  result.launcherUpdate = describeLauncherUpdate(result);
  if (action === 'update') {
    if (result.launcherUpdate.status === 'check_failed') {
      result.npmInstall = { status: 'skipped', reason: 'check_failed' };
    } else if (result.launcherUpdate.needsUpdate) {
      if (!jsonOutput) stderr.write(ko ? 'npm 패키지를 업데이트하고 있습니다…\n' : 'Updating the npm package…\n');
      result.npmInstall = await npmUpdate({
        latestVersion: result.launcherLatestVersion, packageRoot, env, execPath,
      });
      result.launcherVersion = result.npmInstall.version ?? result.launcherVersion;
      result.launcherUpdate = describeLauncherUpdate(result);
    } else {
      result.npmInstall = { status: 'current', version: result.launcherVersion };
    }
  }
  stdout.write(jsonOutput
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${formatNpmUpdateReport(result, { action, ko })}\n`);
  if (['failed', 'skipped'].includes(result.npmInstall?.status)) {
    throw Object.assign(new Error(ko
      ? 'npm 패키지를 업데이트하지 못했습니다.'
      : 'Could not update the npm package.'), { exitCode: 1 });
  }
  return result;
}
