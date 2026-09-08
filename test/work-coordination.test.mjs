import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCore } from '../src/core/index.mjs';
import { withStateLock } from '../src/core/mutation-lock.mjs';
import { normalizePlannedFiles } from '../src/core/handoffs.mjs';
import { acknowledgeWorkEvents, heartbeatWorkSession, inspectWorkCoordination } from '../src/core/work-coordination.mjs';
import { workSessionKey } from '../src/core/work-session.mjs';
import { captureSnapshot } from '../src/sync/capture.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-work-coordination-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo');
  await fs.mkdir(cwd);
  execFileSync('git', ['-C', cwd, 'init', '-b', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' });
  const env = { HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user') };
  let now = Date.parse('2026-09-07T00:00:00.000Z');
  const clock = () => new Date(now);
  const core = (sessionId) => createCore({ cwd, env, clock, agent: 'codex', sessionId });
  const repoId = (await core().repo.register()).repository.id;
  const base = { cwd, repoId, env, clock, agent: 'codex' };
  const invoke = (operation, sessionId, options = {}) => withStateLock(() => operation({ ...base, sessionId, ...options }), { env });
  return {
    root, cwd, env, clock, core, repoId, base,
    cache: path.join(env.HND_HOME, 'cache', `work-events-${repoId}.json`),
    inspect: (sessionId, options) => invoke(inspectWorkCoordination, sessionId, options),
    ack: (sessionId, options) => invoke(acknowledgeWorkEvents, sessionId, options),
    heartbeat: (sessionId, options) => invoke(heartbeatWorkSession, sessionId, options),
    advance: (hours) => { now += hours * 3_600_000; },
  };
}

test('file intentions are distinct from changes, normalized, and warn across different active work items', async (t) => {
  const { core, inspect } = await fixture(t);
  const a = await core('A').handoff.start({ task: 'auth', objective: 'Auth', plannedFiles: ['./src/auth.mjs', 'src\\auth.mjs'] });
  const b = await core('B').handoff.start({ task: 'billing', objective: 'Billing', plannedFiles: ['src/auth.mjs', 'src/billing.mjs'] });
  assert.deepEqual(a.plannedFiles, ['src/auth.mjs']);
  assert.deepEqual(a.changedFiles, []);
  const coordination = await inspect('A');
  assert.equal(coordination.conflicts.length, 1);
  assert.equal(coordination.conflicts[0].file, 'src/auth.mjs');
  assert.equal(coordination.conflicts[0].advisory, true);
  assert.equal(coordination.conflicts[0].affectsSession, true);
  assert.deepEqual(new Set(coordination.conflicts[0].works.map((work) => work.workId)), new Set([a.id, b.id]));
  await core('B').handoff.update({ patch: { plannedFiles: ['src/billing.mjs'] } });
  assert.deepEqual((await inspect('A')).conflicts, []);
  for (const file of ['../escape', 'src/../escape', '/absolute', 'C:\\absolute', 'C:relative', 'a\nb', 'folder/', '.']) {
    assert.throws(() => normalizePlannedFiles([file]), { code: 'INVALID_WORK_FILES' });
  }
  await assert.rejects(core('B').handoff.update({ id: a.id, patch: { plannedFiles: [] } }), { code: 'HANDOFF_CLAIM_CONFLICT' });
});

test('file warnings include existing changed paths while ignoring invalid legacy descriptions and duplicate paths', async (t) => {
  const { core, inspect } = await fixture(t);
  const a = await core('A').handoff.start({
    task: 'existing', objective: 'Previous edits', plannedFiles: ['src/shared.mjs'],
    changedFiles: ['src/shared.mjs', '../outside', '/absolute/path', 'Legacy note\nnot a path'],
  });
  assert.deepEqual((await inspect('A')).conflicts, []);
  await core('B').handoff.start({ task: 'next', objective: 'Next edits', changedFiles: ['./src/shared.mjs'] });
  const { conflicts } = await inspect('A');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].file, 'src/shared.mjs');
  assert.equal(conflicts[0].works.length, 2);
  assert.deepEqual(conflicts[0].works.find((work) => work.workId === a.id).sources, ['planned', 'changed']);
});

