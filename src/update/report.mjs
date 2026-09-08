import { versionAtLeast } from './manifest.mjs';

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

function launcherReport(result, ko) {
  const current = result.launcherVersion;
  const latest = result.launcherLatestVersion;
  const known = Boolean(current && latest && !result.launcherCheckError);
  if (!known) {
    return ko ? [
      'npm 버전 확인 실패',
      '확인: npm view @lch-1/hnd version',
    ] : [
      'npm version check failed',
      'Check: npm view @lch-1/hnd version',
    ];
  }
  if (versionAtLeast(current, latest)) return [];
  return ko ? [
    `npm 업데이트 가능: ${current} → ${latest}`,
    '업데이트: npm install --global @lch-1/hnd@latest',
  ] : [
    `npm update available: ${current} → ${latest}`,
    'Update: npm install --global @lch-1/hnd@latest',
  ];
}

export function formatUpdateReport(result, { action = 'status', ko = false } = {}) {
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
    `로컬 버전: ${releaseLabel(result.clientRelease, true)}`,
    `최신 버전: ${latest}`,
    `업데이트 상태: ${statuses[state.status]}`,
  ] : [
    `Local version: ${releaseLabel(result.clientRelease, false)}`,
    `Latest version: ${latest}`,
    `Update status: ${statuses[state.status]}`,
  ];
  const next = ko ? {
    not_connected: '연결: 웹의 [기기 → PC 연결]에서 안내하는 명령을 실행하세요.',
    check_failed: '다시 확인: hnd update check',
    blocked: '이전에 실패하거나 되돌린 버전입니다. 관리자에게 새 버전을 요청하세요.',
    update_available: '업데이트: hnd update apply',
  } : {
    not_connected: 'Connect: run the command from [Devices → Connect PC] on the web.',
    check_failed: 'Retry: hnd update check',
    blocked: 'This version previously failed or was rolled back. Ask the administrator for a new version.',
    update_available: 'Update: hnd update apply',
  };
  if (next[state.status]) lines.push(next[state.status]);
  const launcher = launcherReport(result, ko);
  if (launcher.length) lines.push('', ...launcher);
  return lines.join('\n');
}
