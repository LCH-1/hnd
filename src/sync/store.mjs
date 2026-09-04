import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertOpaqueId,
  createPrivateFile,
  ensurePrivateDirectory,
  ensurePrivatePermissions,
  readFileLimited,
  safeJoin,
} from './io.mjs';
import {
  createStrongEtag,
  parseEntityTags,
  strongEtagMatches,
} from './etag.mjs';
import { DEFAULT_MAX_BLOB_BYTES } from './constants.mjs';
import { decryptBytes, encryptBytes } from './crypto.mjs';
import { validateSyncSnapshot } from './capture.mjs';

export { DEFAULT_MAX_BLOB_BYTES } from './constants.mjs';

export const CONTROL_SCHEMA_VERSION = 1;
export const DATABASE_SCHEMA_VERSION = 1;
export const DEFAULT_DATABASE_FILENAME = 'hnd.sqlite';
export const DEFAULT_SERVER_MASTER_KEY_FILENAME = 'server-vault.key';
export const DEFAULT_MAX_REVISIONS_PER_TENANT = 50;
export const DEFAULT_ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const DATABASE_APPLICATION_ID = 0x484e4401;
const MAX_CONTROL_BYTES = 2 * 1024 * 1024;
const MAX_DEVICE_NAME_LENGTH = 100;
const MAX_WRAPPED_VAULT_KEY_BYTES = 512;
const VAULT_KEY_BYTES = 32;
const MANAGED_KEY_MAGIC = Buffer.from('HNDK', 'ascii');
const MANAGED_KEY_VERSION = 1;
const MANAGED_KEY_HEADER = Buffer.concat([MANAGED_KEY_MAGIC, Buffer.from([MANAGED_KEY_VERSION])]);
const MANAGED_KEY_NONCE_BYTES = 12;
const MANAGED_KEY_TAG_BYTES = 16;
const MANAGED_KEY_ENVELOPE_BYTES = MANAGED_KEY_HEADER.byteLength
  + MANAGED_KEY_NONCE_BYTES
  + MANAGED_KEY_TAG_BYTES
  + VAULT_KEY_BYTES;
const SERVER_MASTER_KEY_DIGEST_METADATA = 'server_vault_key_sha256';

export class AuthenticationError extends Error {
  constructor(message = 'Invalid or revoked credential') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class PreconditionRequiredError extends Error {
  constructor(message, currentEtag = null) {
    super(message);
    this.name = 'PreconditionRequiredError';
    this.currentEtag = currentEtag;
  }
}

export class PreconditionFailedError extends Error {
  constructor(message, currentEtag = null) {
    super(message);
    this.name = 'PreconditionFailedError';
    this.currentEtag = currentEtag;
  }
}

export class VaultResetError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'VaultResetError';
    this.code = code;
    this.statusCode = 409;
    this.currentEtag = options.currentEtag ?? null;
    this.activeDeviceCount = options.activeDeviceCount ?? 0;
  }
}

export class ManagedVaultKeyError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'ManagedVaultKeyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function hashesEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function randomToken(prefix) {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function normalizeDeviceName(value) {
  const name = String(value || 'unnamed-device').trim();
  if (!name || name.length > MAX_DEVICE_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('Invalid device name');
  }
  return name;
}