test('heartbeats renew only the current valid owner near expiry without fabricating progress', async (t) => {
  const { core, inspect, heartbeat, advance } = await fixture(t);
  const first = await core('A').handoff.start({ task: 'owned', objective: 'Owned work' });
  await inspect('A');
  assert.equal((await heartbeat('A')).unchanged.length, 1);
  advance(1.75);
  const renewal = await heartbeat('A');
  assert.equal(renewal.renewed[0].id, first.id);
  const renewed = await core('A').handoff.show();
  assert.ok(Date.parse(renewed.claimExpiresAt) > Date.parse(first.claimExpiresAt));
  assert.equal(renewed.updatedAt, first.updatedAt);
  assert.equal(renewed.staleAt, first.staleAt);
  assert.equal((await heartbeat('A')).renewed.length, 0);
  assert.equal((await core('A').handoff.show()).history.length, renewed.history.length);
  await core('B').handoff.update({ id: first.id, claimedBy: 'B', forceClaim: true });
  const lost = await heartbeat('A');
  assert.deepEqual(lost.lost.map(({ id, reason }) => ({ id, reason })), [{ id: first.id, reason: 'taken-over' }]);
  assert.equal(lost.renewed.length, 0);
  advance(3);
  assert.equal((await heartbeat('B')).lost[0].reason, 'expired');
  assert.equal((await core('B').handoff.show({ id: first.id })).claimActive, false);
});

test('new sessions establish a baseline and event acknowledgement remains per-session and explicit', async (t) => {
  const { core, inspect, ack, cache, env } = await fixture(t);
  assert.equal((await inspect('A')).baseline, true);
  await inspect('B');
  const task = await core('A').handoff.start({ task: 'first', objective: 'PRIVATE-FULL-BODY-MUST-NOT-ENTER-EVENT-CACHE' });
  const a = await inspect('A');
  const b = await inspect('B');
  assert.equal(a.events[0].workId, task.id);
  assert.equal(a.events[0].action, 'created');
  assert.equal((await inspect('A')).events[0].id, a.events[0].id);
  const fresh = await inspect('new-session');
  assert.equal(fresh.baseline, true);
  assert.deepEqual(fresh.events, []);
  await assert.rejects(ack('new-session', { epoch: a.eventCursor.epoch, eventIds: [a.events[0].id] }), { code: 'INVALID_WORK_EVENT_ACK' });
  await ack('A', { epoch: a.eventCursor.epoch, eventIds: [a.events[0].id] });
  assert.deepEqual((await inspect('A')).events, []);
  assert.equal((await inspect('B')).events[0].id, b.events[0].id);
  await core('A').handoff.update({ currentState: 'CHANGED-TEXT-MUST-NOT-ENTER-EVENT-CACHE' });
  const changed = await inspect('B');
  assert.ok(changed.events.some((event) => event.fields.includes('currentState')));
  const persisted = await fs.readFile(cache, 'utf8');
  assert.doesNotMatch(persisted, /PRIVATE-FULL-BODY|CHANGED-TEXT/);
  assert.ok((await captureSnapshot(env.HND_HOME)).files.every((file) => !file.path.includes('work-events-')));
  await assert.rejects(ack('B', { epoch: 'different-epoch', eventIds: [] }), { code: 'WORK_EVENT_EPOCH_CHANGED' });
});

test('acknowledging a displayed subset does not acknowledge omitted or out-of-order events', async (t) => {
  const { core, inspect, ack } = await fixture(t);
  await inspect('reader');
  await core('writer').handoff.start({ task: 'task', objective: 'Task' });
  const first = await inspect('reader');
  await core('writer').handoff.update({ currentState: 'Second state' });
  const both = await inspect('reader');
  assert.equal(both.events.length, 2);
  const partial = await ack('reader', { epoch: both.eventCursor.epoch, eventIds: [both.events[1].id] });
  assert.equal(partial.cursor, 0);
  assert.deepEqual((await inspect('reader')).events.map((event) => event.id), [first.events[0].id]);
  const completed = await ack('reader', { epoch: both.eventCursor.epoch, eventIds: [first.events[0].id] });
  assert.equal(completed.cursor, 2);
  assert.deepEqual((await inspect('reader')).events, []);
});

