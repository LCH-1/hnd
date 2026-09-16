import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  NOTIFY_DEFAULT_THRESHOLD_SECONDS,
  NOTIFY_DEFAULT_TRIGGER,
  NOTIFY_MAX_CHANNELS,
  NOTIFY_MAX_LABEL_LENGTH,
  NOTIFY_PROVIDERS,
  NOTIFY_TRIGGERS,
  buildNotifyRequest,
  effectiveNotifySettings,
  providerLabel,
  redactNotifyChannel,
  shouldNotify,
  validNotifyChannel,
  webhookUrlProblem,
} from '../shared/notify.mjs';
import { APP_SETTINGS_PATH, effectiveAppSettings, validAppSettings } from '../shared/app-settings.mjs';
import { statePaths } from '../paths.mjs';
import { CoreError } from './errors.mjs';
import { ensureDirectory, listFiles, readJson, removeFile, withFileLock, writeJsonAtomic } from './fs.mjs';
import { redactSensitiveText } from './privacy.mjs';

const TURN_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SEND_TIMEOUT_MS = 4_000;
const MAX_FIELD_LENGTH = 300;

function settingsFile(env) {
  return path.join(statePaths(env).home, APP_SETTINGS_PATH);
}

export async function getNotifySettings({ env = process.env } = {}) {
  const stored = await readJson(settingsFile(env), { optional: true, validate: validAppSettings });
  return effectiveNotifySettings(stored?.notify);
}

async function mutateNotifySettings(env, mutate) {
  const paths = statePaths(env);
  await ensureDirectory(paths.home);
  await ensureDirectory(paths.locks, undefined, { trustedRoot: paths.home });
  return withFileLock(path.join(paths.locks, 'app-settings.lock'), async () => {
    const file = settingsFile(env);
    const current = await readJson(file, { optional: true, validate: validAppSettings });
    if (current === null && await readJson(file, { optional: true }) !== null) {
      throw new CoreError('INVALID_APP_SETTINGS', 'Existing app settings could not be read; nothing was overwritten.');
    }
    const channels = effectiveNotifySettings(current?.notify).channels;
    const next = mutate(channels);
    // Only the notify key is rewritten. Every other preference — including keys
    // a newer client may have added — is carried through untouched.
    const merged = { ...(current ?? {}), notify: { channels: next }, schemaVersion: 1 };
    if (!validAppSettings(merged)) {
      throw new CoreError('INVALID_NOTIFY_SETTINGS', 'The resulting notification settings are not valid.');
    }
    await writeJsonAtomic(file, merged);
    return effectiveAppSettings(merged).notify;
  });
}

function assertProvider(provider) {
  if (!NOTIFY_PROVIDERS.includes(provider)) {
    throw new CoreError('INVALID_NOTIFY_PROVIDER', `Provider must be one of: ${NOTIFY_PROVIDERS.join(', ')}.`);
  }
}

function assertWebhook(provider, webhookUrl) {
  const problem = webhookUrlProblem(provider, webhookUrl);
  if (!problem) return webhookUrl.trim();
  const reason = problem === 'wrong_host' || problem === 'wrong_path'
    ? `This does not look like a ${providerLabel(provider)} webhook URL.`
    : problem === 'not_https' ? 'A webhook URL must use https.'
      : problem === 'missing' ? 'A webhook URL is required.'
        : 'The webhook URL could not be parsed.';
  throw new CoreError('INVALID_WEBHOOK_URL', reason);
}

function assertTrigger(trigger) {
  if (!NOTIFY_TRIGGERS.includes(trigger)) {
    throw new CoreError('INVALID_NOTIFY_TRIGGER', `Trigger must be one of: ${NOTIFY_TRIGGERS.join(', ')}.`);
  }
}

function assertThreshold(seconds) {
  if (!Number.isSafeInteger(seconds)) {
    throw new CoreError('INVALID_NOTIFY_THRESHOLD', 'The threshold must be a whole number of seconds.');
  }
}

