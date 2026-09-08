import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { createCore } from '../src/core/index.mjs';
import { watchWork, writeWatchUpdate } from '../src/work-watch.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-collaboration-flow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo');
  await fs.mkdir(cwd);
  execFileSync('git', ['init', '-b', 'main', cwd], { stdio: 'ignore' });
  execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' });
  const env = { HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user'), HND_LANG: 'en' };
  const core = (sessionId) => createCore({ env, cwd, sessionId, agent: 'codex' });
  await core('A').repo.register();
  const run = async (args, { sessionId, payload, signal, stdout } = {}) => {
    let output = '';
    await main(args, {
      env: sessionId ? { ...env, CODEX_THREAD_ID: sessionId } : env, cwd, signal,
      stdin: Readable.from(payload ? [JSON.stringify(payload)] : []),
      stdout: stdout ?? { write(chunk) { output += chunk; } }, stderr: { write() {} },
    });
    return output;
  };
  return { root, cwd, env, core, run };
}

test('CLI plans detect overlapping work and local consecutive saves retain separate events', async (t) => {
  const { core, run } = await fixture(t);
  const a = core('A');
  const b = core('B');
  await a.handoff.start({ task: 'auth', objective: 'Auth' });
  await b.handoff.start({ task: 'billing', objective: 'Billing' });
  await run(['work', 'plan', '--file', 'src/shared.mjs'], { sessionId: 'A' });
  const planned = JSON.parse(await run(['work', 'plan', '--file', 'src/shared.mjs'], { sessionId: 'B' }));
  assert.equal(planned.conflicts[0].file, 'src/shared.mjs');
  assert.equal(planned.conflicts[0].works.length, 2);
  const before = await a.work.inspect({ limit: 512 });
  await a.work.ack({ repoId: before.repoId, epoch: before.eventCursor.epoch, eventIds: before.events.map((event) => event.id) });
  await b.handoff.update({ currentState: 'First API change' });
  await b.handoff.update({ currentState: 'Second API change' });
  const after = await a.work.inspect();
  assert.equal(after.events.filter((event) => event.fields.includes('currentState')).length, 2);
  assert.equal(after.events.every((event) => !JSON.stringify(event).includes('API change')), true);
});

test('hooks acknowledge only rendered events while preview and undersized context leave events pending', async (t) => {
  const { core, run } = await fixture(t);
  const a = core('A');
  const b = core('B');
  await a.handoff.start({ task: 'reader', objective: 'Reader' });
  await b.handoff.start({ task: 'writer', objective: 'Writer' });
  await run(['hook', 'codex', 'start'], { payload: { session_id: 'A' } });
  await b.handoff.update({ currentState: 'Changed contract' });
  const full = await a.compose();
  const eventLayer = full.layers.find((layer) => layer.kind === 'work-events');
  assert.ok(eventLayer);
  const small = await a.compose({ maxBytes: full.bytes - eventLayer.bytes });
  assert.equal(small.coordination.omitted, true);
  assert.deepEqual(small.coordination.deliveredEventIds, []);
  await run(['preview', '--session-id', 'A', '--session-agent', 'codex', '--json']);
  assert.ok((await a.work.inspect()).events.length);
  const output = await run(['hook', 'codex', 'prompt'], { payload: { session_id: 'A', prompt: 'Continue' } });
  assert.match(output, /Work event/);
  assert.equal((await a.work.inspect()).events.length, 0);
});

test('failed hook acknowledgement retries the same revision on the next prompt', async (t) => {
  const { core, run } = await fixture(t);
  const a = core('A');
  const b = core('B');
  await a.handoff.start({ task: 'reader', objective: 'Reader' });
  await b.handoff.start({ task: 'writer', objective: 'Writer' });
  await run(['hook', 'codex', 'start'], { payload: { session_id: 'A' } });
  await b.handoff.update({ currentState: 'Change requiring delivery' });
  const rename = fs.rename;
  let emitted = false;
  let injected = false;
  fs.rename = async (from, to) => {
    if (emitted && !injected && /work-events-.*\.json$/u.test(String(to))) {
      injected = true;
      throw Object.assign(new Error('injected ack failure'), { code: 'EIO' });
    }
    return rename(from, to);
  };
  try {
    await run(['hook', 'codex', 'prompt'], {
      payload: { session_id: 'A', prompt: 'Continue' },
      stdout: { write(chunk) { emitted ||= chunk.includes('Work event'); } },
    });
  } finally {
    fs.rename = rename;
  }
  assert.equal(injected, true);
  assert.ok((await a.work.inspect()).events.length);
  assert.match(await run(['hook', 'codex', 'prompt'], { payload: { session_id: 'A', prompt: 'Continue' } }), /Work event/);
  assert.equal((await a.work.inspect()).events.length, 0);
});

test('plain-terminal watch works automatically and its cursor never consumes the LLM queue', async (t) => {
  const { core, run } = await fixture(t);
  const a = core('A');
  const b = core('B');
  await a.handoff.start({ task: 'reader', objective: 'Reader' });
  await b.handoff.start({ task: 'writer', objective: 'Writer' });
  const initial = JSON.parse(await run(['work', 'watch', '--once']));
  assert.equal(initial.type, 'work_update');
  assert.ok(initial.sessionKey);
  assert.notEqual(initial.sessionKey, (await a.work.inspect()).sessionKey);
  const controller = new AbortController();
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const updates = [];
  const watching = run(['work', 'watch', '--interval', '100', '--ack'], {
    signal: controller.signal,
    stdout: { write(chunk) {
      const update = JSON.parse(chunk);
      updates.push(update);
      ready();
      if (update.events.length) controller.abort();
    } },
  });
  await started;
  await b.handoff.update({ currentState: 'Watch this change' });
  await watching;
  assert.ok(updates.some((update) => update.events.length));
  assert.ok((await a.work.inspect()).events.length);
});

