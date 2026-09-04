import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ensurePrivateDirectory,
  ensurePrivatePermissions,
  safeJoin,
} from '../sync/io.mjs';

export const ACCOUNT_SCHEMA_VERSION = 3;
export const DEFAULT_ACCOUNT_DATABASE_FILENAME = 'hnd.sqlite';
export const DEFAULT_ACCOUNT_CODE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BOOTSTRAP_CODE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_WEBAUTHN_FLOW_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_RECOVERY_SESSION_TTL_MS = 15 * 60 * 1000;

const DATABASE_APPLICATION_ID = 0x484e4401;
const CORE_DATABASE_SCHEMA_VERSION = 1;
const ACCOUNT_SCHEMA_METADATA_KEY = 'account_schema_version';
const SERVER_OWNER_METADATA_KEY = 'web_server_owner_user_id';
const TOKEN_BYTES = 32;
const WEBAUTHN_USER_ID_BYTES = 32;
const MAX_CREDENTIAL_ID_LENGTH = 1024;
const MAX_CREDENTIAL_PUBLIC_KEY_BYTES = 16 * 1024;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_PASSKEY_LABEL_LENGTH = 80;
const SESSION_TOKEN_PREFIX = 'hnds_';
const CSRF_TOKEN_PREFIX = 'hndc_';
const FLOW_TOKEN_PREFIX = 'hndf_';
const ACCOUNT_CODE_PREFIX = 'hnda_';
const RECOVERY_CODE_PREFIX = 'hndr_';
const RECOVERY_CONFIRMATION_PREFIX = 'hndrc_';
const RECOVERY_CONFIRMATION_METADATA_PREFIX = 'web_recovery_codes_confirmed:';
const ACCOUNT_CODE_PATTERN = /^hnda_[A-Za-z0-9_-]{40,64}$/;
const FLOW_TOKEN_PATTERN = /^hndf_[A-Za-z0-9_-]{40,64}$/;
const SESSION_TOKEN_PATTERN = /^hnds_[A-Za-z0-9_-]{40,64}$/;
const CSRF_TOKEN_PATTERN = /^hndc_[A-Za-z0-9_-]{40,64}$/;
const RECOVERY_CODE_PATTERN = /^hndr_[A-Za-z0-9_-]{24,64}$/;
const RECOVERY_CONFIRMATION_PATTERN = /^hndrc_[A-Za-z0-9_-]{43}$/;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;
const TRANSPORTS = new Set([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);
const SIGNUP_MODES = new Set(['first-user', 'invite', 'open', 'disabled']);
const MEMBERSHIP_ROLES = new Set(['owner', 'admin', 'member']);
const ROLE_RANK = Object.freeze({ member: 1, admin: 2, owner: 3 });
const LANGUAGES = new Set(['auto', 'ko', 'en']);

const ACCOUNT_TABLE_COLUMNS = Object.freeze({
  users: Object.freeze([
    'id', 'username', 'display_name', 'language', 'webauthn_user_id', 'status', 'created_at', 'updated_at',
  ]),
  tenant_memberships: Object.freeze(['tenant_id', 'user_id', 'role', 'created_at']),
  passkey_credentials: Object.freeze([
    'id', 'user_id', 'public_key', 'counter', 'transports', 'device_type', 'backed_up',
    'label', 'created_at', 'last_used_at', 'revoked_at',
  ]),
  account_invites: Object.freeze([
    'id', 'token_hash', 'kind', 'tenant_id', 'role', 'created_by_user_id',
    'created_at', 'expires_at', 'used_at',
  ]),
  webauthn_flows: Object.freeze([
    'id', 'token_hash', 'type', 'challenge', 'user_id', 'session_id', 'invite_id', 'signup_policy',
    'pending_username', 'pending_display_name', 'pending_webauthn_user_id',
    'pending_tenant_id', 'pending_role', 'created_at', 'expires_at', 'used_at',
  ]),
  passkey_registration_flows: Object.freeze([
    'id', 'token_hash', 'challenge', 'user_id', 'session_id', 'label',
    'created_at', 'expires_at', 'used_at',
  ]),
  web_sessions: Object.freeze([
    'id', 'token_hash', 'csrf_hash', 'user_id', 'active_tenant_id', 'created_at',
    'last_seen_at', 'idle_expires_at', 'absolute_expires_at', 'reauthenticated_at',
    'recovery_required', 'revoked_at',
  ]),
  account_recovery_codes: Object.freeze([
    'id', 'user_id', 'token_hash', 'created_at', 'used_at',
  ]),
});

export class AccountStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AccountStoreError';
    this.code = code;
    this.statusCode = options.statusCode ?? 400;
  }
}

function accountError(code, message, statusCode = 400) {
  return new AccountStoreError(code, message, { statusCode });
}

function normalizeLanguage(value) {
  const language = String(value ?? 'auto').trim().toLowerCase();
  if (!LANGUAGES.has(language)) {
    throw accountError('invalid_language', 'Language must be auto, ko, or en.');
  }
  return language;
}

