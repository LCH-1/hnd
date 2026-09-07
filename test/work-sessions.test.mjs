import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { createCore } from '../src/core/index.mjs';
import { resolveWorkSession, workSessionKey, WORK_SESSION_ENV } from '../src/core/work-session.mjs';
import { listLiveContextDeliveries, liveContextSessionKey, recordLiveContextDelivery } from '../src/core/live-context.mjs';
import { connectClaudeSessionEnvironment } from '../src/adapters/session-environment.mjs';
import { captureSnapshot } from '../src/sync/capture.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-work-sessions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo');
  await fs.mkdir(cwd);
  execFileSync('git', ['-C', cwd, 'init', '-b', 'main']);
  execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const env = { HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user'), HND_LANG: 'en' };
  let now = Date.now();
  const clock = () => new Date(now);
  const core = (sessionId) => createCore({ cwd, env, clock, sessionId, agent: 'codex' });
  const run = async (args, payload, overrides = {}) => {
    let stdout = '';
    let stderr = '';
    const code = await main(args, {
      cwd, env: { ...env, ...overrides },
      stdin: Readable.from(payload ? [JSON.stringify(payload)] : []),
      stdout: { write: (value) => { stdout += value; return true; } },
      stderr: { write: (value) => { stderr += value; return true; } },
    });
    return { code, stdout, stderr };
  };
  return { root, cwd, env, clock, core, run, advance: (hours) => { now += hours * 3_600_000; } };
}

test('same project sessions share work but never overwrite one another’s current selection', async (t) => {
  const { core } = await fixture(t);
  const a = core('A');
  const b = core('B');
  const first = await a.handoff.start({ task: 'auth', objective: 'Fix auth', currentState: 'A is editing auth' });
  const second = await b.handoff.start({ task: 'billing', objective: 'Fix billing', currentState: 'B is editing billing' });
  await a.handoff.update({ currentState: 'A saved only auth' });
  assert.equal((await a.handoff.show()).id, first.id);
  assert.equal((await b.handoff.show()).id, second.id);
  assert.equal((await b.handoff.show()).currentState, 'B is editing billing');
  assert.equal((await a.handoff.list()).length, 2);
  const contextA = await a.compose();
  const contextB = await b.compose();
  assert.equal(contextA.handoff.id, first.id);
  assert.equal(contextB.handoff.id, second.id);
  assert.equal(contextA.work.revision, contextB.work.revision);
  assert.match(contextA.content, /B is editing billing/);
  assert.match(contextB.content, /A saved only auth/);
  assert.equal(first.claimSessionKey, contextA.work.sessionKey);
  assert.equal((await a.handoff.show()).history.at(-1).sessionKey, contextA.work.sessionKey);
  await a.handoff.close();
  assert.equal((await a.compose()).handoff, null);
  assert.equal((await b.handoff.show()).id, second.id);
  await assert.rejects(a.handoff.update({ currentState: 'must not update billing' }), { code: 'HANDOFF_SELECTION_REQUIRED' });
});

test('new sessions do not inherit legacy selections or the only available task', async (t) => {
  const { core } = await fixture(t);
  const legacy = core();
  const task = await legacy.handoff.start({ task: 'legacy', objective: 'Existing work' });
  const a = core('fresh');
  assert.equal((await a.compose()).handoff, null);
  await assert.rejects(a.handoff.show(), { code: 'HANDOFF_SELECTION_REQUIRED' });
  await a.handoff.select({ id: task.id });
  assert.equal((await a.handoff.show()).id, task.id);
  assert.equal((await legacy.handoff.show()).id, task.id);
  const b = core('other');
  assert.equal((await b.compose()).handoff, null);
});

test('session claims reject foreign writes, release, close, and same-name impersonation; expiry and explicit takeover work', async (t) => {
  const { core, advance } = await fixture(t);
  const a = core('A');
  const b = core('B');
  const first = await a.handoff.start({ task: 'owned', objective: 'Owned task', claimedBy: 'same display name' });
  await b.handoff.select({ id: first.id });
  for (const operation of [
    () => b.handoff.update({ currentState: 'foreign write' }),
    () => b.handoff.update({ claimedBy: 'same display name' }),
    () => b.handoff.update({ claimedBy: null }),
    () => b.handoff.close(),
    () => core().handoff.update({ id: first.id, currentState: 'missing identity' }),
  ]) await assert.rejects(operation, { code: 'HANDOFF_CLAIM_CONFLICT' });
  await b.handoff.update({ claimedBy: 'explicit takeover', forceClaim: true });
  assert.equal((await b.handoff.show()).claimSessionKey, (await b.compose()).work.sessionKey);
  await assert.rejects(a.handoff.update({ currentState: 'old owner' }), { code: 'HANDOFF_CLAIM_CONFLICT' });
  advance(3);
  assert.equal((await b.handoff.show()).claimActive, false);
  await a.handoff.update({ claimedBy: 'resumed' });
  assert.equal((await a.handoff.show()).claimActive, true);
  await a.handoff.update({ claimedBy: null });
  assert.equal((await a.handoff.show()).claimSessionKey, null);
  await b.handoff.update({ currentState: 'shared unclaimed edit' });
});

