import {
  decryptSnapshot,
  encryptSnapshot,
} from './crypto.mjs';
import { createStrongEtag } from './etag.mjs';
import { DEFAULT_MAX_BLOB_BYTES } from './constants.mjs';

const MAX_ERROR_BODY_BYTES = 64 * 1024;

export class SyncHttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = 'SyncHttpError';
    this.status = status;
    this.etag = options.etag ?? null;
    this.code = options.code ?? null;
  }
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid sync server URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Sync server URL must be an HTTP(S) origin without credentials');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('Sync server URL must not contain a path');
  }
  return url.origin;
}

async function readResponseBuffer(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Sync response has an invalid Content-Length');
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Sync response exceeds ${maxBytes} byte limit`);
    }
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Sync response exceeds ${maxBytes} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received);
}

function verifiedBlobEtag(response, blob, expectedEtag) {
  const received = response.headers.get('etag');
  const computed = createStrongEtag(blob);
  if (received !== computed || (expectedEtag !== undefined && computed !== expectedEtag)) {
    throw new Error('Sync response ETag does not match its encrypted payload');
  }
  return received;
}

async function errorFromResponse(response) {
  let details = {};
  try {
    const body = await readResponseBuffer(response, MAX_ERROR_BODY_BYTES);
    details = JSON.parse(body.toString('utf8'));
  } catch {
    // A malformed error body must not hide the HTTP status.
  }
  return new SyncHttpError(
    response.status,
    details.message || details.error || `Sync request failed with HTTP ${response.status}`,
    { etag: response.headers.get('etag'), code: details.error },
  );
}

export async function enrollDevice(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(`${baseUrl}/v1/enroll`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${options.enrollmentKey}`,
      'X-Hnd-Device-Name': options.deviceName || 'unnamed-device',
    },
    signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
  });
  if (!response.ok) throw await errorFromResponse(response);
  const body = await readResponseBuffer(response, MAX_ERROR_BODY_BYTES);
  const parsed = JSON.parse(body.toString('utf8'));
  if (typeof parsed.deviceToken !== 'string' || !parsed.device?.id) {
    throw new Error('Malformed enrollment response');
  }
  return Object.freeze({
    deviceToken: parsed.deviceToken,
    device: Object.freeze(parsed.device),
  });
}

