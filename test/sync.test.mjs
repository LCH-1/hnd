import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  decryptSnapshot,
  encryptSnapshot,
  generateVaultKey,
  readVaultKey,
  repairVaultKeyPermissions,
  writeVaultKey,
} from '../src/sync/crypto.mjs';
import {
  captureSyncSnapshot,
  restoreSyncSnapshot,
  validateSyncSnapshot,
} from '../src/sync/capture.mjs';
import {
  SyncClient,
  SyncHttpError,
  enrollDevice,
  joinDevice,
} from '../src/sync/client.mjs';
import { createSyncServer, serverMain } from '../src/sync/server.mjs';
import {
  AuthenticationError,
  ControlStore,
  DEFAULT_DATABASE_FILENAME,
  DEFAULT_SERVER_MASTER_KEY_FILENAME,
  ManagedVaultKeyError,
  PreconditionFailedError,
  PreconditionRequiredError,
  SnapshotStore,
  VaultResetError,
} from '../src/sync/store.mjs';

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startServer(t, options = {}) {
  const dataDirectory = await temporaryDirectory(t, 'hnd-sync-server-');
  const errors = [];
  const server = await createSyncServer({
    dataDirectory,
    maxBlobBytes: options.maxBlobBytes ?? 64 * 1024,
    clock: options.clock,
    onError: (error) => errors.push(error),
  });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  return { server, dataDirectory, baseUrl: address.url, errors };
}

async function enroll(serverFixture, tenantId, deviceName = 'test-device') {
  const issued = await serverFixture.server.createEnrollmentKey(tenantId);
  const enrolled = await enrollDevice({
    baseUrl: serverFixture.baseUrl,
    enrollmentKey: issued.enrollmentKey,
    deviceName,
  });
  const client = new SyncClient({
    baseUrl: serverFixture.baseUrl,
    deviceToken: enrolled.deviceToken,
    maxBlobBytes: 64 * 1024,
  });
  return { issued, enrolled, client };
}

async function readTree(directory) {
  const output = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) output.push(await readFile(target));
    }
  }
  await walk(directory);
  return Buffer.concat(output);
}

function inspectServerDatabase(dataDirectory, operation) {
  const database = new DatabaseSync(path.join(dataDirectory, DEFAULT_DATABASE_FILENAME), {
    readOnly: true,
  });
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

test('AES-256-GCM snapshots authenticate ciphertext and vault key files stay private', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-crypto-');
  const key = generateVaultKey();
  const snapshot = {
    schemaVersion: 1,
    policy: 'plaintext-marker-99db650a',
    nested: { value: true },
  };
  const encrypted = encryptSnapshot(snapshot, key);
  assert.deepEqual(decryptSnapshot(encrypted, key), snapshot);
  assert.equal(encrypted.includes(Buffer.from(snapshot.policy)), false);

  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptSnapshot(tampered, key), /authentication failed/);
  assert.throws(() => decryptSnapshot(encrypted, randomBytes(32)), /authentication failed/);

  const keyPath = path.join(directory, 'vault.key');
  await writeVaultKey(keyPath, key);
  assert.deepEqual(await readVaultKey(keyPath), key);
  if (process.platform !== 'win32') {
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    await chmod(keyPath, 0o644);
    await assert.rejects(() => readVaultKey(keyPath), /permissions are too broad/);
    await repairVaultKeyPermissions(keyPath);
    assert.deepEqual(await readVaultKey(keyPath), key);
  }
  await assert.rejects(() => writeVaultKey(keyPath, key), (error) => error.code === 'EEXIST');
});

test('account-managed vault keys use one private server key and encrypted SQLite envelopes', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-managed-vault-key-');
  const first = new SnapshotStore(directory);
  const second = new SnapshotStore(directory);
  await Promise.all([first.init(), second.init()]);
  t.after(() => {
    first.close();
    second.close();
  });

  const masterKeyPath = path.join(directory, DEFAULT_SERVER_MASTER_KEY_FILENAME);
  const masterKeyBefore = await readFile(masterKeyPath);
  assert.equal(masterKeyBefore.byteLength, 32);
  if (process.platform !== 'win32') {
    assert.equal((await stat(masterKeyPath)).mode & 0o777, 0o600);
  }
  assert.equal(inspectServerDatabase(
    directory,
    (database) => Number(database.prepare('PRAGMA user_version').get().user_version),
  ), 1);
  assert.equal(inspectServerDatabase(
    directory,
    (database) => database.prepare(`
      SELECT value FROM schema_metadata WHERE key = 'managed_vault_keys_schema'
    `).get().value,
  ), '1');

  const tenantId = 'managed-key-tenant';
  const vaultKey = generateVaultKey();
  const initialBlob = encryptSnapshot({ schemaVersion: 1, files: [] }, vaultKey);
  await first.putConditional(tenantId, initialBlob, { ifNoneMatch: '*' });
  await assert.rejects(
    () => first.adoptManagedVaultKey(tenantId, generateVaultKey()),
    (error) => error instanceof ManagedVaultKeyError
      && error.code === 'invalid_vault_key'
      && error.statusCode === 400,
  );

  const adopted = await Promise.all([
    first.adoptManagedVaultKey(tenantId, vaultKey),
    second.adoptManagedVaultKey(tenantId, vaultKey),
  ]);
  assert.deepEqual(adopted.map((result) => result.created).sort(), [false, true]);
  assert.equal(first.hasManagedVaultKey(tenantId), true);
  const unlocked = await second.unlockManagedVaultKey(tenantId);
  assert.deepEqual(unlocked, vaultKey);
  unlocked.fill(0);

  const databaseBytes = await readFile(path.join(directory, DEFAULT_DATABASE_FILENAME));
  assert.equal(databaseBytes.includes(vaultKey), false);
  const managedRow = inspectServerDatabase(
    directory,
    (database) => database.prepare(`
      SELECT key_envelope FROM managed_vault_keys WHERE tenant_id = ?
    `).get(tenantId),
  );
  assert.equal(Buffer.from(managedRow.key_envelope).byteLength, 65);
  assert.equal(Buffer.from(managedRow.key_envelope).equals(vaultKey), false);
  assert.deepEqual(await readFile(masterKeyPath), masterKeyBefore);

  const replacementKey = generateVaultKey();
  const current = await first.get(tenantId);
  await first.putConditional(
    tenantId,
    encryptSnapshot({ schemaVersion: 1, files: [] }, replacementKey),
    { ifMatch: current.etag },
  );
  await assert.rejects(
    () => second.adoptManagedVaultKey(tenantId, replacementKey),
    (error) => error instanceof ManagedVaultKeyError
      && error.code === 'vault_key_already_managed',
  );

  const resetKey = generateVaultKey();
  const beforeReset = await first.get(tenantId);
  await first.resetVault(
    tenantId,
    encryptSnapshot({ schemaVersion: 1, files: [] }, resetKey),
    { ifMatch: beforeReset.etag },
  );
  assert.equal(first.hasManagedVaultKey(tenantId), false);
  await assert.rejects(
    () => first.unlockManagedVaultKey(tenantId),
    (error) => error instanceof ManagedVaultKeyError
      && error.code === 'legacy_vault_key_unavailable',
  );

  masterKeyBefore.fill(0);
  vaultKey.fill(0);
  replacementKey.fill(0);
  resetKey.fill(0);
});

