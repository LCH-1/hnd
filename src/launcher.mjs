import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { main as fallbackMain } from './cli.mjs';
import { VERSION as FALLBACK_RUNTIME_VERSION } from './constants.mjs';
import { useCliLanguage } from './cli-i18n.mjs';
import { LAUNCHER_VERSION } from './launcher-version.mjs';
import {
  applyConnectorUpdate,
  checkConnectorUpdate,
  checkServerVersion,
  connectorUpdateStatus,
  rollbackConnectorUpdate,
  updateDue,
} from './update/client.mjs';
import {
  readRuntimePointer,
  runtimeDirectory,
  runtimeReady,
} from './update/state.mjs';
import { refreshManagedSkillsAfterUpdate } from './update/integration.mjs';
import { checkLauncherRelease, checkServerRelease } from './update/registry.mjs';
import { applyNpmUpdate } from './update/npm.mjs';
import { describeClientUpdate, describeServerUpdate, describeLauncherUpdate, formatUpdateReport } from './update/report.mjs';
import './update/worker.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDirectory, '..');
const defaultBinPath = path.join(packageRoot, 'bin', 'hnd.mjs');
const publicKeyPath = path.join(packageRoot, 'assets', 'release-public-key.pem');
const workerPath = path.join(moduleDirectory, 'update', 'worker.mjs');

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeText(stream, value) {
  stream.write(String(value).endsWith('\n') ? String(value) : `${value}\n`);
}

function releaseDigest(release) {
  return release?.sha256 ?? release?.bundle?.sha256 ?? null;
}

function releaseDescriptor(release, { builtIn = false } = {}) {
  if (!release) return null;
  return {
    version: release.version,
    sequence: release.sequence ?? null,
    sha256: releaseDigest(release),
    builtIn,
  };
}

function withoutSignature(release) {
  if (!release) return release;
  const safe = { ...release };
  delete safe.signature;
  return safe;
}

async function importedRuntime(pointer, env, { verified = false } = {}) {
  if (!pointer || (!verified && !await runtimeReady(pointer, env))) return null;
  const entrypoint = path.join(runtimeDirectory(pointer, env), 'src', 'cli.mjs');
  const module = await import(`${pathToFileURL(entrypoint).href}?release=${pointer.sha256}`);
  if (typeof module.main !== 'function') throw new Error('Connector runtime has no CLI entrypoint');
  return { main: module.main, pointer };
}

async function selectRuntime(env) {
  const [current, previous] = await Promise.all([
    readRuntimePointer('current', env).catch(() => null),
    readRuntimePointer('previous', env).catch(() => null),
  ]);
  if (current) {
    let ready = null;
    try {
      ready = await runtimeReady(current, env);
    } catch {
      // A transient filesystem error is not proof that the active runtime is
      // corrupt. Fall back for this invocation without changing pointers.
    }
    if (ready) {
      try {
        const selected = await importedRuntime(current, env, { verified: true });
        if (selected) return selected;
      } catch {
        // A runtime that cannot even import is not a user-command failure. It
        // is safe to quarantine it and use a previous verified runtime.
        await rollbackConnectorUpdate(env, { expectedCurrent: current }).catch(() => {});
      }
    } else if (ready === false) {
      // A deterministic marker/hash failure should not be rechecked on every
      // command. Atomically switch to the verified previous runtime when one
      // exists, preserving the same quarantine behavior as an import failure.
      await rollbackConnectorUpdate(env, { expectedCurrent: current }).catch(() => {});
    }
  }
  if (previous) {
    try {
      const selected = await importedRuntime(previous, env);
      if (selected) {
        return selected;
      }
    } catch {
      // Fall through to the immutable runtime bundled with the launcher.
    }
  }
  return { main: fallbackMain, pointer: null };
}

function updateOptions(env, overrides = {}) {
  return {
    env,
    launcherVersion: LAUNCHER_VERSION,
    publicKeyPath,
    ...overrides,
  };
}

