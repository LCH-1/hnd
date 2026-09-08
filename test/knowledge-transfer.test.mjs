import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { createCore } from '../src/core/index.mjs';
import { exportKnowledge, importKnowledgeFile, sessionCandidate } from '../src/core/knowledge-transfer.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-transfer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo');
  await fs.mkdir(cwd);
  execFileSync('git', ['-C', cwd, 'init', '-b', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' });
  const env = { HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user'), HND_LANG: 'en' };
  const core = createCore({ env, cwd });
  await core.repo.register();
  const run = async (args) => {
    let output = '';
    await main(args, { cwd, env, stdin: Readable.from([]), stdout: { write(chunk) { output += chunk; } }, stderr: { write() {} } });
    return JSON.parse(output);
  };
  return { root, cwd, env, core, run };
}

test('Markdown knowledge round-trips multiple bodies with horizontal rules and Windows newlines', async (t) => {
  const { core } = await fixture(t);
  const entries = [
    await core.knowledge.add({ title: 'First', body: 'Before\n\n---\n\nAfter\n\n```md\n---\nexample\n---\n```', tags: ['first'] }),
    await core.knowledge.add({ title: 'Second', body: 'Second body\n---\nStill second', tags: ['second'] }),
  ];
  const exported = exportKnowledge(entries, { format: 'markdown' });
  for (const text of [exported, exported.replaceAll('\n', '\r\n')]) {
    const imported = importKnowledgeFile('notes.md', text);
    assert.equal(imported.length, 2);
    for (const [index, original] of entries.entries()) {
      assert.equal(imported[index].title, original.title);
      assert.equal(imported[index].body, original.body);
      assert.deepEqual(imported[index].tags, original.tags);
      assert.equal(imported[index].approval, 'pending');
    }
  }
});

test('JSON and OKF exports with unlabeled sources can actually be saved after import', async (t) => {
  const { core } = await fixture(t);
  const source = await core.knowledge.add({ title: 'Source note', body: 'Keep the provenance', sources: [{ kind: 'file', ref: 'README.md' }] });
  for (const format of ['json', 'okf']) {
    const [candidate] = importKnowledgeFile('notes.json', exportKnowledge([source], { format }));
    const saved = await core.knowledge.add(candidate);
    assert.deepEqual(saved.sources, source.sources);
    assert.equal(saved.approval, 'pending');
  }
});

test('CLI import preserves exported environment unless an explicit override is supplied', async (t) => {
  const { core, cwd, run } = await fixture(t);
  await core.env.set('prod');
  const source = await core.knowledge.add({ title: 'Production only', body: 'Prod deployment constraint', scope: 'env' });
  await fs.writeFile(path.join(cwd, 'export.json'), exportKnowledge([source]));
  await core.env.set('dev');
  const preview = await run(['know', 'import', 'export.json']);
  const saved = await run(['know', 'import', 'export.json', '--apply', '--json']);
  assert.equal(preview.candidates[0].environment, 'prod');
  assert.equal(saved[0].environment, preview.candidates[0].environment);
  const overridePreview = await run(['know', 'import', 'export.json', '--environment', 'staging']);
  const override = await run(['know', 'import', 'export.json', '--apply', '--environment', 'staging', '--json']);
  assert.equal(overridePreview.candidates[0].environment, 'staging');
  assert.equal(override[0].environment, 'staging');
});

test('Codex transcript message envelopes become review candidates without tool results', () => {
  const source = [
    { type: 'session_meta', payload: { id: 'session', cwd: '/project' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Migration finished and checked.' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Remember the rollback constraint.' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'PRIVATE TOOL OUTPUT' } },
  ].map((line) => JSON.stringify(line)).join('\n');
  const candidate = sessionCandidate('session.jsonl', source, { sourceRef: 'session.jsonl' });
  assert.match(candidate.body, /Migration finished and checked/);
  assert.match(candidate.body, /Remember the rollback constraint/);
  assert.doesNotMatch(candidate.body, /PRIVATE TOOL OUTPUT/);
  assert.equal(candidate.approval, 'pending');
  assert.equal(candidate.sources[0].ref, 'session.jsonl');
});

test('optional knowledge cannot displace required policy or shared work when the context budget is tight', async (t) => {
  const { core } = await fixture(t);
  await core.policy.set({ scope: 'repo', content: 'REPOSITORY POLICY MUST REMAIN' });
  await core.policy.set({ scope: 'local', content: 'LOCAL POLICY MUST REMAIN' });
  await core.handoff.start({ task: 'task', objective: 'Selected task must remain' });
  const required = await core.compose();
  await core.knowledge.add({ title: 'Optional reference', body: 'Detailed reference. '.repeat(200), pinned: true });
  const compact = await core.compose({ maxBytes: required.bytes + 20 });
  assert.match(compact.content, /REPOSITORY POLICY MUST REMAIN/);
  assert.match(compact.content, /LOCAL POLICY MUST REMAIN/);
  assert.match(compact.content, /Selected task must remain/);
  assert.ok(compact.layers.some((layer) => layer.kind === 'work-index'));
  assert.ok(!compact.layers.some((layer) => layer.kind === 'knowledge'));
  assert.ok(compact.warnings.some((warning) => warning.code === 'KNOWLEDGE_OMITTED_FOR_SIZE'));
});

test('knowledge context source IDs identify only entries actually rendered', async (t) => {
  const { core } = await fixture(t);
  const oversized = await core.knowledge.add({ title: 'Oversized', body: 'x'.repeat(7000), pinned: true });
  const small = await core.knowledge.add({ title: 'Small', body: 'Actually delivered', pinned: true });
  const layer = (await core.compose()).layers.find((entry) => entry.kind === 'knowledge');
  assert.deepEqual(layer.source, [small.id]);
  assert.doesNotMatch(layer.id, new RegExp(oversized.id));
  assert.match(layer.rendered, /Actually delivered/);
});

test('knowledge export does not follow symlinks or destroy an existing export on failed replacement', async (t) => {
  const { root, core, run } = await fixture(t);
  await core.knowledge.add({ title: 'Export test', body: 'New export contents' });
  const target = path.join(root, 'existing.json');
  await fs.writeFile(target, 'previous backup');
  if (process.platform !== 'win32') {
    const link = path.join(root, 'link.json');
    await fs.symlink(target, link);
    await assert.rejects(run(['know', 'export', '--output', link, '--json']), { code: 'OPERATION_CONFLICT' });
    assert.equal(await fs.readFile(target, 'utf8'), 'previous backup');
  }
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === target) throw Object.assign(new Error('injected export failure'), { code: 'EIO' });
    return rename(from, to);
  };
  try {
    await assert.rejects(run(['know', 'export', '--output', target, '--json']), { code: 'EIO' });
  } finally {
    fs.rename = rename;
  }
  assert.equal(await fs.readFile(target, 'utf8'), 'previous backup');
  await run(['know', 'export', '--output', target, '--json']);
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).entries.length, 1);
  assert.ok(!(await fs.readdir(root)).some((file) => file.endsWith('.tmp')));
});
