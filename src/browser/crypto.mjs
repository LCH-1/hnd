export const VAULT_KEY_BYTES = 32;
export const GCM_NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const MAX_SNAPSHOT_PLAINTEXT_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_AUTHENTICATION_ERROR_CODE = 'snapshot_authentication_failed';

const AUTHENTICATED_HEADER = Uint8Array.of(
  0x48, 0x4e, 0x44, 0x45, // HNDE
  0x01, // envelope version
);

export const ENVELOPE_OVERHEAD_BYTES = AUTHENTICATED_HEADER.byteLength
  + GCM_NONCE_BYTES
  + GCM_TAG_BYTES;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function webCrypto(options = {}) {
  const provider = options.crypto ?? globalThis.crypto;
  if (
    !provider
    || typeof provider.getRandomValues !== 'function'
    || !provider.subtle
    || typeof provider.subtle.importKey !== 'function'
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

function plaintextBytes(value) {
  if (typeof value === 'string') return textEncoder.encode(value);
  return copyBytes(value, 'Plaintext');
}

function vaultKeyBytes(value) {
  const key = copyBytes(value, 'Vault key');
  if (key.byteLength !== VAULT_KEY_BYTES) {
    key.fill(0);
    throw new Error(`Vault key must be exactly ${VAULT_KEY_BYTES} bytes`);
  }
  return key;
}

function maximumPlaintextBytes(options) {
  const maximum = options.maxBytes ?? MAX_SNAPSHOT_PLAINTEXT_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer');
  }
  return maximum;
}

function headerMatches(envelope) {
  if (envelope.byteLength < AUTHENTICATED_HEADER.byteLength) return false;
  for (let index = 0; index < AUTHENTICATED_HEADER.byteLength; index += 1) {
    if (envelope[index] !== AUTHENTICATED_HEADER[index]) return false;
  }
  return true;
}

async function importedVaultKey(value, usage, provider) {
  const raw = vaultKeyBytes(value);
  try {
    return await provider.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM', length: 256 },
      false,
      [usage],
    );
  } finally {
    raw.fill(0);
  }
}

/** Generate a raw 256-bit vault key. Keep the returned bytes in memory only. */
export function generateVaultKey(options = {}) {
  const provider = webCrypto(options);
  const key = new Uint8Array(VAULT_KEY_BYTES);
  provider.getRandomValues(key);
  return key;
}

/**
 * Encrypt bytes in the existing server wire format:
 * HNDE || version(1) || nonce(12) || tag(16) || ciphertext.
 */
export async function encryptBytes(plaintext, vaultKey, options = {}) {
  const provider = webCrypto(options);
  const cleartext = plaintextBytes(plaintext);
  const maximum = maximumPlaintextBytes(options);
  if (cleartext.byteLength > maximum) {
    cleartext.fill(0);
    throw new Error(`Snapshot plaintext exceeds ${maximum} byte limit`);
  }
  try {
    const key = await importedVaultKey(vaultKey, 'encrypt', provider);
    const nonce = new Uint8Array(GCM_NONCE_BYTES);
    provider.getRandomValues(nonce);
    const sealed = new Uint8Array(await provider.subtle.encrypt({
      name: 'AES-GCM',
      iv: nonce,
      additionalData: AUTHENTICATED_HEADER,
      tagLength: GCM_TAG_BYTES * 8,
    }, key, cleartext));

    // WebCrypto returns ciphertext || tag, while the established Node wire
    // format places the tag before the ciphertext.
    const ciphertextBytes = sealed.byteLength - GCM_TAG_BYTES;
    if (ciphertextBytes !== cleartext.byteLength) {
      throw new Error('WebCrypto returned an invalid AES-GCM result');
    }
    const envelope = new Uint8Array(ENVELOPE_OVERHEAD_BYTES + ciphertextBytes);
    envelope.set(AUTHENTICATED_HEADER, 0);
    envelope.set(nonce, AUTHENTICATED_HEADER.byteLength);
    envelope.set(
      sealed.subarray(ciphertextBytes),
      AUTHENTICATED_HEADER.byteLength + GCM_NONCE_BYTES,
    );
    envelope.set(sealed.subarray(0, ciphertextBytes), ENVELOPE_OVERHEAD_BYTES);
    return envelope;
  } finally {
    cleartext.fill(0);
  }
}

export async function decryptBytes(envelope, vaultKey, options = {}) {
  const provider = webCrypto(options);
  const blob = copyBytes(envelope, 'Encrypted snapshot');
  const maximum = maximumPlaintextBytes(options);
  if (blob.byteLength < ENVELOPE_OVERHEAD_BYTES) {
    throw new Error('Invalid encrypted snapshot envelope');
  }
  if (blob.byteLength > maximum + ENVELOPE_OVERHEAD_BYTES) {
    throw new Error(`Encrypted snapshot exceeds ${maximum + ENVELOPE_OVERHEAD_BYTES} byte limit`);
  }
  if (!headerMatches(blob)) throw new Error('Unsupported encrypted snapshot envelope');

  const nonceStart = AUTHENTICATED_HEADER.byteLength;
  const tagStart = nonceStart + GCM_NONCE_BYTES;
  const ciphertextStart = tagStart + GCM_TAG_BYTES;
  const ciphertextBytes = blob.byteLength - ciphertextStart;
  const nonce = blob.subarray(nonceStart, tagStart);
  const sealed = new Uint8Array(ciphertextBytes + GCM_TAG_BYTES);
  sealed.set(blob.subarray(ciphertextStart), 0);
  sealed.set(blob.subarray(tagStart, ciphertextStart), ciphertextBytes);
  const key = await importedVaultKey(vaultKey, 'decrypt', provider);

  try {
    return new Uint8Array(await provider.subtle.decrypt({
      name: 'AES-GCM',
      iv: nonce,
      additionalData: AUTHENTICATED_HEADER,
      tagLength: GCM_TAG_BYTES * 8,
    }, key, sealed));
  } catch {
    const error = new Error('Encrypted snapshot authentication failed');
    error.code = SNAPSHOT_AUTHENTICATION_ERROR_CODE;
    throw error;
  }
}

export async function encryptSnapshot(snapshot, vaultKey, options = {}) {
  const serialized = JSON.stringify(snapshot);
  if (serialized === undefined) {
    throw new TypeError('Snapshot must be JSON serializable');
  }
  const plaintext = textEncoder.encode(serialized);
  try {
    return await encryptBytes(plaintext, vaultKey, options);
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptSnapshot(envelope, vaultKey, options = {}) {
  const plaintext = await decryptBytes(envelope, vaultKey, options);
  try {
    return JSON.parse(textDecoder.decode(plaintext));
  } catch {
    throw new Error('Decrypted snapshot is not valid JSON');
  } finally {
    plaintext.fill(0);
  }
}