export async function addNotifyChannel({
  env = process.env,
  provider,
  webhookUrl,
  label,
  trigger = NOTIFY_DEFAULT_TRIGGER,
  thresholdSeconds = NOTIFY_DEFAULT_THRESHOLD_SECONDS,
  enabled = true,
} = {}) {
  assertProvider(provider);
  assertTrigger(trigger);
  assertThreshold(thresholdSeconds);
  const url = assertWebhook(provider, webhookUrl);
  const channel = {
    id: randomUUID().slice(0, 8),
    provider,
    label: String(label ?? '').trim().slice(0, NOTIFY_MAX_LABEL_LENGTH) || providerLabel(provider),
    webhookUrl: url,
    enabled: enabled !== false,
    trigger,
    thresholdSeconds,
  };
  if (!validNotifyChannel(channel)) {
    throw new CoreError('INVALID_NOTIFY_CHANNEL', 'The notification channel values are not valid.');
  }
  const settings = await mutateNotifySettings(env, (channels) => {
    if (channels.length >= NOTIFY_MAX_CHANNELS) {
      throw new CoreError('TOO_MANY_NOTIFY_CHANNELS', `At most ${NOTIFY_MAX_CHANNELS} notification channels are supported.`);
    }
    if (channels.some((existing) => existing.webhookUrl === channel.webhookUrl)) {
      throw new CoreError('DUPLICATE_NOTIFY_CHANNEL', 'That webhook URL is already registered.');
    }
    return [...channels, channel];
  });
  return { channel: redactNotifyChannel(channel), settings };
}

export async function updateNotifyChannel({ env = process.env, id, ...patch } = {}) {
  if (typeof id !== 'string' || !id) throw new CoreError('MISSING_NOTIFY_CHANNEL', 'A channel id is required.');
  const fields = ['label', 'webhookUrl', 'enabled', 'trigger', 'thresholdSeconds'];
  const values = Object.fromEntries(Object.entries(patch).filter(([key, value]) => fields.includes(key) && value !== undefined));
  if (!Object.keys(values).length) throw new CoreError('EMPTY_NOTIFY_UPDATE', 'Provide at least one value to change.');
  if (values.trigger !== undefined) assertTrigger(values.trigger);
  if (values.thresholdSeconds !== undefined) assertThreshold(values.thresholdSeconds);
  let updated = null;
  const settings = await mutateNotifySettings(env, (channels) => {
    const index = channels.findIndex((channel) => channel.id === id);
    if (index === -1) throw new CoreError('UNKNOWN_NOTIFY_CHANNEL', `No notification channel with id ${id}.`);
    const merged = { ...channels[index], ...values };
    if (values.label !== undefined) merged.label = String(values.label).trim().slice(0, NOTIFY_MAX_LABEL_LENGTH);
    if (values.webhookUrl !== undefined) merged.webhookUrl = assertWebhook(merged.provider, values.webhookUrl);
    if (!validNotifyChannel(merged)) {
      throw new CoreError('INVALID_NOTIFY_CHANNEL', 'The notification channel values are not valid.');
    }
    updated = merged;
    return channels.map((channel, position) => (position === index ? merged : channel));
  });
  return { channel: redactNotifyChannel(updated), settings };
}

export async function removeNotifyChannel({ env = process.env, id } = {}) {
  if (typeof id !== 'string' || !id) throw new CoreError('MISSING_NOTIFY_CHANNEL', 'A channel id is required.');
  const settings = await mutateNotifySettings(env, (channels) => {
    if (!channels.some((channel) => channel.id === id)) {
      throw new CoreError('UNKNOWN_NOTIFY_CHANNEL', `No notification channel with id ${id}.`);
    }
    return channels.filter((channel) => channel.id !== id);
  });
  return { removed: id, settings };
}

export async function findNotifyChannel({ env = process.env, id } = {}) {
  const { channels } = await getNotifySettings({ env });
  if (id === undefined) return channels;
  const channel = channels.find((candidate) => candidate.id === id);
  if (!channel) throw new CoreError('UNKNOWN_NOTIFY_CHANNEL', `No notification channel with id ${id}.`);
  return [channel];
}

/**
 * Posts one webhook. Delivery is best-effort by design: the caller is a hook
 * that must not fail a turn because Slack was slow.
 */
