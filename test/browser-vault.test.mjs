import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  decryptBytes as decryptBytesNode,
  decryptSnapshot as decryptSnapshotNode,
  encryptBytes as encryptBytesNode,
  encryptSnapshot as encryptSnapshotNode,
  parseVaultKey,
  serializeVaultKey,
} from '../src/sync/crypto.mjs';
import {
  createIndexedDbVaultStorage,
  createBrowserVault,
  createWrappingKey,
  decryptBytes,
  decryptSnapshot,
  deleteBrowserVault,
  encryptBytes,
  encryptSnapshot,
  generateVaultKey,
  importBrowserVault,
  loadBrowserVault,
  SNAPSHOT_AUTHENTICATION_ERROR_CODE,
  unwrapVaultKey,
  wrapVaultKey,
} from '../src/browser/index.mjs';
import {
  adoptBrowserVaultKey,
  createAccountConnection,
  listLocalVaultIds,
  resetBrowserVault,
  unlockBrowserVault,
  unlockManagedBrowserVault,
} from '../src/web/vault.js';
import { ApiError } from '../src/web/api.js';

function memoryStorage() {
  const records = new Map();
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));
  return {
    async get(key) {
      // Yield once so concurrent initialization exercises insertIfAbsent.
      await Promise.resolve();
      return clone(records.get(key));
    },
    async insertIfAbsent(key, value) {
      if (records.has(key)) return false;
      records.set(key, clone(value));
      return true;
    },
    async delete(key) {
      records.delete(key);
    },
    async keys() {
      return [...records.keys()];
    },
    inspect(key) {
      return clone(records.get(key));
    },
    replace(key, value) {
      records.set(key, clone(value));
    },
  };
}

test('local vault discovery enumerates only validated vault record keys', async () => {
  const storage = memoryStorage();
  await Promise.all([
    createBrowserVault({ storage, crypto: webcrypto, vaultId: 'tenant-one' }),
    createBrowserVault({ storage, crypto: webcrypto, vaultId: 'tenant.two' }),
  ]);
  storage.replace('unrelated', { value: true });
  storage.replace('hnd:vault:bad/id', { value: true });
  assert.deepEqual(
    await listLocalVaultIds({ storage }),
    ['tenant-one', 'tenant.two'],
  );
});

test('missing browser vault directs the user to the managed account unlock path', async () => {
  await assert.rejects(
    unlockBrowserVault('missing-vault', {
      storage: memoryStorage(),
      loadBrowserVault: async () => null,
    }),
    /오프라인 보관함 키[\s\S]*패스키[\s\S]*계정 보관함/u,
  );
});

test('browser WebCrypto snapshots are byte-compatible with the existing Node envelope', async () => {
  const vaultKey = generateVaultKey({ crypto: webcrypto });
  assert.equal(vaultKey.byteLength, 32);
  assert.notDeepEqual(vaultKey, new Uint8Array(32));
  assert.deepEqual(parseVaultKey(serializeVaultKey(vaultKey)), Buffer.from(vaultKey));

  const snapshot = {
    schemaVersion: 1,
    files: [{
      path: 'policies/global.md',
      encoding: 'base64',
      bytes: 6,
      sha256: 'a'.repeat(64),
      content: 'aG5kIPCfmIA=',
    }],
  };
  const browserEnvelope = await encryptSnapshot(snapshot, vaultKey, { crypto: webcrypto });
  assert.deepEqual(Array.from(browserEnvelope.subarray(0, 5)), [0x48, 0x4e, 0x44, 0x45, 1]);
  assert.deepEqual(decryptSnapshotNode(browserEnvelope, vaultKey), snapshot);

  const nodeEnvelope = encryptSnapshotNode(snapshot, vaultKey);
  assert.deepEqual(await decryptSnapshot(nodeEnvelope, vaultKey, { crypto: webcrypto }), snapshot);

  const arbitrary = Uint8Array.of(0, 1, 2, 127, 128, 254, 255);
  assert.deepEqual(
    decryptBytesNode(await encryptBytes(arbitrary, vaultKey, { crypto: webcrypto }), vaultKey),
    Buffer.from(arbitrary),
  );
  assert.deepEqual(
    await decryptBytes(encryptBytesNode(arbitrary, vaultKey), vaultKey, { crypto: webcrypto }),
    arbitrary,
  );

  const tampered = browserEnvelope.slice();
  tampered[tampered.byteLength - 1] ^= 1;
  await assert.rejects(
    decryptSnapshot(tampered, vaultKey, { crypto: webcrypto }),
    (error) =>
      error?.code === SNAPSHOT_AUTHENTICATION_ERROR_CODE &&
      /authentication failed/.test(error.message),
  );
  await assert.rejects(
    encryptBytes(Uint8Array.of(1, 2), vaultKey, { crypto: webcrypto, maxBytes: 1 }),
    /byte limit/,
  );
  await assert.rejects(
    encryptBytes(Uint8Array.of(1), new Uint8Array(31), { crypto: webcrypto }),
    /exactly 32 bytes/,
  );
});