function validTimestamp(value, { nullable = false } = {}) {
  return (nullable && value === null)
    || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function validateLegacyControlState(state) {
  if (!state || state.schemaVersion !== CONTROL_SCHEMA_VERSION) {
    throw new Error('Unsupported control store schema');
  }
  if (state.invitations === undefined) state.invitations = [];
  if (
    !Array.isArray(state.enrollments)
    || !Array.isArray(state.invitations)
    || !Array.isArray(state.devices)
  ) {
    throw new Error('Malformed control store');
  }
  for (const enrollment of state.enrollments) {
    assertOpaqueId(enrollment.id, 'enrollment id');
    assertOpaqueId(enrollment.tenantId, 'tenant id');
    if (
      !/^[a-f0-9]{64}$/.test(enrollment.tokenHash || '')
      || !validTimestamp(enrollment.createdAt)
      || !validTimestamp(enrollment.expiresAt)
      || !validTimestamp(enrollment.usedAt, { nullable: true })
    ) {
      throw new Error('Malformed enrollment');
    }
    if ('token' in enrollment || 'enrollmentKey' in enrollment) {
      throw new Error('Control store must not contain raw enrollment keys');
    }
  }
  for (const invitation of state.invitations) {
    assertOpaqueId(invitation.id, 'invitation id');
    assertOpaqueId(invitation.tenantId, 'tenant id');
    if (!/^[a-f0-9]{64}$/.test(invitation.tokenHash || '')) {
      throw new Error('Malformed invitation token hash');
    }
    if (
      typeof invitation.wrappedVaultKey !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(invitation.wrappedVaultKey)
      || Buffer.from(invitation.wrappedVaultKey, 'base64').byteLength === 0
      || Buffer.from(invitation.wrappedVaultKey, 'base64').byteLength > MAX_WRAPPED_VAULT_KEY_BYTES
      || !validTimestamp(invitation.createdAt)
      || !validTimestamp(invitation.expiresAt)
      || !validTimestamp(invitation.usedAt, { nullable: true })
    ) {
      throw new Error('Malformed wrapped vault key');
    }
    if ('token' in invitation || 'invitationToken' in invitation || 'vaultKey' in invitation) {
      throw new Error('Control store must not contain raw invitation secrets');
    }
  }
  for (const device of state.devices) {
    assertOpaqueId(device.id, 'device id');
    assertOpaqueId(device.tenantId, 'tenant id');
    normalizeDeviceName(device.name);
    if (
      !/^[a-f0-9]{64}$/.test(device.tokenHash || '')
      || !validTimestamp(device.createdAt)
      || !validTimestamp(device.revokedAt, { nullable: true })
    ) {
      throw new Error('Malformed device');
    }
    if ('token' in device || 'deviceToken' in device) {
      throw new Error('Control store must not contain raw device tokens');
    }
  }
  return state;
}

function publicDevice(device) {
  return Object.freeze({
    id: device.id,
    tenantId: Object.hasOwn(device, 'tenant_id') ? device.tenant_id : device.tenantId,
    name: device.name,
    createdAt: Object.hasOwn(device, 'created_at') ? device.created_at : device.createdAt,
    revokedAt: Object.hasOwn(device, 'revoked_at') ? device.revoked_at : device.revokedAt,
  });
}

function withImmediateTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function initializeSchema(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA secure_delete = ON;
    PRAGMA trusted_schema = OFF;
  `);
  const version = Number(database.prepare('PRAGMA user_version').get().user_version);
  const applicationId = Number(database.prepare('PRAGMA application_id').get().application_id);
  if (version === 0) {
    const existing = database.prepare(`
      SELECT count(*) AS count
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
    `).get().count;
    if (Number(existing) !== 0 || (applicationId !== 0 && applicationId !== DATABASE_APPLICATION_ID)) {
      throw new Error('Database is not an empty hnd database');
    }
    withImmediateTransaction(database, () => {
      database.exec(`
        CREATE TABLE schema_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;

        CREATE TABLE tenants (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE enrollments (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT
        ) STRICT;

        CREATE TABLE invitations (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          wrapped_vault_key BLOB NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT
        ) STRICT;

        CREATE TABLE devices (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        ) STRICT;

        CREATE TABLE revisions (
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          blob BLOB NOT NULL,
          bytes INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, id)
        ) STRICT;

        CREATE TABLE snapshots (
          tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
          revision_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (tenant_id, revision_id)
            REFERENCES revisions(tenant_id, id) ON DELETE RESTRICT
        ) STRICT;

        CREATE INDEX enrollments_expires_at ON enrollments(expires_at);
        CREATE INDEX invitations_expires_at ON invitations(expires_at);
        CREATE INDEX devices_tenant_id ON devices(tenant_id, created_at, id);
        CREATE INDEX revisions_tenant_created ON revisions(tenant_id, created_at DESC, id);
      `);
      database.exec(`PRAGMA application_id = ${DATABASE_APPLICATION_ID}`);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
    });
  } else if (version !== DATABASE_SCHEMA_VERSION || applicationId !== DATABASE_APPLICATION_ID) {
    throw new Error(`Unsupported hnd database schema version: ${version}`);
  }
  database.enableLoadExtension(false);
  database.enableDefensive(true);
}

function ensureTenant(database, tenantId, createdAt) {
  database.prepare(`
    INSERT OR IGNORE INTO tenants (id, created_at) VALUES (?, ?)
  `).run(tenantId, createdAt);
}

function setMetadata(database, key, value = '1') {
  database.prepare(`
    INSERT INTO schema_metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function hasMetadata(database, key) {
  return database.prepare('SELECT 1 AS present FROM schema_metadata WHERE key = ?').get(key) !== undefined;
}

function initializeManagedVaultKeySchema(database) {
  withImmediateTransaction(database, () => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS managed_vault_keys (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        key_envelope BLOB NOT NULL
          CHECK (length(key_envelope) = ${MANAGED_KEY_ENVELOPE_BYTES}),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    setMetadata(database, 'managed_vault_keys_schema', '1');
  });
}

function managedKeyAad(tenantId) {
  return Buffer.concat([
    MANAGED_KEY_HEADER,
    Buffer.from([0]),
    Buffer.from(tenantId, 'utf8'),
  ]);
}

function wrapManagedVaultKey(vaultKey, masterKey, tenantId) {
  const nonce = randomBytes(MANAGED_KEY_NONCE_BYTES);
  const aad = managedKeyAad(tenantId);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce, {
    authTagLength: MANAGED_KEY_TAG_BYTES,
  });
  cipher.setAAD(aad);
  try {
    const ciphertext = Buffer.concat([cipher.update(vaultKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MANAGED_KEY_HEADER, nonce, tag, ciphertext]);
  } finally {
    aad.fill(0);
    nonce.fill(0);
  }
}

function unwrapManagedVaultKey(envelope, masterKey, tenantId) {
  const wrapped = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope ?? []);
  if (
    wrapped.byteLength !== MANAGED_KEY_ENVELOPE_BYTES
    || !wrapped.subarray(0, MANAGED_KEY_MAGIC.byteLength).equals(MANAGED_KEY_MAGIC)
    || wrapped[MANAGED_KEY_MAGIC.byteLength] !== MANAGED_KEY_VERSION
  ) {
    throw new Error('Stored managed vault key envelope is invalid');
  }
  const nonceStart = MANAGED_KEY_HEADER.byteLength;
  const tagStart = nonceStart + MANAGED_KEY_NONCE_BYTES;
  const ciphertextStart = tagStart + MANAGED_KEY_TAG_BYTES;
  const aad = managedKeyAad(tenantId);
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      masterKey,
      wrapped.subarray(nonceStart, tagStart),
      { authTagLength: MANAGED_KEY_TAG_BYTES },
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(wrapped.subarray(tagStart, ciphertextStart));
    const key = Buffer.concat([
      decipher.update(wrapped.subarray(ciphertextStart)),
      decipher.final(),
    ]);
    if (key.byteLength !== VAULT_KEY_BYTES) {
      key.fill(0);
      throw new Error('Stored managed vault key has an invalid length');
    }
    return key;
  } catch (error) {
    if (error?.message === 'Stored managed vault key has an invalid length') throw error;
    throw new Error('Stored managed vault key envelope authentication failed');
  } finally {
    aad.fill(0);
  }
}

function validateServerMasterKeyMetadata(metadata) {
  if (!metadata.isFile()) {
    throw new Error('Server vault key path must be a regular file');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('Server vault key file permissions are too broad; expected 0600');
  }
  if (metadata.size !== VAULT_KEY_BYTES) {
    throw new Error('Server vault key file is invalid');
  }
}