test('startup refuses a missing, replaced, or corrupted server vault key', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-managed-vault-key-integrity-');
  const tenantId = 'managed-integrity-tenant';
  const vaultKey = generateVaultKey();
  const store = await new SnapshotStore(directory).init();
  const blob = encryptSnapshot({ schemaVersion: 1, files: [] }, vaultKey);
  await store.putConditional(tenantId, blob, { ifNoneMatch: '*' });
  await store.adoptManagedVaultKey(tenantId, vaultKey);
  store.close();

  const masterKeyPath = path.join(directory, DEFAULT_SERVER_MASTER_KEY_FILENAME);
  const originalMasterKey = await readFile(masterKeyPath);
  await rm(masterKeyPath);
  const missing = new SnapshotStore(directory);
  await assert.rejects(
    () => missing.init(),
    /missing while managed vault keys exist/,
  );
  missing.close();

  await writeFile(masterKeyPath, randomBytes(32), { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(masterKeyPath, 0o600);
  const replaced = new SnapshotStore(directory);
  await assert.rejects(
    () => replaced.init(),
    /envelope authentication failed/,
  );
  replaced.close();

  await writeFile(masterKeyPath, originalMasterKey);
  if (process.platform !== 'win32') {
    await chmod(masterKeyPath, 0o644);
    const broad = new SnapshotStore(directory);
    await assert.rejects(() => broad.init(), /permissions are too broad/);
    broad.close();
    await chmod(masterKeyPath, 0o600);
  }

  const database = new DatabaseSync(path.join(directory, DEFAULT_DATABASE_FILENAME));
  const row = database.prepare(`
    SELECT key_envelope FROM managed_vault_keys WHERE tenant_id = ?
  `).get(tenantId);
  const corrupted = Buffer.from(row.key_envelope);
  corrupted[corrupted.length - 1] ^= 1;
  database.prepare(`
    UPDATE managed_vault_keys SET key_envelope = ? WHERE tenant_id = ?
  `).run(corrupted, tenantId);
  database.close();
  corrupted.fill(0);
  const corruptedStore = new SnapshotStore(directory);
  await assert.rejects(
    () => corruptedStore.init(),
    /envelope authentication failed/,
  );
  corruptedStore.close();

  originalMasterKey.fill(0);
  vaultKey.fill(0);
});

test('runtime server vault key failures close every managed operation without changing data', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-managed-vault-key-runtime-');
  const tenantId = 'managed-runtime-tenant';
  const vaultKey = generateVaultKey();
  const store = await new SnapshotStore(directory).init();
  t.after(() => store.close());
  const initial = await store.putConditional(
    tenantId,
    encryptSnapshot({ schemaVersion: 1, files: [] }, vaultKey),
    { ifNoneMatch: '*' },
  );
  await store.adoptManagedVaultKey(tenantId, vaultKey);
  const replacementBlob = encryptSnapshot({ schemaVersion: 1, files: [] }, vaultKey);
  const masterKeyPath = path.join(directory, DEFAULT_SERVER_MASTER_KEY_FILENAME);
  const originalMasterKey = await readFile(masterKeyPath);

  async function assertFailClosed() {
    await assert.rejects(() => store.assertServerMasterKeyHealthy());
    for (const operation of [
      () => store.managedVaultKeyStatus(tenantId),
      () => store.unlockManagedVaultKey(tenantId),
      () => store.adoptManagedVaultKey(tenantId, vaultKey),
      () => store.createManagedDeviceInvitation(tenantId, { ttlMs: 60_000 }),
      () => store.putConditional(tenantId, replacementBlob, {
        ifMatch: initial.etag,
        requireManagedKey: true,
      }),
    ]) {
      await assert.rejects(
        operation,
        (error) => error instanceof ManagedVaultKeyError
          && error.code === 'vault_key_service_unavailable'
          && error.statusCode === 503,
      );
    }
    assert.equal((await store.get(tenantId)).etag, initial.etag);
    assert.equal((await store.listRevisions(tenantId)).length, 1);
    assert.equal(store.hasManagedVaultKey(tenantId), true);
    assert.equal(inspectServerDatabase(
      directory,
      (database) => Number(database.prepare(`
        SELECT count(*) AS count FROM invitations WHERE tenant_id = ?
      `).get(tenantId).count),
    ), 0);
  }

  if (process.platform !== 'win32') {
    await chmod(masterKeyPath, 0o644);
    await assertFailClosed();
    await chmod(masterKeyPath, 0o600);
    assert.equal(await store.assertServerMasterKeyHealthy(), true);
  }

  const replacementMasterKey = randomBytes(32);
  await writeFile(masterKeyPath, replacementMasterKey);
  if (process.platform !== 'win32') await chmod(masterKeyPath, 0o600);
  await assertFailClosed();
  replacementMasterKey.fill(0);
  await writeFile(masterKeyPath, originalMasterKey);
  if (process.platform !== 'win32') await chmod(masterKeyPath, 0o600);
  assert.equal(await store.assertServerMasterKeyHealthy(), true);

  await rm(masterKeyPath);
  await assertFailClosed();
  await writeFile(masterKeyPath, originalMasterKey, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(masterKeyPath, 0o600);
  assert.equal(await store.assertServerMasterKeyHealthy(), true);

  if (process.platform !== 'win32') {
    const symlinkTarget = path.join(directory, 'server-vault-key-target');
    await writeFile(symlinkTarget, originalMasterKey, { mode: 0o600 });
    await chmod(symlinkTarget, 0o600);
    await rm(masterKeyPath);
    await symlink(symlinkTarget, masterKeyPath);
    await assertFailClosed();
    await rm(masterKeyPath);
    await writeFile(masterKeyPath, originalMasterKey, { mode: 0o600 });
    await chmod(masterKeyPath, 0o600);
    assert.equal(await store.assertServerMasterKeyHealthy(), true);
  }

  const unlocked = await store.unlockManagedVaultKey(tenantId);
  assert.deepEqual(unlocked, vaultKey);
  unlocked.fill(0);
  originalMasterKey.fill(0);
  vaultKey.fill(0);
});

test('vault reset serializes against account-created connection codes', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-managed-connection-reset-race-');
  const first = await new SnapshotStore(directory).init();
  const second = await new SnapshotStore(directory).init();
  t.after(() => {
    first.close();
    second.close();
  });
  const tenantId = 'managed-connection-reset-race';
  const vaultKey = generateVaultKey();
  const initialized = await first.putConditional(
    tenantId,
    encryptSnapshot({ schemaVersion: 1, files: [] }, vaultKey),
    { ifNoneMatch: '*' },
  );
  await first.adoptManagedVaultKey(tenantId, vaultKey);
  const replacementKey = generateVaultKey();
  const [reset, connection] = await Promise.allSettled([
    first.resetVault(
      tenantId,
      encryptSnapshot({ schemaVersion: 1, files: [] }, replacementKey),
      { ifMatch: initialized.etag },
    ),
    second.createManagedDeviceInvitation(tenantId, { ttlMs: 60_000 }),
  ]);
  assert.equal(reset.status, 'fulfilled');
  if (connection.status === 'fulfilled') connection.value.connectionSecret.fill(0);
  else {
    assert.equal(connection.reason instanceof ManagedVaultKeyError, true);
    assert.equal(connection.reason.code, 'legacy_vault_key_unavailable');
  }
  assert.equal(first.hasManagedVaultKey(tenantId), false);
  assert.equal(inspectServerDatabase(
    directory,
    (database) => Number(database.prepare(`
      SELECT count(*) AS count FROM invitations WHERE tenant_id = ?
    `).get(tenantId).count),
  ), 0);
  vaultKey.fill(0);
  replacementKey.fill(0);
});

test('sync client enforces response limits while streaming chunked bodies', async (t) => {
  let requestNumber = 0;
  const server = createHttpServer((request, response) => {
    requestNumber += 1;
    response.on('error', () => {});
    if (requestNumber === 1) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.write(Buffer.alloc(24, 1));
      response.end(Buffer.alloc(24, 2));
      return;
    }
    if (requestNumber === 2) {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '1024',
      });
      response.end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      ETag: `"${'0'.repeat(64)}"`,
    });
    response.end(Buffer.from('safe-size-but-wrong-etag'));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const client = new SyncClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    deviceToken: `hndd_${'A'.repeat(43)}`,
    maxBlobBytes: 32,
  });

  await assert.rejects(() => client.getEncryptedSnapshot(), /exceeds 32 byte limit/);
  await assert.rejects(() => client.getEncryptedSnapshot(), /exceeds 32 byte limit/);
  await assert.rejects(() => client.getEncryptedSnapshot(), /ETag does not match/);
});

test('control store serializes mutations across independent server/admin instances', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-control-lock-');
  const first = new ControlStore(directory);
  const second = new ControlStore(directory);
  t.after(() => first.close());
  t.after(() => second.close());
  await Promise.all([first.init(), second.init()]);
  await Promise.all([
    ...Array.from({ length: 8 }, (_, index) => first.createEnrollmentKey(`tenant-a-${index}`)),
    ...Array.from({ length: 8 }, (_, index) => second.createEnrollmentKey(`tenant-b-${index}`)),
  ]);
  const enrollmentCount = inspectServerDatabase(
    directory,
    (database) => Number(database.prepare('SELECT count(*) AS count FROM enrollments').get().count),
  );
  assert.equal(enrollmentCount, 16);
});