test('a non-extractable IndexedDB-compatible key wraps the raw vault key at rest', async () => {
  const storage = memoryStorage();
  const options = { storage, crypto: webcrypto, vaultId: 'primary' };
  assert.equal(await loadBrowserVault(options), null);
  const [first, second] = await Promise.all([
    createBrowserVault(options),
    createBrowserVault(options),
  ]);

  assert.equal(Number(first.created) + Number(second.created), 1);
  assert.deepEqual(first.vaultKey, second.vaultKey);
  const recordKey = 'hnd:vault:primary';
  const record = storage.inspect(recordKey);
  assert.deepEqual(Object.keys(record).sort(), [
    'kind',
    'schemaVersion',
    'vaultId',
    'wrappedVaultKey',
    'wrappingKey',
  ]);
  assert.equal(record.vaultId, 'primary');
  assert.equal(record.wrappingKey.extractable, false);
  assert.equal(record.wrappingKey.algorithm.name, 'AES-GCM');
  assert.equal(record.wrappingKey.algorithm.length, 256);
  assert.equal(record.wrappedVaultKey.byteLength, 65);
  assert.equal('vaultKey' in record, false);
  assert.equal('passkey' in record, false);
  assert.equal('credentialId' in record, false);
  await assert.rejects(webcrypto.subtle.exportKey('raw', record.wrappingKey));

  const loaded = await loadBrowserVault(options);
  assert.equal(loaded.created, false);
  assert.deepEqual(loaded.vaultKey, first.vaultKey);

  const directWrappingKey = await createWrappingKey({ crypto: webcrypto });
  const directEnvelope = await wrapVaultKey(first.vaultKey, directWrappingKey, {
    crypto: webcrypto,
    vaultId: 'primary',
  });
  assert.deepEqual(await unwrapVaultKey(directEnvelope, directWrappingKey, {
    crypto: webcrypto,
    vaultId: 'primary',
  }), first.vaultKey);
  await assert.rejects(
    unwrapVaultKey(directEnvelope, directWrappingKey, {
      crypto: webcrypto,
      vaultId: 'different',
    }),
    /authentication failed/,
  );
  const extractableKey = await webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  await assert.rejects(
    wrapVaultKey(first.vaultKey, extractableKey, {
      crypto: webcrypto,
      vaultId: 'primary',
    }),
    /non-extractable/,
  );

  await deleteBrowserVault(options);
  assert.equal(await loadBrowserVault(options), null);
});

test('stored vault corruption fails closed and never replaces the existing record', async () => {
  const storage = memoryStorage();
  const options = { storage, crypto: webcrypto, vaultId: 'corruption-test' };
  await createBrowserVault(options);
  const recordKey = 'hnd:vault:corruption-test';
  const corrupted = storage.inspect(recordKey);
  corrupted.wrappedVaultKey[corrupted.wrappedVaultKey.byteLength - 1] ^= 1;
  storage.replace(recordKey, corrupted);

  await assert.rejects(loadBrowserVault(options), /authentication failed/);
  await assert.rejects(createBrowserVault(options), /authentication failed/);
  assert.deepEqual(storage.inspect(recordKey).wrappedVaultKey, corrupted.wrappedVaultKey);
});