async function runUpdateCommand(argv, { env, stdout, stderr, fetchImpl = fetch, execPath, npmUpdate = applyNpmUpdate }) {
  const { language } = await useCliLanguage(env);
  const ko = language === 'ko';
  const args = argv.slice(1);
  const json = args.includes('--json');
  const filtered = args.filter((argument) => argument !== '--json');
  const action = filtered.shift() ?? 'status';
  if (filtered.length > 0) throw new Error(`알 수 없는 update 인수: ${filtered[0]}`);
  if (action === 'help' || action === '--help' || action === '-h') {
    writeText(stdout, ko ? [
      '사용법:',
      '  hnd update           npm 패키지·HND 실행 버전과 업데이트 상태 확인',
      '  hnd update check     최신 버전 확인',
      '  hnd update apply     HND 실행 버전·npm 패키지 업데이트',
      '  hnd update rollback  HND 실행 버전을 이전 버전으로 복구',
      '  hnd update --json    상세 진단 정보',
      '  npm install --global @lch-1/hnd@latest    npm 패키지 수동 업데이트',
      '',
      'npm 자동 업데이트가 불가능하면 수동 명령을 안내합니다.',
    ].join('\n') : [
      'Usage:',
      '  hnd update           Show npm package and HND execution versions and update status',
      '  hnd update check     Check for updates',
      '  hnd update apply     Update HND execution code and the npm package',
      '  hnd update rollback  Restore the previous HND execution version',
      '  hnd update --json    Detailed diagnostics',
      '  npm install --global @lch-1/hnd@latest    Update the npm package manually',
      '',
      'If automatic npm updating is unavailable, a manual command is shown.',
    ].join('\n'));
    return;
  }
  if (!['status', 'check', 'apply', 'rollback'].includes(action)) {
    throw new Error(`알 수 없는 update 작업: ${action}`);
  }
  let result;
  let operationError = null;
  if (action === 'rollback') result = await rollbackConnectorUpdate(env);
  else {
    // A failed version check must not erase the locally installed version or
    // present an unavailable/quarantined release as already up to date.
    result = await connectorUpdateStatus(env);
    const launcherCheck = checkLauncherRelease({ fetchImpl });
    // Server diagnostics stay opt-in for JSON compatibility, not on the normal
    // update path. A PC update no longer waits for GitHub server metadata.
    const serverVersionCheck = json ? checkServerVersion({ env, fetchImpl }) : {};
    const serverReleaseCheck = json ? checkServerRelease({ fetchImpl }) : {};
    try {
      const checked = action === 'apply'
        ? await applyConnectorUpdate(updateOptions(env, { fetchImpl }))
        : await checkConnectorUpdate(updateOptions(env, { fetchImpl, timeoutMs: 5_000 }));
      result = {
        ...result,
        ...checked,
        serverRelease: checked.manifest ?? null,
        serverCheckedAt: checked.configured ? new Date().toISOString() : null,
        serverError: null,
      };
    } catch (error) {
      operationError = error;
      result = {
        ...result,
        serverRelease: null,
        available: null,
        serverCheckedAt: null,
        serverError: error?.message || String(error),
      };
    }
    if (action === 'apply' && !operationError) {
      try {
        result.refreshedSkills = await refreshManagedSkillsAfterUpdate(result, env);
      } catch (error) {
        operationError = error;
        result.skillsRefreshError = error?.message || String(error);
      }
    }
    result = { ...result, ...await launcherCheck, ...await serverVersionCheck, ...await serverReleaseCheck };
    if (action === 'apply' && describeLauncherUpdate({ ...result, launcherVersion: LAUNCHER_VERSION }).needsUpdate) {
      if (!json) writeText(stderr, ko ? 'npm 패키지를 업데이트하고 있습니다…' : 'Updating the npm package…');
      result.npmInstall = await npmUpdate({
        latestVersion: result.launcherLatestVersion, packageRoot, env, execPath,
      });
    }
  }
  const activeRelease = action === 'apply' && result.pointer ? result.pointer : result.current;
  result = {
    ...result,
    launcherVersion: result.npmInstall?.version ?? LAUNCHER_VERSION,
    clientRelease: releaseDescriptor(
      activeRelease ?? { version: FALLBACK_RUNTIME_VERSION },
      { builtIn: !activeRelease },
    ),
    serverRelease: result.serverRelease ?? result.manifest ?? null,
  };
  if (action !== 'rollback') {
    result.clientUpdate = describeClientUpdate(result);
    result.launcherUpdate = describeLauncherUpdate(result);
    if (json) result.serverUpdate = describeServerUpdate(result);
  }
  if (json) {
    const safe = { ...result };
    delete safe.remote;
    safe.manifest = withoutSignature(safe.manifest);
    safe.serverRelease = withoutSignature(safe.serverRelease);
    writeJson(stdout, safe);
    if (operationError && action !== 'status') throw operationError;
    return;
  }
  if (action === 'rollback') {
    writeText(stdout, ko
      ? `HND 실행 버전\n로컬 버전: ${result.current.version}\n복구 상태: 이전 버전으로 복구 완료`
      : `HND execution version\nLocal version: ${result.current.version}\nRecovery status: previous version restored`);
  } else {
    writeText(stdout, formatUpdateReport(result, { action, ko }));
    if (result.skillsRefreshError) writeText(stderr, ko
      ? '스킬 갱신 실패. 다시 시도: hnd update apply'
      : 'Skill refresh failed. Retry: hnd update apply');
    if (operationError && action !== 'status') throw operationError;
  }
}

export async function scheduleAutomaticUpdate(env, {
  spawnImpl = spawn,
  execPath = process.execPath,
} = {}) {
  if (env.HND_DISABLE_AUTO_UPDATE === '1' || !await updateDue({ env })) return false;
  const child = spawnImpl(execPath, [workerPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  // ChildProcess reports spawn failures asynchronously. Without a listener an
  // unavailable executable or exhausted process table becomes an uncaught
  // exception in the foreground hnd command.
  child.once('error', () => {});
  child.unref?.();
  return true;
}

export async function launcherMain(argv = process.argv.slice(2), {
  env = process.env,
  cwd = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  execPath = process.execPath,
  binPath = defaultBinPath,
  fetchImpl = fetch,
  npmUpdate = applyNpmUpdate,
} = {}) {
  if (argv[0] === 'update') {
    await runUpdateCommand(argv, { env, stdout, stderr, fetchImpl, execPath, npmUpdate });
    return;
  }
  const runtime = await selectRuntime(env);
  scheduleAutomaticUpdate(env, { execPath }).catch(() => {});
  return runtime.main(argv, {
    env,
    cwd,
    stdin,
    stdout,
    stderr,
    execPath,
    // Hooks always retain this permanent launcher path, never a versioned
    // cache directory, so future releases can switch underneath them.
    binPath,
  });
}