export async function sendNotification({
  channel,
  event = {},
  language = 'en',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_SEND_TIMEOUT_MS,
} = {}) {
  if (!validNotifyChannel(channel)) {
    throw new CoreError('INVALID_NOTIFY_CHANNEL', 'The notification channel values are not valid.');
  }
  if (typeof fetchImpl !== 'function') {
    return { id: channel.id, delivered: false, reason: 'fetch_unavailable' };
  }
  const request = buildNotifyRequest(channel, event, { language });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      return { id: channel.id, delivered: false, reason: `http_${response.status}` };
    }
    return { id: channel.id, delivered: true, reason: null };
  } catch (error) {
    return { id: channel.id, delivered: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

function turnKey(agent, sessionKey) {
  return createHash('sha256').update(`${agent} ${sessionKey ?? ''}`).digest('hex').slice(0, 32);
}

function turnDirectory(env) {
  return path.join(statePaths(env).runtime, 'turns');
}

async function pruneTurnMarkers(directory, clock) {
  const now = clock.now();
  for (const file of await listFiles(directory, { suffix: '.json' }).catch(() => [])) {
    const marker = await readJson(file, { optional: true });
    const startedAt = Date.parse(marker?.startedAt ?? '');
    if (!Number.isFinite(startedAt) || now - startedAt > TURN_RETENTION_MS) {
      await removeFile(file).catch(() => {});
    }
  }
}

/**
 * Records when a turn began so the stop hook can tell a two-second answer from
 * a twenty-minute refactor. Failures are swallowed: without a marker the
 * long-turn trigger falls back to notifying.
 *
 * This runs inside UserPromptSubmit, whose vendor timeout is two seconds — the
 * tightest budget of any hook phase. It therefore does exactly one directory
 * check and one write, and never scans the directory; expiry is swept in
 * consumeTurnStart, which runs under the five-second stop budget instead.
 */
export async function markTurnStart({ env = process.env, agent, sessionKey, clock = Date } = {}) {
  try {
    const directory = turnDirectory(env);
    await ensureDirectory(directory, undefined, { trustedRoot: statePaths(env).home });
    await writeJsonAtomic(path.join(directory, `${turnKey(agent, sessionKey)}.json`), {
      startedAt: new Date(clock.now()).toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

export async function consumeTurnStart({ env = process.env, agent, sessionKey, clock = Date } = {}) {
  try {
    const directory = turnDirectory(env);
    const file = path.join(directory, `${turnKey(agent, sessionKey)}.json`);
    const marker = await readJson(file, { optional: true });
    await removeFile(file).catch(() => {});
    // Sweep abandoned markers here rather than on the prompt path: a session
    // that ends without a stop hook would otherwise leave a file behind.
    await pruneTurnMarkers(directory, clock);
    const startedAt = Date.parse(marker?.startedAt ?? '');
    if (!Number.isFinite(startedAt)) return null;
    return Math.max(0, (clock.now() - startedAt) / 1000);
  } catch {
    return null;
  }
}

function trimField(value) {
  if (typeof value !== 'string') return '';
  const redacted = redactSensitiveText(value).text.replaceAll(/\s+/gu, ' ').trim();
  return redacted.length > MAX_FIELD_LENGTH ? `${redacted.slice(0, MAX_FIELD_LENGTH - 1)}…` : redacted;
}

/** Everything the message can contain is passed through the secret redactor. */
export function buildNotifyEvent({
  phase,
  agentLabel,
  repository,
  branch,
  changed,
  changedCount,
  elapsedSeconds,
  work,
} = {}) {
  return {
    phase,
    agentLabel,
    repository: trimField(repository),
    branch: trimField(branch),
    changed: changed === true,
    changedCount: Number.isSafeInteger(changedCount) ? changedCount : null,
    elapsedSeconds: typeof elapsedSeconds === 'number' ? elapsedSeconds : null,
    title: trimField(work?.task ?? work?.title),
    currentState: trimField(work?.currentState),
    nextStep: trimField(Array.isArray(work?.nextSteps) ? work.nextSteps[0] : work?.nextSteps),
  };
}

export async function notifyForEvent({
  env = process.env,
  event,
  language = 'en',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_SEND_TIMEOUT_MS,
  channels,
} = {}) {
  const available = channels ?? (await getNotifySettings({ env })).channels;
  const selected = available.filter((channel) => shouldNotify(channel, event));
  if (!selected.length) return { sent: 0, results: [] };
  const results = await Promise.all(selected.map(
    (channel) => sendNotification({ channel, event, language, fetchImpl, timeoutMs }),
  ));
  return { sent: results.filter((result) => result.delivered).length, results };
}
