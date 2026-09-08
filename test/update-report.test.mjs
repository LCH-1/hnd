import assert from 'node:assert/strict';
import test from 'node:test';

import { describeClientUpdate, describeLauncherUpdate, describeServerUpdate, formatUpdateReport } from '../src/update/report.mjs';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

function result(overrides = {}) {
  return {
    configured: true,
    available: false,
    clientRelease: { version: '1.3.0', sequence: 19, sha256: digestA },
    serverRelease: { version: '1.3.0', sequence: 19, bundle: { sha256: digestA } },
    launcherVersion: '0.2.2',
    launcherLatestVersion: '0.2.2',
    serverVersion: '1.0.0',
    serverLatestVersion: '1.0.0',
    serverVersionStatus: 'available',
    serverReleaseStatus: 'available',
    ...overrides,
  };
}

test('update report describes a verified matching client as current, without exposing hashes', () => {
  const input = result();
  assert.deepEqual(describeClientUpdate(input), { status: 'current', needsUpdate: false, reason: 'current' });
  for (const action of ['status', 'check']) {
    const text = formatUpdateReport(input, { action, ko: true });
    assert.equal(text, [
      'npm 패키지\n로컬 버전: 0.2.2\n최신 버전: 0.2.2\n업데이트 상태: 최신',
      'HND 실행 버전\n로컬 버전: 1.3.0\n최신 버전: 1.3.0\n업데이트 상태: 최신',
    ].join('\n\n'));
    assert.doesNotMatch(text, /일치함|변경 없음|aaaaaaaaaaaa/);
  }
  assert.equal(formatUpdateReport(input, { action: 'apply', ko: true }), '모두 최신 버전입니다.');
});

test('update report recognizes a new release with the same semantic version', () => {
  const input = result({
    available: true,
    serverRelease: { version: '1.3.0', sequence: 20, bundle: { sha256: digestB } },
  });
  assert.deepEqual(describeClientUpdate(input), { status: 'update_available', needsUpdate: true, reason: 'new_release' });
  const text = formatUpdateReport(input, { ko: true });
  assert.match(text, /업데이트 상태: 업데이트 가능/);
  assert.doesNotMatch(text, /릴리스|릴리즈|20|bbbbbbbb/);
  assert.match(text, /업데이트: hnd update apply/);
});

test('a quarantined release is blocked rather than current even when available is false', () => {
  const input = result({ quarantined: true, available: false });
  assert.deepEqual(describeClientUpdate(input), { status: 'blocked', needsUpdate: null, reason: 'quarantined' });
  const text = formatUpdateReport(input, { ko: true });
  assert.match(text, /업데이트 상태: 업데이트 차단/);
  assert.match(text, /관리자에게 새 버전을 요청/);
  assert.doesNotMatch(text.split('\n\n')[1], /업데이트 상태: 최신/);
});

test('a successful apply ignores the stale pre-install available flag', () => {
  const input = result({ available: true, installed: true });
  assert.equal(describeClientUpdate(input).status, 'current');
  const text = formatUpdateReport(input, { action: 'apply', ko: true });
  assert.equal(text, 'HND 실행 버전 업데이트 완료: 1.3.0');
  assert.doesNotMatch(text, /모두 최신|npm 패키지 업데이트 완료/);
});

test('matching digests plus available means damaged installation requiring repair', () => {
  const input = result({ available: true });
  assert.deepEqual(describeClientUpdate(input), { status: 'update_available', needsUpdate: true, reason: 'repair_required' });
  const text = formatUpdateReport(input, { ko: true });
  assert.match(text, /업데이트 상태: 재설치 필요/);
  assert.match(text, /업데이트: hnd update apply/);
});

test('a built-in client without a digest is not assumed identical to the server by version alone', () => {
  const input = result({ clientRelease: { version: '1.3.0', builtIn: true } });
  assert.equal(describeClientUpdate(input).status, 'update_available');
  assert.match(formatUpdateReport(input, { ko: true }), /로컬 버전: 1\.3\.0/);
});

test('disconnected and failed checks never claim current and include recovery steps', () => {
  const disconnected = result({ configured: false, serverRelease: null });
  assert.equal(describeClientUpdate(disconnected).status, 'not_connected');
  assert.match(formatUpdateReport(disconnected, { ko: true }), /기기 → PC 연결/);
  for (const input of [result({ serverError: 'network failed' }), result({ serverRelease: null })]) {
    assert.equal(describeClientUpdate(input).status, 'check_failed');
    const text = formatUpdateReport(input, { ko: true });
    assert.match(text, /업데이트 상태: 확인 실패/);
    assert.match(text, /다시 확인: hnd update check/);
    assert.doesNotMatch(text.split('\n\n')[1], /업데이트 상태: 최신/);
  }
});

test('normal output always shows every component but omits internal update metadata', () => {
  const text = formatUpdateReport(result(), { ko: true });
  assert.equal(text.split('\n\n').length, 2);
  assert.doesNotMatch(text, /서버|Server/);
  assert.doesNotMatch(text, /런타임|릴리스|릴리즈|최근|이전|일치|aaaaaaaa/);
});

test('npm launcher comparison recommends updating only when the registry version is newer', () => {
  const older = formatUpdateReport(result({ launcherLatestVersion: '0.3.0' }), { ko: true });
  assert.match(older.split('\n\n')[0], /업데이트 상태: 업데이트 가능/);
  assert.match(older, /npm install --global @lch-1\/hnd@latest/);
  const newer = formatUpdateReport(result({ launcherLatestVersion: '0.2.1' }), { ko: true });
  assert.match(newer.split('\n\n')[0], /공개 버전보다 높음/);
  assert.doesNotMatch(newer, /npm install/);
  const prerelease = formatUpdateReport(result({ launcherVersion: '0.3.0-rc.1', launcherLatestVersion: '0.3.0' }), { ko: true });
  assert.match(prerelease.split('\n\n')[0], /업데이트 상태: 업데이트 가능/);
});