export async function joinDevice(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(`${baseUrl}/v1/join`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${options.invitationToken}`,
      'X-Hnd-Device-Name': options.deviceName || 'unnamed-device',
    },
    signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
  });
  if (!response.ok) throw await errorFromResponse(response);
  const body = await readResponseBuffer(response, MAX_ERROR_BODY_BYTES);
  const parsed = JSON.parse(body.toString('utf8'));
  if (
    typeof parsed.deviceToken !== 'string'
    || !parsed.device?.id
    || typeof parsed.wrappedVaultKey !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed.wrappedVaultKey)
  ) {
    throw new Error('Malformed device invitation response');
  }
  const wrappedVaultKey = Buffer.from(parsed.wrappedVaultKey, 'base64');
  if (wrappedVaultKey.byteLength === 0 || wrappedVaultKey.byteLength > 512) {
    throw new Error('Malformed wrapped vault key');
  }
  return Object.freeze({
    deviceToken: parsed.deviceToken,
    device: Object.freeze(parsed.device),
    wrappedVaultKey,
  });
}

export class SyncClient {
  constructor(options) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (typeof options.deviceToken !== 'string' || !options.deviceToken) {
      throw new Error('deviceToken is required');
    }
    this.deviceToken = options.deviceToken;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    if (!Number.isSafeInteger(this.maxBlobBytes) || this.maxBlobBytes < 1) {
      throw new Error('maxBlobBytes must be a positive safe integer');
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  #headers(extra = {}) {
    return { Authorization: `Bearer ${this.deviceToken}`, ...extra };
  }

  async #fetch(pathname, options = {}) {
    return this.fetchImpl(`${this.baseUrl}${pathname}`, {
      ...options,
      headers: this.#headers(options.headers),
      redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
  }

  async getEncryptedSnapshot(options = {}) {
    const headers = {};
    if (options.etag) headers['If-None-Match'] = options.etag;
    const response = await this.#fetch('/v1/snapshot', { headers });
    if (response.status === 304) {
      return Object.freeze({ notModified: true, missing: false, etag: response.headers.get('etag') });
    }
    if (response.status === 404) {
      return Object.freeze({ notModified: false, missing: true, etag: null });
    }
    if (!response.ok) throw await errorFromResponse(response);
    const blob = await readResponseBuffer(response, this.maxBlobBytes);
    const etag = verifiedBlobEtag(response, blob);
    return Object.freeze({
      notModified: false,
      missing: false,
      etag,
      blob,
    });
  }

  async putEncryptedSnapshot(blob, options = {}) {
    const contents = Buffer.isBuffer(blob) ? blob : Buffer.from(blob ?? []);
    if (!contents.byteLength || contents.byteLength > this.maxBlobBytes) {
      throw new Error(`Encrypted snapshot must contain 1-${this.maxBlobBytes} bytes`);
    }
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (options.etag) headers['If-Match'] = options.etag;
    else headers['If-None-Match'] = '*';
    const response = await this.#fetch('/v1/snapshot', {
      method: 'PUT',
      headers,
      body: contents,
    });
    if (!response.ok) throw await errorFromResponse(response);
    const etag = verifiedBlobEtag(response, contents);
    return Object.freeze({
      created: response.status === 201,
      etag,
      location: response.headers.get('location'),
    });
  }

  async pullSnapshot(vaultKey, options = {}) {
    const result = await this.getEncryptedSnapshot(options);
    if (result.missing || result.notModified) return result;
    return Object.freeze({
      ...result,
      snapshot: decryptSnapshot(result.blob, vaultKey, options.crypto),
    });
  }

  async pushSnapshot(snapshot, vaultKey, options = {}) {
    const blob = encryptSnapshot(snapshot, vaultKey, options.crypto);
    return this.putEncryptedSnapshot(blob, { etag: options.etag });
  }

  async listRevisions() {
    const response = await this.#fetch('/v1/revisions');
    if (!response.ok) throw await errorFromResponse(response);
    const body = await readResponseBuffer(response, MAX_ERROR_BODY_BYTES);
    const parsed = JSON.parse(body.toString('utf8'));
    if (!Array.isArray(parsed.revisions)) throw new Error('Malformed revision list');
    return parsed.revisions;
  }

  async getRevision(revisionId, options = {}) {
    if (!/^[a-f0-9]{64}$/.test(revisionId)) throw new Error('Invalid revision id');
    const headers = options.etag ? { 'If-None-Match': options.etag } : {};
    const response = await this.#fetch(`/v1/revisions/${revisionId}`, { headers });
    if (response.status === 304) {
      return Object.freeze({ notModified: true, etag: response.headers.get('etag') });
    }
    if (response.status === 404) return null;
    if (!response.ok) throw await errorFromResponse(response);
    const blob = await readResponseBuffer(response, this.maxBlobBytes);
    return Object.freeze({
      notModified: false,
      etag: verifiedBlobEtag(response, blob, `"${revisionId}"`),
      blob,
    });
  }

  async listDevices() {
    const response = await this.#fetch('/v1/devices');
    if (!response.ok) throw await errorFromResponse(response);
    const body = await readResponseBuffer(response, MAX_ERROR_BODY_BYTES);
    const parsed = JSON.parse(body.toString('utf8'));
    if (!Array.isArray(parsed.devices)) throw new Error('Malformed device list');
    return parsed.devices;
  }

  async createDeviceInvitation(wrappedVaultKey, options = {}) {
    const wrapped = Buffer.isBuffer(wrappedVaultKey)
      ? wrappedVaultKey
      : Buffer.from(wrappedVaultKey ?? []);
    if (wrapped.byteLength === 0 || wrapped.byteLength > 512) {
      throw new Error('Wrapped vault key must contain 1-512 bytes');
    }
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (options.ttlSeconds !== undefined) {
      if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1) {
        throw new Error('Invitation TTL must be a positive integer');
      }
      headers['X-Hnd-Invitation-Ttl-Seconds'] = String(options.ttlSeconds);
    }
    const response = await this.#fetch('/v1/invitations', {
      method: 'POST',
      headers,
      body: wrapped,
    });
    if (!response.ok) throw await errorFromResponse(response);
    const body = await readResponseBuffer(response, MAX_ERROR_BODY_BYTES);
    const parsed = JSON.parse(body.toString('utf8'));
    if (
      typeof parsed.invitationToken !== 'string'
      || !/^hndi_[A-Za-z0-9_-]{40,64}$/.test(parsed.invitationToken)
      || typeof parsed.expiresAt !== 'string'
    ) {
      throw new Error('Malformed device invitation response');
    }
    return Object.freeze(parsed);
  }

  async revokeDevice(deviceId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(deviceId)) throw new Error('Invalid device id');
    const response = await this.#fetch(`/v1/devices/${deviceId}/revoke`, { method: 'POST' });
    if (!response.ok) throw await errorFromResponse(response);
  }

  getSnapshot(options = {}) {
    return this.getEncryptedSnapshot(options);
  }

  putSnapshot(blob, options = {}) {
    return this.putEncryptedSnapshot(blob, options);
  }
}
