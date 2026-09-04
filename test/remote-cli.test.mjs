import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { formatDeviceInvite, snapshotDigest } from '../src/remote-cli.mjs';
import { captureSyncSnapshot } from '../src/sync/capture.mjs';
import {
  encryptBytes,
  generateVaultKey,
  readVaultKey,
  serializeVaultKey,
} from '../src/sync/crypto.mjs';
import { createSyncServer } from '../src/sync/server.mjs';
import { DEFAULT_DATABASE_FILENAME } from '../src/sync/store.mjs';

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

async function makeTwinCheckouts(root) {
  const source = path.join(root, 'source');
  const workA = path.join(root, 'work-a');
  const workB = path.join(root, 'work-b');
  await fs.mkdir(source, { recursive: true });
  await git(source, 'init', '-b', 'main');
  await git(source, 'config', 'user.email', 'test@example.invalid');
  await git(source, 'config', 'user.name', 'hnd test');
  await fs.writeFile(path.join(source, 'README.md'), '# sync merge fixture\n');
  await git(source, 'add', 'README.md');
  await git(source, 'commit', '-m', 'initial');
  await execFileAsync('git', ['clone', source, workA]);
  await execFileAsync('git', ['clone', source, workB]);
  return { workA, workB };
}

function captureStream() {
  let value = '';
  return {
    write(chunk) {
      value += String(chunk);
      return true;
    },
    value: () => value,
  };
}

function runner(env, cwd) {
  return async (args, input = '') => {
    const stdout = captureStream();
    const stderr = captureStream();
    await main(args, {
      env,
      cwd,
      stdin: Readable.from([input]),
      stdout,
      stderr,
    });
    return { stdout: stdout.value(), stderr: stderr.value() };
  };
}

async function issueWebCompatibleConnectionCode(server, tenantId, vaultKeyPath) {
  const vaultKey = await readVaultKey(vaultKeyPath);
  const invitationSecret = generateVaultKey();
  let wrappedVaultKey;
  try {
    wrappedVaultKey = encryptBytes(vaultKey, invitationSecret, { maxBytes: 32 });
    const issued = await server.control.createDeviceInvitation(
      tenantId,
      wrappedVaultKey,
      { ttlMs: 15 * 60 * 1000 },
    );
    return formatDeviceInvite(issued.invitationToken, invitationSecret);
  } finally {
    vaultKey.fill(0);
    invitationSecret.fill(0);
    wrappedVaultKey?.fill(0);
  }
}

async function snapshotTree(root) {
  async function visit(directory, relative = '') {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const result = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        result.push({ path: `${relativePath}/`, type: 'directory' });
        result.push(...await visit(absolutePath, relativePath));
      } else if (entry.isFile()) {
        result.push({
          path: relativePath,
          type: 'file',
          content: (await fs.readFile(absolutePath)).toString('base64'),
        });
      } else if (entry.isSymbolicLink()) {
        result.push({ path: relativePath, type: 'symlink', target: await fs.readlink(absolutePath) });
      }
    }
    return result;
  }
  return visit(root);
}

test('unenrolled sync commands explain account-based PC setup without leaking paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-remote-unenrolled-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HND_HOME: path.join(root, '.hnd'),
    HND_USER_HOME: root,
  };
  const run = runner(env, root);

  const status = (await run(['sync', 'status'])).stdout;
  assert.match(status, /HND 계정 연결: 안 됨/u);
  assert.doesNotMatch(status, /PC 서버 등록/u);
  assert.match(status, /HND 웹[\s\S]+\[기기\].+\[PC 연결\][\s\S]+hnd connect/u);
  assert.match(status, /첫 PC와 추가 PC의 연결 방법은 같습니다/u);
  assert.match(status, /기존 PC가 켜져 있거나 초대를 만들어 줄 필요는 없습니다/u);
  assert.match(status, /서버 계정이 연결 권한과 보호된 보관함 키를 관리합니다/u);
  assert.match(status, /마지막 로컬 캐시[\s\S]+자동으로 동기화/u);
  assert.doesNotMatch(status, /E2EE|서버는.+키를 보관하지 않/u);
  assert.equal((await run(['sync'])).stdout, status);
  assert.doesNotMatch(status, /ENOENT|remotes\.json/u);

  await assert.rejects(
    () => run(['sync', 'enroll']),
    (error) => {
      assert.equal(error.name, 'UsageError');
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /서버 주소가 없습니다[\s\S]+이전 연결 방식[\s\S]+hnd connect/u);
      assert.doesNotMatch(error.message, /invalid|ENOENT|remotes\.json/iu);
      return true;
    },
  );

  await assert.rejects(
    () => run(['sync', 'invite']),
    (error) => {
      assert.equal(error.name, 'UsageError');
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /더 이상 PC 연결 코드를 만들지 않습니다[\s\S]+웹[\s\S]+hnd connect/u);
      assert.doesNotMatch(error.message, /ENOENT|remotes\.json/u);
      return true;
    },
  );

  await assert.rejects(
    () => run(['sync', 'join']),
    (error) => {
      assert.equal(error.name, 'UsageError');
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /서버 주소가 없습니다[\s\S]+hnd connect[\s\S]+이전 별칭/u);
      return true;
    },
  );
});