test('watch reports offline sync honestly and exits promptly when cancelled', async (t) => {
  const { core, env } = await fixture(t);
  const controller = new AbortController();
  const iterator = watchWork({ core: core('observer'), env, heartbeat: false, sync: true,
    signal: controller.signal, synchronize: async () => ({ status: 'deferred', reason: 'network', pending: true, synced: false }) });
  const first = await iterator.next();
  assert.equal(first.value.sync.synced, false);
  assert.equal(first.value.sync.reason, 'network');
  controller.abort();
  assert.equal((await iterator.next()).done, true);
});

test('watch output waits for backpressure and cleans up on cancellation or a closed pipe', async () => {
  const stream = new EventEmitter();
  stream.write = () => false;
  let settled = false;
  const pending = writeWatchUpdate(stream, { type: 'work_update' }).then((result) => { settled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  stream.emit('drain');
  assert.equal(await pending, true);
  assert.equal(stream.listenerCount('close'), 0);
  const controller = new AbortController();
  const aborted = writeWatchUpdate(stream, {}, { signal: controller.signal });
  controller.abort();
  assert.equal(await aborted, false);
  assert.equal(stream.listenerCount('drain'), 0);
  const closed = writeWatchUpdate(stream, {});
  stream.emit('close');
  assert.equal(await closed, false);
});

test('privacy CLI protects secrets and configures exclusions without silently deleting records', async (t) => {
  const { core, run } = await fixture(t);
  const secret = `ghp_${'x'.repeat(30)}`;
  const scan = await run(['privacy', 'scan', '--text', `Token ${secret}`]);
  assert.equal(JSON.parse(scan).sensitive, true);
  assert.ok(!scan.includes(secret));
  await assert.rejects(run(['know', 'add', 'Secret', '--text', secret]), { code: 'SENSITIVE_CONTENT' });
  await run(['privacy', 'set', '--exclude-path', 'private/**', '--retention-days', '30']);
  await run(['privacy', 'set', '--scope', 'session', '--enabled', 'false'], { sessionId: 'A' });
  assert.equal((await core('A').privacy.get()).enabled, false);
  assert.equal((await core('B').privacy.get()).enabled, true);
  assert.equal(JSON.parse(await run(['privacy', 'retention', '--project'])).applied, false);
  await core('A').handoff.start({ task: 'legacy-secret', objective: secret, allowSensitive: true });
  const context = await core('A').compose();
  assert.ok(!context.content.includes(secret));
});

test('checkpoint operation session overrides and ambiguous work context respect privacy', async (t) => {
  const { core, env, cwd } = await fixture(t);
  await core('B').privacy.set({ scope: 'session', policy: { enabled: false } });
  const neutral = createCore({ env, cwd, sessionKey: null, agent: 'codex' });
  assert.equal((await neutral.auto.capture({ sessionId: 'B' })).skipped, true);
  await neutral.auto.capture({ sessionId: 'A' });
  assert.equal(await neutral.auto.show({ sessionId: 'B' }), null);
  const secret = `ghp_${'y'.repeat(30)}`;
  await neutral.handoff.start({ task: secret, objective: 'Legacy task name', allowSensitive: true });
  await neutral.handoff.start({ task: 'another', objective: 'Another task' });
  const repository = await neutral.repo.resolve({ create: false });
  const context = await neutral.compose({ repoId: repository.repository.id });
  assert.ok(context.layers.some((layer) => layer.id === 'handoff:selection-required'));
  assert.ok(!JSON.stringify(context).includes(secret));
});

test('CLI semantic configuration and reviewed experiment adoption preserve default search contracts', async (t) => {
  const { core, run } = await fixture(t);
  const a = core('A');
  const work = await a.handoff.start({ task: 'explore', objective: 'Explore alternatives' });
  const base = await a.knowledge.add({ title: 'Decision', body: 'Original option', scope: 'repo' });
  assert.equal(JSON.parse(await run(['know', 'search-config', 'on'])).enabled, true);
  assert.equal(JSON.parse(await run(['know', 'search-config', 'off'])).enabled, false);
  const search = JSON.parse(await run(['know', 'find', 'Original', '--mode', 'hybrid', '--json']));
  assert.equal(search.fallback, true);
  assert.equal(search.reason, 'disabled');
  assert.ok(Array.isArray(JSON.parse(await run(['know', 'find', 'Original', '--json']))));
  const created = JSON.parse(await run(['know', 'branch', 'new', 'alternative', '--work', work.id, '--from', base.id]));
  await run(['know', 'edit', created.entry.id, '--text', 'Reviewed alternative']);
  const list = JSON.parse(await run(['know', 'list', '--json']));
  assert.ok(!list.some((entry) => entry.id === created.entry.id));
  const diff = JSON.parse(await run(['know', 'branch', 'diff', created.entry.id]));
  const adopted = JSON.parse(await run(['know', 'branch', 'adopt', created.entry.id, '--expect', diff.revision]));
  assert.equal(adopted.target.body, 'Reviewed alternative');
  assert.equal((await a.knowledge.get({ id: base.id })).body, 'Reviewed alternative');
});
