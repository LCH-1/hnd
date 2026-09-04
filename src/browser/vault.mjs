import { generateVaultKey, VAULT_KEY_BYTES } from './crypto.mjs';

export const BROWSER_VAULT_RECORD_SCHEMA_VERSION = 1;

// This module intentionally has no WebAuthn/passkey input. A passkey may
// authenticate a user to the application, but it is not the account vault key and
// is not used as this device-local wrapping key. Non-extractable limits key
// export; it cannot protect against already-running same-origin script.

const RECORD_KIND = 'hnd-browser-vault';
const RECORD_KEYS = new Set([
  'kind',
  'schemaVersion',
  'vaultId',
  'wrappingKey',
  'wrappedVaultKey',
]);
const WRAP_HEADER = Uint8Array.of(
  0x48, 0x4e, 0x44, 0x4b, // HNDK
  0x01, // local wrapping format version
);
const WRAP_NONCE_BYTES = 12;
const WRAP_TAG_BYTES = 16;
const WRAPPED_VAULT_BYTES = WRAP_HEADER.byteLength
  + WRAP_NONCE_BYTES
  + WRAP_TAG_BYTES
  + VAULT_KEY_BYTES;
const textEncoder = new TextEncoder();

function webCrypto(options = {}) {
  const provider = options.crypto ?? globalThis.crypto;
  if (
    !provider
    || typeof provider.getRandomValues !== 'function'
    || !provider.subtle
    || typeof provider.subtle.generateKey !== 'function'
  ) {
    throw new Error('WebCrypto is not available in this context');
  }
  return provider;
}

function copyBytes(value, label) {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  throw new TypeError(`${label} must be an ArrayBuffer or typed array`);
}

function copiedVaultKey(value) {
  const copy = copyBytes(value, 'Vault key');
  if (copy.byteLength !== VAULT_KEY_BYTES) {
    copy.fill(0);
    throw new Error(`Vault key must be exactly ${VAULT_KEY_BYTES} bytes`);
  }
  return copy;
}

function equalVaultKeys(left, right) {
  // Vault keys have already been length-checked. Do not exit on the first
  // differing byte, so equality does not disclose a useful matching prefix.
  let difference = 0;
  for (let index = 0; index < VAULT_KEY_BYTES; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function normalizedVaultId(value = 'default') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new TypeError('vaultId must contain 1-128 ASCII letters, digits, dots, underscores, or hyphens');
  }
  return value;
}

function storageKey(vaultId) {
  return `hnd:vault:${vaultId}`;
}

function wrappingAad(vaultId) {
  const identifier = textEncoder.encode(vaultId);
  const aad = new Uint8Array(WRAP_HEADER.byteLength + 1 + identifier.byteLength);
  aad.set(WRAP_HEADER, 0);
  aad[WRAP_HEADER.byteLength] = identifier.byteLength;
  aad.set(identifier, WRAP_HEADER.byteLength + 1);
  return aad;
}

function wrappingKeyIsSafe(key) {
  const usages = Array.from(key?.usages ?? []);
  return key?.type === 'secret'
    && key.extractable === false
    && key.algorithm?.name === 'AES-GCM'
    && key.algorithm?.length === 256
    && usages.length === 2
    && usages.includes('encrypt')
    && usages.includes('decrypt');
}

function assertStorage(storage) {
  if (
    !storage
    || typeof storage.get !== 'function'
    || typeof storage.insertIfAbsent !== 'function'
    || typeof storage.delete !== 'function'
  ) {
    throw new TypeError('storage must implement get, insertIfAbsent, and delete');
  }
  return storage;
}

function recordIsWellFormed(record, vaultId) {
  return record !== null
    && typeof record === 'object'
    && !Array.isArray(record)
    && Object.keys(record).length === RECORD_KEYS.size
    && Object.keys(record).every((key) => RECORD_KEYS.has(key))
    && record.kind === RECORD_KIND
    && record.schemaVersion === BROWSER_VAULT_RECORD_SCHEMA_VERSION
    && record.vaultId === vaultId
    && wrappingKeyIsSafe(record.wrappingKey)
    && (record.wrappedVaultKey instanceof ArrayBuffer || ArrayBuffer.isView(record.wrappedVaultKey));
}

function wrapHeaderMatches(envelope) {
  for (let index = 0; index < WRAP_HEADER.byteLength; index += 1) {
    if (envelope[index] !== WRAP_HEADER[index]) return false;
  }
  return true;
}

