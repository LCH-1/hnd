import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCore } from '../src/core/index.mjs';
import {
  buildNotifyEvent,
  consumeTurnStart,
  markTurnStart,
  sendNotification,
} from '../src/core/notify.mjs';
import { validAppSettings } from '../src/shared/app-settings.mjs';
import {
  buildNotifyRequest,
  maskWebhookUrl,
  providerGuide,
  redactNotifySettings,
  renderNotifyText,
  shouldNotify,
  validWebhookUrl,
  webhookUrlProblem,
} from '../src/shared/notify.mjs';

const SLACK_URL = 'https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnopqrst';
const DISCORD_URL = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz';

function channel(values = {}) {
  return {
    id: 'ch1',
    provider: 'slack',
    label: 'Team',
    webhookUrl: SLACK_URL,
    enabled: true,
    trigger: 'long-turn',
    thresholdSeconds: 60,
    ...values,
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-notify-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
  const env = { ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user') };
  const core = createCore({ env, cwd, agent: 'codex', sessionId: 'notify-test' });
  await core.init();
  await core.repo.resolve({ create: true });
  return { cwd, env, core };
}

test('only documented provider webhook URLs are accepted', () => {
  assert.equal(validWebhookUrl('slack', SLACK_URL), true);
  assert.equal(validWebhookUrl('discord', DISCORD_URL), true);
  assert.equal(validWebhookUrl('discord', 'https://canary.discord.com/api/v10/webhooks/123456789012345678/abcdefghijklmnop'), true);
  // A settings file that syncs between devices must not be able to aim a POST
  // at an arbitrary host.
  assert.equal(webhookUrlProblem('slack', 'https://evil.example.com/services/aaaaaaaaaaaa'), 'wrong_host');
  assert.equal(webhookUrlProblem('slack', DISCORD_URL), 'wrong_host');
  assert.equal(webhookUrlProblem('slack', 'http://hooks.slack.com/services/T0/B0/aaaaaaaaaaaa'), 'not_https');
  assert.equal(webhookUrlProblem('slack', 'https://hooks.slack.com/other/T0/B0/aaaaaaaaaaaa'), 'wrong_path');
  assert.equal(webhookUrlProblem('slack', 'https://user:pass@hooks.slack.com/services/T0/B0/aaaaaaaaaaaa'), 'malformed');
  assert.equal(webhookUrlProblem('discord', 'https://discord.com/api/webhooks/12/short'), 'wrong_path');
  assert.equal(webhookUrlProblem('telegram', SLACK_URL), 'unknown_provider');
  assert.equal(webhookUrlProblem('slack', ''), 'missing');
});

test('app settings reject malformed notification channels', () => {
  assert.equal(validAppSettings({ schemaVersion: 1, notify: { channels: [channel()] } }), true);
  assert.equal(validAppSettings({ schemaVersion: 1, notify: { channels: [] } }), true);
  assert.equal(validAppSettings({ schemaVersion: 1, notify: {} }), false);
  assert.equal(validAppSettings({ schemaVersion: 1, notify: { channels: [channel({ trigger: 'hourly' })] } }), false);
  assert.equal(validAppSettings({ schemaVersion: 1, notify: { channels: [channel({ thresholdSeconds: 0 })] } }), false);
  assert.equal(validAppSettings({ schemaVersion: 1, notify: { channels: [channel({ webhookUrl: 'https://example.com' })] } }), false);
  assert.equal(validAppSettings({ schemaVersion: 1, notify: { channels: [channel(), channel()] } }), false);
  assert.equal(validAppSettings({ schemaVersion: 1, notify: { channels: [{ ...channel(), extra: 1 }] } }), false);
});

test('each trigger decides independently whether a turn is worth reporting', () => {
  const stop = { phase: 'stop', elapsedSeconds: 10, changed: false };
  assert.equal(shouldNotify(channel({ trigger: 'always' }), stop), true);
  assert.equal(shouldNotify(channel({ trigger: 'long-turn' }), stop), false);
  assert.equal(shouldNotify(channel({ trigger: 'long-turn' }), { ...stop, elapsedSeconds: 90 }), true);
  assert.equal(shouldNotify(channel({ trigger: 'changed-files' }), stop), false);
  assert.equal(shouldNotify(channel({ trigger: 'changed-files' }), { ...stop, changed: true }), true);
  assert.equal(shouldNotify(channel({ trigger: 'session-end' }), stop), false);
  assert.equal(shouldNotify(channel({ trigger: 'session-end' }), { phase: 'end' }), true);
  // Only session-end channels fire on SessionEnd, so the pair of hooks that run
  // back to back cannot produce two messages for one turn.
  assert.equal(shouldNotify(channel({ trigger: 'always' }), { phase: 'end' }), false);
  // A turn with no recorded start is reported rather than dropped.
  assert.equal(shouldNotify(channel({ trigger: 'long-turn' }), { phase: 'stop', elapsedSeconds: null }), true);
  assert.equal(shouldNotify(channel({ enabled: false, trigger: 'always' }), stop), false);
});

test('each provider receives the payload shape it documents', () => {
  const event = { repository: 'handoff', branch: 'main', agentLabel: 'Codex', elapsedSeconds: 75, changedCount: 3 };
  const slack = buildNotifyRequest(channel(), event);
  assert.equal(slack.url, SLACK_URL);
  assert.equal(JSON.parse(slack.body).text.includes('handoff (main)'), true);
  assert.equal(JSON.parse(slack.body).content, undefined);
  const discord = buildNotifyRequest(channel({ provider: 'discord', webhookUrl: DISCORD_URL }), event);
  assert.equal(JSON.parse(discord.body).text, undefined);
  assert.equal(JSON.parse(discord.body).content.includes('Codex'), true);
  // Discord rejects anything past 2000 characters, so the body is capped.
  const long = renderNotifyText({ currentState: 'x'.repeat(5_000) }, { provider: 'discord' });
  assert.equal(long.length <= 1_800, true);
});

test('webhook URLs never appear in a listing or a redacted view', () => {
  assert.equal(maskWebhookUrl(SLACK_URL).includes('abcdefghij'), false);
  assert.equal(maskWebhookUrl(SLACK_URL).startsWith('https://hooks.slack.com/'), true);
  const redacted = redactNotifySettings({ channels: [channel()] });
  assert.equal(Object.hasOwn(redacted.channels[0], 'webhookUrl'), false);
  assert.equal(JSON.stringify(redacted).includes(SLACK_URL), false);
});

test('message fields are collapsed and screened for secrets', () => {
  const event = buildNotifyEvent({
    phase: 'stop',
    repository: 'handoff',
    work: {
      task: 'Ship it',
      currentState: 'used  token\n\nxoxb-1234567890-abcdefghijklmnopqrstuvwx',
      nextSteps: ['deploy', 'later'],
    },
  });
  assert.equal(event.currentState.includes('xoxb-'), false);
  assert.equal(event.currentState.includes('[REDACTED:slack_token]'), true);
  assert.equal(event.currentState.includes('\n'), false);
  assert.equal(event.nextStep, 'deploy');
  assert.equal(event.title, 'Ship it');
});

test('delivery failures are reported as a reason instead of throwing', async () => {
  const ok = await sendNotification({ channel: channel(), fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.deepEqual(ok, { id: 'ch1', delivered: true, reason: null });
  const rejected = await sendNotification({ channel: channel(), fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.deepEqual(rejected, { id: 'ch1', delivered: false, reason: 'http_404' });
  const offline = await sendNotification({
    channel: channel(),
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.deepEqual(offline, { id: 'ch1', delivered: false, reason: 'network_error' });
  const slow = await sendNotification({
    channel: channel(),
    timeoutMs: 10,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  assert.deepEqual(slow, { id: 'ch1', delivered: false, reason: 'timeout' });
});

test('channels round-trip through the shared settings file', async (t) => {
  const { core, env } = await fixture(t);
  assert.deepEqual(await core.notify.get(), { channels: [] });
  const added = await core.notify.add({ provider: 'slack', webhookUrl: SLACK_URL, label: 'Team' });
  assert.equal(Object.hasOwn(added.channel, 'webhookUrl'), false);
  const id = added.channel.id;
  await core.notify.update({ id, trigger: 'always', enabled: false });
  const [stored] = await core.notify.find({ id });
  assert.equal(stored.trigger, 'always');
  assert.equal(stored.enabled, false);
  assert.equal(stored.webhookUrl, SLACK_URL);

  // Other preferences in the same file survive a notify write untouched.
  const file = path.join(env.HND_HOME, 'app-settings.json');
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), workRecording: 'automatic' }));
  await core.notify.add({ provider: 'discord', webhookUrl: DISCORD_URL });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).workRecording, 'automatic');
  assert.equal((await core.notify.get()).channels.length, 2);

  await assert.rejects(
    core.notify.add({ provider: 'slack', webhookUrl: SLACK_URL }),
    (error) => error.code === 'DUPLICATE_NOTIFY_CHANNEL',
  );
  await assert.rejects(
    core.notify.add({ provider: 'slack', webhookUrl: 'https://example.com/hook' }),
    (error) => error.code === 'INVALID_WEBHOOK_URL',
  );
  await assert.rejects(core.notify.update({ id: 'missing', trigger: 'always' }), (error) => error.code === 'UNKNOWN_NOTIFY_CHANNEL');
  await core.notify.remove({ id });
  assert.equal((await core.notify.get()).channels.length, 1);
});

test('only channels whose trigger matches the turn receive a request', async (t) => {
  const { core } = await fixture(t);
  await core.notify.add({ provider: 'slack', webhookUrl: SLACK_URL, trigger: 'always', label: 'Always' });
  await core.notify.add({ provider: 'discord', webhookUrl: DISCORD_URL, trigger: 'long-turn', thresholdSeconds: 600 });
  const sent = [];
  const result = await core.notify.send({
    event: { phase: 'stop', elapsedSeconds: 5, changed: false },
    fetchImpl: async (url) => { sent.push(url); return { ok: true, status: 200 }; },
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(sent, [SLACK_URL]);
});

test('turn duration is measured from the prompt hook and consumed once', async (t) => {
  const { env } = await fixture(t);
  let now = 1_000_000;
  const clock = { now: () => now };
  assert.equal(await consumeTurnStart({ env, agent: 'codex', sessionKey: 's1', clock }), null);
  await markTurnStart({ env, agent: 'codex', sessionKey: 's1', clock });
  now += 90_000;
  assert.equal(await consumeTurnStart({ env, agent: 'codex', sessionKey: 's1', clock }), 90);
  // The marker is one-shot: a second read must not reuse a spent start time.
  assert.equal(await consumeTurnStart({ env, agent: 'codex', sessionKey: 's1', clock }), null);
  // Sessions are keyed separately so two agents cannot read each other's turn.
  await markTurnStart({ env, agent: 'codex', sessionKey: 's1', clock });
  assert.equal(await consumeTurnStart({ env, agent: 'claude', sessionKey: 's1', clock }), null);
});

test('the prompt-phase write stays off the directory-scanning path', async (t) => {
  const { env } = await fixture(t);
  let now = 2_000_000;
  const clock = { now: () => now };
  // UserPromptSubmit runs under a two-second vendor timeout, so marking a turn
  // must not grow with the number of sessions that ever ran on this machine.
  for (const sessionKey of ['a', 'b', 'c']) await markTurnStart({ env, agent: 'codex', sessionKey, clock });
  const directory = path.join(env.HND_HOME, 'runtime', 'turns');
  assert.equal((await fs.readdir(directory)).length, 3);

  // Age every marker past retention, then mark another turn: the prompt path
  // must leave the expired files alone instead of reading each one.
  now += 25 * 60 * 60 * 1000;
  await markTurnStart({ env, agent: 'codex', sessionKey: 'd', clock });
  assert.equal((await fs.readdir(directory)).length, 4);

  // The stop path is where expiry is actually swept, under the larger budget.
  assert.equal(await consumeTurnStart({ env, agent: 'codex', sessionKey: 'd', clock }), 0);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('the settings panel wiring resolves against the shipped markup', async () => {
  const [html, app, worker, staticRoutes] = await Promise.all([
    fs.readFile(new URL('../src/web/app.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/web/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/web/sw.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/server/web-static.mjs', import.meta.url), 'utf8'),
  ]);
  const ids = new Set([...html.matchAll(/id="([^"]+)"/gu)].map((match) => match[1]));
  const referenced = [...app.matchAll(/\$\("#(notify[^"]*)"/gu)].map((match) => match[1]);
  assert.equal(referenced.length > 0, true);
  assert.deepEqual(referenced.filter((id) => !ids.has(id)), []);

  const dialog = html.slice(html.indexOf('id="notify-dialog"'), html.indexOf('id="project-dialog"'));
  const fields = new Set([...dialog.matchAll(/name="([^"]+)"/gu)].map((match) => match[1]));
  for (const name of ['id', 'provider', 'webhookUrl', 'label', 'trigger', 'thresholdSeconds', 'enabled']) {
    assert.equal(fields.has(name), true, `dialog is missing the ${name} field`);
  }
  assert.match(dialog, /data-notify-field="threshold"/u);
  // The provider is a radio group, not a select: app.js reads it through
  // elements.namedItem("provider").value, which works for a RadioNodeList only
  // while every option shares the name and one of them is checked by default.
  const providers = [...dialog.matchAll(/<input[^>]*name="provider"[^>]*>/gu)].map((match) => match[0]);
  assert.equal(providers.length, 2);
  for (const input of providers) assert.match(input, /type="radio"/u);
  assert.equal(providers.filter((input) => /\schecked\b/u.test(input)).length, 1);
  assert.deepEqual(
    providers.map((input) => input.match(/value="([^"]+)"/u)[1]),
    ['slack', 'discord'],
  );
  assert.doesNotMatch(dialog, /<select name="provider"/u);
  // The panel imports a shared module, so both delivery paths must serve it.
  assert.match(staticRoutes, /'\/shared\/notify\.mjs'/u);
  assert.match(worker, /"\/shared\/notify\.mjs"/u);
});

test('setup guidance is available for every supported provider in both languages', () => {
  for (const provider of ['slack', 'discord']) {
    for (const language of ['ko', 'en']) {
      const guide = providerGuide(provider, language);
      assert.equal(guide.provider, provider);
      assert.equal(guide.steps.length >= 4, true);
      assert.equal(validWebhookUrl(provider, guide.example), true);
    }
  }
});
