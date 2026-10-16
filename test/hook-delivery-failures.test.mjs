import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { main, writeHookOutput } from '../src/cli.mjs';
import { listLiveContextDeliveries } from '../src/core/live-context.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-hook-delivery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  await fs.mkdir(cwd);
  const env = { ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user'), HND_DISABLE_AUTO_UPDATE: '1' };
  let errors = '';
  const run = async (args, { output, payload = {} } = {}) => {
    let text = '';
    await main(args, {
      env, cwd, stdin: Readable.from([JSON.stringify({ cwd, session_id: 'delivery-session', ...payload })]),
      stderr: { write: (chunk) => { errors += chunk; return true; } },
      stdout: output ?? { write: (chunk) => { text += chunk; return true; } },
    });
    return text;
  };
  await run(['init']);
  await run(['policy', 'set', 'global', '--text', 'POLICY-MUST-RETRY']);
  return { cwd, env, run, errors: () => errors };
}

test('a failed stdout write leaves policy eligible for delivery on the next prompt', async (t) => {
  const { env, run, errors } = await fixture(t);
  await run(['hook', 'claude', 'prompt'], { output: { write() { throw new Error('broken pipe fixture'); } } });
  assert.match(errors(), /broken pipe fixture/u);
  assert.deepEqual(await listLiveContextDeliveries({ env }), []);
  assert.match(await run(['hook', 'claude', 'prompt']), /POLICY-MUST-RETRY/u);
  assert.equal(await run(['hook', 'claude', 'prompt']), '{}\n');
});

test('asynchronous Writable failure is consumed and does not acknowledge policy delivery', async (t) => {
  const { env, run, errors } = await fixture(t);
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      queueMicrotask(() => callback(Object.assign(new Error('async broken pipe fixture'), { code: 'EPIPE' })));
    },
  });
  await run(['hook', 'codex', 'prompt'], { output });
  assert.match(errors(), /async broken pipe fixture/u);
  assert.deepEqual(await listLiveContextDeliveries({ env }), []);
  assert.match(await run(['hook', 'codex', 'prompt']), /POLICY-MUST-RETRY/u);
});

test('Cursor retries a failed materialization even when the live revision is unchanged', async (t) => {
  const { cwd, env, run, errors } = await fixture(t);
  const rule = path.join(cwd, '.cursor/rules/50-hnd.mdc');
  await fs.mkdir(path.dirname(rule), { recursive: true });
  await fs.writeFile(rule, 'unmanaged fixture');
  assert.equal(await run(['hook', 'cursor', 'prompt']), '{"continue":true}\n');
  assert.match(errors(), /Cursor fallback update failed/u);
  assert.deepEqual(await listLiveContextDeliveries({ env }), []);
  await fs.rm(rule);
  await run(['hook', 'cursor', 'prompt']);
  assert.match(await fs.readFile(rule, 'utf8'), /POLICY-MUST-RETRY/u);
  assert.equal((await listLiveContextDeliveries({ env })).length, 1);
});

test('a Writable error arriving after the output deadline remains handled', async () => {
  let complete;
  const stream = new Writable({ write(_chunk, _encoding, callback) { complete = callback; } });
  await assert.rejects(writeHookOutput(stream, 'context', { deadlineAt: Date.now() + 10 }), /before its deadline/u);
  assert.ok(stream.listenerCount('error') > 0, 'the pending write still needs its error listener');
  complete(Object.assign(new Error('late pipe closure'), { code: 'EPIPE' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stream.listenerCount('error'), 0);
});
