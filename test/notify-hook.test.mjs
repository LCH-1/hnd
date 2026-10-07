import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { createCore } from '../src/core/index.mjs';
import { markTurnStart } from '../src/core/notify.mjs';
import { liveContextSessionKey } from '../src/core/live-context.mjs';
import { setProcessLockDeadline, withStateLock } from '../src/core/mutation-lock.mjs';

const SLACK_URL = 'https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnopqrst';

async function fixture(t, { git = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-notify-hook-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  if (git) execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
  const env = { ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user') };
  const core = createCore({ env, cwd, agent: 'claude', sessionId: 'current-session' });
  await core.init();
  await core.repo.resolve({ create: true });
  await core.handoff.start({ task: 'OLD AUTOMATION', objective: 'Old task', currentState: 'OLD DELETION', nextSteps: ['OLD SHARE SETUP'] });
  const added = await core.notify.add({ provider: 'slack', webhookUrl: SLACK_URL, trigger: 'always' });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, SLACK_URL);
    requests.push(JSON.parse(options.body).text);
    return { ok: true, status: 200 };
  });
  const run = async (agent, phase, payload = {}) => {
    let stdout = '';
    let stderr = '';
    await main(['hook', agent, phase], {
      cwd, env, stdin: Readable.from([JSON.stringify({ cwd, session_id: 'current-session', ...payload })]),
      stdout: { write(chunk) { stdout += String(chunk); } },
      stderr: { write(chunk) { stderr += String(chunk); } },
    });
    return { stdout, stderr };
  };
  return { root, cwd, env, core, requests, run, channelId: added.channel.id };
}

test('Claude and Codex notifications use the current final answer despite an old selected work', async (t) => {
  const f = await fixture(t);
  for (const agent of ['claude', 'codex']) {
    const stopped = await f.run(agent, 'stop', { last_assistant_message: `CURRENT ${agent} ANSWER\n\nSecond paragraph.` });
    assert.deepEqual(JSON.parse(stopped.stdout), {});
    assert.match(f.requests.at(-1), new RegExp(`CURRENT ${agent} ANSWER\\n\\nSecond paragraph\\.`, 'u'));
    assert.doesNotMatch(f.requests.at(-1), /OLD AUTOMATION|OLD DELETION|OLD SHARE SETUP/u);
  }
});

test('missing final message reports its absence instead of sending old work or old transcript', async (t) => {
  const f = await fixture(t);
  const transcript = path.join(f.root, 'old.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ type: 'assistant', message: { content: 'OLD TRANSCRIPT' } }));
  await f.run('claude', 'stop', { transcript_path: transcript });
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0], /최종 답변을 종료 훅에서 받지 못했습니다|did not receive the final response/u);
  assert.doesNotMatch(f.requests[0], /OLD AUTOMATION|OLD TRANSCRIPT/u);
});

test('read-only state still delivers the final response and never reuses an unconsumed timer', async (t) => {
  const f = await fixture(t);
  const sessionKey = liveContextSessionKey('claude', { session_id: 'current-session' }, f.env);
  await markTurnStart({ env: f.env, agent: 'claude', sessionKey, clock: { now: () => Date.now() - 60_000 } });
  const originalOpen = fs.open.bind(fs);
  const originalUnlink = fs.unlink.bind(fs);
  const readonly = () => Object.assign(new Error('read-only fixture'), { code: 'EROFS' });
  t.mock.method(fs, 'open', (file, flags, ...args) => {
    const writes = typeof flags === 'number' ? flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT) : /[wax+]/u.test(flags);
    if (String(file).startsWith(f.env.HND_HOME) && writes) throw readonly();
    return originalOpen(file, flags, ...args);
  });
  t.mock.method(fs, 'unlink', (file) => {
    if (String(file).startsWith(f.env.HND_HOME)) throw readonly();
    return originalUnlink(file);
  });
  const stopped = await f.run('claude', 'stop', { last_assistant_message: 'CURRENT ANSWER WHILE READ ONLY' });
  assert.deepEqual(JSON.parse(stopped.stdout), {});
  assert.match(f.requests[0], /CURRENT ANSWER WHILE READ ONLY/u);
  assert.match(f.requests[0], /EROFS/u);
  assert.doesNotMatch(f.requests[0], /OLD AUTOMATION|1분 0초|1m 0s/u);
  await f.run('claude', 'stop', { last_assistant_message: 'NEXT CURRENT ANSWER' });
  assert.match(f.requests[1], /NEXT CURRENT ANSWER/u);
  assert.doesNotMatch(f.requests[1], /1분 0초|1m 0s/u);
});

test('a busy progress lock does not delay a response notification', async (t) => {
  const f = await fixture(t);
  t.after(() => setProcessLockDeadline(null));
  let release;
  let entered;
  const acquired = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const holder = withStateLock(() => { entered(); return held; }, { env: f.env });
  await acquired;
  let delivered;
  const notification = new Promise((resolve) => { delivered = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    f.requests.push(JSON.parse(options.body).text);
    delivered();
    return { ok: true, status: 200 };
  });
  const hook = f.run('claude', 'stop', { last_assistant_message: 'ANSWER BEFORE LOCK RELEASE' });
  let timer;
  try {
    await Promise.race([
      notification,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('notification waited for the state lock')), 1_000); }),
    ]);
    assert.match(f.requests[0], /ANSWER BEFORE LOCK RELEASE/u);
  } finally {
    clearTimeout(timer);
    release();
    await holder;
    await hook;
  }
});

test('changed-files channels still wait for a real checkpoint and retain its file count', async (t) => {
  const f = await fixture(t, { git: true });
  await f.core.notify.update({ id: f.channelId, trigger: 'changed-files' });
  await fs.writeFile(path.join(f.cwd, 'change.txt'), 'changed');
  await f.run('codex', 'stop', { last_assistant_message: 'CURRENT CHANGE ANSWER' });
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0], /CURRENT CHANGE ANSWER/u);
  assert.match(f.requests[0], /미커밋 파일 1개|1 uncommitted files/u);
  await f.run('codex', 'stop', { last_assistant_message: 'NO NEW CHANGE' });
  assert.equal(f.requests.length, 1);
});
