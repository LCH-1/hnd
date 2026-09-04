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

function releaseLabel(release, { ko, builtIn = false } = {}) {
  if (!release) return ko ? '확인되지 않음' : 'unknown';
  if (builtIn) return ko ? `${release.version} · npm 내장` : `${release.version} · npm built-in`;
  const digest = releaseDigest(release);
  return [
    release.version,
    release.sequence === undefined || release.sequence === null
      ? null
      : (ko ? `릴리스 ${release.sequence}` : `release ${release.sequence}`),
    digest ? digest.slice(0, 12) : null,
  ].filter(Boolean).join(' · ');
}

function sameRelease(left, right) {
  const leftDigest = releaseDigest(left);
  const rightDigest = releaseDigest(right);
  return Boolean(leftDigest && rightDigest && leftDigest === rightDigest);
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
      '  hnd update status',
      '  hnd update check',
      '  hnd update apply',
      '  hnd update rollback',
      '',
      'hnd 명령을 실행할 때 마지막 확인 시도 후 6시간이 지났으면 짧은 백그라운드 확인을 시작합니다. 계속 실행되는 업데이트 프로그램은 없습니다. 서버가 꺼져 있으면 마지막 정상 버전을 계속 사용합니다.',
    ].join('\n') : [
      'Usage:',
      '  hnd update status',
      '  hnd update check',
      '  hnd update apply',
      '  hnd update rollback',
      '',
      'HND starts a short background check when the last attempt was more than 6 hours ago. No updater runs continuously. If the server is unavailable, the last verified version remains active.',
    ].join('\n'));
    return;
  }
  if (!['status', 'check', 'apply', 'rollback'].includes(action)) {
    throw new Error(`알 수 없는 update 작업: ${action}`);
  }
  let result;
  if (action === 'status') {
    result = await connectorUpdateStatus(env);
    if (result.configured) {
      try {
        const checked = await checkConnectorUpdate(updateOptions(env, { fetchImpl, timeoutMs: 5_000 }));
        result = {
          ...result,
          serverRelease: checked.manifest,
          available: checked.available,
          quarantined: checked.quarantined,
          serverCheckedAt: new Date().toISOString(),
          serverError: null,
        };
      } catch (error) {
        result = {
          ...result,
          serverRelease: null,
          available: null,
          serverCheckedAt: null,
          serverError: error?.message || String(error),
        };
      }
    }
  }
  else if (action === 'check') result = await checkConnectorUpdate(updateOptions(env, { fetchImpl }));
  else if (action === 'apply') {
    result = await applyConnectorUpdate(updateOptions(env, { fetchImpl }));
    result = {
      ...result,
      refreshedSkills: await refreshManagedSkillsAfterUpdate(result, env),
    };
  }
  else result = await rollbackConnectorUpdate(env);
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
  if (json) {
    const safe = { ...result };
    delete safe.remote;
    safe.manifest = withoutSignature(safe.manifest);
    safe.serverRelease = withoutSignature(safe.serverRelease);
    writeJson(stdout, safe);
    return;
  }
  if (action === 'status') {
    writeText(stdout, ko ? [
      `중앙 서버: ${result.configured ? `연결됨 (${result.server})` : 'PC 연결 후 확인 가능'}`,
      `npm 런처: ${result.launcherVersion}`,
      `로컬 런타임: ${releaseLabel(result.clientRelease, { ko: true, builtIn: result.clientRelease.builtIn })}`,
      `서버 제공 런타임: ${!result.configured ? 'PC 연결 후 확인 가능' : result.serverError ? `확인 실패 (${result.serverError})` : releaseLabel(result.serverRelease, { ko: true })}`,
      `업데이트 상태: ${!result.configured ? '중앙 서버에 PC 연결 필요' : result.serverError ? '서버 확인 실패 · 로컬 런타임은 계속 사용 가능' : result.available ? '업데이트 가능' : '최신 · 로컬 런타임과 서버가 일치함'}`,
      `이전 런타임: ${releaseLabel(result.previous, { ko: true })}`,
      `최근 확인: ${result.update?.lastCheckedAt ?? '아직 없음'}`,
      result.lastError ? `최근 오류: ${result.lastError.message}` : '최근 오류: 없음',
    ].join('\n') : [
      `Central server: ${result.configured ? `connected (${result.server})` : 'available after PC connection'}`,
      `npm launcher: ${result.launcherVersion}`,
      `Local runtime: ${releaseLabel(result.clientRelease, { ko: false, builtIn: result.clientRelease.builtIn })}`,
      `Server runtime: ${!result.configured ? 'available after PC connection' : result.serverError ? `check failed (${result.serverError})` : releaseLabel(result.serverRelease, { ko: false })}`,
      `Update state: ${!result.configured ? 'connect this PC to the central server' : result.serverError ? 'server check failed; the local runtime remains usable' : result.available ? 'update available' : 'current; local runtime and server match'}`,
      `Previous runtime: ${releaseLabel(result.previous, { ko: false })}`,
      `Last check: ${result.update?.lastCheckedAt ?? 'never'}`,
      result.lastError ? `Last error: ${result.lastError.message}` : 'Last error: none',
    ].join('\n'));
  } else if (action === 'check') {
    if (!result.configured) {
      writeText(stdout, ko
        ? '이 PC를 HND 서버에 먼저 연결하세요.'
        : 'Connect this PC to the HND server first.');
    } else {
      writeText(stdout, (ko ? [
        `로컬 런타임: ${releaseLabel(result.clientRelease, { ko: true, builtIn: result.clientRelease.builtIn })}`,
        `서버 제공 런타임: ${releaseLabel(result.serverRelease, { ko: true })}`,
        `확인 결과: ${result.available ? '업데이트 가능' : '최신 · 로컬 런타임과 서버가 일치함'}`,
      ] : [
        `Local runtime: ${releaseLabel(result.clientRelease, { ko: false, builtIn: result.clientRelease.builtIn })}`,
        `Server runtime: ${releaseLabel(result.serverRelease, { ko: false })}`,
        `Result: ${result.available ? 'update available' : 'current; local runtime and server match'}`,
      ]).join('\n'));
    }
  } else if (action === 'apply') {
    if (!result.configured) {
      writeText(stdout, ko
        ? '이 PC는 HND 서버에 연결되지 않아 업데이트할 수 없습니다. 웹의 [기기 → PC 연결]에서 새 명령을 만든 뒤 먼저 연결하세요.'
        : 'This PC is not connected to an HND server. Create a new command under [Devices → Connect PC] and connect it first.');
    } else {
      writeText(stdout, (ko ? [
        result.installed ? '업데이트 완료' : '변경 없음',
        `로컬 런타임: ${releaseLabel(result.clientRelease, { ko: true, builtIn: result.clientRelease.builtIn })}`,
        `서버 제공 런타임: ${releaseLabel(result.serverRelease, { ko: true })}`,
        `적용 상태: ${sameRelease(result.clientRelease, result.serverRelease) ? '일치함' : '일치하지 않음'}`,
      ] : [
        result.installed ? 'Update complete' : 'No changes',
        `Local runtime: ${releaseLabel(result.clientRelease, { ko: false, builtIn: result.clientRelease.builtIn })}`,
        `Server runtime: ${releaseLabel(result.serverRelease, { ko: false })}`,
        `Applied state: ${sameRelease(result.clientRelease, result.serverRelease) ? 'matching' : 'not matching'}`,
      ]).join('\n'));
    }
  } else {
    writeText(stdout, ko
      ? `이전 버전으로 전환했습니다: ${result.current.version}`
      : `Rolled back to the previous version: ${result.current.version}`);
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