test('vault-key import is idempotent, conflict-safe, and atomic across tabs', async () => {
  const storage = memoryStorage();
  const vaultKey = generateVaultKey({ crypto: webcrypto });
  const originalInput = vaultKey.slice();
  const options = {
    storage,
    crypto: webcrypto,
    vaultId: 'invited-vault',
    vaultKey,
  };

  const [first, second] = await Promise.all([
    importBrowserVault(options),
    importBrowserVault(options),
  ]);
  assert.equal(Number(first.created) + Number(second.created), 1);
  assert.deepEqual(first.vaultKey, vaultKey);
  assert.deepEqual(second.vaultKey, vaultKey);
  assert.notEqual(first.vaultKey, vaultKey);
  assert.deepEqual(vaultKey, originalInput);

  const repeated = await importBrowserVault(options);
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.vaultKey, vaultKey);
  const beforeConflict = storage.inspect('hnd:vault:invited-vault');
  const different = generateVaultKey({ crypto: webcrypto });
  await assert.rejects(
    importBrowserVault({ ...options, vaultKey: different }),
    /different vault key/,
  );
  assert.deepEqual(
    storage.inspect('hnd:vault:invited-vault').wrappedVaultKey,
    beforeConflict.wrappedVaultKey,
  );
  assert.deepEqual((await loadBrowserVault(options)).vaultKey, vaultKey);

  const competingStorage = memoryStorage();
  const leftKey = generateVaultKey({ crypto: webcrypto });
  const rightKey = generateVaultKey({ crypto: webcrypto });
  const competing = await Promise.allSettled([
    importBrowserVault({
      storage: competingStorage,
      crypto: webcrypto,
      vaultId: 'competing-import',
      vaultKey: leftKey,
    }),
    importBrowserVault({
      storage: competingStorage,
      crypto: webcrypto,
      vaultId: 'competing-import',
      vaultKey: rightKey,
    }),
  ]);
  const fulfilled = competing.filter((result) => result.status === 'fulfilled');
  const rejected = competing.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /different vault key/);
  assert.deepEqual(
    (await loadBrowserVault({
      storage: competingStorage,
      crypto: webcrypto,
      vaultId: 'competing-import',
    })).vaultKey,
    fulfilled[0].value.vaultKey,
  );
});

test('a logged-in account creates a server-issued PC connection without reading a local key', async () => {
  const connectionCode = `hndj_${'A'.repeat(43)}.${'B'.repeat(43)}.${'C'.repeat(12)}`;
  const expiresAt = '2026-09-01T00:00:00.000Z';
  let submitted;
  const created = await createAccountConnection({
    ttlSeconds: 600,
    api: {
      async connectionCreate(payload) {
        submitted = structuredClone(payload);
        return {
          connectionCode,
          connectionId: 'browser-connection-1',
          expiresAt,
        };
      },
    },
  });
  assert.deepEqual(submitted, { ttlSeconds: 600 });
  assert.deepEqual(created, {
    connectionCode,
    connectionId: 'browser-connection-1',
    expiresAt,
  });
});

test('account connection failures do not touch browser vault storage', async () => {
  let storageReads = 0;
  await assert.rejects(
    createAccountConnection({
      storage: {
        async get() {
          storageReads += 1;
          throw new Error('must not read local storage');
        },
      },
      api: {
        async connectionCreate() {
          throw new Error('network failed');
        },
      },
    }),
    /network failed/,
  );
  assert.equal(storageReads, 0);
});

test('managed account unlock imports the server key locally and zeroizes raw copies', async () => {
  const original = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const encoded = Buffer.from(original).toString('base64url');
  let importedKey;
  const result = await unlockManagedBrowserVault('tenant-browser', {
    storage: memoryStorage(),
    api: {
      async vaultKeyUnlock(payload) {
        assert.deepEqual(payload, {});
        return { vaultKey: encoded };
      },
    },
    async importBrowserVault(options) {
      importedKey = options.vaultKey;
      assert.equal(options.replaceExisting, true);
      assert.deepEqual(importedKey, original);
      return { created: true, vaultKey: importedKey };
    },
  });
  assert.deepEqual(result, { imported: true, replaced: false });
  assert.deepEqual(importedKey, new Uint8Array(32));
});