test('each session tracks the last delivered shared work revision independently', async (t) => {
  const { core, env, clock } = await fixture(t);
  const a = core('A');
  const b = core('B');
  await a.handoff.start({ task: 'auth', objective: 'Auth' });
  await b.handoff.start({ task: 'billing', objective: 'Billing' });
  const initialA = await a.compose();
  const initialB = await b.compose();
  await recordLiveContextDelivery({ agent: 'codex', payload: { session_id: 'A' }, composition: initialA, env, clock });
  await recordLiveContextDelivery({ agent: 'codex', payload: { session_id: 'B' }, composition: initialB, env, clock });
  await b.handoff.update({ currentState: 'billing schema changed' });
  const changedA = await a.compose();
  assert.notEqual(changedA.work.revision, initialA.work.revision);
  // Reading/previewing does not acknowledge the new state.
  assert.equal((await listLiveContextDeliveries({ env })).find((entry) => entry.sessionKey === initialA.work.sessionKey).workRevision, initialA.work.revision);
  const delivery = await recordLiveContextDelivery({ agent: 'codex', payload: { session_id: 'A' }, composition: changedA, env, clock });
  assert.equal(delivery.changed, true);
  assert.match(delivery.content, /billing schema changed/);
  const markers = await listLiveContextDeliveries({ env });
  assert.equal(markers.find((entry) => entry.sessionKey === initialA.work.sessionKey).workRevision, changedA.work.revision);
  assert.equal(markers.find((entry) => entry.sessionKey === initialB.work.sessionKey).workRevision, initialB.work.revision);
  const snapshot = await captureSnapshot(env.HND_HOME);
  assert.ok(snapshot.files.some((file) => file.path.includes('/handoffs/')));
  assert.ok(snapshot.files.every((file) => !file.path.includes('handoff-selections') && !file.path.includes('live-context-delivery')));
});

test('CLI session identity matches hooks and Cursor materialization never publishes a personal selection', async (t) => {
  const { run, cwd, core } = await fixture(t);
  const createdA = await run(['work', 'new', 'task-A', '--goal', 'A', '--session-id', 'A', '--session-agent', 'codex', '--json']);
  assert.equal(createdA.stderr, '');
  const a = JSON.parse(createdA.stdout);
  const createdB = await run(['work', 'new', 'task-B', '--goal', 'B', '--session-id', 'B', '--session-agent', 'codex', '--json']);
  assert.equal(createdB.stderr, '');
  const b = JSON.parse(createdB.stdout);
  const hookA = await run(['hook', 'codex', 'start'], { cwd, session_id: 'A' });
  assert.equal(hookA.stderr, '');
  const text = JSON.parse(hookA.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, new RegExp(`Selected work: ${a.id}`));
  assert.match(text, /task-B/);
  const session = JSON.parse((await run(['work', 'session', '--session-id', 'A', '--session-agent', 'codex'])).stdout);
  assert.equal(session.selectedHandoffId, a.id);
  assert.equal(session.hasUndeliveredChanges, false);
  const key = workSessionKey({ sessionId: 'B', agent: 'codex' });
  assert.equal(JSON.parse((await run(['work', 'show', '--json'], undefined, { [WORK_SESSION_ENV]: key })).stdout).id, b.id);
  await run(['materialize', '--session-key', key]);
  const shared = await fs.readFile(path.join(cwd, '.cursor/rules/50-hnd.mdc'), 'utf8');
  assert.match(shared, /Shared project work/);
  assert.doesNotMatch(shared, /This session:|Selected work:|Active handoff context/);
  const cursor = await run(['hook', 'cursor', 'start'], { cwd, session_id: 'cursor-A' });
  const cursorWire = JSON.parse(cursor.stdout);
  assert.equal(cursorWire.env[WORK_SESSION_ENV], workSessionKey({ sessionId: 'cursor-A', agent: 'cursor' }));
  await run(['hook', 'cursor', 'prompt'], { cwd, conversation_id: 'cursor-A' });
  assert.doesNotMatch(await fs.readFile(path.join(cwd, '.cursor/rules/50-hnd.mdc'), 'utf8'), /This session:|Selected work:/);
  assert.equal((await core('A').handoff.show()).id, a.id);
});

