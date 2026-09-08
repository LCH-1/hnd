import assert from 'node:assert/strict';
import test from 'node:test';

import { describeClientUpdate, formatUpdateReport } from '../src/update/report.mjs';

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
    ...overrides,
  };
}

test('update report describes a verified matching client as current, without exposing hashes', () => {
  const input = result();
  assert.deepEqual(describeClientUpdate(input), { status: 'current', needsUpdate: false, reason: 'current' });
  for (const action of ['status', 'check', 'apply']) {
    const text = formatUpdateReport(input, { action, ko: true });
    assert.match(text, /현재 클라이언트: 1\.3\.0 · 릴리스 19/);
    assert.match(text, /최신 클라이언트 \(연결된 서버 기준\): 1\.3\.0 · 릴리스 19/);
    assert.match(text, /불필요 · 이미 최신 버전입니다 \(연결된 서버 기준\)/);
    assert.match(text, /다음 명령: hnd update check/);
    assert.doesNotMatch(text, /일치함|변경 없음|aaaaaaaaaaaa/);
  }
});

test('update report recognizes a new release with the same semantic version', () => {
  const input = result({
    available: true,
    serverRelease: { version: '1.3.0', sequence: 20, bundle: { sha256: digestB } },
  });
  assert.deepEqual(describeClientUpdate(input), { status: 'update_available', needsUpdate: true, reason: 'new_release' });
  const text = formatUpdateReport(input, { ko: true });
  assert.match(text, /릴리스 20/);
  assert.match(text, /다음 명령: hnd update apply/);
});

test('a quarantined release is blocked rather than current even when available is false', () => {
  const input = result({ quarantined: true, available: false });
  assert.deepEqual(describeClientUpdate(input), { status: 'blocked', needsUpdate: null, reason: 'quarantined' });
  const text = formatUpdateReport(input, { ko: true });
  assert.match(text, /판단 보류 · 이전 롤백 또는 실패로 해당 릴리스가 차단/);
  assert.match(text, /다음 명령: hnd update check/);
  assert.doesNotMatch(text, /클라이언트 업데이트 필요 여부: 불필요/);
});

test('a successful apply ignores the stale pre-install available flag', () => {
  const input = result({ available: true, installed: true });
  assert.equal(describeClientUpdate(input).status, 'current');
  const text = formatUpdateReport(input, { action: 'apply', ko: true });
  assert.match(text, /^클라이언트 업데이트 완료/);
  assert.match(text, /다음 명령: hnd update check/);
});

test('matching digests plus available means damaged installation requiring repair', () => {
  const input = result({ available: true });
  assert.deepEqual(describeClientUpdate(input), { status: 'update_available', needsUpdate: true, reason: 'repair_required' });
  const text = formatUpdateReport(input, { ko: true });
  assert.match(text, /설치 파일 검증에 실패하여 재설치가 필요/);
  assert.match(text, /다음 명령: hnd update apply/);
});

test('a built-in client without a digest is not assumed identical to the server by version alone', () => {
  const input = result({ clientRelease: { version: '1.3.0', builtIn: true } });
  assert.equal(describeClientUpdate(input).status, 'update_available');
  assert.match(formatUpdateReport(input, { ko: true }), /현재 클라이언트: 1\.3\.0 · npm 내장/);
});

test('disconnected and failed checks never claim current and include recovery steps', () => {
  const disconnected = result({ configured: false, serverRelease: null });
  assert.equal(describeClientUpdate(disconnected).status, 'not_connected');
  assert.match(formatUpdateReport(disconnected, { ko: true }), /기기 → PC 연결/);
  for (const input of [result({ serverError: 'network failed' }), result({ serverRelease: null })]) {
    assert.equal(describeClientUpdate(input).status, 'check_failed');
    const text = formatUpdateReport(input, { ko: true });
    assert.match(text, /현재 클라이언트는 계속 사용할 수 있습니다/);
    assert.match(text, /다음 명령: hnd update check/);
    assert.doesNotMatch(text, /클라이언트 업데이트 필요 여부: 불필요/);
  }
});

test('server program versions remain explicitly unknown instead of reusing client or npm versions', () => {
  const text = formatUpdateReport(result(), { ko: true });
  assert.match(text, /현재 서버 프로그램 버전: 확인 불가 · 서버가 버전 정보를 제공하지 않습니다/);
  assert.match(text, /최신 서버 프로그램 버전: 확인 불가 · 서버 릴리스 조회 경로가 없습니다/);
  assert.match(text, /서버 업데이트 필요 여부: 판단 불가/);
  assert.match(text, /docs\/DEPLOYMENT\.md/);
  assert.match(text, /클라이언트만 업데이트하며 서버 프로그램을 변경하지 않습니다/);
});

test('npm launcher comparison recommends updating only when the registry version is newer', () => {
  const older = formatUpdateReport(result({ launcherLatestVersion: '0.3.0' }), { ko: true });
  assert.match(older, /npm 런처 업데이트 필요 여부: 필요/);
  assert.match(older, /npm install --global @lch-1\/hnd@latest/);
  const newer = formatUpdateReport(result({ launcherLatestVersion: '0.2.1' }), { ko: true });
  assert.match(newer, /설치된 버전이 npm 최신 공개 버전보다 새 버전/);
  assert.doesNotMatch(newer, /npm install/);
  const prerelease = formatUpdateReport(result({ launcherVersion: '0.3.0-rc.1', launcherLatestVersion: '0.3.0' }), { ko: true });
  assert.match(prerelease, /npm 런처 업데이트 필요 여부: 필요/);
});

test('failed npm lookup is unknown and offers an explicit manual version check', () => {
  for (const input of [
    result({ launcherLatestVersion: null }),
    result({ launcherLatestVersion: '0.3.0', launcherCheckError: 'timeout' }),
  ]) {
    const text = formatUpdateReport(input, { ko: true });
    assert.match(text, /npm 런처 업데이트 필요 여부: 판단 불가/);
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
  ];
  for (const input of inputs) {
    const text = formatUpdateReport(input, { action: 'apply', ko: false });
    assert.doesNotMatch(text, /[가-힣]/);
    assert.match(text, /Installed client:/);
    assert.match(text, /Latest client \(from the connected server\):/);
    assert.match(text, /Client update needed:/);
    assert.match(text, /hnd update (?:apply|check)/);
    assert.match(text, /Installed server program version: unknown/);
  }
});

test('formatting is pure and does not mutate result records', () => {
  const input = result({ previous: { version: '1.2.0', sequence: 18, sha256: digestB } });
  const before = structuredClone(input);
  const text = formatUpdateReport(input, { action: 'status', ko: true });
  assert.deepEqual(input, before);
  assert.match(text, /되돌릴 수 있는 이전 클라이언트: 1\.2\.0 · 릴리스 18/);
});