test('managed account unlock atomically replaces a stale local key', async () => {
  const storage = memoryStorage();
  const staleKey = new Uint8Array(32).fill(0x11);
  const currentKey = new Uint8Array(32).fill(0x22);
  await importBrowserVault({
    storage,
    crypto: webcrypto,
    vaultId: 'tenant-stale',
    vaultKey: staleKey,
  });
  const result = await unlockManagedBrowserVault('tenant-stale', {
    storage,
    crypto: webcrypto,
    api: {
      async vaultKeyUnlock() {
        return { vaultKey: Buffer.from(currentKey).toString('base64url') };
      },
    },
  });
  assert.deepEqual(result, { imported: false, replaced: true });
  const loaded = await loadBrowserVault({
    storage,
    crypto: webcrypto,
    vaultId: 'tenant-stale',
  });
  assert.deepEqual(loaded.vaultKey, currentKey);
  loaded.vaultKey.fill(0);
});

test('managed account unlock rejects malformed keys before local import', async () => {
  let imported = false;
  await assert.rejects(
    unlockManagedBrowserVault('tenant-browser', {
      storage: memoryStorage(),
      api: {
        async vaultKeyUnlock() {
          return { vaultKey: 'not-a-vault-key' };
        },
      },
      async importBrowserVault() {
        imported = true;
      },
    }),
    /올바른 계정 보관함 키/u,
  );
  assert.equal(imported, false);
});

test('local legacy keys can be adopted by the account and are zeroized afterwards', async () => {
  const sourceKey = Uint8Array.from({ length: 32 }, (_, index) => index + 7);
  const expected = Buffer.from(sourceKey).toString('base64url');
  const rawKey = sourceKey.slice();
  let submitted;
  const result = await adoptBrowserVaultKey('tenant-browser', {
    storage: memoryStorage(),
    loadBrowserVault: async () => ({ vaultKey: rawKey }),
    api: {
      async vaultKeyAdopt(payload) {
        submitted = structuredClone(payload);
        return { managed: true };
      },
    },
  });
  assert.equal(result.managed, true);
  assert.deepEqual(submitted, { vaultKey: expected });
  assert.deepEqual(rawKey, new Uint8Array(32));
});

test('destructive vault reset stores a new local key before replacing the remote snapshot', async () => {
  const storage = memoryStorage();
  let submitted;
  let submittedEtag;
  const result = await resetBrowserVault('reset-vault', '"previous"', {
    storage,
    crypto: webcrypto,
    api: {
      async vaultReset(payload, etag) {
        submitted = structuredClone(payload);
        submittedEtag = etag;
        assert.ok(storage.inspect('hnd:vault:reset-vault'));
        const nextEtag = `"${createHash('sha256')
          .update(Buffer.from(payload.snapshot, 'base64url'))
          .digest('hex')}"`;
        return { etag: nextEtag, revisionId: nextEtag.slice(1, -1) };
      },
      async vaultKeyAdopt() {
        return { managed: true };
      },
    },
  });

  assert.equal(submittedEtag, '"previous"');
  assert.deepEqual(Object.keys(submitted).sort(), [
    'algorithm',
    'confirmation',
    'snapshot',
    'version',
  ]);
  assert.equal(submitted.version, 1);
  assert.equal(submitted.algorithm, 'AES-256-GCM');
  assert.equal(submitted.confirmation, 'RESET_VAULT');
  const local = await loadBrowserVault({
    storage,
    crypto: webcrypto,
    vaultId: 'reset-vault',
  });
  assert.deepEqual(
    await decryptSnapshot(
      Buffer.from(submitted.snapshot, 'base64url'),
      local.vaultKey,
      { crypto: webcrypto },
    ),
    { schemaVersion: 1, files: [] },
  );
  local.vaultKey.fill(0);
  assert.equal(result.created, true);
  assert.equal(result.recovered, false);
  assert.equal(result.revisionId, result.etag.slice(1, -1));
});

