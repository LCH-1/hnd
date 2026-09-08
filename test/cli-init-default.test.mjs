import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { createCore } from '../src/core/index.mjs';
import { statePaths } from '../src/paths.mjs';

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
  assert.match(initialized.stdout, /프로젝트 등록 완료:/u);
  assert.match(initialized.stdout, /환경: default/u);
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

  const beforeRepeat = await fs.readFile(statePaths(env).bindings, 'utf8');
  const cursorBeforeRepeat = await fs.readFile(path.join(firstRepository, '.cursor/rules/50-hnd.mdc'), 'utf8');
  const repeated = JSON.parse((await run(['init', '--env', 'staging', '--json'])).stdout);
  assert.equal(repeated.environment, 'laptop');
  assert.equal(repeated.registrationStatus, 'existing');
  assert.equal(await fs.readFile(statePaths(env).bindings, 'utf8'), beforeRepeat);
  assert.equal(await fs.readFile(path.join(firstRepository, '.cursor/rules/50-hnd.mdc'), 'utf8'), cursorBeforeRepeat);
  const repeatedText = (await run(['init', '--env', 'deva'])).stdout;
  assert.match(repeatedText, /이미 등록된 프로젝트입니다\./u);
  assert.doesNotMatch(repeatedText, /프로젝트 등록 완료/u);
  assert.match(repeatedText, /환경: laptop/u);
  assert.match(repeatedText, /hnd env set LABEL/u);
  await run(['env', 'set', 'staging']);
  assert.equal(JSON.parse((await run(['init', '--json'])).stdout).environment, 'staging');
  await run(['env', 'clear']);
  assert.equal(JSON.parse((await run(['init', '--json'])).stdout).environment, null);
});

test('concurrent init preserves the first environment; invalid first-time input creates no binding', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-init-once-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo');
  await fs.mkdir(repository);
  initializeRepository(repository);
  const env = { ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user') };
  const core = createCore({ cwd: repository, env });
  await assert.rejects(core.repo.init({ environment: '../invalid' }), { code: 'INVALID_ENVIRONMENT' });
  assert.deepEqual((await core.repo.list()), []);
  const results = await Promise.all(['dev', 'deva', 'prod'].map((environment) => core.repo.init({ environment })));
  const created = results.find((result) => result.registrationStatus === 'created');
  assert.ok(created);
  assert.equal(results.filter((result) => result.registrationStatus === 'created').length, 1);
  assert.ok(results.every((result) => result.environment === created.environment));
  assert.equal(await core.env.get(), created.environment);
});
