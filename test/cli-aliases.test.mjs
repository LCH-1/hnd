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

test('short commands cover rules, work handoffs, and sync', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-cli-aliases-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'checkout');
  await fs.mkdir(repository, { recursive: true });
  execFileSync('git', ['-C', repository, 'init', '--initial-branch=main']);

  const env = {
    ...process.env,
    HND_HOME: path.join(root, 'state'),
    HND_USER_HOME: path.join(root, 'user'),
    LANG: 'ko_KR.UTF-8',
  };
  const run = async (args) => {
    const stdout = captureStream();
    const stderr = captureStream();
    await main(args, {
      env,
      cwd: repository,
      stdin: Readable.from([]),
      stdout,
      stderr,
    });
    return { stdout: stdout.value(), stderr: stderr.value() };
  };

  await run(['init', '--env', 'laptop']);
  await run(['rule', 'set', 'all', '--text', 'shared rule']);
  await run(['rule', 'set', 'repo', '--text', 'repo rule']);
  await run(['rule', 'set', 'env', '--text', 'environment rule']);
  await run(['rule', 'set', 'pc', '--text', 'device rule']);
  assert.match((await run(['rule', 'show', 'all'])).stdout, /shared rule/);
  assert.match((await run(['rule', 'show', 'pc'])).stdout, /device rule/);
  assert.equal(JSON.parse((await run(['rule', 'list', '--json'])).stdout).length, 4);

  const started = JSON.parse((await run([
    'work', 'new', 'short-commands', '--goal', 'Verify the short interface', '--json',
  ])).stdout);
  await run(['work', 'save', '--id', started.id, '--current', 'Alias coverage is ready']);
  assert.equal(
    JSON.parse((await run(['work', 'show', '--id', started.id, '--json'])).stdout).currentState,
    'Alias coverage is ready',
  );
  assert.equal(JSON.parse((await run(['work', 'list', '--json'])).stdout).length, 1);
  assert.match((await run(['work', 'use', '--id', started.id])).stdout, /Selected short-commands/);
  assert.match((await run(['work', 'done', '--id', started.id])).stdout, /Closed short-commands/);

  const automatic = JSON.parse((await run(['sync', 'auto', '--json'])).stdout);
  assert.deepEqual(automatic, { enabled: true, configured: false, pending: null });
  assert.equal(JSON.parse((await run(['sync', 'auto', 'off', '--json'])).stdout).enabled, false);
  assert.equal(JSON.parse((await run(['sync', 'auto', 'on', '--json'])).stdout).enabled, true);
  assert.deepEqual(JSON.parse((await run(['sync', 'status', '--json'])).stdout), { enrolled: false });
  const help = (await run(['help'])).stdout;
  assert.match(help, /평소에 필요한 명령:/u);
  assert.match(help, /hnd rule set <all\|repo\|env\|pc>/);
  assert.match(help, /hnd project help[\s\S]*?hnd advanced help/u);
  assert.doesNotMatch(help, /hnd sync push|hnd hook|hnd sync join/u);

  const projectHelp = (await run(['project', 'help'])).stdout;
  assert.match(projectHelp, /세션을 시작하면 자동 등록/u);
  assert.match(projectHelp, /hnd init/u);
  assert.match(projectHelp, /prod\/test 체크아웃/u);

  const ruleHelp = (await run(['rule', 'help'])).stdout;
  assert.match(ruleHelp, /우선순위: pc > env > repo > all/u);
  assert.match(ruleHelp, /hnd rule set <all\|repo\|env\|pc>/u);
  assert.equal((await run(['rule', '--help'])).stdout, ruleHelp);

  const workHelp = (await run(['work', 'help'])).stdout;
  assert.match(workHelp, /hnd work new TASK/u);
  const syncHelp = (await run(['sync', 'help'])).stdout;
  assert.match(syncHelp, /hnd sync auto \[status\|on\|off\]/u);
  assert.match(syncHelp, /문제가 있을 때만 사용합니다/u);
  const advancedHelp = (await run(['advanced', 'help'])).stdout;
  assert.match(advancedHelp, /hnd hook/u);
  assert.match(advancedHelp, /hnd sync join[\s\S]+hnd sync enroll/u);
  assert.doesNotMatch(help, /hnd sync invite/u);
  assert.equal((await run(['help', 'project'])).stdout, projectHelp);
  await assert.rejects(
    () => run(['help', 'missing-topic']),
    /도움말 주제를 찾을 수 없습니다/u,
  );
});
