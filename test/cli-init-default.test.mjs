import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';

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

function initializeRepository(repository) {
  execFileSync('git', ['-C', repository, 'init', '--initial-branch=main'], {
    stdio: 'ignore',
  });
}

test('init keeps an independent environment for each checkout', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-init-default-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const firstRepository = path.join(root, 'first');
  const secondRepository = path.join(root, 'second');
  await fs.mkdir(firstRepository);
  await fs.mkdir(secondRepository);
  initializeRepository(firstRepository);
  initializeRepository(secondRepository);

  const env = {
    ...process.env,
    HND_HOME: path.join(root, 'state'),
    HND_USER_HOME: path.join(root, 'user'),
    LANG: 'ko_KR.UTF-8',
  };
  const run = async (args, cwd = firstRepository) => {
    const stdout = captureStream();
    const stderr = captureStream();
    await main(args, {
      env,
      cwd,
      stdin: Readable.from([]),
      stdout,
      stderr,
    });
    return { stdout: stdout.value(), stderr: stderr.value() };
  };

  const initialized = await run(['init']);
  assert.match(initialized.stdout, /Environment: default/u);
  assert.equal(initialized.stderr, '');
  const statusJson = JSON.parse((await run(['status', '--json'])).stdout);
  assert.equal(statusJson.environment, 'default');
  assert.equal(statusJson.remoteConfigured, false);
  const statusText = (await run(['status'])).stdout;
  assert.match(statusText, /자동 동기화: 켜짐 \(PC를 연결한 뒤 시작\)/u);
  assert.match(statusText, /HND 계정 연결: 안 됨/u);
  assert.doesNotMatch(statusText, /PC 서버 등록/u);
  assert.match(statusText, /다음 단계: hnd sync status/u);

  await run(['env', 'set', 'laptop']);
  assert.equal(JSON.parse((await run(['init', '--json'], secondRepository)).stdout).environment, 'default');
  assert.equal(JSON.parse((await run(['env', 'show', '--json'])).stdout).environment, 'laptop');

  assert.equal(JSON.parse((await run(['init', '--env', 'staging', '--json'])).stdout).environment, 'staging');
  await run(['env', 'clear']);
  assert.equal(JSON.parse((await run(['init', '--json'])).stdout).environment, 'default');
});
