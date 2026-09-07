import { createHash } from 'node:crypto';

import { CoreError } from './errors.mjs';

export const WORK_SESSION_ENV = 'HND_WORK_SESSION';

// Native IDs are supplied to each agent's shell tool, not guessed from cwd,
// the newest transcript, a parent PID, or another session's selected task.
export function nativeWorkSession(env = process.env, agent) {
  const candidates = [];
  if ((!agent || agent === 'codex') && (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID)) {
    candidates.push({ agent: 'codex', sessionId: env.CODEX_THREAD_ID || env.CODEX_SESSION_ID,
      source: env.CODEX_THREAD_ID ? 'CODEX_THREAD_ID' : 'CODEX_SESSION_ID' });
  }
  if ((!agent || agent === 'cursor') && env.CURSOR_CONVERSATION_ID) {
    // Cursor encodes punctuation and truncates this shell variable to 200
    // characters. Only unchanged IDs (including its normal UUIDs) can be
    // hashed directly without accidentally merging or splitting sessions.
    if (!/^[a-zA-Z0-9-]{1,199}$/.test(env.CURSOR_CONVERSATION_ID)) {
      throw new CoreError('WORK_SESSION_UNAVAILABLE', 'Cursor supplied an encoded or truncated conversation ID; automatic work-session routing is unavailable.');
    }
    candidates.push({ agent: 'cursor', sessionId: env.CURSOR_CONVERSATION_ID, source: 'CURSOR_CONVERSATION_ID' });
  }
  if (candidates.length > 1) {
    throw new CoreError('WORK_SESSION_AMBIGUOUS', 'Multiple native agent identities are present; refusing to guess the current work session.');
  }
  return candidates[0] ?? null;
}

export function resolveWorkSession(options = {}) {
  const env = options.env ?? process.env;
  const explicit = options.sessionKey !== undefined || options.sessionId !== undefined;
  const configured = env[WORK_SESSION_ENV] || env.HND_SESSION_ID;
  if (explicit || configured) {
    return { sessionKey: workSessionKey(options), source: explicit ? 'explicit' : 'hnd-environment' };
  }
  const native = nativeWorkSession(env);
  if (native) return { sessionKey: workSessionKey({ ...native, env: {} }), source: native.source };
  if (env.CURSOR_AGENT === '1' || env.CLAUDECODE === '1' || env.CODEX_CI === '1') {
    throw new CoreError('WORK_SESSION_UNAVAILABLE', 'The agent did not supply a work-session identity. Update HND and the agent, run hnd setup, and start a new session; refusing to use the shared terminal selection.');
  }
  return { sessionKey: null, source: 'legacy-terminal' };
}

export function workSessionKey({ sessionKey, sessionId, agent, env = process.env } = {}) {
  // null explicitly requests a session-neutral view (e.g. a shared Cursor file).
  if (sessionKey === null) return null;
  if (sessionKey === undefined && sessionId === undefined && !env[WORK_SESSION_ENV]) {
    sessionId = env.HND_SESSION_ID;
  }
  agent = agent ?? env.HND_SESSION_AGENT ?? 'manual';
  if (sessionId !== undefined) {
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 512 || /[\0\r\n]/.test(sessionId)) {
      throw new CoreError('INVALID_WORK_SESSION', 'sessionId must be 1-512 characters without control line breaks');
    }
    if (typeof agent !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(agent)) {
      throw new CoreError('INVALID_WORK_SESSION', 'A valid session agent is required');
    }
    return createHash('sha256').update(`${agent}\0${sessionId}`).digest('hex');
  }
  const key = sessionKey ?? env[WORK_SESSION_ENV];
  if (key === undefined || key === '') return null;
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
    throw new CoreError('INVALID_WORK_SESSION', 'sessionKey must be a SHA-256 digest');
  }
  return key;
}
