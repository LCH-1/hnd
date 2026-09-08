import { versionAtLeast } from './manifest.mjs';
import { NPM_UPDATE_COMMAND } from './npm.mjs';

function digest(release) {
  return release?.sha256 ?? release?.bundle?.sha256 ?? null;
}

function sameRelease(left, right) {
  return Boolean(digest(left) && digest(left) === digest(right));
}

export function describeClientUpdate(result) {
  if (!result.configured) {
    return { status: 'not_connected', needsUpdate: null, reason: 'not_connected' };
  }
  // Quarantine deliberately makes `available` false. It never means current.
  if (result.quarantined) {
    return { status: 'blocked', needsUpdate: null, reason: 'quarantined' };
  }
  if (result.serverError || !result.serverRelease) {
    return { status: 'check_failed', needsUpdate: null, reason: 'server_check_failed' };
  }
  const matching = sameRelease(result.clientRelease, result.serverRelease);
  // `available` describes the pre-install check, not the resulting installation.
  if (result.installed && matching) {
    return { status: 'current', needsUpdate: false, reason: 'current' };
  }
  if (result.available || !matching) {
    return {
      status: 'update_available',
      needsUpdate: true,
      reason: matching ? 'repair_required' : 'new_release',
    };
  }
  return { status: 'current', needsUpdate: false, reason: 'current' };
}

function releaseLabel(release, ko) {
  return release?.version ?? (ko ? '확인 불가' : 'unknown');
}

function compareVersions(current, latest) {
  if (!current || !latest) return { status: 'check_failed', needsUpdate: null };
  if (!versionAtLeast(current, latest)) return { status: 'update_available', needsUpdate: true };
  return { status: versionAtLeast(latest, current) ? 'current' : 'ahead', needsUpdate: false };
}

export function describeLauncherUpdate(result) {
  if (result.launcherCheckError) return { status: 'check_failed', needsUpdate: null };
  return compareVersions(result.launcherVersion, result.launcherLatestVersion);
}

export function describeServerUpdate(result) {
  if (['not_connected', 'unsupported', 'check_failed'].includes(result.serverVersionStatus)) {
    return { status: result.serverVersionStatus, needsUpdate: null };
  }
  if (result.serverVersionError || !result.serverVersion) return { status: 'check_failed', needsUpdate: null };
  if (result.serverReleaseStatus === 'not_published') return { status: 'not_published', needsUpdate: null };
  if (result.serverReleaseError) return { status: 'check_failed', needsUpdate: null };
  return compareVersions(result.serverVersion, result.serverLatestVersion);
}

function versionSection(title, current, latest, state, ko) {
  const labels = ko ? {
    current: '최신', ahead: '공개 버전보다 높음', update_available: '업데이트 가능',
    check_failed: '확인 실패', not_connected: '연결 필요',
  } : {
    current: 'up to date', ahead: 'ahead of public version', update_available: 'update available',
    check_failed: 'check failed', not_connected: 'connection required',
  };
  return [title, ...(ko ? [
    `로컬 버전: ${releaseLabel({ version: current }, ko)}`,
    `최신 버전: ${releaseLabel({ version: latest }, ko)}`,
    `업데이트 상태: ${labels[state.status]}`,
  ] : [
    `Local version: ${releaseLabel({ version: current }, ko)}`,
    `Latest version: ${releaseLabel({ version: latest }, ko)}`,
    `Update status: ${labels[state.status]}`,
  ])];
}

function launcherReport(result, ko) {
  const state = describeLauncherUpdate(result);
  const lines = versionSection(ko ? 'npm 패키지' : 'npm package', result.launcherVersion,
    result.launcherCheckError ? null : result.launcherLatestVersion, state, ko);
  if (state.needsUpdate) lines.push(ko
    ? `업데이트: ${NPM_UPDATE_COMMAND}`
    : `Update: ${NPM_UPDATE_COMMAND}`);
  if (state.status === 'check_failed') lines.push(ko
    ? '다시 확인: npm view @lch-1/hnd version'
    : 'Retry: npm view @lch-1/hnd version');
  return lines;
}

