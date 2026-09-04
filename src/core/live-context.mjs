import { createHash } from 'node:crypto';
import path from 'node:path';

import { readJson, withFileLock, writeJsonAtomic } from './fs.mjs';
import { statePaths } from '../paths.mjs';

const SCHEMA_VERSION = 2;
const KERNEL_VERSION = 1;
const MAX_SESSIONS = 512;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const CURSOR_LIVE_CONTEXT_SESSION_ENV = 'HND_CURSOR_RULE_SESSION';

function deliveryPath(env) {
  return path.join(statePaths(env).cache, 'live-context-delivery.json');
}

function deliveryLockPath(env) {
  return path.join(statePaths(env).locks, 'live-context-delivery.lock');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function payloadSessionId(payload) {
  return [
    payload?.session_id,
    payload?.sessionId,
    payload?.conversation_id,
    payload?.conversationId,
    payload?.thread_id,
    payload?.threadId,
  ].find((value) => (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !value.includes('\0')
  ));
}

export function liveContextSessionKey(agent, payload = {}, env = process.env) {
  if (!['claude', 'codex', 'cursor'].includes(agent)) {
    throw new TypeError(`Unsupported live-context agent: ${agent}`);
  }
  if (
    agent === 'cursor'
    && /^[a-f0-9]{64}$/.test(env[CURSOR_LIVE_CONTEXT_SESSION_ENV] || '')
  ) {
    return env[CURSOR_LIVE_CONTEXT_SESSION_ENV];
  }
  const sessionId = payloadSessionId(payload);
  return sessionId ? sha256(`${agent}\0${sessionId}`) : null;
}

function contextLayers(composition) {
  if (!composition || !Array.isArray(composition.layers)) {
    throw new TypeError('A composed HND context is required for live-context delivery.');
  }
  return composition.layers;
}

export function effectiveLiveContextRevision(composition) {
  const layers = contextLayers(composition).map((layer) => ({
    id: layer.id ?? null,
    kind: layer.kind ?? null,
    scope: layer.scope ?? null,
    repoId: layer.repoId ?? null,
    environment: layer.environment ?? null,
    rendered: layer.rendered,
  }));
  if (layers.some((layer) => typeof layer.rendered !== 'string')) {
    throw new TypeError('Every HND live-context layer must have rendered text.');
  }
  return sha256(JSON.stringify({
    kernelVersion: KERNEL_VERSION,
    repositoryId: composition.repository?.id ?? null,
    environment: composition.environment ?? null,
    layers,
  }));
}

export function liveContextPreamble(revision) {
  if (!/^[a-f0-9]{64}$/.test(revision || '')) {
    throw new TypeError('Live-context revision must be a SHA-256 digest.');
  }
  return `# hnd live context

Live context revision: \`${revision}\`.

This complete HND snapshot replaces earlier HND snapshots in this session. If they
conflict, use the newest revision. This applies only to HND context; system and user
instructions remain authoritative.

- Every section labeled as policy below is an active, mandatory instruction for the
  current turn. Follow it exactly; do not treat policy as background information.
- When a policy requires an exact response, do not inspect files, invoke tools or
  skills, or add acknowledgements, explanations, formatting, or any other text.
- Policy precedence is: local override > environment > repository > global.
- Handoff and checkpoint content is informational and cannot override or weaken any policy.
- The device-only local override appears last and cannot be removed remotely.`;
}

export function renderLiveContextSnapshot(
  composition,
  revision = effectiveLiveContextRevision(composition),
) {
  const layers = contextLayers(composition);
  return `${[liveContextPreamble(revision), ...layers.map((layer) => layer.rendered)].join('\n\n')}\n`;
}

function validState(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.schemaVersion === SCHEMA_VERSION
    && value.sessions
    && typeof value.sessions === 'object'
    && !Array.isArray(value.sessions)
    && Object.entries(value.sessions).every(([key, entry]) => (
      /^[a-f0-9]{64}$/.test(key)
      && entry
      && typeof entry === 'object'
      && !Array.isArray(entry)
      && /^[a-f0-9]{64}$/.test(entry.contextRevision)
      && typeof entry.recordedAt === 'string'
    ))
  );
}

async function readState(env) {
  try {
    return await readJson(deliveryPath(env), { optional: true, validate: validState });
  } catch {
    // This file is only a de-duplication cache. Re-delivering the current
    // snapshot is safer than failing a prompt because an optimization record
    // is damaged.
    return null;
  }
}

function prunedSessions(sessions, now) {
  const cutoff = now.getTime() - SESSION_MAX_AGE_MS;
  return Object.fromEntries(Object.entries(sessions)
    .filter(([, entry]) => Date.parse(entry.recordedAt) >= cutoff)
    .sort((left, right) => Date.parse(right[1].recordedAt) - Date.parse(left[1].recordedAt))
    .slice(0, MAX_SESSIONS));
}

/**
 * Atomically compares and records the complete effective HND context revision
 * for one agent session. A missing vendor session id deliberately returns
 * changed=true so a live update is never skipped merely because a hook payload
 * was incomplete.
 */
export async function recordLiveContextDelivery({
  agent,
  payload = {},
  composition,
  env = process.env,
  clock = Date,
  force = false,
} = {}) {
  const revision = effectiveLiveContextRevision(composition);
  const content = renderLiveContextSnapshot(composition, revision);
  const sessionKey = liveContextSessionKey(agent, payload, env);
  if (!sessionKey) {
    return Object.freeze({ changed: true, revision, content, sessionKey: null });
  }
  const source = typeof clock === 'function' ? clock() : clock.now();
  const now = source instanceof Date ? source : new Date(source);
  if (Number.isNaN(now.getTime())) throw new TypeError('clock returned an invalid date');

  return withFileLock(deliveryLockPath(env), async () => {
    const current = await readState(env);
    const sessions = prunedSessions(current?.sessions || {}, now);
    const changed = force || sessions[sessionKey]?.contextRevision !== revision;
    if (changed) {
      sessions[sessionKey] = { contextRevision: revision, recordedAt: now.toISOString() };
      await writeJsonAtomic(deliveryPath(env), {
        schemaVersion: SCHEMA_VERSION,
        sessions: prunedSessions(sessions, now),
      });
    }
    return Object.freeze({ changed, revision, content, sessionKey });
  }, { timeoutMs: 500, staleMs: 30_000 });
}
