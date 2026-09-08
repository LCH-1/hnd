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
  if (!release) return ko ? '확인 불가' : 'unknown';
  return [
    release.version,
    release.sequence == null ? null : `${ko ? '릴리스' : 'release'} ${release.sequence}`,
    release.builtIn ? (ko ? 'npm 내장' : 'npm built-in') : null,
  ].filter(Boolean).join(' · ');
}

function launcherReport(result, ko) {
  const current = result.launcherVersion;
  const latest = result.launcherLatestVersion;
  const known = Boolean(current && latest && !result.launcherCheckError);
  const needsUpdate = known && !versionAtLeast(current, latest);
  const newer = known && current !== latest && versionAtLeast(current, latest);
  if (ko) {
    return [
      `현재 npm 런처: ${current ?? '확인 불가'}`,
      `최신 npm 런처: ${known ? latest : '확인 불가 · npm 버전 조회 실패'}`,
      `npm 런처 업데이트 필요 여부: ${!known ? '판단 불가' : needsUpdate ? '필요' : newer ? '불필요 · 설치된 버전이 npm 최신 공개 버전보다 새 버전입니다' : '불필요 · 이미 최신 버전입니다'}`,
      needsUpdate
        ? 'npm 런처 업데이트 명령: npm install --global @lch-1/hnd@latest'
        : 'npm 런처 버전 확인 명령: npm view @lch-1/hnd version',
    ];
  }
  return [
    `Installed npm launcher: ${current ?? 'unknown'}`,
    `Latest npm launcher: ${known ? latest : 'unknown · npm version lookup failed'}`,
    `npm launcher update needed: ${!known ? 'unknown' : needsUpdate ? 'yes' : newer ? 'no · the installed version is newer than the latest public npm version' : 'no · already up to date'}`,
    needsUpdate
      ? 'npm launcher update command: npm install --global @lch-1/hnd@latest'
      : 'npm launcher version check command: npm view @lch-1/hnd version',
  ];
}

export function formatUpdateReport(result, { action = 'status', ko = false } = {}) {
  const state = describeClientUpdate(result);
  const latest = state.status === 'not_connected'
    ? (ko ? '확인 불가 · 이 PC를 먼저 연결하세요' : 'unknown · connect this PC first')
    : state.status === 'check_failed'
      ? (ko ? '확인 불가 · 연결된 서버 조회 실패' : 'unknown · connected server lookup failed')
      : releaseLabel(result.serverRelease, ko);
  const need = ko ? {
    not_connected: '판단 불가 · PC 연결이 필요합니다',
    check_failed: '판단 불가 · 서버를 확인할 수 없습니다. 현재 클라이언트는 계속 사용할 수 있습니다',
    blocked: '판단 보류 · 이전 롤백 또는 실패로 해당 릴리스가 차단되었습니다. 관리자에게 새 릴리스를 요청하세요',
    update_available: state.reason === 'repair_required'
      ? '필요 · 버전은 같지만 설치 파일 검증에 실패하여 재설치가 필요합니다'
      : '필요 · 연결된 서버에 새 클라이언트가 있습니다',
    current: '불필요 · 이미 최신 버전입니다 (연결된 서버 기준)',
  } : {
    not_connected: 'unknown · this PC must be connected first',
    check_failed: 'unknown · server lookup failed; the current client remains usable',
    blocked: 'deferred · this release was blocked after a rollback or failure; ask the administrator for a new release',
    update_available: state.reason === 'repair_required'
      ? 'yes · the version matches, but installed files failed verification and must be reinstalled'
      : 'yes · a new client is available from the connected server',
    current: 'no · already up to date with the connected server',
  };
  const next = state.status === 'not_connected'
    ? (ko
      ? '다음 작업: 웹의 [기기 → PC 연결]에서 연결 명령을 실행한 뒤 hnd update check'
      : 'Next step: run the connection command from [Devices → Connect PC], then hnd update check')
    : `${ko ? '다음 명령' : 'Next command'}: ${state.status === 'update_available' ? 'hnd update apply' : 'hnd update check'}`;
  const lines = ko ? [
    ...(action === 'apply' && result.installed && state.status === 'current' ? ['클라이언트 업데이트 완료'] : []),
    `현재 클라이언트: ${releaseLabel(result.clientRelease, true)}`,
    `최신 클라이언트 (연결된 서버 기준): ${latest}`,
    `클라이언트 업데이트 필요 여부: ${need[state.status]}`,
    next,
    '',
    '현재 서버 프로그램 버전: 확인 불가 · 서버가 버전 정보를 제공하지 않습니다',
    '최신 서버 프로그램 버전: 확인 불가 · 서버 릴리스 조회 경로가 없습니다',
    '서버 업데이트 필요 여부: 판단 불가',
    '서버 업데이트 방법: 관리자 배포가 필요합니다. 저장소의 docs/DEPLOYMENT.md를 참고하세요.',
    'hnd update apply는 이 PC의 클라이언트만 업데이트하며 서버 프로그램을 변경하지 않습니다.',
  ] : [
    ...(action === 'apply' && result.installed && state.status === 'current' ? ['Client update complete'] : []),
    `Installed client: ${releaseLabel(result.clientRelease, false)}`,
    `Latest client (from the connected server): ${latest}`,
    `Client update needed: ${need[state.status]}`,
    next,
    '',
    'Installed server program version: unknown · the server does not provide version information',
    'Latest server program version: unknown · no server release lookup is configured',
    'Server update needed: unknown',
    'Server update method: an administrator must deploy it. See docs/DEPLOYMENT.md in the repository.',
    'hnd update apply updates only this PC\'s client; it does not change the server program.',
  ];
  if (action === 'status' && result.previous) {
    lines.push(`${ko ? '되돌릴 수 있는 이전 클라이언트' : 'Previous client available for rollback'}: ${releaseLabel(result.previous, ko)}`);
  }
  lines.push('', ...launcherReport(result, ko));
  return lines.join('\n');
}