export async function createWrappingKey(options = {}) {
  const provider = webCrypto(options);
  const key = await provider.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  if (!wrappingKeyIsSafe(key)) {
    throw new Error('WebCrypto did not create a non-extractable AES-GCM wrapping key');
  }
  return key;
}

export async function wrapVaultKey(vaultKey, wrappingKey, options = {}) {
  const provider = webCrypto(options);
  const vaultId = normalizedVaultId(options.vaultId);
  if (!wrappingKeyIsSafe(wrappingKey)) {
    throw new Error('Wrapping key must be a non-extractable 256-bit AES-GCM key');
  }
  const raw = copyBytes(vaultKey, 'Vault key');
  if (raw.byteLength !== VAULT_KEY_BYTES) {
    raw.fill(0);
    throw new Error(`Vault key must be exactly ${VAULT_KEY_BYTES} bytes`);
  }
  const nonce = new Uint8Array(WRAP_NONCE_BYTES);
  provider.getRandomValues(nonce);

  try {
    const sealed = new Uint8Array(await provider.subtle.encrypt({
      name: 'AES-GCM',
      iv: nonce,
      additionalData: wrappingAad(vaultId),
      tagLength: WRAP_TAG_BYTES * 8,
    }, wrappingKey, raw));
    const ciphertextBytes = sealed.byteLength - WRAP_TAG_BYTES;
    if (ciphertextBytes !== VAULT_KEY_BYTES) {
      throw new Error('WebCrypto returned an invalid wrapped vault key');
    }
    const envelope = new Uint8Array(WRAPPED_VAULT_BYTES);
    envelope.set(WRAP_HEADER, 0);
    envelope.set(nonce, WRAP_HEADER.byteLength);
    envelope.set(sealed.subarray(ciphertextBytes), WRAP_HEADER.byteLength + WRAP_NONCE_BYTES);
    envelope.set(
      sealed.subarray(0, ciphertextBytes),
      WRAP_HEADER.byteLength + WRAP_NONCE_BYTES + WRAP_TAG_BYTES,
    );
    return envelope;
  } finally {
    raw.fill(0);
  }
}

export async function unwrapVaultKey(envelope, wrappingKey, options = {}) {
  const provider = webCrypto(options);
  const vaultId = normalizedVaultId(options.vaultId);
  if (!wrappingKeyIsSafe(wrappingKey)) {
    throw new Error('Wrapping key must be a non-extractable 256-bit AES-GCM key');
  }
  const wrapped = copyBytes(envelope, 'Wrapped vault key');
  if (wrapped.byteLength !== WRAPPED_VAULT_BYTES || !wrapHeaderMatches(wrapped)) {
    throw new Error('Unsupported or malformed wrapped vault key');
  }
  const nonceStart = WRAP_HEADER.byteLength;
  const tagStart = nonceStart + WRAP_NONCE_BYTES;
  const ciphertextStart = tagStart + WRAP_TAG_BYTES;
  const sealed = new Uint8Array(VAULT_KEY_BYTES + WRAP_TAG_BYTES);
  sealed.set(wrapped.subarray(ciphertextStart), 0);
  sealed.set(wrapped.subarray(tagStart, ciphertextStart), VAULT_KEY_BYTES);

  let cleartext;
  try {
    cleartext = new Uint8Array(await provider.subtle.decrypt({
      name: 'AES-GCM',
      iv: wrapped.subarray(nonceStart, tagStart),
      additionalData: wrappingAad(vaultId),
      tagLength: WRAP_TAG_BYTES * 8,
    }, wrappingKey, sealed));
  } catch {
    throw new Error('Stored vault key authentication failed');
  }
  if (cleartext.byteLength !== VAULT_KEY_BYTES) {
    cleartext.fill(0);
    throw new Error('Stored vault key has an invalid length');
  }
  return cleartext;
}

async function readStoredVault(storage, vaultId, options) {
  const record = await storage.get(storageKey(vaultId));
  if (record === undefined || record === null) return null;
  if (!recordIsWellFormed(record, vaultId)) {
    throw new Error('Stored browser vault record is malformed or unsafe');
  }
  return unwrapVaultKey(record.wrappedVaultKey, record.wrappingKey, {
    ...options,
    vaultId,
  });
}