test('bearer credentials use indexed token-hash lookups without scanning token tables', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-indexed-token-lookup-');
  const control = await new ControlStore(directory).init();
  t.after(() => control.close());

  const statements = [];
  const database = control.getDatabase();
  const prepare = database.prepare.bind(database);
  database.prepare = (sql) => {
    statements.push(String(sql).replace(/\s+/g, ' ').trim());
    return prepare(sql);
  };

  const enrollment = await control.createEnrollmentKey('indexed-token-tenant');
  const enrolled = await control.consumeEnrollmentKey(
    enrollment.enrollmentKey,
    'indexed-enrollment-device',
  );
  const invitation = await control.createDeviceInvitation(
    'indexed-token-tenant',
    Buffer.from('indexed-wrapped-vault-key'),
  );
  await control.consumeDeviceInvitation(invitation.invitationToken, 'indexed-invitation-device');
  await control.authenticateDevice(enrolled.deviceToken);

  assert.ok(statements.includes('DELETE FROM invitations WHERE expires_at <= ?'));
  assert.equal(
    statements.some((statement) => statement.includes('SELECT id, expires_at FROM invitations')),
    false,
  );
  const prunePlan = prepare(`
    EXPLAIN QUERY PLAN DELETE FROM invitations WHERE expires_at <= ?
  `).all(new Date().toISOString());
  assert.ok(prunePlan.some((row) => (
    /SEARCH invitations USING (?:COVERING )?INDEX invitations_expires_at/.test(row.detail)
    && row.detail.includes('(expires_at<?)')
  )));

  for (const table of ['enrollments', 'invitations', 'devices']) {
    assert.ok(
      statements.includes(`SELECT * FROM ${table} WHERE token_hash = ?`),
      `missing indexed ${table} token lookup`,
    );
    assert.equal(statements.includes(`SELECT * FROM ${table}`), false);
    const queryPlan = prepare(`
      EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE token_hash = ?
    `).all('0'.repeat(64));
    assert.ok(queryPlan.some((row) => (
      row.detail.includes(`SEARCH ${table} USING INDEX`)
      && row.detail.includes('(token_hash=?)')
    )));
  }
});

