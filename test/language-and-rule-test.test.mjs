import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { createCore } from '../src/core/index.mjs';

function captureStream() {
  let value = '';
  return {
    write(chunk) { value += String(chunk); return true; },
    value: () => value,
  };
}

async function fixture(context, language = 'en_US.UTF-8') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-language-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo');
  await fs.mkdir(repository);
  execFileSync('git', ['-C', repository, 'init', '--initial-branch=main'], { stdio: 'ignore' });
  const env = {
    ...process.env,
    LANG: language,
    LC_ALL: '',
    LC_MESSAGES: '',
    HND_HOME: path.join(root, 'state'),
    HND_USER_HOME: path.join(root, 'user'),
  };
  const run = async (args) => {
    const stdout = captureStream();
    const stderr = captureStream();
    await main(args, { env, cwd: repository, stdin: Readable.from([]), stdout, stderr });
    return { stdout: stdout.value(), stderr: stderr.value() };
  };
  return { env, repository, run };
}

test('CLI language follows the OS and supports persistent set and auto commands', async (context) => {
  const { run } = await fixture(context);
  assert.match((await run(['help'])).stdout, /Everyday commands:/u);
  assert.match((await run(['lang', 'show'])).stdout, /Current language: en/u);

  await run(['lang', 'set', 'kr']);
  assert.match((await run(['help'])).stdout, /평소에 필요한 명령:/u);
  assert.deepEqual(JSON.parse((await run(['lang', 'show', '--json'])).stdout), {
    preference: 'ko',
    language: 'ko',
    source: 'setting',
  });

  await run(['lang', 'auto']);
  assert.deepEqual(JSON.parse((await run(['lang', 'show', '--json'])).stdout), {
    preference: 'auto',
    language: 'en',
    source: 'os',
  });
});

test('temporary rule test exercises all, project, and environment layers without replacing rules', async (context) => {
  const { env, repository, run } = await fixture(context);
  await run(['init', '--env', 'dev']);
  const started = JSON.parse((await run(['rule', 'test', 'start', '--json'])).stdout);
  assert.equal(started.active, true);
  assert.equal(started.environment, 'dev');

  const composed = await createCore({ env, cwd: repository }).compose({ createRepository: false });
  for (const [scope, prompt] of Object.entries(started.prompts)) {
    assert.match(composed.content, new RegExp(prompt, 'u'), scope);
    assert.match(composed.content, new RegExp(started.expected[scope], 'u'), scope);
  }
  assert.match(composed.content, /mandatory exact response/u);
  assert.match(composed.content, /Do not inspect the repository, invoke a tool or skill/u);
  assert.deepEqual(composed.layers.filter((layer) => layer.kind === 'policy').map((layer) => layer.scope), [
    'global', 'repo', 'env',
  ]);

  const shown = JSON.parse((await run(['rule', 'test', 'show', '--json'])).stdout);
  assert.deepEqual(shown.prompts, started.prompts);
  assert.deepEqual(shown.expected, started.expected);

  const core = createCore({ env, cwd: repository });
  assert.equal((await core.policy.get({ scope: 'global' })).exists, false);
  assert.equal((await core.policy.get({ scope: 'repo' })).exists, false);
  assert.equal((await core.policy.get({ scope: 'env' })).exists, false);

  await run(['rule', 'test', 'stop']);
  const clean = await core.compose({ createRepository: false });
  assert.doesNotMatch(clean.content, /Temporary HND rule-delivery test/u);
});

test('rule test text explains live rule refresh and keeps one-shot checks', async (context) => {
  const { run } = await fixture(context);
  await run(['init', '--env', 'dev']);
  const started = (await run(['rule', 'test', 'start'])).stdout;
  assert.match(started, /running session with current hooks receives the latest changed Live Context/u);
  assert.match(started, /claude -p 'HND-GLOBAL-/u);
  assert.match(started, /codex exec --ephemeral 'HND-GLOBAL-/u);
  assert.match((await run(['rule', 'test', 'show'])).stdout, /running session with current hooks/u);
});
