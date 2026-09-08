import { versionAtLeast } from './manifest.mjs';
import { SERVER_RELEASES_URL } from './registry.mjs';

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

function versionSection(title, current, latest, state, ko, { server = false } = {}) {
  const labels = ko ? {
    current: '최신', ahead: '공개 버전보다 높음', update_available: '업데이트 가능',
    check_failed: '확인 실패', not_connected: '연결 필요',
    unsupported: '버전 조회 미지원', not_published: '공식 버전 미등록',
  } : {
    current: 'up to date', ahead: 'ahead of public version', update_available: 'update available',
    check_failed: 'check failed', not_connected: 'connection required',
    unsupported: 'version lookup unsupported', not_published: 'no official release',
  };
  return [title, ...(ko ? [
    `${server ? '설치' : '로컬'} 버전: ${releaseLabel({ version: current }, ko)}`,
    `최신 버전: ${releaseLabel({ version: latest }, ko)}`,
    `업데이트 상태: ${labels[state.status]}`,
  ] : [
    `${server ? 'Installed' : 'Local'} version: ${releaseLabel({ version: current }, ko)}`,
    `Latest version: ${releaseLabel({ version: latest }, ko)}`,
    `Update status: ${labels[state.status]}`,
  ])];
}

function launcherReport(result, ko) {
  const state = describeLauncherUpdate(result);
  const lines = versionSection(ko ? '클라이언트 (npm)' : 'Client (npm)', result.launcherVersion,
    result.launcherCheckError ? null : result.launcherLatestVersion, state, ko);
  if (state.needsUpdate) lines.push(ko
    ? '업데이트: npm install --global @lch-1/hnd@latest'
    : 'Update: npm install --global @lch-1/hnd@latest');
  if (state.status === 'check_failed') lines.push(ko
    ? '다시 확인: npm view @lch-1/hnd version'
    : 'Retry: npm view @lch-1/hnd version');
  return lines;
}

function serverReport(result, ko) {
  const state = describeServerUpdate(result);
  const lines = versionSection(ko ? '서버' : 'Server',
    result.serverVersionError ? null : result.serverVersion,
    result.serverReleaseError ? null : result.serverLatestVersion, state, ko, { server: true });
  if (state.needsUpdate) {
    lines.push(...(ko ? [
      `배포 전 DB·키 백업 및 안내 확인: ${result.serverReleaseUrl ?? SERVER_RELEASES_URL}`,
      '업데이트(서버 관리자): 서버 저장소에서 git pull --ff-only && docker compose up -d --build hnd-server',
    ] : [
      `Back up the database and key, then read the deployment notes: ${result.serverReleaseUrl ?? SERVER_RELEASES_URL}`,
      'Update (server administrator): in the server repository, git pull --ff-only && docker compose up -d --build hnd-server',
    ]));
  } else if (state.status === 'unsupported') {
    lines.push(ko
      ? '확인: 서버 관리자에게 버전 조회를 지원하는 서버 업데이트를 요청하세요.'
      : 'Check: ask the administrator to update the server to support version lookup.');
  } else if (state.status === 'not_published') {
    lines.push(`${ko ? '릴리즈 안내' : 'Releases'}: ${SERVER_RELEASES_URL}`);
  } else if (state.status === 'check_failed') {
    lines.push(ko ? '다시 확인: hnd update check' : 'Retry: hnd update check');
  }
  return lines;
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
    '클라이언트 기능',
    `로컬 버전: ${releaseLabel(result.clientRelease, true)}`,
    `최신 버전: ${latest}`,
    `업데이트 상태: ${statuses[state.status]}`,
  ] : [
    'Client features',
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
  return [...launcherReport(result, ko), '', ...lines, '', ...serverReport(result, ko)].join('\n');
}