test('retired sync invite always points to the account UI without I/O', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-retired-invite-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let requestCount = 0;
  const probe = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(500).end();
  });
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = probe.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function configuredRunner(label, { withVaultKey, trapVaultKeyAccess = false }) {
    const deviceRoot = path.join(root, label);
    const hndRoot = path.join(deviceRoot, '.hnd');
    const secrets = path.join(hndRoot, 'secrets');
    await fs.mkdir(secrets, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(hndRoot, 'remotes.json'), `${JSON.stringify({
      schemaVersion: 1,
      baseUrl,
      device: { id: `${label}-device`, name: label },
      etag: null,
      snapshotDigest: null,
    })}\n`, { mode: 0o600 });
    await fs.writeFile(
      path.join(secrets, 'device.token'),
      `hndd_${'A'.repeat(43)}\n`,
      { mode: 0o600 },
    );
    if (withVaultKey) {
      const key = generateVaultKey();
      try {
        await fs.writeFile(path.join(secrets, 'vault.key'), serializeVaultKey(key), { mode: 0o600 });
      } finally {
        key.fill(0);
      }
    } else if (trapVaultKeyAccess) {
      // Any legacy readVaultKey attempt rejects because this is not a regular
      // file. The retired command must return its fixed guide before touching it.
      await fs.mkdir(path.join(secrets, 'vault.key'));
    }
    const env = {
      ...process.env,
      HND_HOME: hndRoot,
      HND_USER_HOME: deviceRoot,
    };
    return { hndRoot, run: runner(env, deviceRoot) };
  }

  const withoutKey = await configuredRunner('without-key', { withVaultKey: false });
  const withKey = await configuredRunner('with-key', { withVaultKey: true });
  const trappedKey = await configuredRunner('trapped-key', {
    withVaultKey: false,
    trapVaultKeyAccess: true,
  });
  async function rejectedInvite(state) {
    const before = await snapshotTree(state.hndRoot);
    let message;
    await assert.rejects(
      () => state.run(['sync', 'invite', '--url', baseUrl, '--ttl-minutes', '1']),
      (error) => {
        assert.equal(error.name, 'UsageError');
        message = error.message;
        return true;
      },
    );
    assert.deepEqual(await snapshotTree(state.hndRoot), before);
    return message;
  }

  const withoutKeyMessage = await rejectedInvite(withoutKey);
  const withKeyMessage = await rejectedInvite(withKey);
  const trappedKeyMessage = await rejectedInvite(trappedKey);
  assert.equal(withoutKeyMessage, withKeyMessage);
  assert.equal(withoutKeyMessage, trappedKeyMessage);
  assert.match(withKeyMessage, /HND 웹[\s\S]+\[기기\].+\[PC 연결\][\s\S]+hnd connect/u);
  assert.equal(requestCount, 0);
});