test('bounded queues report lost ranges and require a separate explicit gap acknowledgement', async (t) => {
  const { core, inspect, ack, cache } = await fixture(t);
  await inspect('reader');
  const task = await core('writer').handoff.start({ task: 'task', objective: 'Task' });
  const first = await inspect('reader');
  const stored = JSON.parse(await fs.readFile(cache, 'utf8'));
  stored.sequence = 512;
  stored.events = Array.from({ length: 512 }, (_, index) => ({
    ...first.events[0], id: `${stored.epoch}:${index + 1}`, sequence: index + 1,
  }));
  await fs.writeFile(cache, JSON.stringify(stored));
  await core('writer').handoff.update({ currentState: 'A newer state' });
  const gap = await inspect('reader', { limit: 512 });
  assert.equal(gap.events.length, 512);
  assert.deepEqual(gap.gap, { from: 1, to: 1 });
  const acknowledged = await ack('reader', { epoch: gap.eventCursor.epoch, eventIds: gap.events.map((event) => event.id) });
  assert.equal(acknowledged.cursor, 0);
  assert.deepEqual((await inspect('reader')).gap, { from: 1, to: 1 });
  await assert.rejects(ack('reader', { epoch: gap.eventCursor.epoch, gapThrough: 2 }), { code: 'INVALID_WORK_EVENT_ACK' });
  const recovered = await ack('reader', { epoch: gap.eventCursor.epoch, gapThrough: 1 });
  assert.deepEqual(recovered.acknowledgedGap, { from: 1, to: 1 });
  assert.equal(recovered.cursor, 513);
  assert.equal((await inspect('reader')).gap, null);
  assert.equal(task.id, gap.events[0].workId);
});

test('cache damage resets its epoch visibly and rejects acknowledgements from the old epoch', async (t) => {
  const { inspect, ack, cache } = await fixture(t);
  const first = await inspect('A');
  await fs.writeFile(cache, '{damaged');
  const reset = await inspect('A');
  assert.equal(reset.cacheReset, true);
  assert.equal(reset.baseline, true);
  assert.notEqual(reset.eventCursor.epoch, first.eventCursor.epoch);
  await assert.rejects(ack('A', { epoch: first.eventCursor.epoch, eventIds: [] }), { code: 'WORK_EVENT_EPOCH_CHANGED' });
});

test('the 512-session cache retains a newly observed session even when every timestamp is identical', async (t) => {
  const { inspect, cache } = await fixture(t);
  await inspect('original');
  const state = JSON.parse(await fs.readFile(cache, 'utf8'));
  const template = Object.values(state.sessions)[0];
  state.sessions = Object.fromEntries(Array.from({ length: 512 }, (_, index) => [
    workSessionKey({ agent: 'codex', sessionId: `old-${index}`, env: {} }), structuredClone(template),
  ]));
  await fs.writeFile(cache, JSON.stringify(state));
  assert.equal((await inspect('new')).baseline, true);
  assert.equal(Object.keys(JSON.parse(await fs.readFile(cache, 'utf8')).sessions).length, 512);
  assert.equal((await inspect('new')).baseline, false);
});

test('takeover competing with a heartbeat cannot resurrect the previous owner', async (t) => {
  const { core, heartbeat, advance } = await fixture(t);
  const task = await core('A').handoff.start({ task: 'race', objective: 'One current owner' });
  advance(1.75);
  await Promise.all([
    heartbeat('A'),
    core('B').handoff.update({ id: task.id, claimedBy: 'B', forceClaim: true }),
  ]);
  assert.equal((await core('B').handoff.show({ id: task.id })).claimSessionKey,
    workSessionKey({ agent: 'codex', sessionId: 'B', env: {} }));
});

test('previewing a takeover cannot hide loss of an owned work item that is no longer selected', async (t) => {
  const { core, inspect, heartbeat } = await fixture(t);
  const first = await core('A').handoff.start({ task: 'first', objective: 'First' });
  await core('A').handoff.start({ task: 'second', objective: 'Second' });
  await inspect('A');
  await core('B').handoff.update({ id: first.id, claimedBy: 'B', forceClaim: true });
  await inspect('A');
  const activity = await heartbeat('A');
  assert.ok(activity.lost.some((record) => record.id === first.id && record.reason === 'taken-over'));
  assert.ok(!(await heartbeat('A')).lost.some((record) => record.id === first.id));
});

test('handoff sensitive content requires an explicit override while old contents do not block lease or close', async (t) => {
  const { core, heartbeat, advance } = await fixture(t);
  const secret = `ghp_${'A'.repeat(30)}`;
  await assert.rejects(core('A').handoff.start({ task: 'private', objective: secret }), { code: 'SENSITIVE_CONTENT' });
  const task = await core('A').handoff.start({ task: 'private', objective: secret, allowSensitive: true });
  await assert.rejects(core('A').handoff.update({ notes: [secret] }), { code: 'SENSITIVE_CONTENT' });
  advance(1.75);
  assert.equal((await heartbeat('A')).renewed.length, 1);
  await core('A').handoff.update({ currentState: 'Safe new progress' });
  await assert.rejects(core('A').handoff.close({ notes: [secret] }), { code: 'SENSITIVE_CONTENT' });
  assert.equal((await core('A').handoff.close()).id, task.id);
});