function applyReport(result, ko) {
  const client = describeClientUpdate(result);
  const npm = describeLauncherUpdate(result);
  const changed = Boolean(result.installed || result.npmInstall?.status === 'updated' || result.refreshedSkills?.length);
  const npmFailed = ['failed', 'skipped'].includes(result.npmInstall?.status);
  if (!changed && !result.skillsRefreshError && !npmFailed && client.status === 'current' && npm.status === 'current') {
    return ko ? '모두 최신 버전입니다.' : 'Everything is up to date.';
  }
  const lines = [];
  if (result.installed && client.status === 'current') lines.push(ko
    ? `HND 실행 버전 업데이트 완료: ${result.clientRelease.version}`
    : `HND execution version updated: ${result.clientRelease.version}`);
  if (result.npmInstall?.status === 'updated') lines.push(ko
    ? `npm 패키지 업데이트 완료: ${result.launcherVersion}`
    : `npm package updated: ${result.launcherVersion}`);
  if (result.refreshedSkills?.length) lines.push(ko ? '에이전트 스킬을 갱신했습니다.' : 'Agent skills refreshed.');
  if (client.status === 'current' && !changed) lines.push(ko ? 'HND 실행 버전은 최신입니다.' : 'HND execution version is up to date.');
  if (client.status !== 'current') {
    const status = ko ? {
      not_connected: 'HND 실행 버전을 확인하려면 기기를 연결하세요.',
      check_failed: 'HND 실행 버전 업데이트에 실패했습니다.',
      blocked: 'HND 실행 버전 업데이트가 차단됐습니다.',
      update_available: 'HND 실행 버전 업데이트가 필요합니다.',
    } : {
      not_connected: 'Connect this device to check the HND execution version.',
      check_failed: 'HND execution update failed.',
      blocked: 'HND execution update is blocked.',
      update_available: 'HND execution update is required.',
    };
    lines.push(status[client.status], clientNextStep(client.status, ko));
  }
  if (npm.needsUpdate || npmFailed) {
    const reasons = ko ? {
      permission: '권한 부족', npm_missing: 'npm을 찾을 수 없음', not_global: '전역 npm 설치본이 아님',
      busy: '다른 업데이트가 진행 중', timeout: '시간 초과', verification_failed: '설치 확인 실패',
      install_failed: '설치 실패', check_failed: '버전 확인 실패',
    } : {
      permission: 'insufficient permissions', npm_missing: 'npm not found', not_global: 'not a global npm installation',
      busy: 'another update is running', timeout: 'timed out', verification_failed: 'installation verification failed',
      install_failed: 'installation failed', check_failed: 'version check failed',
    };
    lines.push(npmFailed
      ? (ko ? `npm 패키지 자동 업데이트를 하지 못했습니다 (${reasons[result.npmInstall.reason] ?? reasons.install_failed}).`
        : `Could not update the npm package automatically (${reasons[result.npmInstall.reason] ?? reasons.install_failed}).`)
      : (ko ? 'npm 패키지 업데이트가 필요합니다.' : 'The npm package needs an update.'));
    lines.push(`${ko ? '업데이트' : 'Update'}: ${NPM_UPDATE_COMMAND}`);
  } else if (npm.status === 'check_failed') {
    lines.push(ko ? 'npm 최신 버전을 확인하지 못했습니다.' : 'Could not check the latest npm package version.');
    lines.push(ko ? '다시 확인: npm view @lch-1/hnd version' : 'Retry: npm view @lch-1/hnd version');
  } else if (npm.status === 'ahead') {
    lines.push(ko ? 'npm 패키지가 공개된 최신 버전보다 높아 유지했습니다.' : 'The npm package is ahead of the public version and was kept.');
  }
  return lines.join('\n');
}

function clientNextStep(status, ko) {
  return (ko ? {
    not_connected: '연결: 웹의 [기기 → PC 연결]에서 안내하는 명령을 실행하세요.',
    check_failed: '다시 시도: hnd update apply',
    blocked: '이전에 실패하거나 되돌린 버전입니다. 관리자에게 새 버전을 요청하세요.',
    update_available: '업데이트: hnd update apply',
  } : {
    not_connected: 'Connect: run the command from [Devices → Connect PC] on the web.',
    check_failed: 'Retry: hnd update apply',
    blocked: 'This version previously failed or was rolled back. Ask the administrator for a new version.',
    update_available: 'Update: hnd update apply',
  })[status];
}

export function formatUpdateReport(result, { action = 'status', ko = false } = {}) {
  if (action === 'apply') return applyReport(result, ko);
  const state = describeClientUpdate(result);
  const latest = ['not_connected', 'check_failed'].includes(state.status)
    ? releaseLabel(null, ko) : releaseLabel(result.serverRelease, ko);
  const statuses = ko ? {
    not_connected: '연결 필요',
    check_failed: '확인 실패',
    blocked: '업데이트 차단',
    update_available: state.reason === 'repair_required'
      ? '재설치 필요' : '업데이트 가능',
    current: action === 'apply' && result.installed ? '업데이트 완료' : '최신',
  } : {
    not_connected: 'connection required',
    check_failed: 'check failed',
    blocked: 'update blocked',
    update_available: state.reason === 'repair_required'
      ? 'reinstall required' : 'update available',
    current: action === 'apply' && result.installed ? 'updated' : 'up to date',
  };
  const lines = ko ? [
    'HND 실행 버전',
    `로컬 버전: ${releaseLabel(result.clientRelease, true)}`,
    `최신 버전: ${latest}`,
    `업데이트 상태: ${statuses[state.status]}`,
  ] : [
    'HND execution version',
    `Local version: ${releaseLabel(result.clientRelease, false)}`,
    `Latest version: ${latest}`,
    `Update status: ${statuses[state.status]}`,
  ];
  const next = state.status === 'check_failed'
    ? (ko ? '다시 확인: hnd update check' : 'Retry: hnd update check') : clientNextStep(state.status, ko);
  if (next) lines.push(next);
  return [...launcherReport(result, ko), '', ...lines].join('\n');
}