test('enrollment status uses an explicit device relation and migrates legacy rows with fallback', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-enrollment-device-link-');
  const now = Date.parse('2026-09-04T03:04:05.678Z');
  const initial = await new ControlStore(directory, { clock: () => now }).init();
  const legacyEnrollment = await initial.createEnrollmentKey('enrollment-link-tenant');
  const legacyDevice = await initial.consumeEnrollmentKey(
    legacyEnrollment.enrollmentKey,
    'legacy-linked-device',
  );
  initial.close();

  const oldSchema = new DatabaseSync(path.join(directory, DEFAULT_DATABASE_FILENAME));
  oldSchema.exec(`
    DROP INDEX enrollments_device_id;
    ALTER TABLE enrollments DROP COLUMN device_id;
    DELETE FROM schema_metadata WHERE key = 'enrollment_device_backfill_v1';
  `);
  oldSchema.close();

  const control = await new ControlStore(directory, { clock: () => now }).init();
  t.after(() => control.close());
  const migrated = inspectServerDatabase(directory, (database) => ({
    columns: new Set(database.prepare('PRAGMA table_info(enrollments)').all().map((row) => row.name)),
    index: database.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'index' AND name = 'enrollments_device_id'
    `).get(),
    foreignKeyViolations: database.prepare('PRAGMA foreign_key_check').all(),
  }));
  assert.equal(migrated.columns.has('device_id'), true);
  assert.equal(migrated.index.present, 1);
  assert.deepEqual(migrated.foreignKeyViolations, []);

  const legacyStatus = await control.enrollmentStatus(
    'enrollment-link-tenant',
    legacyEnrollment.enrollmentId,
  );
  assert.equal(legacyStatus.device.id, legacyDevice.device.id);
  assert.equal(legacyStatus.device.name, 'legacy-linked-device');
  assert.equal(inspectServerDatabase(directory, (database) => database.prepare(`
    SELECT device_id FROM enrollments WHERE id = ?
  `).get(legacyEnrollment.enrollmentId).device_id), legacyDevice.device.id);

  const firstEnrollment = await control.createEnrollmentKey('enrollment-link-tenant');
  const secondEnrollment = await control.createEnrollmentKey('enrollment-link-tenant');
  const firstDevice = await control.consumeEnrollmentKey(
    firstEnrollment.enrollmentKey,
    'same-millisecond-first',
  );
  const secondDevice = await control.consumeEnrollmentKey(
    secondEnrollment.enrollmentKey,
    'same-millisecond-second',
  );
  assert.equal(firstDevice.device.createdAt, secondDevice.device.createdAt);

  const firstStatus = await control.enrollmentStatus(
    'enrollment-link-tenant',
    firstEnrollment.enrollmentId,
  );
  const secondStatus = await control.enrollmentStatus(
    'enrollment-link-tenant',
    secondEnrollment.enrollmentId,
  );
  assert.equal(firstStatus.device.id, firstDevice.device.id);
  assert.equal(firstStatus.device.name, 'same-millisecond-first');
  assert.equal(secondStatus.device.id, secondDevice.device.id);
  assert.equal(secondStatus.device.name, 'same-millisecond-second');

  const storedLinks = inspectServerDatabase(directory, (database) => database.prepare(`
    SELECT id, device_id FROM enrollments
    WHERE id IN (?, ?)
    ORDER BY id
  `).all(firstEnrollment.enrollmentId, secondEnrollment.enrollmentId));
  assert.deepEqual(
    new Map(storedLinks.map((row) => [row.id, row.device_id])),
    new Map([
      [firstEnrollment.enrollmentId, firstDevice.device.id],
      [secondEnrollment.enrollmentId, secondDevice.device.id],
    ]),
  );
});

test('legacy enrollment migration never guesses between same-instant devices', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-ambiguous-enrollment-link-');
  const now = Date.parse('2026-09-04T03:04:05.678Z');
  const initial = await new ControlStore(directory, { clock: () => now }).init();
  const firstEnrollment = await initial.createEnrollmentKey('ambiguous-link-tenant');
  const secondEnrollment = await initial.createEnrollmentKey('ambiguous-link-tenant');
  await initial.consumeEnrollmentKey(firstEnrollment.enrollmentKey, 'ambiguous-first');
  await initial.consumeEnrollmentKey(secondEnrollment.enrollmentKey, 'ambiguous-second');
  initial.close();

  const oldSchema = new DatabaseSync(path.join(directory, DEFAULT_DATABASE_FILENAME));
  oldSchema.exec(`
    DROP INDEX enrollments_device_id;
    ALTER TABLE enrollments DROP COLUMN device_id;
    DELETE FROM schema_metadata WHERE key = 'enrollment_device_backfill_v1';
  `);
  oldSchema.close();

  const control = await new ControlStore(directory, { clock: () => now }).init();
  t.after(() => control.close());
  const firstStatus = await control.enrollmentStatus(
    'ambiguous-link-tenant',
    firstEnrollment.enrollmentId,
  );
  const secondStatus = await control.enrollmentStatus(
    'ambiguous-link-tenant',
    secondEnrollment.enrollmentId,
  );
  assert.equal(firstStatus.consumed, true);
  assert.equal(secondStatus.consumed, true);
  assert.equal(firstStatus.device, null);
  assert.equal(secondStatus.device, null);
  assert.deepEqual(inspectServerDatabase(directory, (database) => database.prepare(`
    SELECT device_id FROM enrollments
    WHERE id IN (?, ?)
  `).all(firstEnrollment.enrollmentId, secondEnrollment.enrollmentId)
    .map((row) => ({ ...row }))), [
    { device_id: null },
    { device_id: null },
  ]);
});

test('legacy invitation timestamps are canonicalized before indexed expiration pruning', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-invitation-timezone-');
  const tenantId = 'legacy-invitation-timezone-tenant';
  const invitationId = randomUUID();
  let now = Date.parse('2026-09-04T05:00:00.000Z');
  await writeFile(path.join(directory, 'control.json'), `${JSON.stringify({
    schemaVersion: 1,
    enrollments: [],
    invitations: [{
      id: invitationId,
      tenantId,
      tokenHash: 'a'.repeat(64),
      wrappedVaultKey: Buffer.from('legacy-wrapped-key').toString('base64'),
      createdAt: '2026-09-03T23:00:00-10:00',
      expiresAt: '2026-09-04T01:00:00-10:00',
      usedAt: null,
    }],
    devices: [],
  })}\n`);

  const control = await new ControlStore(directory, { clock: () => now }).init();
  t.after(() => control.close());
  assert.deepEqual(inspectServerDatabase(directory, (database) => ({ ...database.prepare(`
    SELECT created_at, expires_at FROM invitations WHERE id = ?
  `).get(invitationId) })), {
    created_at: '2026-09-04T09:00:00.000Z',
    expires_at: '2026-09-04T11:00:00.000Z',
  });
  await control.listDevices(tenantId);
  assert.equal(inspectServerDatabase(directory, (database) => Number(database.prepare(`
    SELECT count(*) AS count FROM invitations WHERE id = ?
  `).get(invitationId).count)), 1);

  now = Date.parse('2026-09-04T12:00:00.000Z');
  await control.listDevices(tenantId);
  assert.equal(inspectServerDatabase(directory, (database) => Number(database.prepare(`
    SELECT count(*) AS count FROM invitations WHERE id = ?
  `).get(invitationId).count)), 0);
});

test('snapshot ETag compare-and-swap is serialized across server instances', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-snapshot-lock-');
  const first = new SnapshotStore(directory, { maxBlobBytes: 64 * 1024 });
  const second = new SnapshotStore(directory, { maxBlobBytes: 64 * 1024 });
  t.after(() => first.close());
  t.after(() => second.close());
  await Promise.all([first.init(), second.init()]);
  const initial = await first.putConditional('tenant-lock', Buffer.alloc(32 * 1024, 0), {
    ifNoneMatch: '*',
  });
  const competing = await Promise.allSettled([
    first.putConditional('tenant-lock', Buffer.alloc(32 * 1024, 1), { ifMatch: initial.etag }),
    second.putConditional('tenant-lock', Buffer.alloc(32 * 1024, 2), { ifMatch: initial.etag }),
  ]);
  assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(competing.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await first.listRevisions('tenant-lock')).length, 2);
});

test('snapshot retention bounds tenant storage and keeps the latest revisions', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-snapshot-retention-');
  const store = new SnapshotStore(directory, {
    maxBlobBytes: 64 * 1024,
    maxRevisionsPerTenant: 2,
  });
  t.after(() => store.close());
  await store.init();
  const first = await store.putConditional('tenant-retention', Buffer.from('revision-one'), {
    ifNoneMatch: '*',
  });
  const second = await store.putConditional('tenant-retention', Buffer.from('revision-two'), {
    ifMatch: first.etag,
  });
  const third = await store.putConditional('tenant-retention', Buffer.from('revision-three'), {
    ifMatch: second.etag,
  });

  assert.deepEqual(
    (await store.listRevisions('tenant-retention')).map((revision) => revision.id).sort(),
    [second.revisionId, third.revisionId].sort(),
  );
  assert.equal(await store.getRevision('tenant-retention', first.revisionId), null);
  assert.deepEqual((await store.getRevision('tenant-retention', third.revisionId)).blob, Buffer.from('revision-three'));
});

test('device names can be changed only inside their tenant while the device is active', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-device-name-');
  const control = new ControlStore(directory);
  t.after(() => control.close());
  await control.init();

  const enrollment = await control.createEnrollmentKey('tenant-device-name');
  const enrolled = await control.consumeEnrollmentKey(enrollment.enrollmentKey, 'old-name');
  assert.equal(
    await control.renameDevice('other-tenant', enrolled.device.id, 'wrong-tenant'),
    null,
  );
  const renamed = await control.renameDevice(
    'tenant-device-name',
    enrolled.device.id,
    '  개발 서버 🛠️  ',
  );
  assert.equal(renamed.name, '개발 서버 🛠️');
  assert.equal((await control.listDevices('tenant-device-name'))[0].name, '개발 서버 🛠️');
  await assert.rejects(
    () => control.renameDevice('tenant-device-name', enrolled.device.id, '   '),
    /Invalid device name/u,
  );
  await assert.rejects(
    () => control.renameDevice('tenant-device-name', enrolled.device.id, 'a'.repeat(101)),
    /Invalid device name/u,
  );
  await control.revokeDevice('tenant-device-name', enrolled.device.id);
  assert.equal(
    await control.renameDevice('tenant-device-name', enrolled.device.id, 'revoked-name'),
    null,
  );
});

test('vault reset is atomic, tenant-scoped, and blocked while an active device exists', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-vault-reset-');
  const snapshots = new SnapshotStore(directory, { maxBlobBytes: 64 * 1024 });
  const control = new ControlStore(directory);
  t.after(() => snapshots.close());
  t.after(() => control.close());
  await Promise.all([snapshots.init(), control.init()]);

  const tenantA = 'tenant-reset-a';
  const tenantB = 'tenant-reset-b';
  const firstA = await snapshots.putConditional(tenantA, Buffer.from('tenant-a-first'), {
    ifNoneMatch: '*',
  });
  const currentA = await snapshots.putConditional(tenantA, Buffer.from('tenant-a-current'), {
    ifMatch: firstA.etag,
  });
  const currentB = await snapshots.putConditional(tenantB, Buffer.from('tenant-b-current'), {
    ifNoneMatch: '*',
  });

  const unusedA = await control.createEnrollmentKey(tenantA);
  const usedA = await control.createEnrollmentKey(tenantA);
  const enrolledA = await control.consumeEnrollmentKey(usedA.enrollmentKey, 'revoked-reset-device');
  const unusedB = await control.createEnrollmentKey(tenantB);
  const invitationA = await control.createDeviceInvitation(tenantA, Buffer.from('wrapped-a'));
  const invitationB = await control.createDeviceInvitation(tenantB, Buffer.from('wrapped-b'));

  await assert.rejects(
    () => snapshots.resetVault(tenantA, Buffer.from('tenant-a-reset'), { ifMatch: currentA.etag }),
    (error) => error instanceof VaultResetError
      && error.code === 'active_devices_present'
      && error.activeDeviceCount === 1
      && error.currentEtag === currentA.etag,
  );
  assert.equal((await control.enrollmentStatus(tenantA, unusedA.enrollmentId)).consumed, false);
  assert.equal((await snapshots.listRevisions(tenantA)).length, 2);

  await control.revokeDevice(tenantA, enrolledA.device.id);
  await assert.rejects(
    () => snapshots.resetVault(tenantA, Buffer.from('tenant-a-reset')),
    (error) => error instanceof PreconditionRequiredError && error.currentEtag === currentA.etag,
  );
  await assert.rejects(
    () => snapshots.resetVault(tenantA, Buffer.from('tenant-a-reset'), { ifMatch: firstA.etag }),
    (error) => error instanceof PreconditionFailedError && error.currentEtag === currentA.etag,
  );
  await assert.rejects(
    () => snapshots.resetVault(tenantA, Buffer.from('tenant-a-reset'), { ifMatch: '*' }),
    (error) => error instanceof PreconditionFailedError && error.currentEtag === currentA.etag,
  );

  const resetBlob = Buffer.from('tenant-a-reset');
  const reset = await snapshots.resetVault(tenantA, resetBlob, { ifMatch: currentA.etag });
  assert.deepEqual(await snapshots.get(tenantA), { blob: resetBlob, etag: reset.etag });
  assert.deepEqual(
    (await snapshots.listRevisions(tenantA)).map((revision) => revision.id),
    [reset.revisionId],
  );
  assert.equal(await control.enrollmentStatus(tenantA, unusedA.enrollmentId), null);
  assert.equal((await control.enrollmentStatus(tenantA, usedA.enrollmentId)).consumed, true);
  const remainingDevices = await control.listDevices(tenantA);
  assert.equal(remainingDevices.length, 1);
  assert.equal(remainingDevices[0].id, enrolledA.device.id);
  assert.ok(remainingDevices[0].revokedAt);

  const databaseState = inspectServerDatabase(directory, (database) => ({
    tenantAInvitations: Number(database.prepare(
      'SELECT count(*) AS count FROM invitations WHERE tenant_id = ?',
    ).get(tenantA).count),
    tenantBInvitations: Number(database.prepare(
      'SELECT count(*) AS count FROM invitations WHERE tenant_id = ?',
    ).get(tenantB).count),
    foreignKeyViolations: database.prepare('PRAGMA foreign_key_check').all(),
  }));
  assert.equal(databaseState.tenantAInvitations, 0);
  assert.equal(databaseState.tenantBInvitations, 1);
  assert.deepEqual(databaseState.foreignKeyViolations, []);
  assert.equal(await control.enrollmentStatus(tenantB, unusedB.enrollmentId) !== null, true);
  assert.equal((await snapshots.get(tenantB)).etag, currentB.etag);
  assert.equal(invitationA.tenantId, tenantA);
  assert.equal(invitationB.tenantId, tenantB);

  await assert.rejects(
    () => snapshots.resetVault('tenant-without-vault', Buffer.from('new-vault'), {
      ifMatch: `"${'0'.repeat(64)}"`,
    }),
    (error) => error instanceof VaultResetError && error.code === 'vault_not_initialized',
  );
});

test('concurrent vault resets serialize their ETag comparison', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-vault-reset-race-');
  const first = new SnapshotStore(directory, { maxBlobBytes: 64 * 1024 });
  const second = new SnapshotStore(directory, { maxBlobBytes: 64 * 1024 });
  t.after(() => first.close());
  t.after(() => second.close());
  await Promise.all([first.init(), second.init()]);
  const initial = await first.putConditional('tenant-reset-race', Buffer.from('initial'), {
    ifNoneMatch: '*',
  });

  const competing = await Promise.allSettled([
    first.resetVault('tenant-reset-race', Buffer.from('first-reset'), { ifMatch: initial.etag }),
    second.resetVault('tenant-reset-race', Buffer.from('second-reset'), { ifMatch: initial.etag }),
  ]);
  assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = competing.find((result) => result.status === 'rejected');
  assert.ok(rejected.reason instanceof PreconditionFailedError);
  assert.equal((await first.listRevisions('tenant-reset-race')).length, 1);
});

test('legacy vault reset serializes against managed-key adoption and preserves the vault', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-vault-adopt-reset-race-');
  const first = await new SnapshotStore(directory, { maxBlobBytes: 64 * 1024 }).init();
  const second = await new SnapshotStore(directory, { maxBlobBytes: 64 * 1024 }).init();
  t.after(() => {
    first.close();
    second.close();
  });

  const tenantId = 'tenant-adopt-before-legacy-reset';
  const vaultKey = generateVaultKey();
  const initialBlob = encryptSnapshot(
    { schemaVersion: 1, files: [] },
    vaultKey,
  );
  const initial = await first.putConditional(tenantId, initialBlob, { ifNoneMatch: '*' });
  assert.equal(first.hasManagedVaultKey(tenantId), false);

  await first.adoptManagedVaultKey(tenantId, vaultKey);
  const resetKey = generateVaultKey();
  await assert.rejects(
    () => second.resetVault(
      tenantId,
      encryptSnapshot({ schemaVersion: 1, files: [] }, resetKey),
      { ifMatch: initial.etag, requireUnmanagedKey: true },
    ),
    (error) => error instanceof VaultResetError
      && error.code === 'vault_already_managed'
      && error.statusCode === 409
      && error.currentEtag === initial.etag,
  );

  assert.deepEqual(await second.get(tenantId), { blob: initialBlob, etag: initial.etag });
  assert.equal((await first.listRevisions(tenantId)).length, 1);
  assert.equal(second.hasManagedVaultKey(tenantId), true);
  const unlocked = await second.unlockManagedVaultKey(tenantId);
  assert.deepEqual(unlocked, vaultKey);

  unlocked.fill(0);
  vaultKey.fill(0);
  resetKey.fill(0);
});

test('vault reset rolls back every cleanup operation when its transaction fails', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-vault-reset-rollback-');
  const snapshots = new SnapshotStore(directory, { maxBlobBytes: 64 * 1024 });
  const control = new ControlStore(directory);
  t.after(() => snapshots.close());
  t.after(() => control.close());
  await Promise.all([snapshots.init(), control.init()]);

  const tenantId = 'tenant-reset-rollback';
  const initial = await snapshots.putConditional(tenantId, Buffer.from('rollback-initial'), {
    ifNoneMatch: '*',
  });
  const enrollment = await control.createEnrollmentKey(tenantId);
  await control.createDeviceInvitation(tenantId, Buffer.from('rollback-wrapped-key'));

  const database = new DatabaseSync(path.join(directory, DEFAULT_DATABASE_FILENAME));
  try {
    database.exec(`
      CREATE TRIGGER force_vault_reset_rollback
      BEFORE DELETE ON revisions
      WHEN OLD.tenant_id = 'tenant-reset-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced vault reset rollback');
      END;
    `);
  } finally {
    database.close();
  }

  await assert.rejects(
    () => snapshots.resetVault(tenantId, Buffer.from('rollback-replacement'), {
      ifMatch: initial.etag,
    }),
    /forced vault reset rollback/,
  );
  assert.equal((await snapshots.get(tenantId)).etag, initial.etag);
  assert.deepEqual(
    (await snapshots.listRevisions(tenantId)).map((revision) => revision.id),
    [initial.revisionId],
  );
  assert.equal((await control.enrollmentStatus(tenantId, enrollment.enrollmentId)).consumed, false);
  const preserved = inspectServerDatabase(directory, (readOnlyDatabase) => ({
    invitations: Number(readOnlyDatabase.prepare(
      'SELECT count(*) AS count FROM invitations WHERE tenant_id = ?',
    ).get(tenantId).count),
    foreignKeyViolations: readOnlyDatabase.prepare('PRAGMA foreign_key_check').all(),
  }));
  assert.equal(preserved.invitations, 1);
  assert.deepEqual(preserved.foreignKeyViolations, []);
});

test('vault reset serializes safely against snapshot writes and invitation joins', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-vault-reset-interleavings-');
  const first = new SnapshotStore(directory, { maxBlobBytes: 64 * 1024 });
  const second = new SnapshotStore(directory, { maxBlobBytes: 64 * 1024 });
  const control = new ControlStore(directory);
  t.after(() => first.close());
  t.after(() => second.close());
  t.after(() => control.close());
  await Promise.all([first.init(), second.init(), control.init()]);

  const resetFirstTenant = 'tenant-reset-before-write';
  const resetFirstInitial = await first.putConditional(
    resetFirstTenant,
    Buffer.from('reset-first-initial'),
    { ifNoneMatch: '*' },
  );
  const resetBeforeWrite = await Promise.allSettled([
    first.resetVault(resetFirstTenant, Buffer.from('reset-first'), {
      ifMatch: resetFirstInitial.etag,
    }),
    second.putConditional(resetFirstTenant, Buffer.from('stale-write'), {
      ifMatch: resetFirstInitial.etag,
    }),
  ]);
  assert.equal(resetBeforeWrite[0].status, 'fulfilled');
  assert.ok(resetBeforeWrite[1].reason instanceof PreconditionFailedError);

  const writeFirstTenant = 'tenant-write-before-reset';
  const writeFirstInitial = await first.putConditional(
    writeFirstTenant,
    Buffer.from('write-first-initial'),
    { ifNoneMatch: '*' },
  );
  const writeBeforeReset = await Promise.allSettled([
    first.putConditional(writeFirstTenant, Buffer.from('write-first'), {
      ifMatch: writeFirstInitial.etag,
    }),
    second.resetVault(writeFirstTenant, Buffer.from('stale-reset'), {
      ifMatch: writeFirstInitial.etag,
    }),
  ]);
  assert.equal(writeBeforeReset[0].status, 'fulfilled');
  assert.ok(writeBeforeReset[1].reason instanceof PreconditionFailedError);

  const resetBeforeJoinTenant = 'tenant-reset-before-join';
  const resetBeforeJoinInitial = await first.putConditional(
    resetBeforeJoinTenant,
    Buffer.from('join-first-initial'),
    { ifNoneMatch: '*' },
  );
  const resetBeforeJoinInvitation = await control.createDeviceInvitation(
    resetBeforeJoinTenant,
    Buffer.from('wrapped-before-join'),
  );
  const resetBeforeJoin = await Promise.allSettled([
    first.resetVault(resetBeforeJoinTenant, Buffer.from('reset-before-join'), {
      ifMatch: resetBeforeJoinInitial.etag,
    }),
    control.consumeDeviceInvitation(resetBeforeJoinInvitation.invitationToken, 'late-device'),
  ]);
  assert.equal(resetBeforeJoin[0].status, 'fulfilled');
  assert.ok(resetBeforeJoin[1].reason instanceof AuthenticationError);
  assert.equal((await control.listDevices(resetBeforeJoinTenant)).length, 0);

  const joinBeforeResetTenant = 'tenant-join-before-reset';
  const joinBeforeResetInitial = await first.putConditional(
    joinBeforeResetTenant,
    Buffer.from('reset-second-initial'),
    { ifNoneMatch: '*' },
  );
  const joinBeforeResetInvitation = await control.createDeviceInvitation(
    joinBeforeResetTenant,
    Buffer.from('wrapped-before-reset'),
  );
  const joinBeforeReset = await Promise.allSettled([
    control.consumeDeviceInvitation(joinBeforeResetInvitation.invitationToken, 'early-device'),
    second.resetVault(joinBeforeResetTenant, Buffer.from('reset-after-join'), {
      ifMatch: joinBeforeResetInitial.etag,
    }),
  ]);
  assert.equal(joinBeforeReset[0].status, 'fulfilled');
  assert.ok(joinBeforeReset[1].reason instanceof VaultResetError);
  assert.equal(joinBeforeReset[1].reason.code, 'active_devices_present');
  assert.equal((await first.get(joinBeforeResetTenant)).etag, joinBeforeResetInitial.etag);

  assert.deepEqual(
    inspectServerDatabase(
      directory,
      (readOnlyDatabase) => readOnlyDatabase.prepare('PRAGMA foreign_key_check').all(),
    ),
    [],
  );
});

test('legacy file-backed control and snapshots migrate into the single SQLite database', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-sync-legacy-migration-');
  const tenantId = 'legacy-tenant';
  const deviceToken = `hndd_${'A'.repeat(43)}`;
  const now = new Date().toISOString();
  await writeFile(path.join(directory, 'control.json'), `${JSON.stringify({
    schemaVersion: 1,
    enrollments: [],
    invitations: [],
    devices: [{
      id: randomUUID(),
      tenantId,
      tokenHash: createHash('sha256').update(deviceToken).digest('hex'),
      name: 'legacy-device',
      createdAt: now,
      revokedAt: null,
    }],
  })}\n`);
  const blob = Buffer.from('legacy-opaque-snapshot');
  const revisionId = createHash('sha256').update(blob).digest('hex');
  const revisionsDirectory = path.join(directory, 'tenants', tenantId, 'revisions');
  await mkdir(revisionsDirectory, { recursive: true });
  await writeFile(path.join(revisionsDirectory, `${revisionId}.bin`), blob);
  await writeFile(path.join(directory, 'tenants', tenantId, 'snapshot.bin'), blob);

  const control = await new ControlStore(directory).init();
  const snapshots = await new SnapshotStore(directory).init();
  t.after(() => control.close());
  t.after(() => snapshots.close());

  assert.equal((await control.authenticateDevice(deviceToken)).name, 'legacy-device');
  assert.deepEqual((await snapshots.get(tenantId)).blob, blob);
  const migrated = inspectServerDatabase(directory, (database) => ({
    devices: Number(database.prepare('SELECT count(*) AS count FROM devices').get().count),
    revisions: Number(database.prepare('SELECT count(*) AS count FROM revisions').get().count),
    markers: Number(database.prepare(`
      SELECT count(*) AS count FROM schema_metadata
      WHERE key IN ('legacy_control_imported', 'legacy_snapshots_imported')
    `).get().count),
  }));
  assert.deepEqual(migrated, { devices: 1, revisions: 1, markers: 2 });
});

test('capture/restore has a fixed allowlist and validates everything before writing', async (t) => {
  const source = await temporaryDirectory(t, 'hnd-sync-capture-source-');
  await mkdir(path.join(source, 'policies'), { recursive: true });
  await mkdir(path.join(source, 'repositories', 'repo-a', 'handoffs'), { recursive: true });
  await mkdir(path.join(source, 'secrets'), { recursive: true });
  await mkdir(path.join(source, 'cache'), { recursive: true });
  await writeFile(path.join(source, 'policies', 'global.md'), 'allowed-global');
  await writeFile(path.join(source, 'repositories.json'), '{"repo-a":true}');
  await writeFile(path.join(source, 'repositories', 'repo-a', 'policy.md'), 'allowed-repo');
  await writeFile(path.join(source, 'repositories', 'repo-a', 'handoffs', 'current.md'), 'allowed-handoff');
  await writeFile(path.join(source, 'config.json'), 'EXCLUDED_ACTIVE_ENVIRONMENT');
  await writeFile(path.join(source, 'bindings.json'), 'EXCLUDED_LOCAL_PATH');
  await writeFile(path.join(source, 'local-override.md'), 'EXCLUDED_LOCAL_OVERRIDE');
  await writeFile(path.join(source, 'guard.md'), 'EXCLUDED_GUARD');
  await writeFile(path.join(source, 'remotes.json'), 'EXCLUDED_REMOTE_TOKEN');
  await writeFile(path.join(source, 'secrets', 'vault.key'), 'EXCLUDED_SECRET');
  await writeFile(path.join(source, 'cache', 'snapshot.bin'), 'EXCLUDED_CACHE');

  const snapshot = await captureSyncSnapshot(source);
  assert.deepEqual(snapshot.files.map((file) => file.path), [
    'policies/global.md',
    'repositories.json',
    'repositories/repo-a/handoffs/current.md',
    'repositories/repo-a/policy.md',
  ]);
  const serialized = JSON.stringify(snapshot);
  for (const excluded of [
    'EXCLUDED_ACTIVE_ENVIRONMENT',
    'EXCLUDED_LOCAL_PATH',
    'EXCLUDED_LOCAL_OVERRIDE',
    'EXCLUDED_GUARD',
    'EXCLUDED_REMOTE_TOKEN',
    'EXCLUDED_SECRET',
    'EXCLUDED_CACHE',
  ]) {
    assert.equal(serialized.includes(excluded), false);
  }

  const destination = await temporaryDirectory(t, 'hnd-sync-capture-destination-');
  await mkdir(path.join(destination, 'repositories', 'repo-a', 'handoffs'), { recursive: true });
  await mkdir(path.join(destination, 'repositories', 'stale-repo'), { recursive: true });
  await writeFile(path.join(destination, 'repositories', 'repo-a', 'handoffs', 'stale.md'), 'remove-stale-handoff');
  await writeFile(path.join(destination, 'repositories', 'stale-repo', 'policy.md'), 'remove-stale-policy');
  await writeFile(path.join(destination, 'config.json'), 'keep-local-config');
  await writeFile(path.join(destination, 'local-override.md'), 'keep-local-override');
  await writeFile(path.join(destination, 'guard.md'), 'keep-local-guard');
  const restored = await restoreSyncSnapshot(destination, snapshot);
  assert.equal(await readFile(path.join(destination, 'policies', 'global.md'), 'utf8'), 'allowed-global');
  assert.equal(await readFile(path.join(destination, 'repositories', 'repo-a', 'policy.md'), 'utf8'), 'allowed-repo');
  assert.equal(await readFile(path.join(destination, 'config.json'), 'utf8'), 'keep-local-config');
  assert.equal(await readFile(path.join(destination, 'local-override.md'), 'utf8'), 'keep-local-override');
  assert.equal(await readFile(path.join(destination, 'guard.md'), 'utf8'), 'keep-local-guard');
  assert.deepEqual(restored.removed, [
    'repositories/repo-a/handoffs/stale.md',
    'repositories/stale-repo/policy.md',
  ]);
  await assert.rejects(() => lstat(path.join(destination, 'repositories', 'stale-repo')), (error) => error.code === 'ENOENT');

  const malicious = structuredClone(snapshot);
  malicious.files[0].path = '../escape';
  assert.throws(() => validateSyncSnapshot(malicious), /traversal|allowlist|Invalid/);

  const ambiguousEnvelope = structuredClone(snapshot);
  ambiguousEnvelope.untrustedMetadata = { deeply: { nested: true } };
  assert.throws(() => validateSyncSnapshot(ambiguousEnvelope), /malformed/);

  const originalGlobal = await readFile(path.join(destination, 'policies', 'global.md'), 'utf8');
  const corrupt = structuredClone(snapshot);
  corrupt.files.at(-1).sha256 = '0'.repeat(64);
  await assert.rejects(() => restoreSyncSnapshot(destination, corrupt), /Digest mismatch/);
  assert.equal(await readFile(path.join(destination, 'policies', 'global.md'), 'utf8'), originalGlobal);
});

test('snapshot paths use code-point order and reject portable filesystem aliases', async (t) => {
  const source = await temporaryDirectory(t, 'hnd-sync-portable-paths-');
  await mkdir(path.join(source, 'repositories', 'Z'), { recursive: true });
  await mkdir(path.join(source, 'repositories', 'a'), { recursive: true });
  await writeFile(path.join(source, 'repositories', 'Z', 'policy.md'), 'upper');
  await writeFile(path.join(source, 'repositories', 'a', 'policy.md'), 'lower');

  const snapshot = await captureSyncSnapshot(source);
  assert.deepEqual(snapshot.files.map((file) => file.path), [
    'repositories/Z/policy.md',
    'repositories/a/policy.md',
  ]);
  const reversed = structuredClone(snapshot);
  reversed.files.reverse();
  assert.deepEqual(validateSyncSnapshot(reversed).files.map((file) => file.path), [
    'repositories/Z/policy.md',
    'repositories/a/policy.md',
  ]);

  const supplementaryPlaneOrder = structuredClone(snapshot);
  supplementaryPlaneOrder.files[0].path = 'repositories/\u{10000}/policy.md';
  supplementaryPlaneOrder.files[1].path = 'repositories/\uE000/policy.md';
  assert.deepEqual(validateSyncSnapshot(supplementaryPlaneOrder).files.map((file) => file.path), [
    'repositories/\uE000/policy.md',
    'repositories/\u{10000}/policy.md',
  ]);

  const caseAlias = structuredClone(snapshot);
  caseAlias.files[0].path = 'repositories/Repo/policy.md';
  caseAlias.files[1].path = 'repositories/repo/policy.md';
  assert.throws(
    () => validateSyncSnapshot(caseAlias),
    /collision after case folding or Unicode normalization/,
  );

  const normalizationAlias = structuredClone(snapshot);
  normalizationAlias.files[0].path = 'repositories/caf\u00e9/policy.md';
  normalizationAlias.files[1].path = 'repositories/cafe\u0301/policy.md';
  assert.throws(
    () => validateSyncSnapshot(normalizationAlias),
    /collision after case folding or Unicode normalization/,
  );

  const fullCaseFoldAlias = structuredClone(snapshot);
  fullCaseFoldAlias.files[0].path = 'repositories/Stra\u00dfe/policy.md';
  fullCaseFoldAlias.files[1].path = 'repositories/STRASSE/policy.md';
  assert.throws(
    () => validateSyncSnapshot(fullCaseFoldAlias),
    /collision after case folding or Unicode normalization/,
  );

  const fileDirectoryAlias = structuredClone(snapshot);
  fileDirectoryAlias.files[0].path = 'repositories/repo/policy.md';
  fileDirectoryAlias.files[1].path = 'repositories/Repo';
  assert.throws(
    () => validateSyncSnapshot(fileDirectoryAlias),
    /collision after case folding or Unicode normalization/,
  );
});

test('capture and restore reject symlink traversal', async (t) => {
  if (process.platform === 'win32') t.skip('symlink creation requires elevated privileges on Windows');
  const source = await temporaryDirectory(t, 'hnd-sync-symlink-source-');
  const outside = await temporaryDirectory(t, 'hnd-sync-symlink-outside-');
  await writeFile(path.join(outside, 'policy.md'), 'outside-secret');
  await symlink(outside, path.join(source, 'repositories'));
  await assert.rejects(() => captureSyncSnapshot(source), /symlink/);

  const cleanSource = await temporaryDirectory(t, 'hnd-sync-symlink-clean-');
  await mkdir(path.join(cleanSource, 'repositories', 'repo-a'), { recursive: true });
  await writeFile(path.join(cleanSource, 'repositories', 'repo-a', 'policy.md'), 'inside');
  const snapshot = await captureSyncSnapshot(cleanSource);

  const destination = await temporaryDirectory(t, 'hnd-sync-symlink-destination-');
  await symlink(outside, path.join(destination, 'repositories'));
  await assert.rejects(() => restoreSyncSnapshot(destination, snapshot), /symlink/);
  assert.equal(await readFile(path.join(outside, 'policy.md'), 'utf8'), 'outside-secret');
});

test('opaque server enrolls once, stores token hashes, enforces ETags, and preserves revisions', async (t) => {
  const fixture = await startServer(t);
  const { issued, enrolled, client } = await enroll(fixture, 'tenant-a');
  const databaseBytesBefore = await readFile(path.join(
    fixture.dataDirectory,
    DEFAULT_DATABASE_FILENAME,
  ));
  assert.equal(databaseBytesBefore.includes(Buffer.from(issued.enrollmentKey)), false);
  assert.equal(databaseBytesBefore.includes(Buffer.from(enrolled.deviceToken)), false);
  const tokenHashes = inspectServerDatabase(
    fixture.dataDirectory,
    (database) => database.prepare(`
      SELECT token_hash FROM enrollments
      UNION ALL SELECT token_hash FROM devices
    `).all().map((row) => row.token_hash),
  );
  assert.ok(tokenHashes.length >= 2);
  assert.ok(tokenHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)));

  const secondEnrollment = await fetch(`${fixture.baseUrl}/v1/enroll`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${issued.enrollmentKey}` },
  });
  assert.equal(secondEnrollment.status, 401);
  assert.equal((await client.getEncryptedSnapshot()).missing, true);

  const wrappedVaultKey = randomBytes(80);
  await assert.rejects(
    () => client.createDeviceInvitation(wrappedVaultKey, { ttlSeconds: 60 }),
    (error) => error instanceof SyncHttpError
      && error.status === 410
      && error.code === 'device_delegation_retired',
  );
  const invitation = await fixture.server.control.createDeviceInvitation(
    'tenant-a',
    wrappedVaultKey,
    { ttlMs: 60_000 },
  );
  const joined = await joinDevice({
    baseUrl: fixture.baseUrl,
    invitationToken: invitation.invitationToken,
    deviceName: 'invited-device',
  });
  assert.deepEqual(joined.wrappedVaultKey, wrappedVaultKey);
  const reusedInvitation = await fetch(`${fixture.baseUrl}/v1/join`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${invitation.invitationToken}` },
  });
  assert.equal(reusedInvitation.status, 401);
  const databaseBytesAfterInvitation = await readFile(path.join(
    fixture.dataDirectory,
    DEFAULT_DATABASE_FILENAME,
  ));
  assert.equal(databaseBytesAfterInvitation.includes(Buffer.from(invitation.invitationToken)), false);
  assert.equal(databaseBytesAfterInvitation.includes(Buffer.from(joined.deviceToken)), false);
  assert.equal(inspectServerDatabase(
    fixture.dataDirectory,
    (database) => Number(database.prepare('SELECT count(*) AS count FROM invitations').get().count),
  ), 0);

  const key = generateVaultKey();
  const marker = 'SERVER-MUST-NEVER-SEE-PLAINTEXT-ea291f92';
  const firstSnapshot = { schemaVersion: 1, globalPolicy: marker, revision: 1 };
  const firstBlob = encryptSnapshot(firstSnapshot, key);
  const firstPut = await client.putEncryptedSnapshot(firstBlob);
  assert.equal(firstPut.created, true);
  assert.match(firstPut.etag, /^"[a-f0-9]{64}"$/);
  assert.match(firstPut.location, /^\/v1\/revisions\/[a-f0-9]{64}$/);

  const fetched = await client.getEncryptedSnapshot();
  assert.deepEqual(decryptSnapshot(fetched.blob, key), firstSnapshot);
  const joinedClient = new SyncClient({
    baseUrl: fixture.baseUrl,
    deviceToken: joined.deviceToken,
    maxBlobBytes: 64 * 1024,
  });
  assert.deepEqual(decryptSnapshot((await joinedClient.getEncryptedSnapshot()).blob, key), firstSnapshot);
  assert.equal(fetched.etag, firstPut.etag);
  const notModified = await client.getEncryptedSnapshot({ etag: firstPut.etag });
  assert.equal(notModified.notModified, true);

  const noPrecondition = await fetch(`${fixture.baseUrl}/v1/snapshot`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${enrolled.deviceToken}`,
      'Content-Type': 'application/octet-stream',
    },
    body: encryptSnapshot({ revision: 'rejected' }, key),
  });
  assert.equal(noPrecondition.status, 428);

  const staleEtag = `"${'0'.repeat(64)}"`;
  await assert.rejects(
    () => client.putEncryptedSnapshot(encryptSnapshot({ revision: 'stale' }, key), { etag: staleEtag }),
    (error) => error instanceof SyncHttpError && error.status === 412 && error.etag === firstPut.etag,
  );
  assert.deepEqual(decryptSnapshot((await client.getEncryptedSnapshot()).blob, key), firstSnapshot);

  const secondSnapshot = { schemaVersion: 1, globalPolicy: marker, revision: 2 };
  const secondPut = await client.putEncryptedSnapshot(encryptSnapshot(secondSnapshot, key), {
    etag: firstPut.etag,
  });
  assert.equal(secondPut.created, false);
  assert.notEqual(secondPut.etag, firstPut.etag);

  const revisions = await client.listRevisions();
  assert.equal(revisions.length, 2);
  assert.equal(revisions.filter((revision) => revision.current).length, 1);
  const firstRevisionId = firstPut.etag.slice(1, -1);
  const historical = await client.getRevision(firstRevisionId);
  assert.deepEqual(decryptSnapshot(historical.blob, key), firstSnapshot);
  assert.equal((await client.getRevision(firstRevisionId, { etag: firstPut.etag })).notModified, true);

  const serverBytes = await readTree(fixture.dataDirectory);
  assert.equal(serverBytes.includes(Buffer.from(marker)), false);
  assert.equal(serverBytes.includes(Buffer.from(issued.enrollmentKey)), false);
  assert.equal(serverBytes.includes(Buffer.from(enrolled.deviceToken)), false);
  assert.equal(serverBytes.includes(Buffer.from(invitation.invitationToken)), false);
  assert.equal(serverBytes.includes(Buffer.from(joined.deviceToken)), false);
  assert.deepEqual(fixture.errors, []);
});

