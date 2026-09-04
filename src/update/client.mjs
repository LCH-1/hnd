import fs from 'node:fs/promises';
import path from 'node:path';

import { readJson, withFileLock } from '../core/fs.mjs';
import { statePaths } from '../paths.mjs';
import { installConnectorBundle } from './install.mjs';
import {
  CONNECTOR_RELEASE_KEY_ID,
  MAX_CONNECTOR_BUNDLE_BYTES,
  validateConnectorManifest,
} from './manifest.mjs';
import {
  originUpdateState,
  readRuntimePointer,
  readUpdateState,
  rollbackRuntime,
  runtimeReady,
  runtimePaths,
  writeUpdateState,
} from './state.mjs';

export const DEFAULT_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_DEVICE_TOKEN_BYTES = 512;

function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('The HND account server URL is invalid');
  }
  if (!['https:', 'http:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname))) {
    throw new Error('The HND account server URL is not a trusted HTTP endpoint');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  return parsed.origin + parsed.pathname;
}

async function readEnrolledRemote(env) {
  const paths = statePaths(env);
  const config = await readJson(paths.remotes, { optional: true });
  if (!config) return null;
  if (config.schemaVersion !== 1 || typeof config.baseUrl !== 'string') {
    throw new Error('Remote configuration is invalid');
  }
  const tokenPath = path.join(paths.secrets, 'device.token');
  const metadata = await fs.lstat(tokenPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DEVICE_TOKEN_BYTES) {
    throw new Error('Device credential is invalid');
  }
  const deviceToken = (await fs.readFile(tokenPath, 'utf8')).trim();
  if (!/^hndd_[A-Za-z0-9_-]{40,128}$/.test(deviceToken)) {
    throw new Error('Device credential is invalid');
  }
  return { baseUrl: normalizeBaseUrl(config.baseUrl), deviceToken };
}

async function responseBytes(response, maximum, expectedLength) {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new Error('Update response has an invalid Content-Length');
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size > maximum || (expectedLength !== undefined && size !== expectedLength)) {
      throw new Error('Update response size is invalid');
    }
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('Update response has no readable body');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximum) {
        await reader.cancel().catch(() => {});
        throw new Error('Update response size is invalid');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const value = Buffer.concat(chunks, received);
  if (expectedLength !== undefined && value.byteLength !== expectedLength) {
    throw new Error('Update response size is invalid');
  }
  return value;
}