test('remote CLI syncs two devices with encrypted snapshots, conflicts, deletion, and revocation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-remote-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = await createSyncServer({ dataDirectory: path.join(root, 'server') });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());

  const deviceARoot = path.join(root, 'device-a');
  const deviceBRoot = path.join(root, 'device-b');
  await fs.mkdir(deviceARoot, { recursive: true });
  await fs.mkdir(deviceBRoot, { recursive: true });
  const envA = {
    ...process.env,
    HND_HOME: path.join(deviceARoot, '.hnd'),
    HND_USER_HOME: deviceARoot,
  };
  const envB = {
    ...process.env,
    HND_HOME: path.join(deviceBRoot, '.hnd'),
    HND_USER_HOME: deviceBRoot,
  };
  const runA = runner(envA, deviceARoot);
  const runB = runner(envB, deviceBRoot);

  const enrollAKey = await server.createEnrollmentKey('shared-tenant');
  await assert.rejects(
    () => runA([
      'remote', 'enroll', '--url', address.url, '--key', enrollAKey.enrollmentKey,
      '--name', 'device-a',
    ]),
    /암호화 키 파일이 없습니다/u,
  );
  const legacyEnrollmentText = (await runA([
    'remote', 'enroll', '--url', address.url, '--key', enrollAKey.enrollmentKey,
    '--name', 'device-a', '--create-vault-key',
  ])).stdout;
  assert.match(legacyEnrollmentText, /^이전 방식 PC 연결 완료: device-a/u);
  assert.doesNotMatch(legacyEnrollmentText, /PC 등록 완료/u);
  const enrolledA = JSON.parse((await runA(['remote', 'status', '--json'])).stdout);
  assert.equal(enrolledA.enrolled, true);
  assert.match((await runA(['remote', 'status'])).stdout, /^HND 계정 연결: 완료/u);
  await runA(['sync', 'auto', 'off']);
  assert.match((await runA(['sync', 'auto'])).stdout, /HND 계정 연결: 완료/u);
  await runA(['policy', 'set', 'global', '--text', 'SYNCED-POLICY-A']);
  await runA(['policy', 'set', 'local', '--text', 'DEVICE-A-GUARD']);
  const firstPush = JSON.parse((await runA(['remote', 'push', '--json'])).stdout);
  assert.equal(firstPush.pushed, true);

  const exportedKey = path.join(root, 'vault.key');
  await runA(['remote', 'key', 'export', '--file', exportedKey]);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(exportedKey)).mode & 0o777, 0o600);
  }

  const retryRoot = path.join(root, 'device-retry');
  await fs.mkdir(retryRoot, { recursive: true });
  const retryEnv = {
    ...process.env,
    HND_HOME: path.join(retryRoot, '.hnd'),
    HND_USER_HOME: retryRoot,
  };
  const runRetry = runner(retryEnv, retryRoot);
  const retryEnrollment = await server.createEnrollmentKey('shared-tenant');
  await assert.rejects(
    () => runRetry([
      'remote', 'enroll', '--url', address.url, '--key', retryEnrollment.enrollmentKey,
      '--name', 'device-retry', '--vault-key-file', path.join(root, 'missing-vault.key'),
    ]),
    /암호화 키 파일을 찾을 수 없습니다[\s\S]+이전 연결 또는 복구용[\s\S]+PC 연결/u,
  );
  const retryArguments = [
    'remote', 'enroll', '--key', retryEnrollment.enrollmentKey,
    '--name', 'device-retry', '--vault-key-file', exportedKey,
  ];
  await assert.rejects(
    () => runRetry([...retryArguments, '--url', 'http://127.0.0.1:1']),
  );
  const retried = JSON.parse((await runRetry([
    ...retryArguments, '--url', address.url, '--json',
  ])).stdout);
  assert.equal(retried.enrolled, true);
  assert.equal(retried.vaultKeySource, 'existing');

  // Simulate the account-authenticated web UI issuing the hndj code. The CLI
  // only consumes this format through `hnd connect` now.
  const invitation = await issueWebCompatibleConnectionCode(
    server,
    'shared-tenant',
    exportedKey,
  );
  assert.match(invitation, /^hndj_/);
  const replacement = invitation.endsWith('A') ? 'B' : 'A';
  const tamperedInvitation = `${invitation.slice(0, -1)}${replacement}`;
  await assert.rejects(
    () => runB(['remote', 'join', '--url', address.url, '--invite', tamperedInvitation]),
    /checksum/,
  );
  const enrolledB = JSON.parse((await runB([
    'connect', '--url', address.url, '--code-stdin',
    '--name', 'device-b', '--json',
  ], invitation)).stdout);
  assert.equal(enrolledB.joined, true);
  await runB(['sync', 'auto', 'off']);
  await assert.rejects(
    () => runner({ ...envB, HND_HOME: path.join(root, 'replay-state') }, deviceBRoot)([
      'remote', 'join', '--url', address.url, '--invite', invitation, '--name', 'replay',
    ]),
    (error) => error.status === 401,
  );
  await runB(['remote', 'pull']);
  assert.match((await runB(['policy', 'show', 'global'])).stdout, /SYNCED-POLICY-A/);
  assert.match((await runB(['policy', 'show', 'local'])).stdout, /No local policy/);

  await runB(['policy', 'set', 'global', '--text', 'SYNCED-POLICY-B']);
  await runB(['remote', 'push']);
  await runA(['policy', 'set', 'global', '--text', 'UNPUSHED-DEVICE-A']);
  await assert.rejects(() => runA(['remote', 'push']), (error) => error.code === 'REMOTE_CONFLICT');
  await assert.rejects(() => runA(['remote', 'pull']), (error) => error.code === 'REMOTE_CONFLICT');

  const forced = JSON.parse((await runA(['remote', 'pull', '--force', '--json'])).stdout);
  assert.equal(forced.pulled, true);
  assert.ok(forced.backupPath);
  const backup = JSON.parse(await fs.readFile(forced.backupPath, 'utf8'));
  const backedUpPolicy = backup.files.find((file) => file.path === 'policies/global.md');
  assert.equal(Buffer.from(backedUpPolicy.content, 'base64').toString('utf8'), 'UNPUSHED-DEVICE-A');
  assert.match((await runA(['policy', 'show', 'global'])).stdout, /SYNCED-POLICY-B/);
  assert.match((await runA(['policy', 'show', 'local'])).stdout, /DEVICE-A-GUARD/);

  const firstRevisionId = firstPush.etag.slice(1, -1);
  const restored = JSON.parse((await runA([
    'remote', 'restore', firstRevisionId, '--force', '--json',
  ])).stdout);
  assert.equal(restored.localChanges, true);
  assert.match((await runA(['policy', 'show', 'global'])).stdout, /SYNCED-POLICY-A/);
  await runA(['remote', 'push']);
  await runB(['remote', 'pull']);
  assert.match((await runB(['policy', 'show', 'global'])).stdout, /SYNCED-POLICY-A/);

  await runB(['policy', 'remove', 'global']);
  await runB(['remote', 'push']);
  await runA(['remote', 'pull']);
  assert.match((await runA(['policy', 'show', 'global'])).stdout, /No global policy/);
  assert.match((await runA(['policy', 'show', 'local'])).stdout, /DEVICE-A-GUARD/);

  const recoveryTarget = await captureSyncSnapshot(envA.HND_HOME);
  await runA(['policy', 'set', 'global', '--text', 'SIMULATED-PARTIAL-RESTORE']);
  const recoveryPrevious = await captureSyncSnapshot(envA.HND_HOME);
  const journalPath = path.join(envA.HND_HOME, 'cache', 'restore-journal.json');
  await fs.writeFile(journalPath, `${JSON.stringify({
    schemaVersion: 1,
    operationId: 'test-interrupted-restore',
    createdAt: new Date().toISOString(),
    previous: recoveryPrevious,
    target: recoveryTarget,
    targetDigest: snapshotDigest(recoveryTarget),
  })}\n`);
  await assert.rejects(
    () => runA(['policy', 'show', 'global']),
    (error) => error.code === 'STATE_RECOVERY_REQUIRED',
  );
  await runA(['remote', 'pull']);
  assert.match((await runA(['policy', 'show', 'global'])).stdout, /No global policy/);
  await assert.rejects(fs.stat(journalPath), { code: 'ENOENT' });

  const databasePath = path.join(root, 'server', DEFAULT_DATABASE_FILENAME);
  const rollbackDatabase = new DatabaseSync(databasePath);
  const currentServerRevisionId = rollbackDatabase.prepare(`
    SELECT revision_id FROM snapshots WHERE tenant_id = ?
  `).get('shared-tenant').revision_id;
  rollbackDatabase.prepare(`
    UPDATE snapshots SET revision_id = ? WHERE tenant_id = ?
  `).run(firstRevisionId, 'shared-tenant');
  rollbackDatabase.close();
  await assert.rejects(
    () => runA(['remote', 'pull']),
    (error) => error.code === 'REMOTE_CONFLICT' && /rollback/i.test(error.message),
  );
  const restoreDatabase = new DatabaseSync(databasePath);
  restoreDatabase.prepare(`
    UPDATE snapshots SET revision_id = ? WHERE tenant_id = ?
  `).run(currentServerRevisionId, 'shared-tenant');
  restoreDatabase.close();

  const statusText = (await runA(['remote', 'status', '--json'])).stdout;
  assert.equal(statusText.includes(enrollAKey.enrollmentKey), false);
  assert.equal(statusText.includes('hnd-vault-v1:'), false);
  await runA(['remote', 'revoke', enrolledB.device.id]);
  await assert.rejects(
    () => runB(['remote', 'pull']),
    (error) => error.status === 401,
  );
});