test('ambiguous vault reset confirms only its exact generated ciphertext and ETag', async () => {
  const storage = memoryStorage();
  let committedSnapshot;
  let committedEtag;
  const result = await resetBrowserVault('reset-response-loss', '"before"', {
    storage,
    crypto: webcrypto,
    api: {
      async vaultReset(payload) {
        committedSnapshot = payload.snapshot;
        committedEtag = `"${createHash('sha256')
          .update(Buffer.from(payload.snapshot, 'base64url'))
          .digest('hex')}"`;
        throw new ApiError('response lost', { code: 'network_error' });
      },
      async vaultStatus() {
        return { initialized: true, etag: committedEtag };
      },
      async vaultSnapshot() {
        return { snapshot: committedSnapshot, etag: committedEtag };
      },
      async vaultKeyAdopt() {
        return { managed: true };
      },
    },
  });
  assert.deepEqual(result, { created: true, recovered: true });
  const local = await loadBrowserVault({
    storage,
    crypto: webcrypto,
    vaultId: 'reset-response-loss',
  });
  assert.equal(local.vaultKey.byteLength, 32);
  local.vaultKey.fill(0);

  const mismatchStorage = memoryStorage();
  await assert.rejects(
    resetBrowserVault('reset-mismatch', '"before"', {
      storage: mismatchStorage,
      crypto: webcrypto,
      api: {
        async vaultReset() {
          throw new ApiError('response lost', { code: 'network_error' });
        },
        async vaultStatus() {
          return { initialized: true, etag: '"different"' };
        },
      },
    }),
    /암호화 키는 이 브라우저에 보존/u,
  );
  assert.ok(mismatchStorage.inspect('hnd:vault:reset-mismatch'));
});

test('vault reset preserves ambiguous keys but removes a new key after definite rejection', async () => {
  for (const status of [409, 412]) {
    const storage = memoryStorage();
    const id = `reset-ambiguous-${status}`;
    await assert.rejects(
      resetBrowserVault(id, '"before"', {
        storage,
        crypto: webcrypto,
        api: {
          async vaultReset() {
            throw new ApiError('precondition uncertain', { status });
          },
          async vaultStatus() {
            return { initialized: true, etag: '"old"' };
          },
        },
      }),
      (error) => error instanceof ApiError && error.status === status,
    );
    assert.ok(storage.inspect(`hnd:vault:${id}`));
  }

  const definiteStorage = memoryStorage();
  await assert.rejects(
    resetBrowserVault('reset-definite', '"before"', {
      storage: definiteStorage,
      crypto: webcrypto,
      api: {
        async vaultReset() {
          throw new ApiError('forbidden', { status: 403 });
        },
      },
    }),
    (error) => error instanceof ApiError && error.status === 403,
  );
  assert.equal(definiteStorage.inspect('hnd:vault:reset-definite'), undefined);
});

test('vault reset clears the raw key returned by local creation', async () => {
  const rawKey = generateVaultKey({ crypto: webcrypto });
  const expectedEtag = { value: null };
  await resetBrowserVault('reset-zeroize', '"before"', {
    storage: memoryStorage(),
    crypto: webcrypto,
    createBrowserVault: async () => ({ created: true, vaultKey: rawKey }),
    api: {
      async vaultReset(payload) {
        expectedEtag.value = `"${createHash('sha256')
          .update(Buffer.from(payload.snapshot, 'base64url'))
          .digest('hex')}"`;
        return {
          etag: expectedEtag.value,
          revisionId: expectedEtag.value.slice(1, -1),
        };
      },
      async vaultKeyAdopt() {
        return { managed: true };
      },
    },
  });
  assert.deepEqual(rawKey, new Uint8Array(32));
});

test('IndexedDB adapter reports unavailable browser storage without a fallback', () => {
  assert.throws(
    () => createIndexedDbVaultStorage({ indexedDB: null }),
    /IndexedDB is not available/,
  );
});
