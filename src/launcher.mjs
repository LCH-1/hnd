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
import { checkLauncherRelease } from './update/registry.mjs';
import { describeClientUpdate, formatUpdateReport } from './update/report.mjs';
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

async function runUpdateCommand(argv, { env, stdout, stderr, fetchImpl = fetch }) {
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
      '  hnd update status    현재·최신 클라이언트와 npm 런처 버전, 필요한 명령 확인',
      '  hnd update check     연결된 서버와 npm 공식 registry에서 최신 정보 조회',
      '  hnd update apply     이 PC의 클라이언트 업데이트 (서버는 변경하지 않음)',
      '  hnd update rollback  이전 정상 클라이언트로 복구하고 문제 릴리스 적용 차단',
      '  npm install --global @lch-1/hnd@latest    npm 런처 업데이트',
      '',
      '서버 프로그램은 서버 관리자가 별도로 배포합니다: docs/DEPLOYMENT.md',
      '서버 자체 버전과 최신 서버 릴리스는 현재 조회 기능이 없습니다. 서버가 제공하는 클라이언트 버전과 구분합니다.',
      '',
      'hnd 명령을 실행할 때 마지막 확인 시도 후 6시간이 지났으면 짧은 백그라운드 확인을 시작합니다. 계속 실행되는 업데이트 프로그램은 없습니다. 서버가 꺼져 있으면 마지막 정상 버전을 계속 사용합니다.',
    ].join('\n') : [
      'Usage:',
      '  hnd update status    Show installed/latest client and npm launcher versions and next steps',
      '  hnd update check     Check the connected server and official npm registry',
      '  hnd update apply     Update this PC client (does not update the server)',
      '  hnd update rollback  Restore the previous client and block the problematic release',
      '  npm install --global @lch-1/hnd@latest    Update the npm launcher',
      '',
      'Server administrators deploy the server separately: docs/DEPLOYMENT.md',
      'Server program and latest server release versions are not currently exposed; the client release offered by the server is separate.',
      '',
      'HND starts a short background check when the last attempt was more than 6 hours ago. No updater runs continuously. If the server is unavailable, the last verified version remains active.',
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
    result = { ...result, ...await launcherCheck };
  }
  const activeRelease = action === 'apply' && result.pointer ? result.pointer : result.current;
  result = {
    ...result,
    launcherVersion: LAUNCHER_VERSION,
    clientRelease: releaseDescriptor(
      activeRelease ?? { version: FALLBACK_RUNTIME_VERSION },
      { builtIn: !activeRelease },
    ),
    serverRelease: result.serverRelease ?? result.manifest ?? null,
  };
  if (action !== 'rollback') result.clientUpdate = describeClientUpdate(result);
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
      ? `이전 정상 클라이언트로 복구했습니다: ${result.current.version}\n문제가 있던 릴리스는 다시 적용하지 않습니다.\n다음 단계: hnd update check`
      : `Restored the previous verified client: ${result.current.version}\nThe problematic release will not be reapplied.\nNext: hnd update check`);
  } else {
    writeText(stdout, formatUpdateReport(result, { action, ko }));
    if (result.skillsRefreshError) writeText(stderr, ko
      ? '클라이언트 버전 확인/적용은 끝났지만 기존 스킬 갱신에 실패했습니다. hnd update apply로 다시 시도하세요.'
      : 'Client processing finished, but managed skill refresh failed. Retry with hnd update apply.');
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
} = {}) {
  if (argv[0] === 'update') {
    await runUpdateCommand(argv, { env, stdout, stderr, fetchImpl });
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