test('work session identity is bounded, namespaced, explicit, and supports neutral views', () => {
  const key = workSessionKey({ sessionId: 'same', agent: 'codex' });
  assert.notEqual(key, workSessionKey({ sessionId: 'same', agent: 'claude' }));
  assert.equal(workSessionKey({ env: { [WORK_SESSION_ENV]: key } }), key);
  assert.equal(workSessionKey({ sessionKey: null, env: { [WORK_SESSION_ENV]: key } }), null);
  assert.equal(workSessionKey({ env: { HND_SESSION_ID: 'same', HND_SESSION_AGENT: 'codex' } }), key);
  assert.equal(workSessionKey({ sessionKey: key, env: { HND_SESSION_ID: 'other' } }), key);
  assert.equal(workSessionKey({ env: { [WORK_SESSION_ENV]: key, HND_SESSION_ID: 'other' } }), key);
  assert.throws(() => workSessionKey({ sessionId: '' }), { code: 'INVALID_WORK_SESSION' });
  assert.throws(() => workSessionKey({ sessionKey: '../wrong' }), { code: 'INVALID_WORK_SESSION' });
});

test('competing sessions cannot both claim unowned shared work', async (t) => {
  const { core } = await fixture(t);
  const task = await core().handoff.start({ task: 'shared', objective: 'One owner' });
  const results = await Promise.allSettled([
    core('A').handoff.update({ id: task.id, claimedBy: 'agent A' }),
    core('B').handoff.update({ id: task.id, claimedBy: 'agent B' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'HANDOFF_CLAIM_CONFLICT');
});

test('per-operation session identity overrides a neutral or differently bound core', async (t) => {
  const { core } = await fixture(t);
  const neutral = core();
  const a = await neutral.handoff.start({ sessionId: 'A', task: 'A', objective: 'A' });
  const b = await core('A').handoff.start({ sessionId: 'B', task: 'B', objective: 'B' });
  assert.equal((await core('A').handoff.show()).id, a.id);
  assert.equal((await core('B').handoff.show()).id, b.id);
  assert.equal((await neutral.compose({ sessionId: 'A' })).handoff.id, a.id);
});

test('session selections remain separate across branches and unselected hooks show shared work only', async (t) => {
  const { core, cwd, run } = await fixture(t);
  const a = core('A');
  const task = await a.handoff.start({ task: 'main task', objective: 'Main' });
  execFileSync('git', ['-C', cwd, 'checkout', '-b', 'feature'], { stdio: 'ignore' });
  assert.equal((await a.compose()).handoff, null);
  execFileSync('git', ['-C', cwd, 'checkout', 'main'], { stdio: 'ignore' });
  assert.equal((await a.handoff.show()).id, task.id);
  const hook = await run(['hook', 'codex', 'start'], { cwd, session_id: 'unselected' });
  const text = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /main task/);
  assert.match(text, /Selected work: none/);
  assert.doesNotMatch(text, /Active handoff context/);
});

test('oversized shared summaries never displace policy or get acknowledged as delivered work', async (t) => {
  const { core, env, clock } = await fixture(t);
  const a = core('A');
  await a.handoff.start({ task: 'task', objective: 'Important task' });
  await a.policy.set({ scope: 'local', content: 'LOCAL RULE MUST REMAIN' });
  const full = await a.compose();
  const index = full.layers.find((layer) => layer.kind === 'work-index');
  const compact = await a.compose({ maxBytes: full.bytes - index.bytes });
  assert.equal(compact.work.omitted, true);
  assert.match(compact.content, /LOCAL RULE MUST REMAIN/);
  assert.match(compact.content, /Important task/);
  assert.ok(compact.warnings.some((warning) => warning.code === 'WORK_INDEX_OMITTED_FOR_SIZE'));
  await recordLiveContextDelivery({ agent: 'codex', payload: { session_id: 'A' }, composition: compact, env, clock });
  assert.equal((await listLiveContextDeliveries({ env }))[0].workRevision, null);
  await recordLiveContextDelivery({ agent: 'codex', payload: { session_id: 'A' }, composition: full, env, clock });
  await a.handoff.update({ currentState: 'not delivered yet' });
  const changed = await a.compose({ maxBytes: full.bytes - index.bytes + 100 });
  assert.equal(changed.work.omitted, true);
  await recordLiveContextDelivery({ agent: 'codex', payload: { session_id: 'A' }, composition: changed, env, clock });
  assert.equal((await listLiveContextDeliveries({ env }))[0].workRevision, full.work.revision);
});

test('native routing is namespaced, explicit overrides still win, and ambiguous identities fail closed', () => {
  const key = (agent, sessionId) => workSessionKey({ agent, sessionId, env: {} });
  assert.deepEqual(resolveWorkSession({ env: { CODEX_THREAD_ID: 'thread-A', CODEX_SESSION_ID: 'old' } }), {
    sessionKey: key('codex', 'thread-A'), source: 'CODEX_THREAD_ID',
  });
  assert.equal(resolveWorkSession({ env: { CODEX_SESSION_ID: 'session-A' } }).sessionKey, key('codex', 'session-A'));
  assert.equal(resolveWorkSession({ env: { CURSOR_CONVERSATION_ID: 'thread-A' } }).sessionKey, key('cursor', 'thread-A'));
  const inherited = { CODEX_THREAD_ID: 'A', CURSOR_CONVERSATION_ID: 'B' };
  assert.throws(() => resolveWorkSession({ env: inherited }), { code: 'WORK_SESSION_AMBIGUOUS' });
  assert.equal(resolveWorkSession({ sessionId: 'override', env: inherited }).sessionKey, key('manual', 'override'));
  assert.equal(resolveWorkSession({ env: { ...inherited, [WORK_SESSION_ENV]: key('claude', 'C') } }).sessionKey, key('claude', 'C'));
  assert.equal(resolveWorkSession({ sessionKey: null, env: inherited }).sessionKey, null);
  for (const env of [{ CURSOR_AGENT: '1' }, { CLAUDECODE: '1' }, { CODEX_CI: '1' },
    { CURSOR_CONVERSATION_ID: 'encoded_2Fid' }, { CURSOR_CONVERSATION_ID: 'a'.repeat(200) }]) {
    assert.throws(() => resolveWorkSession({ env }), { code: 'WORK_SESSION_UNAVAILABLE' });
  }
  assert.deepEqual(resolveWorkSession({ env: {} }), { sessionKey: null, source: 'legacy-terminal' });
});

test('Codex and Cursor commands automatically match their hooks across concurrent same-directory sessions', async (t) => {
  const { run, cwd } = await fixture(t);
  for (const [agent, variable] of [['codex', 'CODEX_THREAD_ID'], ['cursor', 'CURSOR_CONVERSATION_ID']]) {
    const a = { [variable]: `${agent}-A` };
    const b = { [variable]: `${agent}-B` };
    const first = JSON.parse((await run(['work', 'new', `${agent}-first`, '--goal', 'First', '--json'], undefined, a)).stdout);
    const second = JSON.parse((await run(['work', 'new', `${agent}-second`, '--goal', 'Second', '--json'], undefined, b)).stdout);
    assert.equal((await run(['work', 'save', '--current', 'A only'], undefined, a)).stderr, '');
    assert.equal(JSON.parse((await run(['work', 'show', '--json'], undefined, a)).stdout).id, first.id);
    assert.equal(JSON.parse((await run(['work', 'show', '--json'], undefined, b)).stdout).id, second.id);
    const context = JSON.parse((await run(['context', '--json'], undefined, a)).stdout);
    assert.equal(context.work.sessionKey, first.claimSessionKey);
    assert.match(context.content, new RegExp(`${agent}-second`));
    const hook = await run(['hook', agent, 'start'], { cwd, session_id: `${agent}-A` });
    const wire = JSON.parse(hook.stdout);
    assert.match(wire.additional_context ?? wire.hookSpecificOutput.additionalContext, new RegExp(`Selected work: ${first.id}`));
    const status = JSON.parse((await run(['work', 'session'], undefined, a)).stdout);
    assert.equal(status.sessionSource, variable);
    assert.equal(status.selectedHandoffId, first.id);
    assert.equal(status.hasUndeliveredChanges, false);
    await assert.rejects(run(['work', 'save', '--id', first.id, '--current', 'foreign'], undefined, b), { code: 'HANDOFF_CLAIM_CONFLICT' });
    assert.equal((await run(['work', 'done'], undefined, a)).stderr, '');
    assert.equal(JSON.parse((await run(['work', 'show', '--json'], undefined, b)).stdout).id, second.id);
  }
});

test('Claude start connects subsequent real shell commands without worker-managed keys and preserves other hook exports', async (t) => {
  const { root, run, cwd, env } = await fixture(t);
  const bin = path.resolve('bin/hnd.mjs');
  const files = [path.join(root, 'claude-A.env'), path.join(root, 'claude-B.env')];
  await fs.writeFile(files[0], "export HND_TEST_EXISTING='keep me'\n", { mode: 0o600 });
  const command = (file, ...args) => JSON.parse(execFileSync('bash', [
    '-c', 'source "$1"; shift; exec "$@"', 'hnd-test', file, process.execPath, bin, ...args,
  ], { cwd, env: { ...process.env, ...env, CLAUDECODE: '1' }, encoding: 'utf8' }));
  for (const [index, file] of files.entries()) {
    const hook = await run(['hook', 'claude', 'start'], { cwd, session_id: `claude-${index}` }, { CLAUDE_ENV_FILE: file });
    assert.equal(hook.stderr, '');
  }
  const first = command(files[0], 'work', 'new', 'claude-first', '--goal', 'First', '--json');
  const second = command(files[1], 'work', 'new', 'claude-second', '--goal', 'Second', '--json');
  assert.equal(command(files[0], 'work', 'show', '--json').id, first.id);
  assert.equal(command(files[1], 'work', 'show', '--json').id, second.id);
  const before = await fs.readFile(files[0], 'utf8');
  assert.match(before, /HND_TEST_EXISTING='keep me'/);
  await run(['hook', 'claude', 'start'], { cwd, session_id: 'claude-0', source: 'resume' }, { CLAUDE_ENV_FILE: files[0] });
  assert.equal(await fs.readFile(files[0], 'utf8'), before);
  assert.equal(command(files[0], 'work', 'session').selectedHandoffId, first.id);
  await run(['hook', 'claude', 'start'], { cwd, session_id: 'new-fork', source: 'fork' }, { CLAUDE_ENV_FILE: files[0] });
  assert.equal(command(files[0], 'work', 'session').selectedHandoffId, null);
  assert.equal(command(files[1], 'work', 'show', '--json').id, second.id);
});

test('Claude environment bridge rejects unsafe targets and never interpolates raw payload into shell source', async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, 'env');
  const key = workSessionKey({ agent: 'claude', sessionId: "$(touch unwanted); 'quoted'", env: {} });
  assert.equal(await connectClaudeSessionEnvironment({ sessionKey: key, env: {} }), false);
  await assert.rejects(connectClaudeSessionEnvironment({ sessionKey: key, env: { CLAUDE_ENV_FILE: 'relative' } }));
  await connectClaudeSessionEnvironment({ sessionKey: key, env: { CLAUDE_ENV_FILE: target } });
  const content = await fs.readFile(target, 'utf8');
  assert.equal(content, `\nexport HND_WORK_SESSION='${key}'\n`);
  if (process.platform !== 'win32') {
    const link = path.join(root, 'symlink');
    await fs.symlink(target, link);
    await assert.rejects(connectClaudeSessionEnvironment({ sessionKey: key, env: { CLAUDE_ENV_FILE: link } }));
    await fs.chmod(target, 0o666);
    await assert.rejects(connectClaudeSessionEnvironment({ sessionKey: key, env: { CLAUDE_ENV_FILE: target } }));
    assert.equal(await fs.readFile(target, 'utf8'), content);
  }
});