test('remote merge applies independent edits and records local-wins conflicts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-remote-merge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = await createSyncServer({ dataDirectory: path.join(root, 'server') });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const { workA, workB } = await makeTwinCheckouts(root);
  const envA = {
    ...process.env,
    HND_HOME: path.join(root, 'device-a', '.hnd'),
    HND_USER_HOME: path.join(root, 'device-a'),
  };
  const envB = {
    ...process.env,
    HND_HOME: path.join(root, 'device-b', '.hnd'),
    HND_USER_HOME: path.join(root, 'device-b'),
  };
  const runA = runner(envA, workA);
  const runB = runner(envB, workB);

  const enrollment = await server.createEnrollmentKey('merge-tenant');
  await runA([
    'remote', 'enroll', '--url', address.url, '--key', enrollment.enrollmentKey,
    '--name', 'device-a', '--create-vault-key',
  ]);
  await runA(['sync', 'auto', 'off']);
  await runA(['init']);
  await runA(['policy', 'set', 'global', '--text', 'GLOBAL-BASE']);
  await runA(['policy', 'set', 'repo', '--text', 'REPO-BASE']);
  await runA(['remote', 'push']);

  const invitation = await issueWebCompatibleConnectionCode(
    server,
    'merge-tenant',
    path.join(envA.HND_HOME, 'secrets', 'vault.key'),
  );
  await runB([
    'remote', 'join', '--url', address.url, '--invite', invitation, '--name', 'device-b',
  ]);
  await runB(['sync', 'auto', 'off']);
  await runB(['remote', 'pull']);
  await runB(['init']);

  await runB(['policy', 'set', 'global', '--text', 'GLOBAL-REMOTE']);
  await runB(['remote', 'push']);
  await runA(['policy', 'set', 'repo', '--text', 'REPO-LOCAL']);
  await assert.rejects(
    () => runA(['remote', 'push']),
    (error) => error.code === 'REMOTE_CONFLICT',
  );

  const cleanMerge = JSON.parse((await runA(['remote', 'merge', '--json'])).stdout);
  assert.equal(cleanMerge.merged, true);
  assert.deepEqual(cleanMerge.conflicts, []);
  assert.equal(cleanMerge.localChanges, true);
  assert.match((await runA(['policy', 'show', 'global'])).stdout, /GLOBAL-REMOTE/);
  assert.match((await runA(['policy', 'show', 'repo'])).stdout, /REPO-LOCAL/);
  await runA(['remote', 'push']);
  await runB(['remote', 'pull']);

  await runB(['policy', 'set', 'global', '--text', 'GLOBAL-B-CONFLICT']);
  await runB(['remote', 'push']);
  await runA(['policy', 'set', 'global', '--text', 'GLOBAL-A-CONFLICT']);
  const conflictMerge = JSON.parse((await runA(['remote', 'merge', '--json'])).stdout);
  assert.deepEqual(conflictMerge.conflicts, ['policies/global.md']);
  assert.equal(conflictMerge.localChanges, true);
  assert.ok(conflictMerge.conflictPath);
  const report = JSON.parse(await fs.readFile(conflictMerge.conflictPath, 'utf8'));
  assert.equal(report.resolution, 'The local version was retained for every listed conflict.');
  assert.equal(report.conflicts[0].path, 'policies/global.md');
  assert.equal(
    Buffer.from(report.conflicts[0].remote.content, 'base64').toString('utf8'),
    'GLOBAL-B-CONFLICT',
  );
  assert.match((await runA(['policy', 'show', 'global'])).stdout, /GLOBAL-A-CONFLICT/);

  const status = JSON.parse((await runA(['remote', 'status', '--json'])).stdout);
  assert.equal(status.mergeBasePresent, true);
  assert.equal(status.localChanges, true);
  await runA(['remote', 'push']);
  await runB(['remote', 'pull']);
  assert.match((await runB(['policy', 'show', 'global'])).stdout, /GLOBAL-A-CONFLICT/);
});
