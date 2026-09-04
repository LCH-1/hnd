import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import {
  PRIVATE_FILE_MODE,
  atomicWriteFile,
  createPrivateFile,
  ensurePrivatePermissions,
} from './io.mjs';

export const VAULT_KEY_BYTES = 32;
export const GCM_NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const MAX_SNAPSHOT_PLAINTEXT_BYTES = 4 * 1024 * 1024;

const MAGIC = Buffer.from('HNDE', 'ascii');
const VERSION = 1;
const AUTHENTICATED_HEADER = Buffer.concat([MAGIC, Buffer.from([VERSION])]);
export const ENVELOPE_OVERHEAD_BYTES = AUTHENTICATED_HEADER.byteLength
  + GCM_NONCE_BYTES
  + GCM_TAG_BYTES;
const KEY_PREFIX = 'hnd-vault-v1:';

function asVaultKey(key) {
  const normalized = Buffer.isBuffer(key) ? key : Buffer.from(key ?? []);
  if (normalized.byteLength !== VAULT_KEY_BYTES) {
    throw new Error(`Vault key must be exactly ${VAULT_KEY_BYTES} bytes`);
  }
  return normalized;
}

function asPlaintext(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new TypeError('Plaintext must be a Buffer, Uint8Array, or string');
}

export function generateVaultKey() {
  return randomBytes(VAULT_KEY_BYTES);
}

export function encryptBytes(plaintext, key, options = {}) {
  const cleartext = asPlaintext(plaintext);
  const maxBytes = options.maxBytes ?? MAX_SNAPSHOT_PLAINTEXT_BYTES;
  if (cleartext.byteLength > maxBytes) {
    throw new Error(`Snapshot plaintext exceeds ${maxBytes} byte limit`);
  }

  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', asVaultKey(key), nonce, {
    authTagLength: GCM_TAG_BYTES,
  });
  cipher.setAAD(AUTHENTICATED_HEADER);
  const ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([AUTHENTICATED_HEADER, nonce, tag, ciphertext]);
}

export function decryptBytes(envelope, key, options = {}) {
  const blob = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope ?? []);
  const maxBytes = options.maxBytes ?? MAX_SNAPSHOT_PLAINTEXT_BYTES;
  if (blob.byteLength < ENVELOPE_OVERHEAD_BYTES) {
    throw new Error('Invalid encrypted snapshot envelope');
  }
  if (blob.byteLength > maxBytes + ENVELOPE_OVERHEAD_BYTES) {
    throw new Error(`Encrypted snapshot exceeds ${maxBytes + ENVELOPE_OVERHEAD_BYTES} byte limit`);
  }
  if (!blob.subarray(0, MAGIC.byteLength).equals(MAGIC) || blob[MAGIC.byteLength] !== VERSION) {
    throw new Error('Unsupported encrypted snapshot envelope');
  }

  const nonceStart = AUTHENTICATED_HEADER.byteLength;
  const tagStart = nonceStart + GCM_NONCE_BYTES;
  const ciphertextStart = tagStart + GCM_TAG_BYTES;
  const nonce = blob.subarray(nonceStart, tagStart);
  const tag = blob.subarray(tagStart, ciphertextStart);
  const ciphertext = blob.subarray(ciphertextStart);

  try {
    const decipher = createDecipheriv('aes-256-gcm', asVaultKey(key), nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(AUTHENTICATED_HEADER);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Encrypted snapshot authentication failed');
  }
}

export function encryptSnapshot(snapshot, key, options = {}) {
  const serialized = JSON.stringify(snapshot);
  if (serialized === undefined) {
    throw new TypeError('Snapshot must be JSON serializable');
  }
  return encryptBytes(serialized, key, options);
}

export function decryptSnapshot(envelope, key, options = {}) {
  const plaintext = decryptBytes(envelope, key, options);
  try {
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('Decrypted snapshot is not valid JSON');
  }
}

export function serializeVaultKey(key) {
  return `${KEY_PREFIX}${asVaultKey(key).toString('base64url')}\n`;
}

export function parseVaultKey(contents) {
  const value = Buffer.isBuffer(contents) ? contents.toString('utf8') : String(contents);
  const trimmed = value.trim();
  if (!trimmed.startsWith(KEY_PREFIX)) {
    throw new Error('Invalid vault key file format');
  }
  const encoded = trimmed.slice(KEY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error('Invalid vault key encoding');
  }
  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64url');
  } catch {
    throw new Error('Invalid vault key encoding');
  }
  if (decoded.toString('base64url') !== encoded) throw new Error('Invalid vault key encoding');
  return Buffer.from(asVaultKey(decoded));
}

export async function writeVaultKey(filePath, key, options = {}) {
  const serialized = serializeVaultKey(key);
  if (options.overwrite) {
    await atomicWriteFile(filePath, serialized, { mode: PRIVATE_FILE_MODE, maxBytes: 256 });
  } else {
    await createPrivateFile(filePath, serialized);
  }
  return filePath;
}

export async function readVaultKey(filePath, options = {}) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Vault key path must be a regular file');
  }
  if (process.platform !== 'win32' && !options.allowInsecurePermissions && (metadata.mode & 0o077) !== 0) {
    throw new Error('Vault key file permissions are too broad; expected 0600');
  }
  const contents = await readFile(filePath);
  if (contents.byteLength > 256) {
    throw new Error('Vault key file is unexpectedly large');
  }
  return parseVaultKey(contents);
}

export async function repairVaultKeyPermissions(filePath) {
  await ensurePrivatePermissions(filePath);
}