async function readServerMasterKey(filePath) {
  const noFollowFlag = fsConstants.O_NOFOLLOW ?? 0;
  let pathMetadata = null;
  if (noFollowFlag === 0) {
    pathMetadata = await lstat(filePath);
    if (pathMetadata.isSymbolicLink()) {
      throw new Error('Server vault key path must be a regular file');
    }
  }

  let handle;
  let key;
  try {
    try {
      handle = await open(filePath, fsConstants.O_RDONLY | noFollowFlag);
    } catch (error) {
      if (error?.code === 'ELOOP') {
        throw new Error('Server vault key path must be a regular file');
      }
      throw error;
    }
    const openedMetadata = await handle.stat();
    validateServerMasterKeyMetadata(openedMetadata);
    if (
      pathMetadata
      && (pathMetadata.dev !== openedMetadata.dev || pathMetadata.ino !== openedMetadata.ino)
    ) {
      throw new Error('Server vault key changed while it was being opened');
    }

    key = Buffer.allocUnsafe(VAULT_KEY_BYTES);
    let offset = 0;
    while (offset < key.byteLength) {
      const { bytesRead } = await handle.read(
        key,
        offset,
        key.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) throw new Error('Server vault key file is invalid');
      offset += bytesRead;
    }
    const finalMetadata = await handle.stat();
    validateServerMasterKeyMetadata(finalMetadata);
    if (
      openedMetadata.dev !== finalMetadata.dev
      || openedMetadata.ino !== finalMetadata.ino
    ) {
      throw new Error('Server vault key changed while it was being read');
    }
    return key;
  } catch (error) {
    key?.fill(0);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function serverMasterKeyDigest(masterKey) {
  return createHash('sha256').update(masterKey).digest('hex');
}

function assertServerMasterKeyDigest(database, masterKey) {
  const expected = database.prepare(
    'SELECT value FROM schema_metadata WHERE key = ?',
  ).get(SERVER_MASTER_KEY_DIGEST_METADATA)?.value;
  const actual = serverMasterKeyDigest(masterKey);
  if (
    typeof expected !== 'string'
    || !/^[a-f0-9]{64}$/.test(expected)
    || !hashesEqual(expected, actual)
  ) {
    throw new Error('Server vault key does not match its database identity');
  }
}

function bindServerMasterKeyDigest(database, masterKey) {
  const digest = serverMasterKeyDigest(masterKey);
  withImmediateTransaction(database, () => {
    database.prepare(`
      INSERT OR IGNORE INTO schema_metadata (key, value) VALUES (?, ?)
    `).run(SERVER_MASTER_KEY_DIGEST_METADATA, digest);
    assertServerMasterKeyDigest(database, masterKey);
  });
}

async function readVerifiedServerMasterKey(filePath, database) {
  const masterKey = await readServerMasterKey(filePath);
  try {
    assertServerMasterKeyDigest(database, masterKey);
    return masterKey;
  } catch (error) {
    masterKey.fill(0);
    throw error;
  }
}

async function ensureServerMasterKey(filePath, database) {
  try {
    return await readServerMasterKey(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const managedKeyCount = Number(database.prepare(
    'SELECT count(*) AS count FROM managed_vault_keys',
  ).get().count);
  const hasBoundDigest = database.prepare(
    'SELECT 1 AS present FROM schema_metadata WHERE key = ?',
  ).get(SERVER_MASTER_KEY_DIGEST_METADATA) !== undefined;
  if (managedKeyCount > 0 || hasBoundDigest) {
    throw new Error('Server vault key file is missing while managed vault keys exist');
  }

  const generated = randomBytes(VAULT_KEY_BYTES);
  try {
    try {
      await createPrivateFile(filePath, generated);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  } finally {
    generated.fill(0);
  }
  return readServerMasterKey(filePath);
}

function validateSnapshotWithVaultKey(blob, vaultKey) {
  let plaintext;
  try {
    plaintext = decryptBytes(blob, vaultKey);
    let snapshot;
    try {
      snapshot = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new Error('Decrypted snapshot is not valid JSON');
    }
    validateSyncSnapshot(snapshot);
  } catch {
    throw new ManagedVaultKeyError(
      'invalid_vault_key',
      'The supplied vault key cannot open the current snapshot.',
      400,
    );
  } finally {
    plaintext?.fill(0);
  }
}

function pruneExpiredInvitations(database, now) {
  const remove = database.prepare('DELETE FROM invitations WHERE id = ?');
  for (const invitation of database.prepare('SELECT id, expires_at FROM invitations').all()) {
    if (Date.parse(invitation.expires_at) <= now) remove.run(invitation.id);
  }
}

class SqliteStoreBase {
  constructor(dataDirectory) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.databasePath = safeJoin(this.dataDirectory, DEFAULT_DATABASE_FILENAME);
    this.database = null;
    this.initializing = null;
  }

  async initDatabase() {
    if (this.database) return this.database;
    if (!this.initializing) {
      this.initializing = (async () => {
        await ensurePrivateDirectory(this.dataDirectory);
        try {
          const metadata = await lstat(this.databasePath);
          if (!metadata.isFile() || metadata.isSymbolicLink()) {
            throw new Error('hnd database path is not a regular file');
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        const database = new DatabaseSync(this.databasePath);
        try {
          initializeSchema(database);
          await ensurePrivatePermissions(this.databasePath);
          this.database = database;
          return database;
        } catch (error) {
          database.close();
          throw error;
        }
      })().finally(() => {
        this.initializing = null;
      });
    }
    return this.initializing;
  }

  getDatabase() {
    if (!this.database) throw new Error('Store has not been initialized');
    return this.database;
  }

  close() {
    if (!this.database) return;
    this.database.close();
    this.database = null;
  }
}

async function readLegacyControl(dataDirectory) {
  const controlFile = safeJoin(dataDirectory, 'control.json');
  let raw;
  try {
    raw = await readFileLimited(controlFile, MAX_CONTROL_BYTES);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Control store is not valid JSON');
  }
  return validateLegacyControlState(parsed);
}

export class ControlStore extends SqliteStoreBase {
  constructor(dataDirectory, options = {}) {
    super(dataDirectory);
    this.clock = options.clock ?? (() => Date.now());
  }

  async init() {
    const database = await this.initDatabase();
    if (!hasMetadata(database, 'legacy_control_imported')) {
      const legacy = await readLegacyControl(this.dataDirectory);
      withImmediateTransaction(database, () => {
        if (legacy) this.#importLegacy(database, legacy);
        setMetadata(database, 'legacy_control_imported');
      });
    }
    pruneExpiredInvitations(database, this.clock());
    return this;
  }

  #importLegacy(database, state) {
    for (const entry of [...state.enrollments, ...state.invitations, ...state.devices]) {
      ensureTenant(database, entry.tenantId, entry.createdAt);
    }
    const insertEnrollment = database.prepare(`
      INSERT OR IGNORE INTO enrollments
        (id, tenant_id, token_hash, created_at, expires_at, used_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const entry of state.enrollments) {
      insertEnrollment.run(entry.id, entry.tenantId, entry.tokenHash, entry.createdAt, entry.expiresAt, entry.usedAt);
    }
    const insertInvitation = database.prepare(`
      INSERT OR IGNORE INTO invitations
        (id, tenant_id, token_hash, wrapped_vault_key, created_at, expires_at, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of state.invitations) {
      insertInvitation.run(
        entry.id,
        entry.tenantId,
        entry.tokenHash,
        Buffer.from(entry.wrappedVaultKey, 'base64'),
        entry.createdAt,
        entry.expiresAt,
        entry.usedAt,
      );
    }
    const insertDevice = database.prepare(`
      INSERT OR IGNORE INTO devices
        (id, tenant_id, token_hash, name, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const entry of state.devices) {
      insertDevice.run(entry.id, entry.tenantId, entry.tokenHash, entry.name, entry.createdAt, entry.revokedAt);
    }
  }

  async createEnrollmentKey(tenantId = randomUUID(), options = {}) {
    const normalizedTenantId = assertOpaqueId(tenantId, 'tenant id');
    const ttlMs = options.ttlMs ?? DEFAULT_ENROLLMENT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 7 * 24 * 60 * 60 * 1000) {
      throw new Error('Enrollment TTL must be between one second and seven days');
    }
    const enrollmentKey = randomToken('hnde_');
    const now = this.clock();
    const enrollment = {
      id: randomUUID(),
      tenantId: normalizedTenantId,
      tokenHash: tokenHash(enrollmentKey),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      usedAt: null,
    };
    const database = this.getDatabase();
    withImmediateTransaction(database, () => {
      pruneExpiredInvitations(database, now);
      ensureTenant(database, normalizedTenantId, enrollment.createdAt);
      database.prepare(`
        INSERT INTO enrollments
          (id, tenant_id, token_hash, created_at, expires_at, used_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        enrollment.id,
        enrollment.tenantId,
        enrollment.tokenHash,
        enrollment.createdAt,
        enrollment.expiresAt,
        enrollment.usedAt,
      );
    });
    return Object.freeze({
      enrollmentKey,
      enrollmentId: enrollment.id,
      tenantId: normalizedTenantId,
      expiresAt: enrollment.expiresAt,
    });
  }

  async consumeEnrollmentKey(enrollmentKey, deviceName) {
    if (typeof enrollmentKey !== 'string' || !/^hnde_[A-Za-z0-9_-]{40,64}$/.test(enrollmentKey)) {
      throw new AuthenticationError('Invalid or expired enrollment key');
    }
    const presentedHash = tokenHash(enrollmentKey);
    const name = normalizeDeviceName(deviceName);
    const database = this.getDatabase();
    return withImmediateTransaction(database, () => {
      const now = this.clock();
      pruneExpiredInvitations(database, now);
      const enrollment = database.prepare('SELECT * FROM enrollments').all()
        .find((candidate) => hashesEqual(candidate.token_hash, presentedHash));
      if (!enrollment || enrollment.used_at || Date.parse(enrollment.expires_at) <= now) {
        throw new AuthenticationError('Invalid or expired enrollment key');
      }
      const usedAt = new Date(now).toISOString();
      database.prepare('UPDATE enrollments SET used_at = ? WHERE id = ?').run(usedAt, enrollment.id);
      const deviceToken = randomToken('hndd_');
      const device = {
        id: randomUUID(),
        tenantId: enrollment.tenant_id,
        tokenHash: tokenHash(deviceToken),
        name,
        createdAt: usedAt,
        revokedAt: null,
      };
      database.prepare(`
        INSERT INTO devices (id, tenant_id, token_hash, name, created_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        device.id,
        device.tenantId,
        device.tokenHash,
        device.name,
        device.createdAt,
        device.revokedAt,
      );
      return Object.freeze({ deviceToken, device: publicDevice(device) });
    });
  }

  async createDeviceInvitation(tenantId, wrappedVaultKey, options = {}) {
    const normalizedTenantId = assertOpaqueId(tenantId, 'tenant id');
    const wrapped = Buffer.isBuffer(wrappedVaultKey)
      ? Buffer.from(wrappedVaultKey)
      : Buffer.from(wrappedVaultKey ?? []);
    try {
      if (wrapped.byteLength === 0 || wrapped.byteLength > MAX_WRAPPED_VAULT_KEY_BYTES) {
        throw new Error(`Wrapped vault key must contain 1-${MAX_WRAPPED_VAULT_KEY_BYTES} bytes`);
      }
      const ttlMs = options.ttlMs ?? DEFAULT_ENROLLMENT_TTL_MS;
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 7 * 24 * 60 * 60 * 1000) {
        throw new Error('Invitation TTL must be between one second and seven days');
      }
      const invitationToken = randomToken('hndi_');
      const now = this.clock();
      const invitation = {
        id: randomUUID(),
        tenantId: normalizedTenantId,
        tokenHash: tokenHash(invitationToken),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        usedAt: null,
      };
      const database = this.getDatabase();
      withImmediateTransaction(database, () => {
        pruneExpiredInvitations(database, now);
        ensureTenant(database, normalizedTenantId, invitation.createdAt);
        database.prepare(`
          INSERT INTO invitations
            (id, tenant_id, token_hash, wrapped_vault_key, created_at, expires_at, used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          invitation.id,
          invitation.tenantId,
          invitation.tokenHash,
          wrapped,
          invitation.createdAt,
          invitation.expiresAt,
          invitation.usedAt,
        );
      });
      return Object.freeze({
        invitationToken,
        invitationId: invitation.id,
        tenantId: normalizedTenantId,
        expiresAt: invitation.expiresAt,
      });
    } finally {
      wrapped.fill(0);
    }
  }

  async consumeDeviceInvitation(invitationToken, deviceName) {
    if (typeof invitationToken !== 'string' || !/^hndi_[A-Za-z0-9_-]{40,64}$/.test(invitationToken)) {
      throw new AuthenticationError('Invalid or expired device invitation');
    }
    const presentedHash = tokenHash(invitationToken);
    const name = normalizeDeviceName(deviceName);
    const database = this.getDatabase();
    // Expiration cleanup must survive a rejected bearer attempt. Keeping it
    // outside the consume transaction mirrors the legacy store's durable prune.
    pruneExpiredInvitations(database, this.clock());
    return withImmediateTransaction(database, () => {
      const now = this.clock();
      const invitation = database.prepare('SELECT * FROM invitations').all()
        .find((candidate) => hashesEqual(candidate.token_hash, presentedHash));
      if (!invitation || Date.parse(invitation.expires_at) <= now) {
        throw new AuthenticationError('Invalid or expired device invitation');
      }
      const wrappedVaultKey = Buffer.from(invitation.wrapped_vault_key);
      // secure_delete keeps this one-time wrapped key out of reusable DB pages.
      database.prepare('DELETE FROM invitations WHERE id = ?').run(invitation.id);
      const deviceToken = randomToken('hndd_');
      const device = {
        id: randomUUID(),
        tenantId: invitation.tenant_id,
        tokenHash: tokenHash(deviceToken),
        name,
        createdAt: new Date(now).toISOString(),
        revokedAt: null,
      };
      database.prepare(`
        INSERT INTO devices (id, tenant_id, token_hash, name, created_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        device.id,
        device.tenantId,
        device.tokenHash,
        device.name,
        device.createdAt,
        device.revokedAt,
      );
      return Object.freeze({ deviceToken, device: publicDevice(device), wrappedVaultKey });
    });
  }

  async consumeVaultInvitation(invitationToken, tenantId) {
    if (typeof invitationToken !== 'string' || !/^hndi_[A-Za-z0-9_-]{40,64}$/.test(invitationToken)) {
      throw new AuthenticationError('Invalid or expired device invitation');
    }
    const normalizedTenantId = assertOpaqueId(tenantId, 'tenant id');
    const presentedHash = tokenHash(invitationToken);
    const database = this.getDatabase();
    pruneExpiredInvitations(database, this.clock());
    return withImmediateTransaction(database, () => {
      const now = this.clock();
      const invitation = database.prepare(`
        SELECT * FROM invitations WHERE token_hash = ?
      `).get(presentedHash);
      if (
        !invitation
        || invitation.tenant_id !== normalizedTenantId
        || Date.parse(invitation.expires_at) <= now
        || !hashesEqual(invitation.token_hash, presentedHash)
      ) {
        throw new AuthenticationError('Invalid or expired device invitation');
      }
      const wrappedVaultKey = Buffer.from(invitation.wrapped_vault_key);
      // The browser is already authenticated as a tenant member. Consume only
      // the key envelope and do not mint or persist a browser device token.
      database.prepare('DELETE FROM invitations WHERE id = ?').run(invitation.id);
      return Object.freeze({
        invitationId: invitation.id,
        tenantId: invitation.tenant_id,
        wrappedVaultKey,
      });
    });
  }

  async enrollmentStatus(tenantId, enrollmentId) {
    const normalizedTenantId = assertOpaqueId(tenantId, 'tenant id');
    const normalizedEnrollmentId = assertOpaqueId(enrollmentId, 'enrollment id');
    const database = this.getDatabase();
    const enrollment = database.prepare(`
      SELECT * FROM enrollments WHERE id = ? AND tenant_id = ?
    `).get(normalizedEnrollmentId, normalizedTenantId);
    if (!enrollment) return null;
    const device = enrollment.used_at
      ? database.prepare(`
          SELECT * FROM devices
          WHERE tenant_id = ? AND created_at = ?
          ORDER BY rowid DESC LIMIT 1
        `).get(normalizedTenantId, enrollment.used_at)
      : null;
    return Object.freeze({
      id: enrollment.id,
      tenantId: enrollment.tenant_id,
      createdAt: enrollment.created_at,
      expiresAt: enrollment.expires_at,
      usedAt: enrollment.used_at,
      consumed: Boolean(enrollment.used_at),
      expired: Date.parse(enrollment.expires_at) <= this.clock(),
      device: device ? publicDevice(device) : null,
    });
  }

  async authenticateDevice(deviceToken) {
    if (typeof deviceToken !== 'string' || !/^hndd_[A-Za-z0-9_-]{40,64}$/.test(deviceToken)) {
      throw new AuthenticationError();
    }
    const presentedHash = tokenHash(deviceToken);
    const database = this.getDatabase();
    pruneExpiredInvitations(database, this.clock());
    const device = database.prepare('SELECT * FROM devices').all()
      .find((candidate) => hashesEqual(candidate.token_hash, presentedHash));
    if (!device || device.revoked_at) throw new AuthenticationError();
    return publicDevice(device);
  }

  async listDevices(tenantId) {
    const normalizedTenantId = assertOpaqueId(tenantId, 'tenant id');
    const database = this.getDatabase();
    pruneExpiredInvitations(database, this.clock());
    return database.prepare(`
      SELECT * FROM devices WHERE tenant_id = ? ORDER BY created_at, rowid
    `).all(normalizedTenantId).map(publicDevice);
  }

  async renameDevice(tenantId, deviceId, deviceName) {
    const normalizedTenantId = assertOpaqueId(tenantId, 'tenant id');
    const normalizedDeviceId = assertOpaqueId(deviceId, 'device id');
    if (typeof deviceName !== 'string' || deviceName.trim().length === 0) {
      throw new Error('Invalid device name');
    }
    const name = normalizeDeviceName(deviceName);
    const database = this.getDatabase();
    return withImmediateTransaction(database, () => {
      const result = database.prepare(`
        UPDATE devices SET name = ?
        WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL
      `).run(name, normalizedDeviceId, normalizedTenantId);
      if (Number(result.changes) !== 1) return null;
      return publicDevice(database.prepare(`
        SELECT * FROM devices WHERE id = ? AND tenant_id = ?
      `).get(normalizedDeviceId, normalizedTenantId));
    });
  }

  async revokeDevice(tenantId, deviceId) {
    const normalizedTenantId = assertOpaqueId(tenantId, 'tenant id');
    const normalizedDeviceId = assertOpaqueId(deviceId, 'device id');
    const database = this.getDatabase();
    return withImmediateTransaction(database, () => {
      const device = database.prepare(`
        SELECT revoked_at FROM devices WHERE id = ? AND tenant_id = ?
      `).get(normalizedDeviceId, normalizedTenantId);
      if (!device) return false;
      if (!device.revoked_at) {
        database.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(
          new Date(this.clock()).toISOString(),
          normalizedDeviceId,
        );
      }
      return true;
    });
  }
}

async function readLegacyTenant(tenantsDirectory, entry, maxBlobBytes) {
  if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
  let tenantId;
  try {
    tenantId = assertOpaqueId(entry.name, 'tenant id');
  } catch {
    return null;
  }
  const tenantDirectory = safeJoin(tenantsDirectory, tenantId);
  const revisionsDirectory = safeJoin(tenantDirectory, 'revisions');
  const revisions = new Map();
  let entries = [];
  try {
    entries = await readdir(revisionsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const revisionEntry of entries) {
    const match = /^([a-f0-9]{64})\.bin$/.exec(revisionEntry.name);
    if (!match || !revisionEntry.isFile() || revisionEntry.isSymbolicLink()) continue;
    const revisionPath = safeJoin(revisionsDirectory, revisionEntry.name);
    const blob = await readFileLimited(revisionPath, maxBlobBytes);
    if (createStrongEtag(blob) !== `"${match[1]}"`) {
      throw new Error('Stored revision digest does not match its filename');
    }
    const metadata = await lstat(revisionPath);
    revisions.set(match[1], {
      id: match[1],
      blob,
      createdAt: metadata.birthtime.toISOString(),
    });
  }
  let currentRevisionId = null;
  const snapshotPath = safeJoin(tenantDirectory, 'snapshot.bin');
  try {
    const blob = await readFileLimited(snapshotPath, maxBlobBytes);
    currentRevisionId = createStrongEtag(blob).slice(1, -1);
    if (!revisions.has(currentRevisionId)) {
      const metadata = await lstat(snapshotPath);
      revisions.set(currentRevisionId, {
        id: currentRevisionId,
        blob,
        createdAt: metadata.birthtime.toISOString(),
      });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { tenantId, currentRevisionId, revisions: [...revisions.values()] };
}

function pruneRevisions(database, tenantId, nextRevisionId, previousRevisionId, maximum) {
  const revisions = database.prepare(`
    SELECT id, created_at FROM revisions WHERE tenant_id = ?
  `).all(tenantId);
  const retentionRank = (revision) => {
    if (revision.id === nextRevisionId) return 0;
    if (revision.id === previousRevisionId) return 1;
    return 2;
  };
  revisions.sort((left, right) => (
    retentionRank(left) - retentionRank(right)
    || right.created_at.localeCompare(left.created_at)
    || left.id.localeCompare(right.id)
  ));
  const remove = database.prepare('DELETE FROM revisions WHERE tenant_id = ? AND id = ?');
  for (const revision of revisions.slice(maximum)) remove.run(tenantId, revision.id);
}

export class SnapshotStore extends SqliteStoreBase {
  constructor(dataDirectory, options = {}) {
    super(dataDirectory);
    this.serverMasterKeyPath = safeJoin(
      this.dataDirectory,
      options.serverMasterKeyFilename ?? DEFAULT_SERVER_MASTER_KEY_FILENAME,
    );
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    this.maxRevisionsPerTenant = options.maxRevisionsPerTenant
      ?? DEFAULT_MAX_REVISIONS_PER_TENANT;
    this.clock = options.clock ?? (() => Date.now());
    if (!Number.isSafeInteger(this.maxBlobBytes) || this.maxBlobBytes < 1) {
      throw new Error('maxBlobBytes must be a positive safe integer');
    }
    if (
      !Number.isSafeInteger(this.maxRevisionsPerTenant)
      || this.maxRevisionsPerTenant < 1
      || this.maxRevisionsPerTenant > 10_000
    ) {
      throw new Error('maxRevisionsPerTenant must be an integer from 1 to 10000');
    }
  }

  async init() {
    const database = await this.initDatabase();
    initializeManagedVaultKeySchema(database);
    const masterKey = await ensureServerMasterKey(this.serverMasterKeyPath, database);
    try {
      for (const row of database.prepare(`
        SELECT tenant_id, key_envelope FROM managed_vault_keys ORDER BY tenant_id
      `).all()) {
        const vaultKey = unwrapManagedVaultKey(row.key_envelope, masterKey, row.tenant_id);
        vaultKey.fill(0);
      }
      bindServerMasterKeyDigest(database, masterKey);
    } finally {
      masterKey.fill(0);
    }
    if (!hasMetadata(database, 'legacy_snapshots_imported')) {
      const tenantsDirectory = safeJoin(this.dataDirectory, 'tenants');
      let tenantEntries = [];
      try {
        tenantEntries = await readdir(tenantsDirectory, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      for (const entry of tenantEntries) {
        const tenant = await readLegacyTenant(tenantsDirectory, entry, this.maxBlobBytes);
        if (!tenant) continue;
        withImmediateTransaction(database, () => this.#importLegacyTenant(database, tenant));
      }
      withImmediateTransaction(database, () => setMetadata(database, 'legacy_snapshots_imported'));
    }
    return this;
  }

  async #runtimeMasterKey() {
    try {
      return await readVerifiedServerMasterKey(
        this.serverMasterKeyPath,
        this.getDatabase(),
      );
    } catch (cause) {
      const error = new ManagedVaultKeyError(
        'vault_key_service_unavailable',
        'The account-managed vault key service is unavailable.',
        503,
      );
      error.cause = cause;
      throw error;
    }
  }

  async assertServerMasterKeyHealthy() {
    const masterKey = await readVerifiedServerMasterKey(
      this.serverMasterKeyPath,
      this.getDatabase(),
    );
    try {
      for (const row of this.getDatabase().prepare(`
        SELECT tenant_id, key_envelope FROM managed_vault_keys ORDER BY tenant_id
      `).all()) {
        const vaultKey = unwrapManagedVaultKey(
          row.key_envelope,
          masterKey,
          row.tenant_id,
        );
        vaultKey.fill(0);
      }
      return true;
    } finally {
      masterKey.fill(0);
    }
  }

  async managedVaultKeyStatus(tenantId) {
    const safeTenantId = assertOpaqueId(tenantId, 'tenant id');
    const masterKey = await this.#runtimeMasterKey();
    try {
      const row = this.getDatabase().prepare(`
        SELECT key_envelope FROM managed_vault_keys WHERE tenant_id = ?
      `).get(safeTenantId);
      if (!row) return false;
      const vaultKey = unwrapManagedVaultKey(row.key_envelope, masterKey, safeTenantId);
      vaultKey.fill(0);
      return true;
    } catch (cause) {
      if (cause instanceof ManagedVaultKeyError) throw cause;
      const error = new ManagedVaultKeyError(
        'vault_key_service_unavailable',
        'The account-managed vault key service is unavailable.',
        503,
      );
      error.cause = cause;
      throw error;
    } finally {
      masterKey.fill(0);
    }
  }

  hasManagedVaultKey(tenantId) {
    const safeTenantId = assertOpaqueId(tenantId, 'tenant id');
    return this.getDatabase().prepare(`
      SELECT 1 AS present FROM managed_vault_keys WHERE tenant_id = ?
    `).get(safeTenantId) !== undefined;
  }

  async adoptManagedVaultKey(tenantId, vaultKey) {
    const safeTenantId = assertOpaqueId(tenantId, 'tenant id');
    const candidate = Buffer.isBuffer(vaultKey)
      ? Buffer.from(vaultKey)
      : Buffer.from(vaultKey ?? []);
    if (candidate.byteLength !== VAULT_KEY_BYTES) {
      candidate.fill(0);
      throw new ManagedVaultKeyError(
        'invalid_vault_key',
        'Vault key must be exactly 32 bytes.',
        400,
      );
    }
    let masterKey;
    try {
      masterKey = await this.#runtimeMasterKey();
      return withImmediateTransaction(this.getDatabase(), () => {
        const current = this.getDatabase().prepare(`
          SELECT revisions.blob
          FROM snapshots
          JOIN revisions
            ON revisions.tenant_id = snapshots.tenant_id
            AND revisions.id = snapshots.revision_id
          WHERE snapshots.tenant_id = ?
        `).get(safeTenantId);
        if (!current) {
          throw new ManagedVaultKeyError(
            'vault_not_initialized',
            'Initialize the vault before adopting its key.',
          );
        }
        validateSnapshotWithVaultKey(Buffer.from(current.blob), candidate);

        const existing = this.getDatabase().prepare(`
          SELECT key_envelope FROM managed_vault_keys WHERE tenant_id = ?
        `).get(safeTenantId);
        if (existing) {
          const storedKey = unwrapManagedVaultKey(existing.key_envelope, masterKey, safeTenantId);
          try {
            if (
              storedKey.byteLength === candidate.byteLength
              && timingSafeEqual(storedKey, candidate)
            ) {
              return Object.freeze({ created: false, keyManaged: true });
            }
          } finally {
            storedKey.fill(0);
          }
          throw new ManagedVaultKeyError(
            'vault_key_already_managed',
            'This vault already has a different account-managed key.',
          );
        }

        const now = new Date(this.clock()).toISOString();
        const keyEnvelope = wrapManagedVaultKey(candidate, masterKey, safeTenantId);
        try {
          this.getDatabase().prepare(`
            INSERT INTO managed_vault_keys
              (tenant_id, key_envelope, created_at, updated_at)
            VALUES (?, ?, ?, ?)
          `).run(safeTenantId, keyEnvelope, now, now);
        } finally {
          keyEnvelope.fill(0);
        }
        return Object.freeze({ created: true, keyManaged: true });
      });
    } finally {
      candidate.fill(0);
      masterKey?.fill(0);
    }
  }

  async unlockManagedVaultKey(tenantId) {
    const safeTenantId = assertOpaqueId(tenantId, 'tenant id');
    const row = this.getDatabase().prepare(`
      SELECT key_envelope FROM managed_vault_keys WHERE tenant_id = ?
    `).get(safeTenantId);
    if (!row) {
      throw new ManagedVaultKeyError(
        'legacy_vault_key_unavailable',
        'This legacy vault key has not been adopted by the account yet.',
      );
    }
    const masterKey = await this.#runtimeMasterKey();
    try {
      return unwrapManagedVaultKey(row.key_envelope, masterKey, safeTenantId);
    } finally {
      masterKey.fill(0);
    }
  }

  async createManagedDeviceInvitation(tenantId, options = {}) {
    const safeTenantId = assertOpaqueId(tenantId, 'tenant id');
    const ttlMs = options.ttlMs ?? DEFAULT_ENROLLMENT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 7 * 24 * 60 * 60 * 1000) {
      throw new Error('Invitation TTL must be between one second and seven days');
    }
    const masterKey = await this.#runtimeMasterKey();
    const connectionSecret = randomBytes(VAULT_KEY_BYTES);
    let completed = false;
    try {
      const issued = withImmediateTransaction(this.getDatabase(), () => {
        const database = this.getDatabase();
        const now = this.clock();
        pruneExpiredInvitations(database, now);
        const managed = database.prepare(`
          SELECT key_envelope FROM managed_vault_keys WHERE tenant_id = ?
        `).get(safeTenantId);
        if (!managed) {
          throw new ManagedVaultKeyError(
            'legacy_vault_key_unavailable',
            'This legacy vault key has not been adopted by the account yet.',
          );
        }
        const vaultKey = unwrapManagedVaultKey(
          managed.key_envelope,
          masterKey,
          safeTenantId,
        );
        let wrappedVaultKey;
        try {
          wrappedVaultKey = encryptBytes(vaultKey, connectionSecret, { maxBytes: VAULT_KEY_BYTES });
          const invitationToken = randomToken('hndi_');
          const invitation = {
            id: randomUUID(),
            tokenHash: tokenHash(invitationToken),
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + ttlMs).toISOString(),
          };
          database.prepare(`
            INSERT INTO invitations
              (id, tenant_id, token_hash, wrapped_vault_key, created_at, expires_at, used_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
          `).run(
            invitation.id,
            safeTenantId,
            invitation.tokenHash,
            wrappedVaultKey,
            invitation.createdAt,
            invitation.expiresAt,
          );
          return Object.freeze({
            invitationToken,
            invitationId: invitation.id,
            tenantId: safeTenantId,
            expiresAt: invitation.expiresAt,
          });
        } finally {
          wrappedVaultKey?.fill(0);
          vaultKey.fill(0);
        }
      });
      completed = true;
      return Object.freeze({ ...issued, connectionSecret });
    } finally {
      if (!completed) connectionSecret.fill(0);
      masterKey.fill(0);
    }
  }

  #importLegacyTenant(database, tenant) {
    const oldest = tenant.revisions.reduce(
      (selected, revision) => selected === null || revision.createdAt < selected
        ? revision.createdAt
        : selected,
      null,
    ) ?? new Date(this.clock()).toISOString();
    ensureTenant(database, tenant.tenantId, oldest);
    const insert = database.prepare(`
      INSERT OR IGNORE INTO revisions (tenant_id, id, blob, bytes, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const revision of tenant.revisions) {
      insert.run(
        tenant.tenantId,
        revision.id,
        revision.blob,
        revision.blob.byteLength,
        revision.createdAt,
      );
    }
    if (tenant.currentRevisionId) {
      database.prepare(`
        INSERT OR IGNORE INTO snapshots (tenant_id, revision_id, updated_at)
        VALUES (?, ?, ?)
      `).run(tenant.tenantId, tenant.currentRevisionId, new Date(this.clock()).toISOString());
      const current = database.prepare('SELECT revision_id FROM snapshots WHERE tenant_id = ?')
        .get(tenant.tenantId)?.revision_id;
      pruneRevisions(database, tenant.tenantId, current, null, this.maxRevisionsPerTenant);
    }
  }

  #validatedRevision(database, tenantId, revisionId) {
    const row = database.prepare(`
      SELECT blob FROM revisions WHERE tenant_id = ? AND id = ?
    `).get(tenantId, revisionId);
    if (!row) return null;
    const blob = Buffer.from(row.blob);
    if (blob.byteLength > this.maxBlobBytes) throw new Error('Stored revision exceeds server limit');
    const etag = createStrongEtag(blob);
    if (etag !== `"${revisionId}"`) {
      throw new Error('Stored revision digest does not match its id');
    }
    return Object.freeze({ blob, etag, revisionId });
  }

  async get(tenantId) {
    const safeTenantId = assertOpaqueId(tenantId, 'tenant id');
    const database = this.getDatabase();
    const current = database.prepare('SELECT revision_id FROM snapshots WHERE tenant_id = ?')
      .get(safeTenantId);
    if (!current) return null;
    const revision = this.#validatedRevision(database, safeTenantId, current.revision_id);
    if (!revision) throw new Error('Current snapshot points to a missing revision');
    return Object.freeze({ blob: revision.blob, etag: revision.etag });
  }

  async getRevision(tenantId, revisionId) {
    const safeTenantId = assertOpaqueId(tenantId, 'tenant id');
    const safeRevisionId = assertOpaqueId(revisionId, 'revision id');
    if (!/^[a-f0-9]{64}$/.test(safeRevisionId)) throw new Error('Invalid revision id');
    return this.#validatedRevision(this.getDatabase(), safeTenantId, safeRevisionId);
  }

  async listRevisions(tenantId) {
    const safeTenantId = assertOpaqueId(tenantId, 'tenant id');
    return this.getDatabase().prepare(`
      SELECT
        revisions.id,
        revisions.bytes,
        revisions.created_at,
        revisions.id = snapshots.revision_id AS current
      FROM revisions
      LEFT JOIN snapshots ON snapshots.tenant_id = revisions.tenant_id
      WHERE revisions.tenant_id = ?
      ORDER BY revisions.created_at DESC, revisions.id
    `).all(safeTenantId).map((revision) => Object.freeze({
      id: revision.id,
      etag: `"${revision.id}"`,
      bytes: Number(revision.bytes),
      createdAt: revision.created_at,
      current: Boolean(revision.current),
    }));
  }

  async putConditional(tenantId, blob, conditions = {}) {
    const safeTenantId = assertOpaqueId(tenantId, 'tenant id');
    const contents = Buffer.isBuffer(blob) ? Buffer.from(blob) : Buffer.from(blob ?? []);
    if (contents.byteLength === 0) throw new Error('Encrypted snapshot blob must not be empty');
    if (contents.byteLength > this.maxBlobBytes) {
      throw new RangeError(`Encrypted snapshot exceeds ${this.maxBlobBytes} byte limit`);
    }
    if (conditions.ifMatch !== undefined && conditions.ifNoneMatch !== undefined) {
      throw new Error('If-Match and If-None-Match cannot be combined');
    }

    const database = this.getDatabase();
    const masterKey = conditions.requireManagedKey === true
      ? await this.#runtimeMasterKey()
      : null;
    try {
      return withImmediateTransaction(database, () => {
        if (conditions.requireManagedKey === true) {
          const managed = database.prepare(`
            SELECT key_envelope FROM managed_vault_keys WHERE tenant_id = ?
          `).get(safeTenantId);
          if (!managed) {
            throw new ManagedVaultKeyError(
              'legacy_vault_key_unavailable',
              'Adopt or initialize the account-managed vault key before saving changes.',
            );
          }
          const vaultKey = unwrapManagedVaultKey(
            managed.key_envelope,
            masterKey,
            safeTenantId,
          );
          try {
            validateSnapshotWithVaultKey(contents, vaultKey);
          } catch (error) {
            if (error instanceof ManagedVaultKeyError && error.code === 'invalid_vault_key') {
              throw new ManagedVaultKeyError(
                'invalid_snapshot',
                'The encrypted snapshot is not valid for this account-managed vault.',
                400,
              );
            }
            throw error;
          } finally {
            vaultKey.fill(0);
          }
        }
      const currentRow = database.prepare(`
        SELECT revisions.id, revisions.blob
        FROM snapshots
        JOIN revisions
          ON revisions.tenant_id = snapshots.tenant_id
          AND revisions.id = snapshots.revision_id
        WHERE snapshots.tenant_id = ?
      `).get(safeTenantId);
      const current = currentRow
        ? { etag: `"${currentRow.id}"`, blob: Buffer.from(currentRow.blob) }
        : null;
      if (current) {
        if (conditions.ifNoneMatch !== undefined) {
          const parsed = parseEntityTags(conditions.ifNoneMatch);
          if (!parsed.wildcard) throw new Error('Snapshot creation only supports If-None-Match: *');
          throw new PreconditionFailedError('Snapshot already exists', current.etag);
        }
        if (conditions.ifMatch === undefined) {
          throw new PreconditionRequiredError('If-Match is required to replace a snapshot', current.etag);
        }
        if (!strongEtagMatches(conditions.ifMatch, current.etag, true)) {
          throw new PreconditionFailedError('Snapshot has changed', current.etag);
        }
      } else {
        if (conditions.ifMatch !== undefined) {
          parseEntityTags(conditions.ifMatch);
          throw new PreconditionFailedError('Snapshot does not exist');
        }
        if (conditions.ifNoneMatch === undefined) {
          throw new PreconditionRequiredError('If-None-Match: * is required to create a snapshot');
        }
        const parsed = parseEntityTags(conditions.ifNoneMatch);
        if (!parsed.wildcard) {
          throw new PreconditionRequiredError('If-None-Match: * is required to create a snapshot');
        }
      }

      const now = new Date(this.clock()).toISOString();
      ensureTenant(database, safeTenantId, now);
      const nextEtag = createStrongEtag(contents);
      const revisionId = nextEtag.slice(1, -1);
      const existing = database.prepare(`
        SELECT blob FROM revisions WHERE tenant_id = ? AND id = ?
      `).get(safeTenantId, revisionId);
      if (existing && !Buffer.from(existing.blob).equals(contents)) {
        throw new Error('Revision digest collision detected');
      }
      if (!existing) {
        database.prepare(`
          INSERT INTO revisions (tenant_id, id, blob, bytes, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(safeTenantId, revisionId, contents, contents.byteLength, now);
      }
      database.prepare(`
        INSERT INTO snapshots (tenant_id, revision_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET
          revision_id = excluded.revision_id,
          updated_at = excluded.updated_at
      `).run(safeTenantId, revisionId, now);
      pruneRevisions(
        database,
        safeTenantId,
        revisionId,
        current?.etag.slice(1, -1),
        this.maxRevisionsPerTenant,
      );
        return Object.freeze({
          created: current === null,
          etag: nextEtag,
          revisionId,
        });
      });
    } finally {
      masterKey?.fill(0);
    }
  }

  async resetVault(tenantId, blob, conditions = {}) {
    const safeTenantId = assertOpaqueId(tenantId, 'tenant id');
    const contents = Buffer.isBuffer(blob) ? Buffer.from(blob) : Buffer.from(blob ?? []);
    if (contents.byteLength === 0) throw new Error('Encrypted snapshot blob must not be empty');
    if (contents.byteLength > this.maxBlobBytes) {
      throw new RangeError(`Encrypted snapshot exceeds ${this.maxBlobBytes} byte limit`);
    }

    const database = this.getDatabase();
    return withImmediateTransaction(database, () => {
      const currentRow = database.prepare(`
        SELECT revisions.id
        FROM snapshots
        JOIN revisions
          ON revisions.tenant_id = snapshots.tenant_id
          AND revisions.id = snapshots.revision_id
        WHERE snapshots.tenant_id = ?
      `).get(safeTenantId);
      const currentEtag = currentRow ? `"${currentRow.id}"` : null;
      if (conditions.ifMatch === undefined) {
        throw new PreconditionRequiredError(
          'If-Match is required to reset a vault',
          currentEtag,
        );
      }
      if (!currentRow) {
        throw new VaultResetError(
          'vault_not_initialized',
          'The vault has not been initialized. Use vault initialization instead of reset.',
        );
      }

      const parsedIfMatch = parseEntityTags(conditions.ifMatch);
      if (parsedIfMatch.wildcard || !strongEtagMatches(parsedIfMatch, currentEtag, true)) {
        throw new PreconditionFailedError('Snapshot has changed', currentEtag);
      }

      if (conditions.requireUnmanagedKey === true) {
        const managedKey = database.prepare(`
          SELECT 1
          FROM managed_vault_keys
          WHERE tenant_id = ?
        `).get(safeTenantId);
        if (managedKey) {
          throw new VaultResetError(
            'vault_already_managed',
            'Account-managed vaults cannot be reset through legacy recovery.',
            { currentEtag },
          );
        }
      }

      const activeDeviceCount = Number(database.prepare(`
        SELECT count(*) AS count
        FROM devices
        WHERE tenant_id = ? AND revoked_at IS NULL
      `).get(safeTenantId).count);
      if (activeDeviceCount > 0) {
        throw new VaultResetError(
          'active_devices_present',
          'Revoke every active device before resetting the vault.',
          { currentEtag, activeDeviceCount },
        );
      }

      const now = new Date(this.clock()).toISOString();
      const nextEtag = createStrongEtag(contents);
      const revisionId = nextEtag.slice(1, -1);
      const existing = database.prepare(`
        SELECT blob FROM revisions WHERE tenant_id = ? AND id = ?
      `).get(safeTenantId, revisionId);
      if (existing && !Buffer.from(existing.blob).equals(contents)) {
        throw new Error('Revision digest collision detected');
      }
      if (!existing) {
        database.prepare(`
          INSERT INTO revisions (tenant_id, id, blob, bytes, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(safeTenantId, revisionId, contents, contents.byteLength, now);
      }
      database.prepare(`
        UPDATE snapshots
        SET revision_id = ?, updated_at = ?
        WHERE tenant_id = ?
      `).run(revisionId, now, safeTenantId);

      database.prepare('DELETE FROM invitations WHERE tenant_id = ?').run(safeTenantId);
      database.prepare('DELETE FROM managed_vault_keys WHERE tenant_id = ?').run(safeTenantId);
      // Consumed enrollments are immutable audit records and cannot mint another
      // device token. Only still-usable enrollment grants are invalidated here.
      database.prepare(`
        DELETE FROM enrollments WHERE tenant_id = ? AND used_at IS NULL
      `).run(safeTenantId);
      database.prepare(`
        DELETE FROM revisions WHERE tenant_id = ? AND id <> ?
      `).run(safeTenantId, revisionId);

      return Object.freeze({ etag: nextEtag, revisionId });
    });
  }
}
