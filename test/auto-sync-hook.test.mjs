import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { formatDeviceInvite } from '../src/remote-cli.mjs';
import { readAutoSyncPending } from '../src/sync/auto.mjs';
import { readVaultKey } from '../src/sync/crypto.mjs';
import { createSyncServer } from '../src/sync/server.mjs';

const execFileAsync = promisify(execFile);

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

async function twinRepositories(root) {
  const source = path.join(root, 'source');
  const workA = path.join(root, 'work-a');
  const workB = path.join(root, 'work-b');
  await fs.mkdir(source);
  await execFileAsync('git', ['-C', source, 'init', '-b', 'main']);
  await execFileAsync('git', ['-C', source, 'config', 'user.email', 'test@example.invalid']);
  await execFileAsync('git', ['-C', source, 'config', 'user.name', 'hnd test']);
  await fs.writeFile(path.join(source, 'README.md'), '# auto sync\n');
  await execFileAsync('git', ['-C', source, 'add', 'README.md']);
  await execFileAsync('git', ['-C', source, 'commit', '-m', 'initial']);
  await execFileAsync('git', ['clone', source, workA]);
  await execFileAsync('git', ['clone', source, workB]);
  return { workA, workB };
}

async function issueAccountConnection(server, tenantId, hndHome) {
  const vaultKey = await readVaultKey(path.join(hndHome, 'secrets', 'vault.key'));
  try {
    await server.snapshots.adoptManagedVaultKey(tenantId, vaultKey);
  } finally {
    vaultKey.fill(0);
  }
  const issued = await server.snapshots.createManagedDeviceInvitation(
    tenantId,
    { ttlMs: 15 * 60 * 1000 },
  );
  try {
    return formatDeviceInvite(issued.invitationToken, issued.connectionSecret);
  } finally {
    issued.connectionSecret.fill(0);
  }
}

test('session hooks prefer the server, fall back offline, and recover without manual sync', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-auto-sync-hook-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const serverDirectory = path.join(root, 'server');
  let server = await createSyncServer({ dataDirectory: serverDirectory });
  let listening = true;
  const firstAddress = await server.listen({ host: '127.0.0.1', port: 0 });
  const port = Number(new URL(firstAddress.url).port);
  t.after(async () => {
    if (listening) await server.close();
  });

  const { workA, workB } = await twinRepositories(root);
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

  const enrollment = await server.createEnrollmentKey('hook-tenant');
  await runA([
    'sync', 'enroll', '--url', firstAddress.url, '--key', enrollment.enrollmentKey,
    '--name', 'device-a', '--create-vault-key',
  ]);
  await runA(['init']);
  await runA(['rule', 'set', 'all', '--text', 'SERVER-RULE-A']);
  await runA(['sync', 'push']);

  const connectionCode = await issueAccountConnection(server, 'hook-tenant', envA.HND_HOME);
  await runB([
    'connect', '--url', firstAddress.url, '--code', connectionCode, '--name', 'device-b',
  ]);

  const startB = await runB(
    ['hook', 'codex', 'start'],
    JSON.stringify({ cwd: workB, session_id: 'session-b-1' }),
  );
  assert.match(startB.stdout, /SERVER-RULE-A/);
  assert.doesNotMatch(startB.stderr, /sync needs attention|automatic sync unavailable/);
  await runB(['init']);

  await runB(['rule', 'set', 'all', '--text', 'SERVER-RULE-B']);
  const mutationReachedA = await runA(
    ['hook', 'codex', 'start'],
    JSON.stringify({ cwd: workA, session_id: 'session-a-after-mutation' }),
  );
  assert.match(mutationReachedA.stdout, /SERVER-RULE-B/);

  await runA(['rule', 'set', 'all', '--text', 'SERVER-RULE-C']);
  const refreshedSameSession = await runB(
    ['hook', 'codex', 'prompt'],
    JSON.stringify({ cwd: workB, session_id: 'session-b-1', prompt: 'continue' }),
  );
  const refreshedWire = JSON.parse(refreshedSameSession.stdout);
  assert.equal(refreshedWire.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(refreshedWire.hookSpecificOutput.additionalContext, /SERVER-RULE-C/);
  assert.doesNotMatch(refreshedWire.hookSpecificOutput.additionalContext, /SERVER-RULE-A|SERVER-RULE-B/);
  const unchangedSameSession = await runB(
    ['hook', 'codex', 'prompt'],
    JSON.stringify({ cwd: workB, session_id: 'session-b-1', prompt: 'continue again' }),
  );
  assert.deepEqual(JSON.parse(unchangedSameSession.stdout), {});
  let requestCount = 0;
  server.httpServer.on('request', () => { requestCount += 1; });
  const stopped = await runB(
    ['hook', 'codex', 'stop'],
    JSON.stringify({ cwd: workB, session_id: 'session-b-1' }),
  );
  assert.deepEqual(JSON.parse(stopped.stdout), {});
  assert.equal(stopped.stderr, '');
  assert.ok(requestCount > 0);
  const afterStopRequests = requestCount;

  const ended = await runB(
    ['hook', 'codex', 'end'],
    JSON.stringify({ cwd: workB, session_id: 'session-b-1' }),
  );
  assert.equal(ended.stdout, '');
  assert.equal(requestCount, afterStopRequests);

  const startA = await runA(
    ['hook', 'codex', 'start'],
    JSON.stringify({ cwd: workA, session_id: 'session-a-1' }),
  );
  assert.match(startA.stdout, /SERVER-RULE-C/);

  await server.close();
  listening = false;
  await runB(['rule', 'set', 'all', '--text', 'OFFLINE-QUEUED-RULE']);
  const offlineStop = await runB(
    ['hook', 'codex', 'stop'],
    JSON.stringify({ cwd: workB, session_id: 'session-b-2' }),
  );
  assert.deepEqual(JSON.parse(offlineStop.stdout), {});
  assert.match((await runB(['rule', 'show', 'all'])).stdout, /OFFLINE-QUEUED-RULE/);
  const pending = await readAutoSyncPending({ env: envB });
  assert.equal(pending.pending, true);
  assert.equal(pending.kind, 'retry');

  server = await createSyncServer({ dataDirectory: serverDirectory });
  await server.listen({ host: '127.0.0.1', port });
  listening = true;
  const recoveredEnd = await runB(
    ['hook', 'codex', 'end'],
    JSON.stringify({ cwd: workB, session_id: 'session-b-2' }),
  );
  assert.equal(recoveredEnd.stdout, '');
  assert.equal(await readAutoSyncPending({ env: envB }), null);

  const recoveredA = await runA(
    ['hook', 'codex', 'start'],
    JSON.stringify({ cwd: workA, session_id: 'session-a-2' }),
  );
  assert.match(recoveredA.stdout, /OFFLINE-QUEUED-RULE/);

  const autoStatus = JSON.parse((await runB(['sync', 'auto', '--json'])).stdout);
  assert.equal(autoStatus.enabled, true);
  assert.equal(autoStatus.configured, true);
  assert.equal(autoStatus.pending, null);
});