async function createStoredRecord(vaultKey, provider, vaultId) {
  const wrappingKey = await createWrappingKey({ crypto: provider });
  const wrappedVaultKey = await wrapVaultKey(vaultKey, wrappingKey, {
    crypto: provider,
    vaultId,
  });
  return Object.freeze({
    kind: RECORD_KIND,
    schemaVersion: BROWSER_VAULT_RECORD_SCHEMA_VERSION,
    vaultId,
    wrappingKey,
    wrappedVaultKey,
  });
}

export async function loadBrowserVault(options = {}) {
  const storage = assertStorage(options.storage);
  const vaultId = normalizedVaultId(options.vaultId);
  const vaultKey = await readStoredVault(storage, vaultId, options);
  return vaultKey === null ? null : Object.freeze({ vaultKey, created: false, vaultId });
}

/**
 * Explicitly initialize a new browser vault. Call loadBrowserVault first and
 * only invoke this after the enrollment flow has established that creating a
 * new vault is correct. A missing local record is not otherwise auto-replaced.
 */
export async function createBrowserVault(options = {}) {
  const storage = assertStorage(options.storage);
  const vaultId = normalizedVaultId(options.vaultId);
  const existing = await readStoredVault(storage, vaultId, options);
  if (existing !== null) {
    return Object.freeze({ vaultKey: existing, created: false, vaultId });
  }

  const provider = webCrypto(options);
  const vaultKey = generateVaultKey({ crypto: provider });
  let returnedCandidate = false;
  try {
    const candidate = await createStoredRecord(vaultKey, provider, vaultId);

    const inserted = await storage.insertIfAbsent(storageKey(vaultId), candidate);
    if (inserted === true) {
      returnedCandidate = true;
      return Object.freeze({ vaultKey, created: true, vaultId });
    }
    if (inserted !== false) {
      throw new Error('storage.insertIfAbsent must resolve to a boolean');
    }

    // Another tab won the initialization race. Never generate a replacement if
    // that winning record cannot be read or authenticated.
    const winner = await readStoredVault(storage, vaultId, options);
    if (winner === null) throw new Error('Browser vault disappeared during initialization');
    return Object.freeze({ vaultKey: winner, created: false, vaultId });
  } finally {
    if (!returnedCandidate) vaultKey.fill(0);
  }
}

/**
 * Persist a vault key received through an authenticated account flow. The
 * default remains conflict-safe; callers may request an atomic replacement
 * only after a recently authenticated server copy became authoritative.
 */
export async function importBrowserVault(options = {}) {
  const storage = assertStorage(options.storage);
  const vaultId = normalizedVaultId(options.vaultId);
  const provider = webCrypto(options);
  const imported = copiedVaultKey(options.vaultKey);

  try {
    const existing = await readStoredVault(storage, vaultId, options);
    if (existing !== null) {
      let matches;
      try {
        matches = equalVaultKeys(imported, existing);
      } finally {
        existing.fill(0);
      }
      if (!matches) {
        if (options.replaceExisting !== true) {
          throw new Error('A different vault key is already stored for this vault');
        }
        if (typeof storage.replace !== 'function') {
          throw new Error('Browser storage cannot atomically replace a stale vault key');
        }
        const candidate = await createStoredRecord(imported, provider, vaultId);
        await storage.replace(storageKey(vaultId), candidate);
        return Object.freeze({
          vaultKey: imported.slice(),
          created: false,
          replaced: true,
          vaultId,
        });
      }
      return Object.freeze({ vaultKey: imported.slice(), created: false, vaultId });
    }

    const candidate = await createStoredRecord(imported, provider, vaultId);
    const inserted = await storage.insertIfAbsent(storageKey(vaultId), candidate);
    if (inserted === true) {
      return Object.freeze({ vaultKey: imported.slice(), created: true, vaultId });
    }
    if (inserted !== false) {
      throw new Error('storage.insertIfAbsent must resolve to a boolean');
    }

    // A concurrent import won. Accept it only when it is exactly the same
    // 32-byte vault key; never overwrite or silently switch vault identities.
    const winner = await readStoredVault(storage, vaultId, options);
    if (winner === null) throw new Error('Browser vault disappeared during import');
    let matches;
    try {
      matches = equalVaultKeys(imported, winner);
    } finally {
      winner.fill(0);
    }
    if (!matches) throw new Error('A different vault key won the concurrent browser import');
    return Object.freeze({ vaultKey: imported.slice(), created: false, vaultId });
  } finally {
    imported.fill(0);
  }
}

export async function deleteBrowserVault(options = {}) {
  const storage = assertStorage(options.storage);
  const vaultId = normalizedVaultId(options.vaultId);
  await storage.delete(storageKey(vaultId));
}
