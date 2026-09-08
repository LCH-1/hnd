import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCore } from '../src/core/index.mjs';
import { readAppSettings } from '../src/core/app-settings.mjs';
import { setPrivacyPolicy } from '../src/core/privacy.mjs';
import { captureSyncSnapshot, validateSyncSnapshot } from '../src/sync/capture.mjs';
import { validAppSettings } from '../src/shared/app-settings.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-app-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
  const env = { ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user') };
  const core = createCore({ env, cwd, agent: 'codex', sessionId: 'settings-test' });
  await core.init();
  const { repository } = await core.repo.resolve({ create: true });
  const file = path.join(env.HND_HOME, 'app-settings.json');
  const save = (values) => fs.writeFile(file, JSON.stringify({ schemaVersion: 1, ...values }));
  return { cwd, env, core, repository, file, save };
}

test('shared recording preferences default to manual and retain legacy local collection choices', async (t) => {
  const { env, core, save } = await fixture(t);
  await core.auto.set(false);
  await core.config.update({ knowledgeSuggestions: true });
  assert.equal((await core.config.get()).knowledgeSuggestions, true);
  assert.equal(await core.auto.get(), false);
  assert.equal((await readAppSettings({ env })).workRecording, 'manual');
  await save({ autoSave: true, knowledgeSuggestions: false });
  assert.equal(await core.auto.get(), true);
  assert.equal((await core.config.get()).knowledgeSuggestions, false);
  await core.auto.set(false);
  await core.config.update({ knowledgeSuggestions: true });
  assert.equal((await readAppSettings({ env })).autoSave, false);
  assert.equal((await readAppSettings({ env })).knowledgeSuggestions, true);
});

test('automatic recording is delivered in live context, without creating or selecting work by itself', async (t) => {
  const { core, save } = await fixture(t);
  const initial = await core.compose();
  assert.doesNotMatch(initial.content, /Policy: Automatic work recording/);
  await save({ workRecording: 'automatic' });
  const enabled = await core.compose();
  assert.match(enabled.content, /Policy: Automatic work recording/);
  assert.match(enabled.content, /Never inherit another session/);
  assert.match(enabled.content, /Never copy raw prompts/);
  assert.match(enabled.content, /hnd work claim/);
  assert.equal(new Set(enabled.layers.map(layer => layer.id)).size, enabled.layers.length);
  assert.equal((await core.handoff.list()).length, 0);
  await save({ workRecording: 'manual' });
  assert.doesNotMatch((await core.compose()).content, /Policy: Automatic work recording/);
});

test('project and session privacy exclusions prevent automatic recording instructions', async (t) => {
  const { core, env, repository, save } = await fixture(t);
  await save({ workRecording: 'automatic' });
  await setPrivacyPolicy({ env, repoId: repository.id, scope: 'project', policy: { excludeSources: ['session'] } });
  assert.doesNotMatch((await core.compose()).content, /Policy: Automatic work recording/);
  await setPrivacyPolicy({ env, repoId: repository.id, scope: 'project', policy: { excludeSources: [] } });
  await setPrivacyPolicy({ env, repoId: repository.id, agent: 'codex', sessionId: 'settings-test', scope: 'session', policy: { enabled: false } });
  assert.doesNotMatch((await core.compose()).content, /Policy: Automatic work recording/);
});

test('app preferences are synchronized but device credentials and local configuration remain excluded', async (t) => {
  const { env, save } = await fixture(t);
  await save({ workRecording: 'automatic' });
  const snapshot = await captureSyncSnapshot(env.HND_HOME);
  assert.ok(snapshot.files.some(file => file.path === 'app-settings.json'));
  assert.ok(snapshot.files.every(file => file.path !== 'config.json'));
  assert.ok(validateSyncSnapshot(snapshot));
});

test('app preferences reject unexpected fields and invalid types', () => {
  for (const value of [null, [], { schemaVersion: 2 }, { schemaVersion: 1, workRecording: 'yes' }, { schemaVersion: 1, autoSave: 'false' }, { schemaVersion: 1, signupMode: 'open' }]) assert.equal(validAppSettings(value), false);
  assert.equal(validAppSettings({ schemaVersion: 1, workRecording: 'automatic', autoSave: false, knowledgeSuggestions: true }), true);
});