async function authenticatedFetch(remote, pathname, {
  fetchImpl = fetch,
  timeoutMs = 10_000,
  method = 'GET',
} = {}) {
  const target = new URL(pathname, `${remote.baseUrl}/`);
  if (target.origin !== new URL(remote.baseUrl).origin
    || !target.pathname.startsWith('/v1/connector/')) {
    throw new Error('Update endpoint escaped the HND account server origin');
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(target, {
    method,
    headers: { Authorization: `Bearer ${remote.deviceToken}` },
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new Error(`Connector update server returned HTTP ${response.status}`);
  return response;
}

async function readPublicKey(publicKeyPath) {
  const metadata = await fs.lstat(publicKeyPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024) {
    throw new Error('Connector release public key is invalid');
  }
  return fs.readFile(publicKeyPath, 'utf8');
}

function recordForOrigin(state, origin, values) {
  return {
    ...state,
    origins: {
      ...state.origins,
      [origin]: {
        ...originUpdateState(state, origin),
        ...values,
      },
    },
  };
}

function sameRuntimePointer(left, right) {
  return Boolean(
    left
    && right
    && left.schemaVersion === right.schemaVersion
    && left.sequence === right.sequence
    && left.version === right.version
    && left.sha256 === right.sha256
  );
}

export async function checkConnectorUpdate({
  env = process.env,
  launcherVersion,
  publicKeyPath,
  fetchImpl = fetch,
  timeoutMs = 10_000,
} = {}) {
  const remote = await readEnrolledRemote(env);
  if (!remote) return { configured: false, available: false };
  const state = await readUpdateState(env);
  const originState = originUpdateState(state, remote.baseUrl);
  const response = await authenticatedFetch(remote, '/v1/connector/manifest', {
    fetchImpl,
    timeoutMs,
  });
  const bytes = await responseBytes(response, MAX_MANIFEST_BYTES);
  let source;
  try {
    source = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Connector manifest is not valid JSON');
  }
  const manifest = validateConnectorManifest(source, {
    launcherVersion,
    publicKey: await readPublicKey(publicKeyPath),
    keyId: CONNECTOR_RELEASE_KEY_ID,
    highestSequence: originState.highestSequence,
  });
  if (
    manifest.sequence === originState.highestSequence
    && originState.installed
    && originState.installed.sequence === manifest.sequence
    && originState.installed.sha256 !== manifest.bundle.sha256
  ) {
    throw new Error('Connector server reused a trusted release sequence with different bytes');
  }
  const current = await readRuntimePointer('current', env);
  const currentReady = current ? runtimeReady(current, env) : Promise.resolve(false);
  const quarantined = originState.quarantine.includes(manifest.sequence);
  return {
    configured: true,
    available: !quarantined && (
      current?.sha256 !== manifest.bundle.sha256
      || !await currentReady
    ),
    quarantined,
    remote,
    manifest,
    current,
  };
}

export async function applyConnectorUpdate(options = {}) {
  const env = options.env ?? process.env;
  return withFileLock(runtimePaths(env).lock, async () => {
    const checked = await checkConnectorUpdate({ ...options, env });
    const now = new Date().toISOString();
    if (!checked.configured) return checked;
    let state = await readUpdateState(env);
    if (!checked.available) {
      state = recordForOrigin(state, checked.remote.baseUrl, {
        lastCheckedAt: now,
        highestSequence: Math.max(
          originUpdateState(state, checked.remote.baseUrl).highestSequence,
          checked.manifest.sequence,
        ),
        installed: checked.current ?? originUpdateState(state, checked.remote.baseUrl).installed,
      });
      await writeUpdateState({ ...state, lastAttemptAt: now, lastError: null }, env);
      return { ...checked, installed: false };
    }
    const response = await authenticatedFetch(checked.remote, checked.manifest.bundle.path, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs ?? 30_000,
    });
    const bundle = await responseBytes(
      response,
      MAX_CONNECTOR_BUNDLE_BYTES,
      checked.manifest.bundle.bytes,
    );
    const installed = await installConnectorBundle(checked.manifest, bundle, {
      env,
      smoke: options.smoke,
    });
    state = recordForOrigin(state, checked.remote.baseUrl, {
      lastCheckedAt: now,
      highestSequence: Math.max(
        originUpdateState(state, checked.remote.baseUrl).highestSequence,
        checked.manifest.sequence,
      ),
      installed: installed.pointer,
    });
    await writeUpdateState({ ...state, lastAttemptAt: now, lastError: null }, env);
    return { ...checked, ...installed };
  }, { timeoutMs: options.lockTimeoutMs ?? 5_000, staleMs: 10 * 60_000 });
}

export async function updateDue({
  env = process.env,
  now = Date.now(),
  intervalMs = DEFAULT_UPDATE_INTERVAL_MS,
} = {}) {
  const remote = await readEnrolledRemote(env);
  if (!remote) return false;
  const state = await readUpdateState(env);
  const lastAttempt = Date.parse(state.lastAttemptAt || '');
  if (Number.isFinite(lastAttempt) && now - lastAttempt < intervalMs) return false;
  const last = Date.parse(originUpdateState(state, remote.baseUrl).lastCheckedAt || '');
  return !Number.isFinite(last) || now - last >= intervalMs;
}

export async function recordUpdateError(error, env = process.env) {
  const state = await readUpdateState(env).catch(() => ({
    schemaVersion: 1,
    origins: {},
    lastError: null,
  }));
  await writeUpdateState({
    ...state,
    lastAttemptAt: new Date().toISOString(),
    lastError: {
      at: new Date().toISOString(),
      message: error?.message || String(error),
    },
  }, env);
}

export async function connectorUpdateStatus(env = process.env) {
  const [current, previous, state, remote] = await Promise.all([
    readRuntimePointer('current', env),
    readRuntimePointer('previous', env),
    readUpdateState(env),
    readEnrolledRemote(env).catch(() => null),
  ]);
  return {
    configured: Boolean(remote),
    server: remote?.baseUrl ?? null,
    current,
    previous,
    update: remote ? originUpdateState(state, remote.baseUrl) : null,
    lastError: state.lastError ?? null,
  };
}

export async function rollbackConnectorUpdate(env = process.env, { expectedCurrent } = {}) {
  return withFileLock(runtimePaths(env).lock, async () => {
    if (expectedCurrent !== undefined) {
      const active = await readRuntimePointer('current', env);
      if (!sameRuntimePointer(active, expectedCurrent)) {
        return { current: active, rolledBack: null, skipped: 'current_changed' };
      }
    }
    const rolled = await rollbackRuntime(env);
    const remote = await readEnrolledRemote(env);
    if (remote && rolled.rolledBack) {
      let state = await readUpdateState(env);
      const current = originUpdateState(state, remote.baseUrl);
      state = recordForOrigin(state, remote.baseUrl, {
        quarantine: [...new Set([...current.quarantine, rolled.rolledBack.sequence])],
        installed: rolled.current,
      });
      await writeUpdateState(state, env);
    }
    return rolled;
  });
}