test('expired invitation envelopes are garbage-collected without being disclosed', async (t) => {
  let now = Date.parse('2026-08-26T00:00:00.000Z');
  const fixture = await startServer(t, { clock: () => now });
  const { client } = await enroll(fixture, 'tenant-expired');
  const wrappedVaultKey = randomBytes(80);
  const invitation = await fixture.server.control.createDeviceInvitation(
    'tenant-expired',
    wrappedVaultKey,
    { ttlMs: 1_000 },
  );
  let storedInvitations = inspectServerDatabase(
    fixture.dataDirectory,
    (database) => database.prepare('SELECT wrapped_vault_key FROM invitations').all(),
  );
  assert.equal(storedInvitations.length, 1);
  assert.deepEqual(Buffer.from(storedInvitations[0].wrapped_vault_key), wrappedVaultKey);

  now += 1_001;
  const expired = await fetch(`${fixture.baseUrl}/v1/join`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${invitation.invitationToken}` },
  });
  assert.equal(expired.status, 401);
  storedInvitations = inspectServerDatabase(
    fixture.dataDirectory,
    (database) => database.prepare('SELECT wrapped_vault_key FROM invitations').all(),
  );
  assert.equal(storedInvitations.length, 0);
  const databaseBytes = await readFile(path.join(fixture.dataDirectory, DEFAULT_DATABASE_FILENAME));
  assert.equal(databaseBytes.includes(wrappedVaultKey), false);
});

test('tenants are isolated and a revoked device token stops working', async (t) => {
  const fixture = await startServer(t);
  const tenantA = await enroll(fixture, 'tenant-a', 'device-a');
  const tenantB = await enroll(fixture, 'tenant-b', 'device-b');
  const keyA = generateVaultKey();
  const keyB = generateVaultKey();
  await tenantA.client.pushSnapshot({ tenant: 'a' }, keyA);
  await tenantB.client.pushSnapshot({ tenant: 'b' }, keyB);
  assert.deepEqual((await tenantA.client.pullSnapshot(keyA)).snapshot, { tenant: 'a' });
  assert.deepEqual((await tenantB.client.pullSnapshot(keyB)).snapshot, { tenant: 'b' });
  assert.equal((await tenantA.client.listRevisions()).length, 1);
  assert.equal((await tenantB.client.listRevisions()).length, 1);

  const devices = await tenantA.client.listDevices();
  assert.deepEqual(devices.map((device) => device.id), [tenantA.enrolled.device.id]);
  await tenantA.client.revokeDevice(tenantA.enrolled.device.id);
  await assert.rejects(
    () => tenantA.client.getEncryptedSnapshot(),
    (error) => error instanceof SyncHttpError && error.status === 401,
  );
  assert.deepEqual((await tenantB.client.pullSnapshot(keyB)).snapshot, { tenant: 'b' });
});

test('server rejects tenant/path traversal and oversized or invalid writes without changing latest', async (t) => {
  const fixture = await startServer(t, { maxBlobBytes: 256 });
  await assert.rejects(() => fixture.server.createEnrollmentKey('../escape'), /Invalid tenant id/);
  const { enrolled } = await enroll(fixture, 'tenant-size');
  const directHeaders = {
    Authorization: `Bearer ${enrolled.deviceToken}`,
    'Content-Type': 'application/octet-stream',
    'If-None-Match': '*',
  };
  const initial = Buffer.from('opaque-initial');
  const created = await fetch(`${fixture.baseUrl}/v1/snapshot`, {
    method: 'PUT',
    headers: directHeaders,
    body: initial,
  });
  assert.equal(created.status, 201);
  const originalEtag = created.headers.get('etag');

  const oversized = await fetch(`${fixture.baseUrl}/v1/snapshot`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${enrolled.deviceToken}`,
      'Content-Type': 'application/octet-stream',
      'If-Match': originalEtag,
    },
    body: Buffer.alloc(257),
  });
  assert.equal(oversized.status, 413);

  const badMediaType = await fetch(`${fixture.baseUrl}/v1/snapshot`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${enrolled.deviceToken}`,
      'Content-Type': 'text/plain',
      'If-Match': originalEtag,
    },
    body: 'plaintext',
  });
  assert.equal(badMediaType.status, 415);

  const latest = await fetch(`${fixture.baseUrl}/v1/snapshot`, {
    headers: { Authorization: `Bearer ${enrolled.deviceToken}` },
  });
  assert.equal(latest.headers.get('etag'), originalEtag);
  assert.deepEqual(Buffer.from(await latest.arrayBuffer()), initial);

  const traversal = await fetch(`${fixture.baseUrl}/v1/revisions/%2e%2e%2fcontrol.json`, {
    headers: { Authorization: `Bearer ${enrolled.deviceToken}` },
  });
  assert.equal(traversal.status, 404);
  const dataEntries = await readdir(path.dirname(fixture.dataDirectory));
  assert.equal(dataEntries.includes('escape'), false);
  assert.deepEqual(fixture.errors, []);
});

test('serverMain matches the executable contract for help and one-time enrollment issuance', async (t) => {
  let help = '';
  const noServer = await serverMain(['--help'], {
    env: {},
    stdout: { write: (chunk) => { help += chunk; } },
  });
  assert.equal(noServer, null);
  assert.match(help, /hnd-server enroll TENANT/);

  const dataDirectory = await temporaryDirectory(t, 'hnd-server-main-');
  let output = '';
  const enrollment = await serverMain([
    'enroll',
    'tenant-main',
    '--data-dir',
    dataDirectory,
    '--ttl-seconds',
    '60',
  ], {
    env: {},
    stdout: { write: (chunk) => { output += chunk; } },
  });
  assert.equal(output.trim(), enrollment.enrollmentKey);
  const databasePath = path.join(dataDirectory, DEFAULT_DATABASE_FILENAME);
  const databaseBytes = await readFile(databasePath);
  assert.equal(databaseBytes.includes(Buffer.from(enrollment.enrollmentKey)), false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  }
});