function randomToken(prefix) {
  return `${prefix}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function hashesEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left || '') || !/^[a-f0-9]{64}$/.test(right || '')) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function recoveryConfirmationMetadataKey(userId) {
  return `${RECOVERY_CONFIRMATION_METADATA_PREFIX}${userId}`;
}

function recoveryConfirmationId(database, userId) {
  const rows = database.prepare(`
    SELECT token_hash
    FROM account_recovery_codes
    WHERE user_id = ? AND used_at IS NULL
    ORDER BY token_hash
  `).all(userId);
  if (rows.length === 0) return null;
  const digest = createHash('sha256');
  for (const row of rows) digest.update(`${row.token_hash}\n`, 'utf8');
  return `${RECOVERY_CONFIRMATION_PREFIX}${digest.digest('base64url')}`;
}

function isoTimestamp(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function assertTtl(value, label, maximum = 30 * 24 * 60 * 60 * 1000) {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > maximum) {
    throw new Error(`${label} must be between one second and ${maximum} milliseconds`);
  }
  return value;
}

function normalizeUsername(value) {
  const username = String(value ?? '').normalize('NFKC').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw accountError(
      'invalid_username',
      'Username must contain 3-32 lowercase letters, numbers, dots, underscores, or hyphens.',
    );
  }
  return username;
}

function normalizeDisplayName(value, username) {
  const displayName = String(value ?? username).normalize('NFC').trim();
  if (
    !displayName
    || displayName.length > MAX_DISPLAY_NAME_LENGTH
    || /[\u0000-\u001f\u007f]/.test(displayName)
  ) {
    throw accountError('invalid_display_name', `Display name must contain 1-${MAX_DISPLAY_NAME_LENGTH} characters.`);
  }
  return displayName;
}

function normalizePasskeyLabel(value) {
  if (value === undefined || value === null || value === '') return null;
  const label = String(value).normalize('NFC').trim();
  if (!label || label.length > MAX_PASSKEY_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(label)) {
    throw accountError('invalid_passkey', 'Invalid passkey label.');
  }
  return label;
}

function normalizeSignupMode(value) {
  const requested = String(value ?? 'open');
  const mode = requested === 'closed' ? 'disabled' : requested;
  if (!SIGNUP_MODES.has(mode)) throw new Error(`Unsupported signup mode: ${mode}`);
  return mode;
}

function normalizeRole(value = 'member') {
  const role = String(value);
  if (!MEMBERSHIP_ROLES.has(role)) throw new Error(`Unsupported membership role: ${role}`);
  return role;
}

function normalizeWebAuthnUserId(value) {
  const userId = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value ?? []);
  if (userId.byteLength !== WEBAUTHN_USER_ID_BYTES) {
    throw accountError('invalid_passkey', `WebAuthn user ID must contain ${WEBAUTHN_USER_ID_BYTES} bytes.`);
  }
  return userId;
}

function normalizeCredential(value) {
  const id = String(value?.id ?? '');
  if (!CREDENTIAL_ID_PATTERN.test(id) || id.length > MAX_CREDENTIAL_ID_LENGTH) {
    throw accountError('invalid_passkey', 'Invalid passkey credential ID.');
  }
  const publicKey = Buffer.isBuffer(value.publicKey)
    ? Buffer.from(value.publicKey)
    : Buffer.from(value.publicKey ?? []);
  if (publicKey.byteLength < 1 || publicKey.byteLength > MAX_CREDENTIAL_PUBLIC_KEY_BYTES) {
    throw accountError('invalid_passkey', 'Invalid passkey public key.');
  }
  const counter = Number(value.counter);
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw accountError('invalid_passkey', 'Invalid passkey signature counter.');
  }
  const transports = [...new Set(value.transports ?? [])];
  if (transports.some((transport) => !TRANSPORTS.has(transport))) {
    throw accountError('invalid_passkey', 'Invalid passkey transport.');
  }
  const deviceType = value.deviceType ?? 'singleDevice';
  if (!['singleDevice', 'multiDevice'].includes(deviceType)) {
    throw accountError('invalid_passkey', 'Invalid passkey device type.');
  }
  return Object.freeze({
    id,
    publicKey,
    counter,
    transports,
    deviceType,
    backedUp: Boolean(value.backedUp),
    label: normalizePasskeyLabel(value.label),
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

function publicUser(row) {
  return Object.freeze({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    language: row.language ?? 'auto',
    status: row.status,
    webauthnUserId: Buffer.from(row.webauthn_user_id).toString('base64url'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function publicMembership(row) {
  return Object.freeze({
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
  });
}

function publicPasskey(row) {
  return Object.freeze({
    id: row.id,
    userId: row.user_id,
    publicKey: Buffer.from(row.public_key),
    counter: Number(row.counter),
    transports: Object.freeze(JSON.parse(row.transports)),
    deviceType: row.device_type,
    backedUp: Boolean(row.backed_up),
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  });
}

function publicSession(row) {
  return Object.freeze({
    id: row.id,
    userId: row.user_id,
    activeTenantId: row.active_tenant_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    reauthenticatedAt: row.reauthenticated_at,
    recoveryRequired: Boolean(row.recovery_required),
  });
}

function publicAccountInvite(row, now = Date.now()) {
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    tenantId: row.tenant_id,
    role: row.role,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    expired: Date.parse(row.expires_at) <= now,
  });
}

function validateCoreSchema(database) {
  const applicationId = Number(database.prepare('PRAGMA application_id').get().application_id);
  const version = Number(database.prepare('PRAGMA user_version').get().user_version);
  if (applicationId !== DATABASE_APPLICATION_ID || version !== CORE_DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `Account store requires hnd database schema ${CORE_DATABASE_SCHEMA_VERSION}; initialize the sync store first.`,
    );
  }
  for (const table of ['schema_metadata', 'tenants']) {
    const present = database.prepare(`
      SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?
    `).get(table);
    if (!present) throw new Error(`Account store requires core table: ${table}`);
  }
}

function validateAccountSchema(database) {
  for (const [table, requiredColumns] of Object.entries(ACCOUNT_TABLE_COLUMNS)) {
    const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    for (const column of requiredColumns) {
      if (!columns.has(column)) throw new Error(`Account table ${table} is missing required column ${column}`);
    }
  }
}

function initializeAccountSchema(database) {
  validateCoreSchema(database);
  withImmediateTransaction(database, () => {
    const existingMetadata = database.prepare('SELECT value FROM schema_metadata WHERE key = ?')
      .get(ACCOUNT_SCHEMA_METADATA_KEY);
    if (
      existingMetadata
      && !['1', '2', String(ACCOUNT_SCHEMA_VERSION)].includes(existingMetadata.value)
    ) {
      throw new Error(`Unsupported account schema version: ${existingMetadata.value}`);
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'auto' CHECK (language IN ('auto', 'ko', 'en')),
        webauthn_user_id BLOB NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tenant_memberships (
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, user_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS passkey_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL CHECK (counter >= 0),
        transports TEXT NOT NULL,
        device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
        backed_up INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
        label TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS account_invites (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'invite')),
        tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS webauthn_flows (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK (type IN ('signup', 'login', 'reauthenticate')),
        challenge TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES web_sessions(id) ON DELETE CASCADE,
        invite_id TEXT REFERENCES account_invites(id) ON DELETE CASCADE,
        signup_policy TEXT,
        pending_username TEXT,
        pending_display_name TEXT,
        pending_webauthn_user_id BLOB,
        pending_tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
        pending_role TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS web_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_hash TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        active_tenant_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        idle_expires_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        reauthenticated_at TEXT NOT NULL,
        recovery_required INTEGER NOT NULL DEFAULT 0 CHECK (recovery_required IN (0, 1)),
        revoked_at TEXT,
        FOREIGN KEY (active_tenant_id, user_id)
          REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS passkey_registration_flows (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        challenge TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE,
        label TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS account_recovery_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        used_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS tenant_memberships_user
        ON tenant_memberships(user_id, created_at, tenant_id);
      CREATE INDEX IF NOT EXISTS passkey_credentials_user
        ON passkey_credentials(user_id, created_at, id);
      CREATE INDEX IF NOT EXISTS account_invites_expires
        ON account_invites(expires_at, used_at);
      CREATE INDEX IF NOT EXISTS webauthn_flows_expires
        ON webauthn_flows(expires_at, used_at);
      CREATE INDEX IF NOT EXISTS passkey_registration_flows_expires
        ON passkey_registration_flows(expires_at, used_at);
      CREATE INDEX IF NOT EXISTS web_sessions_user
        ON web_sessions(user_id, revoked_at, absolute_expires_at);
      CREATE INDEX IF NOT EXISTS account_recovery_codes_user
        ON account_recovery_codes(user_id, used_at, created_at);
    `);
    const sessionColumns = new Set(database.prepare('PRAGMA table_info(web_sessions)')
      .all().map((row) => row.name));
    if (!sessionColumns.has('recovery_required')) {
      database.exec(`
        ALTER TABLE web_sessions
        ADD COLUMN recovery_required INTEGER NOT NULL DEFAULT 0
          CHECK (recovery_required IN (0, 1));
      `);
    }
    const webauthnFlowColumns = new Set(database.prepare('PRAGMA table_info(webauthn_flows)')
      .all().map((row) => row.name));
    if (!webauthnFlowColumns.has('session_id')) {
      database.exec(`
        ALTER TABLE webauthn_flows
        ADD COLUMN session_id TEXT REFERENCES web_sessions(id) ON DELETE CASCADE;
      `);
    }
    const userColumns = new Set(database.prepare('PRAGMA table_info(users)')
      .all().map((row) => row.name));
    if (!userColumns.has('language')) {
      database.exec(`
        ALTER TABLE users
        ADD COLUMN language TEXT NOT NULL DEFAULT 'auto'
          CHECK (language IN ('auto', 'ko', 'en'));
      `);
    }
    validateAccountSchema(database);
    database.prepare(`
      INSERT INTO schema_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(ACCOUNT_SCHEMA_METADATA_KEY, String(ACCOUNT_SCHEMA_VERSION));
    const owner = database.prepare('SELECT value FROM schema_metadata WHERE key = ?')
      .get(SERVER_OWNER_METADATA_KEY);
    if (!owner) {
      const firstUser = database.prepare(`
        SELECT id FROM users ORDER BY created_at, rowid LIMIT 1
      `).get();
      if (firstUser) {
        database.prepare('INSERT INTO schema_metadata (key, value) VALUES (?, ?)')
          .run(SERVER_OWNER_METADATA_KEY, firstUser.id);
      }
    }
  });
}

function translateConstraint(error, fallbackCode = 'account_conflict') {
  if (!String(error?.code || '').startsWith('ERR_SQLITE_CONSTRAINT')) throw error;
  throw accountError(fallbackCode, 'The account operation conflicted with another request.', 409);
}

export class AccountStore {
  constructor(dataDirectory, options = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.databasePath = safeJoin(this.dataDirectory, options.databaseFilename ?? DEFAULT_ACCOUNT_DATABASE_FILENAME);
    this.clock = options.clock ?? (() => Date.now());
    this.sessionIdleTtlMs = options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
    this.sessionAbsoluteTtlMs = options.sessionAbsoluteTtlMs ?? DEFAULT_SESSION_ABSOLUTE_TTL_MS;
    assertTtl(this.sessionIdleTtlMs, 'Session idle TTL');
    assertTtl(this.sessionAbsoluteTtlMs, 'Session absolute TTL', 365 * 24 * 60 * 60 * 1000);
    if (this.sessionIdleTtlMs > this.sessionAbsoluteTtlMs) {
      throw new Error('Session idle TTL must not exceed session absolute TTL');
    }
    this.database = null;
    this.initializing = null;
  }

  async init() {
    if (this.database) return this;
    if (!this.initializing) {
      this.initializing = (async () => {
        await ensurePrivateDirectory(this.dataDirectory);
        const metadata = await lstat(this.databasePath).catch((error) => {
          if (error?.code === 'ENOENT') {
            throw new Error('Account store requires an initialized hnd.sqlite database.');
          }
          throw error;
        });
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error('hnd database path is not a regular file');
        }
        const database = new DatabaseSync(this.databasePath);
        try {
          database.exec(`
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            PRAGMA journal_mode = DELETE;
            PRAGMA synchronous = FULL;
            PRAGMA secure_delete = ON;
            PRAGMA trusted_schema = OFF;
          `);
          initializeAccountSchema(database);
          database.enableLoadExtension(false);
          database.enableDefensive(true);
          await ensurePrivatePermissions(this.databasePath);
          this.database = database;
          this.#pruneExpired();
          return this;
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

  close() {
    if (!this.database) return;
    this.database.close();
    this.database = null;
  }

  getDatabase() {
    if (!this.database) throw new Error('Account store has not been initialized');
    return this.database;
  }

  #pruneExpired() {
    const now = isoTimestamp(this.clock());
    const database = this.getDatabase();
    database.prepare(`
      DELETE FROM webauthn_flows WHERE expires_at <= ? OR used_at IS NOT NULL
    `).run(now);
    database.prepare(`
      DELETE FROM passkey_registration_flows WHERE expires_at <= ? OR used_at IS NOT NULL
    `).run(now);
    database.prepare(`
      DELETE FROM account_invites WHERE expires_at <= ? AND used_at IS NULL
    `).run(now);
    database.prepare(`
      DELETE FROM web_sessions
      WHERE revoked_at IS NOT NULL OR idle_expires_at <= ? OR absolute_expires_at <= ?
    `).run(now, now);
  }

  userCount() {
    return Number(this.getDatabase().prepare('SELECT count(*) AS count FROM users').get().count);
  }

  signupStatus(mode = 'open') {
    const configuredMode = normalizeSignupMode(mode);
    const users = this.userCount();
    const effectiveMode = configuredMode === 'first-user' && users > 0 ? 'invite' : configuredMode;
    return Object.freeze({
      configuredMode,
      effectiveMode,
      allowed: effectiveMode !== 'disabled',
      requiresCode: effectiveMode === 'invite',
      codeKind: effectiveMode === 'invite' ? 'invite' : null,
    });
  }

  createBootstrapCode(options = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_BOOTSTRAP_CODE_TTL_MS;
    assertTtl(ttlMs, 'Bootstrap code TTL', 7 * 24 * 60 * 60 * 1000);
    const database = this.getDatabase();
    const code = randomToken(ACCOUNT_CODE_PREFIX);
    const now = this.clock();
    const createdAt = isoTimestamp(now);
    const expiresAt = isoTimestamp(now + ttlMs);
    return withImmediateTransaction(database, () => {
      if (Number(database.prepare('SELECT count(*) AS count FROM users').get().count) !== 0) {
        throw accountError('bootstrap_closed', 'The first owner has already been created.', 409);
      }
      let tenantId = options.tenantId ?? null;
      if (!tenantId) {
        const tenants = database.prepare('SELECT id FROM tenants ORDER BY created_at, rowid').all();
        if (tenants.length === 1) tenantId = tenants[0].id;
        else if (tenants.length > 1) {
          throw accountError(
            'tenant_required',
            'More than one tenant exists; select the tenant for the first web owner.',
            409,
          );
        }
      }
      if (tenantId && !database.prepare('SELECT 1 AS present FROM tenants WHERE id = ?').get(tenantId)) {
        throw accountError('tenant_not_found', 'The requested tenant does not exist.', 404);
      }
      database.prepare(`
        DELETE FROM account_invites WHERE kind = 'bootstrap' AND used_at IS NULL
      `).run();
      const id = randomUUID();
      database.prepare(`
        INSERT INTO account_invites
          (id, token_hash, kind, tenant_id, role, created_by_user_id, created_at, expires_at, used_at)
        VALUES (?, ?, 'bootstrap', ?, 'owner', NULL, ?, ?, NULL)
      `).run(id, tokenHash(code), tenantId, createdAt, expiresAt);
      return Object.freeze({ code, id, kind: 'bootstrap', tenantId, role: 'owner', expiresAt });
    });
  }

  createAccountInvite(options = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_ACCOUNT_CODE_TTL_MS;
    assertTtl(ttlMs, 'Account invite TTL');
    const tenantId = options.tenantId ?? null;
    const actorUserId = options.actorUserId ?? null;
    const role = normalizeRole(options.role ?? (tenantId ? 'member' : 'owner'));
    const database = this.getDatabase();
    const code = randomToken(ACCOUNT_CODE_PREFIX);
    const now = this.clock();
    const createdAt = isoTimestamp(now);
    const expiresAt = isoTimestamp(now + ttlMs);
    return withImmediateTransaction(database, () => {
      if (tenantId) {
        const tenant = database.prepare('SELECT 1 AS present FROM tenants WHERE id = ?').get(tenantId);
        if (!tenant) throw accountError('tenant_not_found', 'The requested tenant does not exist.', 404);
      }
      if (actorUserId) {
        if (!tenantId) {
          throw accountError('forbidden', 'A web account may only invite users to one of its tenants.', 403);
        }
        const membership = database.prepare(`
          SELECT role FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?
        `).get(tenantId, actorUserId);
        if (!membership || ROLE_RANK[membership.role] < ROLE_RANK.admin) {
          throw accountError('forbidden', 'Tenant administrator access is required.', 403);
        }
        if (role === 'owner' && membership.role !== 'owner') {
          throw accountError('forbidden', 'Only an owner may invite another owner.', 403);
        }
      }
      const id = randomUUID();
      database.prepare(`
        INSERT INTO account_invites
          (id, token_hash, kind, tenant_id, role, created_by_user_id, created_at, expires_at, used_at)
        VALUES (?, ?, 'invite', ?, ?, ?, ?, ?, NULL)
      `).run(id, tokenHash(code), tenantId, role, actorUserId, createdAt, expiresAt);
      return Object.freeze({ code, id, kind: 'invite', tenantId, role, expiresAt });
    });
  }

  listAccountInvites(options = {}) {
    const tenantId = options.tenantId;
    const actorUserId = options.actorUserId;
    const database = this.getDatabase();
    const membership = database.prepare(`
      SELECT role FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?
    `).get(tenantId, actorUserId);
    if (!membership || ROLE_RANK[membership.role] < ROLE_RANK.admin) {
      throw accountError('forbidden', 'Tenant administrator access is required.', 403);
    }
    const now = this.clock();
    return Object.freeze(database.prepare(`
      SELECT * FROM account_invites
      WHERE tenant_id = ? AND kind = 'invite'
      ORDER BY created_at DESC, id
    `).all(tenantId).map((row) => publicAccountInvite(row, now)));
  }

  listTenantMembers(options = {}) {
    const tenantId = options.tenantId;
    const actorUserId = options.actorUserId;
    const database = this.getDatabase();
    const membership = database.prepare(`
      SELECT role FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?
    `).get(tenantId, actorUserId);
    if (!membership || ROLE_RANK[membership.role] < ROLE_RANK.admin) {
      throw accountError('forbidden', 'Tenant administrator access is required.', 403);
    }
    return Object.freeze(database.prepare(`
      SELECT users.*, tenant_memberships.role, tenant_memberships.created_at AS membership_created_at
      FROM tenant_memberships
      JOIN users ON users.id = tenant_memberships.user_id
      WHERE tenant_memberships.tenant_id = ?
      ORDER BY tenant_memberships.created_at, users.id
    `).all(tenantId).map((row) => Object.freeze({
      user: publicUser(row),
      role: row.role,
      joinedAt: row.membership_created_at,
    })));
  }

  prepareSignup(options) {
    const username = normalizeUsername(options.username);
    const displayName = normalizeDisplayName(options.displayName, username);
    const mode = normalizeSignupMode(options.mode);
    const code = options.code ? String(options.code).trim() : null;
    const database = this.getDatabase();
    const now = this.clock();
    const status = this.signupStatus(mode);
    if (!status.allowed) throw accountError('signup_disabled', 'Account registration is disabled.', 403);
    if (database.prepare('SELECT 1 AS present FROM users WHERE username = ?').get(username)) {
      throw accountError('username_taken', 'That username is unavailable.', 409);
    }

    let invitation = null;
    if (code) {
      if (!ACCOUNT_CODE_PATTERN.test(code)) {
        throw accountError('invalid_account_code', 'The account code is invalid or expired.', 401);
      }
      invitation = database.prepare(`
        SELECT * FROM account_invites WHERE token_hash = ?
      `).get(tokenHash(code));
      if (
        !invitation
        || invitation.used_at
        || Date.parse(invitation.expires_at) <= now
        || !hashesEqual(invitation.token_hash, tokenHash(code))
      ) {
        throw accountError('invalid_account_code', 'The account code is invalid or expired.', 401);
      }
    }

    if (
      status.effectiveMode === 'first-user'
      && invitation
      && invitation.kind !== 'bootstrap'
    ) {
      throw accountError('invalid_account_code', 'The account code is invalid or expired.', 401);
    }
    if (status.effectiveMode === 'invite' && invitation?.kind !== 'invite') {
      throw accountError('invite_required', 'A valid account invitation is required.', 401);
    }
    if (status.effectiveMode === 'open' && invitation?.kind === 'bootstrap' && this.userCount() > 0) {
      throw accountError('invalid_account_code', 'The account code is invalid or expired.', 401);
    }
    let tenantId = invitation?.tenant_id ?? null;
    if (status.effectiveMode === 'first-user' && !invitation) {
      const tenants = database.prepare('SELECT id FROM tenants ORDER BY created_at, rowid').all();
      if (tenants.length === 1) tenantId = tenants[0].id;
      else if (tenants.length > 1) {
        throw accountError(
          'tenant_required',
          'More than one tenant exists; select the tenant for the first web owner.',
          409,
        );
      }
    }
    return Object.freeze({
      username,
      displayName,
      signupPolicy: status.effectiveMode,
      inviteId: invitation?.id ?? null,
      tenantId,
      role: invitation?.role ?? 'owner',
    });
  }

  createWebAuthnFlow(options) {
    const type = String(options.type);
    if (!['signup', 'login', 'reauthenticate'].includes(type)) throw new Error('Invalid WebAuthn flow type');
    const challenge = String(options.challenge ?? '');
    if (!/^[A-Za-z0-9_-]{16,1024}$/.test(challenge)) throw new Error('Invalid WebAuthn challenge');
    const ttlMs = options.ttlMs ?? DEFAULT_WEBAUTHN_FLOW_TTL_MS;
    assertTtl(ttlMs, 'WebAuthn flow TTL', 15 * 60 * 1000);
    const now = this.clock();
    const flowToken = randomToken(FLOW_TOKEN_PREFIX);
    const row = {
      id: randomUUID(),
      tokenHash: tokenHash(flowToken),
      type,
      challenge,
      userId: options.userId ?? null,
      sessionId: options.sessionId ?? null,
      inviteId: options.inviteId ?? null,
      signupPolicy: options.signupPolicy ?? null,
      pendingUsername: options.pendingUsername ?? null,
      pendingDisplayName: options.pendingDisplayName ?? null,
      pendingWebauthnUserId: options.pendingWebauthnUserId
        ? normalizeWebAuthnUserId(options.pendingWebauthnUserId)
        : null,
      pendingTenantId: options.pendingTenantId ?? null,
      pendingRole: options.pendingRole ?? null,
      createdAt: isoTimestamp(now),
      expiresAt: isoTimestamp(now + ttlMs),
    };
    if (type === 'signup') {
      normalizeUsername(row.pendingUsername);
      normalizeDisplayName(row.pendingDisplayName, row.pendingUsername);
      normalizeSignupMode(row.signupPolicy);
      normalizeRole(row.pendingRole);
      if (!row.pendingWebauthnUserId) throw new Error('Signup flow requires a WebAuthn user ID');
    }
    if (type === 'reauthenticate' && (!row.userId || !row.sessionId)) {
      throw new Error('Reauthentication flow requires a user and session');
    }
    this.getDatabase().prepare(`
      INSERT INTO webauthn_flows
        (id, token_hash, type, challenge, user_id, session_id, invite_id, signup_policy,
         pending_username, pending_display_name, pending_webauthn_user_id,
         pending_tenant_id, pending_role, created_at, expires_at, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      row.id,
      row.tokenHash,
      row.type,
      row.challenge,
      row.userId,
      row.sessionId,
      row.inviteId,
      row.signupPolicy,
      row.pendingUsername,
      row.pendingDisplayName,
      row.pendingWebauthnUserId,
      row.pendingTenantId,
      row.pendingRole,
      row.createdAt,
      row.expiresAt,
    );
    return Object.freeze({ flowId: flowToken, type, expiresAt: row.expiresAt });
  }

  consumeWebAuthnFlow(flowId, expectedType) {
    if (typeof flowId !== 'string' || !FLOW_TOKEN_PATTERN.test(flowId)) {
      throw accountError('invalid_auth_flow', 'The authentication request is invalid or expired.', 401);
    }
    const database = this.getDatabase();
    return withImmediateTransaction(database, () => {
      const now = this.clock();
      const row = database.prepare(`
        SELECT * FROM webauthn_flows WHERE token_hash = ?
      `).get(tokenHash(flowId));
      if (
        !row
        || row.type !== expectedType
        || row.used_at
        || Date.parse(row.expires_at) <= now
        || !hashesEqual(row.token_hash, tokenHash(flowId))
      ) {
        throw accountError('invalid_auth_flow', 'The authentication request is invalid or expired.', 401);
      }
      database.prepare('UPDATE webauthn_flows SET used_at = ? WHERE id = ?')
        .run(isoTimestamp(now), row.id);
      return Object.freeze({
        id: row.id,
        type: row.type,
        challenge: row.challenge,
        userId: row.user_id,
        sessionId: row.session_id,
        inviteId: row.invite_id,
        signupPolicy: row.signup_policy,
        pendingUsername: row.pending_username,
        pendingDisplayName: row.pending_display_name,
        pendingWebauthnUserId: row.pending_webauthn_user_id
          ? Buffer.from(row.pending_webauthn_user_id)
          : null,
        pendingTenantId: row.pending_tenant_id,
        pendingRole: row.pending_role,
        expiresAt: row.expires_at,
      });
    });
  }

  createPasskeyRegistrationFlow(options = {}) {
    const challenge = String(options.challenge ?? '');
    if (!/^[A-Za-z0-9_-]{16,1024}$/.test(challenge)) {
      throw new Error('Invalid WebAuthn challenge');
    }
    const ttlMs = options.ttlMs ?? DEFAULT_WEBAUTHN_FLOW_TTL_MS;
    assertTtl(ttlMs, 'WebAuthn flow TTL', 15 * 60 * 1000);
    const authenticated = this.authenticateSession(options.sessionToken, { touch: false });
    if (authenticated.user.id !== options.userId) {
      throw accountError('invalid_auth_flow', 'The authentication request is invalid or expired.', 401);
    }
    const flowToken = randomToken(FLOW_TOKEN_PREFIX);
    const now = this.clock();
    const row = {
      id: randomUUID(),
      tokenHash: tokenHash(flowToken),
      challenge,
      userId: authenticated.user.id,
      sessionId: authenticated.session.id,
      label: normalizePasskeyLabel(options.label),
      createdAt: isoTimestamp(now),
      expiresAt: isoTimestamp(now + ttlMs),
    };
    this.getDatabase().prepare(`
      INSERT INTO passkey_registration_flows
        (id, token_hash, challenge, user_id, session_id, label, created_at, expires_at, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      row.id,
      row.tokenHash,
      row.challenge,
      row.userId,
      row.sessionId,
      row.label,
      row.createdAt,
      row.expiresAt,
    );
    return Object.freeze({ flowId: flowToken, expiresAt: row.expiresAt });
  }

  consumePasskeyRegistrationFlow(flowId, options = {}) {
    if (typeof flowId !== 'string' || !FLOW_TOKEN_PATTERN.test(flowId)) {
      throw accountError('invalid_auth_flow', 'The authentication request is invalid or expired.', 401);
    }
    const authenticated = this.authenticateSession(options.sessionToken, { touch: false });
    const database = this.getDatabase();
    return withImmediateTransaction(database, () => {
      const now = this.clock();
      const row = database.prepare(`
        SELECT * FROM passkey_registration_flows WHERE token_hash = ?
      `).get(tokenHash(flowId));
      if (
        !row
        || row.user_id !== authenticated.user.id
        || row.session_id !== authenticated.session.id
        || row.used_at
        || Date.parse(row.expires_at) <= now
        || !hashesEqual(row.token_hash, tokenHash(flowId))
      ) {
        throw accountError('invalid_auth_flow', 'The authentication request is invalid or expired.', 401);
      }
      database.prepare('UPDATE passkey_registration_flows SET used_at = ? WHERE id = ?')
        .run(isoTimestamp(now), row.id);
      return Object.freeze({
        id: row.id,
        challenge: row.challenge,
        userId: row.user_id,
        sessionId: row.session_id,
        label: row.label,
        expiresAt: row.expires_at,
      });
    });
  }

  completeSignup(flow, credentialValue) {
    if (flow?.type !== 'signup') throw new Error('A consumed signup flow is required');
    const credential = normalizeCredential(credentialValue);
    const username = normalizeUsername(flow.pendingUsername);
    const displayName = normalizeDisplayName(flow.pendingDisplayName, username);
    const webauthnUserId = normalizeWebAuthnUserId(flow.pendingWebauthnUserId);
    const role = normalizeRole(flow.pendingRole);
    const database = this.getDatabase();
    try {
      return withImmediateTransaction(database, () => {
        const now = this.clock();
        const createdAt = isoTimestamp(now);
        let tenantId = flow.pendingTenantId;
        if (flow.inviteId) {
          const invitation = database.prepare('SELECT * FROM account_invites WHERE id = ?').get(flow.inviteId);
          if (
            !invitation
            || invitation.used_at
            || Date.parse(invitation.expires_at) <= now
            || invitation.tenant_id !== tenantId
            || invitation.role !== role
          ) {
            throw accountError('invalid_account_code', 'The account code is invalid or expired.', 401);
          }
          if (
            invitation.kind === 'bootstrap'
            && Number(database.prepare('SELECT count(*) AS count FROM users').get().count) !== 0
          ) {
            throw accountError('bootstrap_closed', 'The first owner has already been created.', 409);
          }
          if (flow.signupPolicy === 'first-user' && invitation.kind !== 'bootstrap') {
            throw accountError('invalid_account_code', 'The account code is invalid or expired.', 401);
          }
          if (flow.signupPolicy === 'invite' && invitation.kind !== 'invite') {
            throw accountError('invalid_account_code', 'The account code is invalid or expired.', 401);
          }
          const consumed = database.prepare(`
            UPDATE account_invites SET used_at = ?
            WHERE id = ? AND used_at IS NULL AND expires_at > ?
          `).run(createdAt, invitation.id, createdAt);
          if (Number(consumed.changes) !== 1) {
            throw accountError('invalid_account_code', 'The account code is invalid or expired.', 401);
          }
        } else if (flow.signupPolicy === 'first-user') {
          if (Number(database.prepare('SELECT count(*) AS count FROM users').get().count) !== 0) {
            throw accountError('bootstrap_closed', 'The first owner has already been created.', 409);
          }
          const tenants = database.prepare('SELECT id FROM tenants ORDER BY created_at, rowid').all();
          if (tenants.length === 1) tenantId = tenants[0].id;
          else if (tenants.length > 1) {
            throw accountError(
              'tenant_required',
              'More than one tenant exists; select the tenant for the first web owner.',
              409,
            );
          } else {
            tenantId = null;
          }
        } else if (flow.signupPolicy !== 'open') {
          throw accountError('invalid_account_code', 'An account code is required.', 401);
        }

        if (!tenantId) {
          tenantId = randomUUID();
          database.prepare('INSERT INTO tenants (id, created_at) VALUES (?, ?)').run(tenantId, createdAt);
        } else if (!database.prepare('SELECT 1 AS present FROM tenants WHERE id = ?').get(tenantId)) {
          throw accountError('tenant_not_found', 'The requested tenant does not exist.', 404);
        }

        const userId = randomUUID();
        database.prepare(`
          INSERT INTO users
            (id, username, display_name, webauthn_user_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?)
        `).run(userId, username, displayName, webauthnUserId, createdAt, createdAt);
        const ownerAssignment = database.prepare(`
          INSERT INTO schema_metadata (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO NOTHING
        `).run(SERVER_OWNER_METADATA_KEY, userId);
        if (flow.signupPolicy === 'first-user' && Number(ownerAssignment.changes) !== 1) {
          throw accountError('bootstrap_closed', 'The first owner has already been created.', 409);
        }
        if (flow.signupPolicy === 'first-user') {
          database.prepare(`
            DELETE FROM account_invites WHERE kind = 'bootstrap' AND used_at IS NULL
          `).run();
        }
        database.prepare(`
          INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at)
          VALUES (?, ?, ?, ?)
        `).run(tenantId, userId, role, createdAt);
        database.prepare(`
          INSERT INTO passkey_credentials
            (id, user_id, public_key, counter, transports, device_type, backed_up,
             label, created_at, last_used_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `).run(
          credential.id,
          userId,
          credential.publicKey,
          credential.counter,
          JSON.stringify(credential.transports),
          credential.deviceType,
          credential.backedUp ? 1 : 0,
          credential.label,
          createdAt,
        );
        const user = database.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        const membership = database.prepare(`
          SELECT * FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?
        `).get(tenantId, userId);
        return Object.freeze({ user: publicUser(user), membership: publicMembership(membership) });
      });
    } catch (error) {
      translateConstraint(error);
    }
  }

  getUser(userId) {
    const row = this.getDatabase().prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return row ? publicUser(row) : null;
  }

  updateDisplayName(userId, displayNameValue) {
    const database = this.getDatabase();
    const current = database.prepare(`
      SELECT * FROM users WHERE id = ? AND status = 'active'
    `).get(userId);
    if (!current) throw accountError('account_not_found', 'The account is unavailable.', 404);
    const displayName = normalizeDisplayName(displayNameValue, current.username);
    const updatedAt = isoTimestamp(this.clock());
    database.prepare(`
      UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?
    `).run(displayName, updatedAt, userId);
    return publicUser({ ...current, display_name: displayName, updated_at: updatedAt });
  }

  updateLanguage(userId, languageValue) {
    const database = this.getDatabase();
    const current = database.prepare(`
      SELECT * FROM users WHERE id = ? AND status = 'active'
    `).get(userId);
    if (!current) throw accountError('account_not_found', 'The account is unavailable.', 404);
    const language = normalizeLanguage(languageValue);
    const updatedAt = isoTimestamp(this.clock());
    database.prepare(`
      UPDATE users SET language = ?, updated_at = ? WHERE id = ?
    `).run(language, updatedAt, userId);
    return publicUser({ ...current, language, updated_at: updatedAt });
  }

  getPasskey(credentialId) {
    if (typeof credentialId !== 'string' || !CREDENTIAL_ID_PATTERN.test(credentialId)) return null;
    const row = this.getDatabase().prepare(`
      SELECT passkey_credentials.*
      FROM passkey_credentials
      JOIN users ON users.id = passkey_credentials.user_id
      WHERE passkey_credentials.id = ?
        AND passkey_credentials.revoked_at IS NULL
        AND users.status = 'active'
    `).get(credentialId);
    return row ? publicPasskey(row) : null;
  }

  listPasskeys(userId) {
    return this.getDatabase().prepare(`
      SELECT * FROM passkey_credentials
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY created_at, id
    `).all(userId).map(publicPasskey);
  }

  addPasskey(userId, credentialValue) {
    const credential = normalizeCredential(credentialValue);
    const database = this.getDatabase();
    const user = database.prepare(`
      SELECT id FROM users WHERE id = ? AND status = 'active'
    `).get(userId);
    if (!user) throw accountError('account_not_found', 'The account is unavailable.', 404);
    const createdAt = isoTimestamp(this.clock());
    try {
      database.prepare(`
        INSERT INTO passkey_credentials
          (id, user_id, public_key, counter, transports, device_type, backed_up,
           label, created_at, last_used_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        credential.id,
        userId,
        credential.publicKey,
        credential.counter,
        JSON.stringify(credential.transports),
        credential.deviceType,
        credential.backedUp ? 1 : 0,
        credential.label,
        createdAt,
      );
    } catch (error) {
      translateConstraint(error, 'passkey_conflict');
    }
    return publicPasskey({
      id: credential.id,
      user_id: userId,
      public_key: credential.publicKey,
      counter: credential.counter,
      transports: JSON.stringify(credential.transports),
      device_type: credential.deviceType,
      backed_up: credential.backedUp ? 1 : 0,
      label: credential.label,
      created_at: createdAt,
      last_used_at: null,
      revoked_at: null,
    });
  }

  revokePasskey(userId, credentialId) {
    const database = this.getDatabase();
    return withImmediateTransaction(database, () => {
      const active = database.prepare(`
        SELECT * FROM passkey_credentials
        WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY created_at, id
      `).all(userId);
      const target = active.find((passkey) => passkey.id === credentialId);
      if (!target) throw accountError('passkey_not_found', 'Passkey not found.', 404);
      if (active.length <= 1) {
        throw accountError('last_passkey', 'The last passkey cannot be removed.', 409);
      }
      const revokedAt = isoTimestamp(this.clock());
      database.prepare(`
        UPDATE passkey_credentials SET revoked_at = ? WHERE id = ? AND user_id = ?
      `).run(revokedAt, credentialId, userId);
      return Object.freeze({ id: credentialId, revokedAt });
    });
  }

  completePasskeyAuthentication(credentialId, previousCounter, authenticationInfo = {}) {
    const newCounter = Number(authenticationInfo.newCounter);
    if (!Number.isSafeInteger(newCounter) || newCounter < 0) {
      throw accountError('authentication_failed', 'Passkey authentication failed.', 401);
    }
    const database = this.getDatabase();
    return withImmediateTransaction(database, () => {
      const row = database.prepare(`
        SELECT passkey_credentials.*, users.status AS user_status
        FROM passkey_credentials
        JOIN users ON users.id = passkey_credentials.user_id
        WHERE passkey_credentials.id = ? AND passkey_credentials.revoked_at IS NULL
      `).get(credentialId);
      if (!row || row.user_status !== 'active' || Number(row.counter) !== Number(previousCounter)) {
        throw accountError('authentication_failed', 'Passkey authentication failed.', 401);
      }
      const backedUp = authenticationInfo.credentialBackedUp === undefined
        ? Number(row.backed_up)
        : authenticationInfo.credentialBackedUp ? 1 : 0;
      const now = isoTimestamp(this.clock());
      database.prepare(`
        UPDATE passkey_credentials
        SET counter = ?, backed_up = ?, last_used_at = ?
        WHERE id = ?
      `).run(newCounter, backedUp, now, credentialId);
      return Object.freeze({ userId: row.user_id, passkey: publicPasskey({
        ...row,
        counter: newCounter,
        backed_up: backedUp,
        last_used_at: now,
      }) });
    });
  }

  membershipsForUser(userId) {
    return this.getDatabase().prepare(`
      SELECT * FROM tenant_memberships WHERE user_id = ? ORDER BY created_at, tenant_id
    `).all(userId).map(publicMembership);
  }

  listWebSessions(userId, currentSessionId = null) {
    const now = this.clock();
    return this.getDatabase().prepare(`
      SELECT * FROM web_sessions
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY last_seen_at DESC, id
    `).all(userId)
      .filter((session) => (
        Date.parse(session.idle_expires_at) > now
        && Date.parse(session.absolute_expires_at) > now
      ))
      .map((session) => Object.freeze({
        ...publicSession(session),
        current: session.id === currentSessionId,
      }));
  }

  revokeWebSession(userId, sessionId, currentSessionId = null) {
    if (sessionId === currentSessionId) {
      throw accountError('current_session', 'Use logout to end the current session.', 409);
    }
    const result = this.getDatabase().prepare(`
      UPDATE web_sessions SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(isoTimestamp(this.clock()), sessionId, userId);
    if (Number(result.changes) !== 1) {
      throw accountError('session_not_found', 'Web session not found.', 404);
    }
    return Object.freeze({ id: sessionId, revoked: true });
  }

  serverSettings(defaults = {}) {
    const rows = new Map(this.getDatabase().prepare(`
      SELECT key, value FROM schema_metadata
      WHERE key IN ('web_signup_mode', 'web_revision_retention')
    `).all().map((row) => [row.key, row.value]));
    const signupMode = rows.has('web_signup_mode')
      ? normalizeSignupMode(rows.get('web_signup_mode'))
      : normalizeSignupMode(defaults.signupMode ?? 'open');
    const revisionRetention = rows.has('web_revision_retention')
      ? Number(rows.get('web_revision_retention'))
      : Number(defaults.revisionRetention ?? 50);
    if (!Number.isSafeInteger(revisionRetention) || revisionRetention < 1 || revisionRetention > 10_000) {
      throw new Error('Stored web revision retention is invalid');
    }
    return Object.freeze({ signupMode, revisionRetention });
  }

  isServerOwner(userId) {
    const owner = this.getDatabase().prepare(`
      SELECT value FROM schema_metadata WHERE key = ?
    `).get(SERVER_OWNER_METADATA_KEY);
    return Boolean(owner && owner.value === userId);
  }

  updateServerSettings(userId, tenantId, patch = {}) {
    if (!this.isServerOwner(userId)) {
      throw accountError('forbidden', 'Server owner access is required.', 403);
    }
    const membership = this.getDatabase().prepare(`
      SELECT 1 AS present FROM tenant_memberships WHERE user_id = ? AND tenant_id = ?
    `).get(userId, tenantId);
    if (!membership) {
      throw accountError('forbidden', 'The selected tenant is unavailable.', 403);
    }
    const current = this.serverSettings(patch.defaults);
    const signupMode = patch.signupMode === undefined
      ? current.signupMode
      : normalizeSignupMode(patch.signupMode);
    const revisionRetention = patch.revisionRetention === undefined
      ? current.revisionRetention
      : Number(patch.revisionRetention);
    if (!Number.isSafeInteger(revisionRetention) || revisionRetention < 1 || revisionRetention > 10_000) {
      throw accountError('invalid_retention', 'Revision retention must be between 1 and 10000.');
    }
    const database = this.getDatabase();
    withImmediateTransaction(database, () => {
      const set = database.prepare(`
        INSERT INTO schema_metadata (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      set.run('web_signup_mode', signupMode);
      set.run('web_revision_retention', String(revisionRetention));
      if (signupMode !== current.signupMode) {
        database.prepare(`
          DELETE FROM webauthn_flows WHERE type = 'signup'
        `).run();
      }
    });
    return Object.freeze({ signupMode, revisionRetention });
  }

  hasUsableRecoveryCodes(userId) {
    return this.recoveryCodeStatus(userId).configured;
  }

  recoveryCodeStatus(userId) {
    const database = this.getDatabase();
    const user = database.prepare(`
      SELECT id FROM users WHERE id = ? AND status = 'active'
    `).get(userId);
    if (!user) throw accountError('account_not_found', 'The account is unavailable.', 404);
    const confirmationId = recoveryConfirmationId(database, userId);
    const confirmed = confirmationId
      ? database.prepare('SELECT value FROM schema_metadata WHERE key = ?')
        .get(recoveryConfirmationMetadataKey(userId))?.value === confirmationId
      : false;
    return Object.freeze({
      configured: Boolean(confirmationId),
      confirmed,
      confirmationId,
    });
  }

  confirmRecoveryCodes(userId, confirmationValue) {
    const confirmationId = String(confirmationValue ?? '').trim();
    if (!RECOVERY_CONFIRMATION_PATTERN.test(confirmationId)) {
      throw accountError('invalid_recovery_confirmation', 'Recovery-code confirmation is invalid.');
    }
    const database = this.getDatabase();
    const current = this.recoveryCodeStatus(userId);
    if (!current.configured || current.confirmationId !== confirmationId) {
      throw accountError(
        'recovery_codes_changed',
        'Recovery codes changed before they were confirmed.',
        409,
      );
    }
    database.prepare(`
      INSERT INTO schema_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(recoveryConfirmationMetadataKey(userId), confirmationId);
    return Object.freeze({ configured: true, confirmed: true });
  }

  createRecoveryCodes(userId, options = {}) {
    const count = options.count ?? 8;
    if (!Number.isSafeInteger(count) || count < 1 || count > 16) {
      throw accountError('invalid_recovery_count', 'Recovery code count must be between 1 and 16.');
    }
    const database = this.getDatabase();
    const user = database.prepare(`
      SELECT id FROM users WHERE id = ? AND status = 'active'
    `).get(userId);
    if (!user) throw accountError('account_not_found', 'The account is unavailable.', 404);
    const codes = Array.from({ length: count }, () => (
      `${RECOVERY_CODE_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`
    ));
    const createdAt = isoTimestamp(this.clock());
    withImmediateTransaction(database, () => {
      database.prepare(`
        DELETE FROM account_recovery_codes WHERE user_id = ? AND used_at IS NULL
      `).run(userId);
      const insert = database.prepare(`
        INSERT INTO account_recovery_codes (id, user_id, token_hash, created_at, used_at)
        VALUES (?, ?, ?, ?, NULL)
      `);
      for (const code of codes) {
        insert.run(randomUUID(), userId, tokenHash(code), createdAt);
      }
    });
    return Object.freeze({
      codes: Object.freeze(codes),
      createdAt,
      confirmationId: recoveryConfirmationId(database, userId),
    });
  }

  consumeRecoveryCode(codeValue) {
    const code = String(codeValue ?? '').trim();
    if (!RECOVERY_CODE_PATTERN.test(code)) {
      throw accountError('invalid_recovery_code', 'The recovery code is invalid or already used.', 401);
    }
    const database = this.getDatabase();
    return withImmediateTransaction(database, () => {
      const now = isoTimestamp(this.clock());
      const row = database.prepare(`
        SELECT
          account_recovery_codes.id AS recovery_id,
          account_recovery_codes.token_hash AS recovery_token_hash,
          account_recovery_codes.used_at AS recovery_used_at,
          users.*
        FROM account_recovery_codes
        JOIN users ON users.id = account_recovery_codes.user_id
        WHERE account_recovery_codes.token_hash = ?
      `).get(tokenHash(code));
      if (
        !row
        || row.status !== 'active'
        || row.recovery_used_at
        || !hashesEqual(row.recovery_token_hash, tokenHash(code))
      ) {
        throw accountError('invalid_recovery_code', 'The recovery code is invalid or already used.', 401);
      }
      const consumed = database.prepare(`
        UPDATE account_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL
      `).run(now, row.recovery_id);
      if (Number(consumed.changes) !== 1) {
        throw accountError('invalid_recovery_code', 'The recovery code is invalid or already used.', 401);
      }
      database.prepare(`
        UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
      `).run(now, row.id);
      const memberships = database.prepare(`
        SELECT * FROM tenant_memberships WHERE user_id = ? ORDER BY created_at, tenant_id
      `).all(row.id).map(publicMembership);
      return Object.freeze({ user: publicUser(row), memberships: Object.freeze(memberships) });
    });
  }

  createSession(userId, options = {}) {
    const database = this.getDatabase();
    const user = database.prepare('SELECT * FROM users WHERE id = ? AND status = \'active\'').get(userId);
    if (!user) throw accountError('authentication_failed', 'Account authentication failed.', 401);
    const memberships = this.membershipsForUser(userId);
    const activeTenantId = options.activeTenantId ?? memberships[0]?.tenantId;
    if (!activeTenantId || !memberships.some((membership) => membership.tenantId === activeTenantId)) {
      throw accountError('forbidden', 'The account has no access to the selected tenant.', 403);
    }
    const sessionToken = randomToken(SESSION_TOKEN_PREFIX);
    const csrfToken = randomToken(CSRF_TOKEN_PREFIX);
    const now = this.clock();
    const recoveryRequired = options.recoveryRequired === true;
    const absoluteTtlMs = recoveryRequired
      ? Math.min(this.sessionAbsoluteTtlMs, DEFAULT_RECOVERY_SESSION_TTL_MS)
      : this.sessionAbsoluteTtlMs;
    const idleTtlMs = recoveryRequired
      ? Math.min(this.sessionIdleTtlMs, DEFAULT_RECOVERY_SESSION_TTL_MS)
      : this.sessionIdleTtlMs;
    const absoluteExpiresAtMs = now + absoluteTtlMs;
    const idleExpiresAtMs = Math.min(now + idleTtlMs, absoluteExpiresAtMs);
    const row = {
      id: randomUUID(),
      tokenHash: tokenHash(sessionToken),
      csrfHash: tokenHash(csrfToken),
      userId,
      activeTenantId,
      createdAt: isoTimestamp(now),
      idleExpiresAt: isoTimestamp(idleExpiresAtMs),
      absoluteExpiresAt: isoTimestamp(absoluteExpiresAtMs),
      recoveryRequired,
    };
    database.prepare(`
      INSERT INTO web_sessions
        (id, token_hash, csrf_hash, user_id, active_tenant_id, created_at, last_seen_at,
         idle_expires_at, absolute_expires_at, reauthenticated_at, recovery_required, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      row.id,
      row.tokenHash,
      row.csrfHash,
      row.userId,
      row.activeTenantId,
      row.createdAt,
      row.createdAt,
      row.idleExpiresAt,
      row.absoluteExpiresAt,
      row.createdAt,
      row.recoveryRequired ? 1 : 0,
    );
    const stored = database.prepare('SELECT * FROM web_sessions WHERE id = ?').get(row.id);
    return Object.freeze({
      sessionToken,
      csrfToken,
      session: publicSession(stored),
      user: publicUser(user),
      memberships: Object.freeze(memberships),
    });
  }

  authenticateSession(sessionToken, options = {}) {
    if (typeof sessionToken !== 'string' || !SESSION_TOKEN_PATTERN.test(sessionToken)) {
      throw accountError('invalid_session', 'The web session is invalid or expired.', 401);
    }
    const database = this.getDatabase();
    const now = this.clock();
    return withImmediateTransaction(database, () => {
      const row = database.prepare(`
        SELECT web_sessions.*, users.status AS user_status
        FROM web_sessions
        JOIN users ON users.id = web_sessions.user_id
        WHERE web_sessions.token_hash = ?
      `).get(tokenHash(sessionToken));
      if (
        !row
        || !hashesEqual(row.token_hash, tokenHash(sessionToken))
        || row.revoked_at
        || row.user_status !== 'active'
        || !Number.isFinite(Date.parse(row.idle_expires_at))
        || !Number.isFinite(Date.parse(row.absolute_expires_at))
        || Date.parse(row.idle_expires_at) <= now
        || Date.parse(row.absolute_expires_at) <= now
      ) {
        if (row && !row.revoked_at) {
          database.prepare('UPDATE web_sessions SET revoked_at = ? WHERE id = ?')
            .run(isoTimestamp(now), row.id);
        }
        throw accountError('invalid_session', 'The web session is invalid or expired.', 401);
      }
      if (options.touch !== false) {
        const idleExpiresAt = isoTimestamp(Math.min(
          now + this.sessionIdleTtlMs,
          Date.parse(row.absolute_expires_at),
        ));
        database.prepare(`
          UPDATE web_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?
        `).run(isoTimestamp(now), idleExpiresAt, row.id);
        row.last_seen_at = isoTimestamp(now);
        row.idle_expires_at = idleExpiresAt;
      }
      const user = database.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
      const memberships = database.prepare(`
        SELECT * FROM tenant_memberships WHERE user_id = ? ORDER BY created_at, tenant_id
      `).all(row.user_id).map(publicMembership);
      if (!memberships.some((membership) => membership.tenantId === row.active_tenant_id)) {
        throw accountError('invalid_session', 'The web session is invalid or expired.', 401);
      }
      return Object.freeze({
        session: publicSession(row),
        user: publicUser(user),
        memberships: Object.freeze(memberships),
      });
    });
  }

  verifyCsrf(sessionToken, csrfToken) {
    if (typeof csrfToken !== 'string' || !CSRF_TOKEN_PATTERN.test(csrfToken)) {
      throw accountError('invalid_csrf', 'CSRF validation failed.', 403);
    }
    const authenticated = this.authenticateSession(sessionToken);
    const stored = this.getDatabase().prepare(`
      SELECT csrf_hash FROM web_sessions WHERE id = ?
    `).get(authenticated.session.id);
    if (!stored || !hashesEqual(stored.csrf_hash, tokenHash(csrfToken))) {
      throw accountError('invalid_csrf', 'CSRF validation failed.', 403);
    }
    return authenticated;
  }

  rotateCsrf(sessionToken) {
    const authenticated = this.authenticateSession(sessionToken);
    const csrfToken = randomToken(CSRF_TOKEN_PREFIX);
    this.getDatabase().prepare('UPDATE web_sessions SET csrf_hash = ? WHERE id = ?')
      .run(tokenHash(csrfToken), authenticated.session.id);
    return Object.freeze({ ...authenticated, csrfToken });
  }

  markSessionReauthenticated(sessionToken) {
    const authenticated = this.authenticateSession(sessionToken);
    if (authenticated.session.recoveryRequired) {
      throw accountError('recovery_passkey_required', 'Register a new passkey to finish account recovery.', 403);
    }
    const reauthenticatedAt = isoTimestamp(this.clock());
    this.getDatabase().prepare(`
      UPDATE web_sessions SET reauthenticated_at = ? WHERE id = ?
    `).run(reauthenticatedAt, authenticated.session.id);
    return Object.freeze({
      ...authenticated,
      session: Object.freeze({ ...authenticated.session, reauthenticatedAt }),
    });
  }

  finishRecoverySession(sessionToken) {
    const authenticated = this.authenticateSession(sessionToken);
    if (!authenticated.session.recoveryRequired) return authenticated;
    const reauthenticatedAt = isoTimestamp(this.clock());
    const updated = this.getDatabase().prepare(`
      UPDATE web_sessions
      SET recovery_required = 0, reauthenticated_at = ?
      WHERE id = ? AND recovery_required = 1 AND revoked_at IS NULL
    `).run(reauthenticatedAt, authenticated.session.id);
    if (Number(updated.changes) !== 1) {
      throw accountError('invalid_session', 'The web session is invalid or expired.', 401);
    }
    return Object.freeze({
      ...authenticated,
      session: Object.freeze({
        ...authenticated.session,
        recoveryRequired: false,
        reauthenticatedAt,
      }),
    });
  }

  revokeSession(sessionToken) {
    if (typeof sessionToken !== 'string' || !SESSION_TOKEN_PATTERN.test(sessionToken)) return false;
    const result = this.getDatabase().prepare(`
      UPDATE web_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL
    `).run(isoTimestamp(this.clock()), tokenHash(sessionToken));
    return Number(result.changes) === 1;
  }
}

export function generateWebAuthnUserId() {
  return randomBytes(WEBAUTHN_USER_ID_BYTES);
}
