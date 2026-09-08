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
    assert.match(text, /^로컬 버전: 1\.3\.0\n최신 버전: 1\.3\.0\n업데이트 상태: 최신$/);
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
  assert.doesNotMatch(text, /업데이트 상태: 최신/);
});

test('a successful apply ignores the stale pre-install available flag', () => {
  const input = result({ available: true, installed: true });
  assert.equal(describeClientUpdate(input).status, 'current');
  const text = formatUpdateReport(input, { action: 'apply', ko: true });
  assert.equal(text, '로컬 버전: 1.3.0\n최신 버전: 1.3.0\n업데이트 상태: 업데이트 완료');
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
    assert.doesNotMatch(text, /업데이트 상태: 최신/);
  }
});

test('normal output omits unavailable server diagnostics and internal update metadata', () => {
  const text = formatUpdateReport(result(), { ko: true });
  assert.equal(text.split('\n').length, 3);
  assert.doesNotMatch(text, /런타임|릴리스|릴리즈|서버|npm|최근|이전|일치|aaaaaaaa/);
});

test('npm launcher comparison recommends updating only when the registry version is newer', () => {
  const older = formatUpdateReport(result({ launcherLatestVersion: '0.3.0' }), { ko: true });
  assert.match(older, /npm 업데이트 가능: /);
  assert.match(older, /npm install --global @lch-1\/hnd@latest/);
  const newer = formatUpdateReport(result({ launcherLatestVersion: '0.2.1' }), { ko: true });
  assert.equal(newer.split('\n').length, 3);
  assert.doesNotMatch(newer, /npm install/);
  const prerelease = formatUpdateReport(result({ launcherVersion: '0.3.0-rc.1', launcherLatestVersion: '0.3.0' }), { ko: true });
  assert.match(prerelease, /npm 업데이트 가능: /);
});

test('failed npm lookup is unknown and offers an explicit manual version check', () => {
  for (const input of [
    result({ launcherLatestVersion: null }),
    result({ launcherLatestVersion: '0.3.0', launcherCheckError: 'timeout' }),
  ]) {
    const text = formatUpdateReport(input, { ko: true });
    assert.match(text, /npm 버전 확인 실패/);
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
    assert.match(text, /Local version:/);
    assert.match(text, /Latest version:/);
    assert.match(text, /Update status:/);
    assert.doesNotMatch(text, /release \d|runtime|Installed server program version/);
  }
});

test('formatting is pure and does not mutate result records', () => {
  const input = result({ previous: { version: '1.2.0', sequence: 18, sha256: digestB } });
  const before = structuredClone(input);
  const text = formatUpdateReport(input, { action: 'status', ko: true });
  assert.deepEqual(input, before);
  assert.doesNotMatch(text, /1\.2\.0|18|이전|릴리즈|릴리스/);
});