test('failed npm lookup is unknown and offers an explicit manual version check', () => {
  for (const input of [
    result({ launcherLatestVersion: null }),
    result({ launcherLatestVersion: '0.3.0', launcherCheckError: 'timeout' }),
  ]) {
    const text = formatUpdateReport(input, { ko: true });
    assert.match(text.split('\n\n')[0], /최신 버전: 확인 불가\n업데이트 상태: 확인 실패/);
    assert.match(text.split('\n\n')[0], /로컬 버전: 0\.2\.2/);
    assert.match(text, /npm view @lch-1\/hnd version/);
    assert.doesNotMatch(text, /npm install/);
  }
});

test('English reports have the same actionable states and no Korean text', () => {
  const inputs = [
    result(),
    result({ available: true }),
    result({ available: true, installed: true }),
    result({ quarantined: true }),
    result({ configured: false }),
    result({ serverError: 'offline' }),
    result({ launcherLatestVersion: '0.3.0' }),
    result({ launcherCheckError: 'offline' }),
    result({ serverLatestVersion: '2.0.0' }),
    result({ serverVersionStatus: 'unsupported' }),
    result({ serverReleaseStatus: 'not_published' }),
    result({ serverReleaseError: 'offline' }),
  ];
  for (const input of inputs) {
    const text = formatUpdateReport(input, { ko: false });
    assert.doesNotMatch(text, /[가-힣]/);
    assert.match(text, /Local version:/);
    assert.match(text, /Latest version:/);
    assert.match(text, /Update status:/);
    assert.doesNotMatch(text, /release \d|runtime|Installed server program version/);
    assert.doesNotMatch(formatUpdateReport(input, { action: 'apply', ko: false }), /[가-힣]|Local version:|Latest version:|Update status:/);
  }
});

test('server diagnostics remain independent but never appear in human update output', () => {
  const input = result({ launcherLatestVersion: '0.3.0', serverLatestVersion: '2.0.0' });
  assert.equal(describeClientUpdate(input).needsUpdate, false);
  assert.equal(describeLauncherUpdate(input).needsUpdate, true);
  assert.equal(describeServerUpdate(input).needsUpdate, true);
  const [npm, features, server] = formatUpdateReport(input, { ko: true }).split('\n\n');
  assert.match(npm, /npm install --global @lch-1\/hnd@latest/);
  assert.doesNotMatch(features, /업데이트 완료|업데이트 가능/);
  assert.equal(server, undefined);
});

test('unknown or unsupported server versions are never inferred from client versions', () => {
  for (const overrides of [
    { serverVersion: null, serverVersionStatus: 'unsupported', serverVersionError: 'HTTP 404' },
    { serverVersion: null, serverVersionStatus: 'check_failed', serverVersionError: 'offline' },
    { serverLatestVersion: null, serverReleaseStatus: 'not_published', serverReleaseError: 'HTTP 404' },
    { serverLatestVersion: null, serverReleaseError: 'timeout' },
    { serverVersion: null, serverVersionStatus: 'not_connected' },
  ]) {
    const input = result(overrides);
    assert.equal(describeServerUpdate(input).needsUpdate, null);
    assert.equal(formatUpdateReport(input, { ko: true }).split('\n\n')[2], undefined);
    assert.equal(describeClientUpdate(input).status, 'current');
  }
});

test('apply shows only actual changes, including npm-only updates and skill repairs', () => {
  assert.equal(formatUpdateReport(result({
    launcherVersion: '0.3.0', launcherLatestVersion: '0.3.0',
    npmInstall: { status: 'updated', previousVersion: '0.2.2', version: '0.3.0' },
  }), { action: 'apply', ko: true }), 'npm 패키지 업데이트 완료: 0.3.0');
  assert.equal(formatUpdateReport(result({ refreshedSkills: [{ agent: 'claude' }] }), { action: 'apply', ko: true }), '에이전트 스킬을 갱신했습니다.');
});

test('apply never says everything is current when checks fail, updates are blocked, or npm cannot update', () => {
  for (const overrides of [
    { serverError: 'offline' }, { configured: false }, { quarantined: true },
    { available: true }, { launcherCheckError: 'offline' }, { launcherLatestVersion: null },
    { skillsRefreshError: 'permission' },
    { launcherLatestVersion: '0.3.0', npmInstall: { status: 'failed', reason: 'permission' } },
  ]) {
    const text = formatUpdateReport(result(overrides), { action: 'apply', ko: true });
    assert.doesNotMatch(text, /모두 최신|로컬 버전:|최신 버전:|업데이트 상태:/);
    assert.ok(text.length > 0);
  }
  const failed = formatUpdateReport(result({
    launcherLatestVersion: '0.3.0', npmInstall: { status: 'failed', reason: 'permission' },
  }), { action: 'apply', ko: true });
  assert.match(failed, /권한 부족/);
  assert.match(failed, /npm install --global @lch-1\/hnd@latest/);
});

test('formatting is pure and does not mutate result records', () => {
  const input = result({ previous: { version: '1.2.0', sequence: 18, sha256: digestB } });
  const before = structuredClone(input);
  const text = formatUpdateReport(input, { action: 'status', ko: true });
  assert.deepEqual(input, before);
  assert.doesNotMatch(text, /1\.2\.0|18|이전|릴리즈|릴리스/);
});
