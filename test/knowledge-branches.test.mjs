import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCore } from '../src/core/index.mjs';
import {
  adoptKnowledgeExperiment, createKnowledgeExperiment, diffKnowledgeExperiment,
  getKnowledge, listKnowledgeExperiments, mergeKnowledge, removeKnowledge,
  searchKnowledgeDetailed, updateKnowledge, validateKnowledgeEntry,
} from '../src/core/knowledge.mjs';
import { captureSyncSnapshot, validateSyncSnapshot } from '../src/sync/capture.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-knowledge-branches-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  execFileSync('git', ['init', '--quiet', cwd]);
  execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const env = { ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: root };
  const core = createCore({ env, cwd, sessionKey: null });
  const work = await core.handoff.start({ task: 'Explore', objective: 'Compare alternatives' });
  return { env, cwd, core, work };
}

test('work-linked experiment stays private until explicit reviewed adoption, preserving sources', async (t) => {
  const { env, cwd, core, work } = await fixture(t);
  const base = await core.knowledge.add({ scope: 'repo', title: 'Database', body: 'Use existing storage',
    sources: [{ kind: 'url', ref: 'https://example.invalid/design' }] });
  const created = await createKnowledgeExperiment({ env, cwd, workId: work.id, name: 'alternative', sourceId: base.id });
  assert.equal(created.entry.approval, 'pending');
  assert.equal(validateKnowledgeEntry(created.entry), true);
  await updateKnowledge({ env, id: created.entry.id, body: 'Try experimental vector storage' });
  assert.deepEqual((await core.knowledge.list()).map((entry) => entry.id), [base.id]);
  assert.deepEqual(await core.knowledge.search({ query: 'experimental' }), []);
  assert.deepEqual((await searchKnowledgeDetailed({ env, query: 'experimental', mode: 'semantic' })).items, []);
  assert.doesNotMatch((await core.compose({ knowledgeQuery: 'experimental' })).content, /Try experimental vector storage/);
  const branches = await listKnowledgeExperiments({ env, cwd, workId: work.id });
  assert.equal(branches[0].name, 'alternative');
  assert.equal(branches[0].items[0].id, created.entry.id);
  const diff = await diffKnowledgeExperiment({ env, id: created.entry.id });
  assert.equal(diff.baseChanged, false);
  assert.deepEqual(diff.changes.map((item) => item.field), ['body']);
  await assert.rejects(adoptKnowledgeExperiment({ env, id: created.entry.id }), { code: 'EXPERIMENT_REVIEW_REQUIRED' });
  const adopted = await adoptKnowledgeExperiment({ env, id: created.entry.id, expectedRevision: diff.revision });
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.target.id, base.id);
  assert.equal(adopted.target.body, 'Try experimental vector storage');
  assert.equal(adopted.target.sources[0].ref, base.sources[0].ref);
  assert.ok(adopted.target.sources.some((source) => source.ref === `hnd:experiment-adopted:${created.entry.id}`));
  assert.equal((await adoptKnowledgeExperiment({ env, id: created.entry.id, expectedRevision: diff.revision })).adopted, false);
  assert.deepEqual((await core.knowledge.list()).map((entry) => entry.id), [base.id]);
  const snapshot = await captureSyncSnapshot(env.HND_HOME);
  assert.doesNotThrow(() => validateSyncSnapshot(snapshot));
});

test('generic approve, marker removal, or merge cannot bypass experiment adoption', async (t) => {
  const { env, cwd, core, work } = await fixture(t);
  const base = await core.knowledge.add({ scope: 'repo', title: 'Shared', body: 'known fact' });
  const experiment = (await createKnowledgeExperiment({ env, cwd, workId: work.id, name: 'trial', sourceId: base.id })).entry;
  await assert.rejects(updateKnowledge({ env, id: experiment.id, approval: 'approved' }), { code: 'EXPERIMENT_ADOPTION_REQUIRED' });
  await assert.rejects(updateKnowledge({ env, id: experiment.id, sources: [] }), { code: 'EXPERIMENT_ADOPTION_REQUIRED' });
  await assert.rejects(mergeKnowledge({ env, targetId: base.id, sourceId: experiment.id }), { code: 'EXPERIMENT_ADOPTION_REQUIRED' });
  await assert.rejects(mergeKnowledge({ env, targetId: experiment.id, sourceId: base.id }), { code: 'EXPERIMENT_ADOPTION_REQUIRED' });
  assert.equal((await getKnowledge({ env, id: base.id })).body, 'known fact');
});

test('adoption detects concurrent proposal changes, changed shared bases, and deleted bases', async (t) => {
  for (const mutation of ['proposal', 'base', 'delete']) {
    await t.test(mutation, async (t) => {
      const { env, cwd, core, work } = await fixture(t);
      const base = await core.knowledge.add({ scope: 'repo', title: 'Shared', body: 'original' });
      const experiment = (await createKnowledgeExperiment({ env, cwd, workId: work.id, name: 'trial', sourceId: base.id })).entry;
      const diff = await diffKnowledgeExperiment({ env, id: experiment.id });
      if (mutation === 'proposal') await updateKnowledge({ env, id: experiment.id, body: 'not reviewed' });
      else if (mutation === 'base') await updateKnowledge({ env, id: base.id, body: 'new shared decision' });
      else await removeKnowledge({ env, id: base.id });
      await assert.rejects(adoptKnowledgeExperiment({ env, id: experiment.id, expectedRevision: diff.revision }), { code: 'EXPERIMENT_REVISION_CONFLICT' });
      assert.equal((await getKnowledge({ env, id: experiment.id })).approval, 'pending');
      if (mutation === 'delete') await assert.rejects(getKnowledge({ env, id: base.id }), { code: 'KNOWLEDGE_NOT_FOUND' });
    });
  }
});

test('new experimental notes adopt once under concurrent calls without Git manipulation', async (t) => {
  const { env, cwd, core, work } = await fixture(t);
  const head = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const args = { env, cwd, workId: work.id, name: 'fresh idea', title: 'New approach', body: 'Reviewed candidate' };
  const created = await createKnowledgeExperiment(args);
  assert.equal((await createKnowledgeExperiment(args)).entry.id, created.entry.id);
  const diff = await diffKnowledgeExperiment({ env, id: created.entry.id });
  const results = await Promise.all([1, 2].map(() => adoptKnowledgeExperiment({ env, id: created.entry.id, expectedRevision: diff.revision })));
  assert.equal(results.filter((result) => result.adopted).length, 1);
  assert.equal((await core.knowledge.list()).length, 1);
  assert.equal(execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), head);
  await assert.rejects(updateKnowledge({ env, id: created.entry.id, body: 'reuse old proposal' }), { code: 'EXPERIMENT_ALREADY_ADOPTED' });
});