test('hook payload identity wins over inherited keys, with only same-agent native fallback', () => {
  const env = { CODEX_THREAD_ID: 'native-codex', HND_CURSOR_RULE_SESSION: 'a'.repeat(64) };
  assert.equal(liveContextSessionKey('cursor', { session_id: 'fresh' }, env), workSessionKey({ agent: 'cursor', sessionId: 'fresh', env: {} }));
  assert.equal(liveContextSessionKey('codex', {}, env), workSessionKey({ agent: 'codex', sessionId: 'native-codex', env: {} }));
  assert.equal(liveContextSessionKey('claude', {}, env), null);
});

test('an unidentified agent never mutates the shared legacy selection; ordinary terminals remain compatible', async (t) => {
  const { run } = await fixture(t);
  const created = JSON.parse((await run(['work', 'new', 'legacy', '--goal', 'Legacy', '--json'])).stdout);
  await assert.rejects(run(['work', 'save', '--current', 'must not leak'], undefined, { CLAUDECODE: '1' }), { code: 'WORK_SESSION_UNAVAILABLE' });
  assert.equal(JSON.parse((await run(['work', 'show', '--json'])).stdout).id, created.id);
  assert.equal(JSON.parse((await run(['work', 'show', '--json'])).stdout).currentState, created.currentState);
  const setup = await run(['setup', '--dry-run'], undefined, { CLAUDECODE: '1' });
  assert.equal(setup.stderr, '');
});
