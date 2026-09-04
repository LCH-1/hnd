import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  encryptSnapshot,
  loadBrowserVault,
} from '../src/browser/index.mjs';
import { ApiError } from '../src/web/api.js';
import {
  hasLocalVault,
  initializeBrowserVault,
  loadEncryptedSnapshot,
} from '../src/web/vault.js';

function memoryStorage() {
  const records = new Map();
  const clone = (value) =>
    value === undefined ? undefined : structuredClone(value);
  return {
    async get(key) {
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
  };
}

test('first-vault response loss keeps the key and confirms the committed snapshot', async () => {
  const storage = memoryStorage();
  let committedSnapshot;
  const remoteApi = {
    async vaultInitialize(payload) {
      committedSnapshot = payload.snapshot;
      throw new ApiError('response lost', { code: 'network_error' });
    },
    async vaultStatus() {
      return { initialized: true };
    },
    async vaultSnapshot() {
      return { snapshot: committedSnapshot, etag: '"committed"' };
    },
    async vaultKeyAdopt({ vaultKey }) {
      assert.match(vaultKey, /^[A-Za-z0-9_-]{43}$/u);
      return { managed: true };
    },
  };

  const result = await initializeBrowserVault('tenant-a', {
    storage,
    crypto: webcrypto,
    api: remoteApi,
  });
  assert.equal(result.created, true);
  assert.equal(result.recovered, true);
  const local = await loadBrowserVault({
    storage,
    crypto: webcrypto,
    vaultId: 'tenant-a',
  });
  assert.equal(local.vaultKey.byteLength, 32);
  local.vaultKey.fill(0);
});

test('ambiguous uncommitted initialization preserves and retries the same local key', async () => {
  const storage = memoryStorage();
  const offlineApi = {
    async vaultInitialize() {
      throw new ApiError('offline', { code: 'network_error' });
    },
    async vaultStatus() {
      return { initialized: false };
    },
  };

  await assert.rejects(
    initializeBrowserVault('tenant-b', {
      storage,
      crypto: webcrypto,
      api: offlineApi,
    }),
    /암호화 키.*보존/u,
  );
  const before = await loadBrowserVault({
    storage,
    crypto: webcrypto,
    vaultId: 'tenant-b',
  });
  assert.ok(before);
  const originalKey = before.vaultKey.slice();
  before.vaultKey.fill(0);

  let initializedPayload;
  const onlineApi = {
    async vaultInitialize(payload) {
      initializedPayload = payload;
      return { initialized: true, etag: '"online"' };
    },
    async vaultKeyAdopt({ vaultKey }) {
      assert.match(vaultKey, /^[A-Za-z0-9_-]{43}$/u);
      return { managed: true };
    },
  };
  const retried = await initializeBrowserVault('tenant-b', {
    storage,
    crypto: webcrypto,
    api: onlineApi,
  });
  assert.equal(retried.created, false);
  assert.equal(retried.recovered, false);
  assert.equal(typeof initializedPayload.snapshot, 'string');
  const after = await loadBrowserVault({
    storage,
    crypto: webcrypto,
    vaultId: 'tenant-b',
  });
  assert.deepEqual(after.vaultKey, originalKey);
  after.vaultKey.fill(0);
  originalKey.fill(0);
});

test('only an authoritative absence after a definitive rejection removes a new key', async () => {
  const storage = memoryStorage();
  const remoteApi = {
    async vaultInitialize() {
      throw new ApiError('invalid request', { status: 400 });
    },
    async vaultStatus() {
      return { initialized: false };
    },
  };

  await assert.rejects(
    initializeBrowserVault('tenant-c', {
      storage,
      crypto: webcrypto,
      api: remoteApi,
    }),
    (error) => error instanceof ApiError && error.status === 400,
  );
  assert.equal(
    await loadBrowserVault({
      storage,
      crypto: webcrypto,
      vaultId: 'tenant-c',
    }),
    null,
  );
});

test('local-vault presence checks zeroize the raw key returned by the loader', async () => {
  const raw = new Uint8Array(32).fill(0x5a);
  const present = await hasLocalVault('tenant-d', {
    storage: {},
    async loadBrowserVault() {
      return { vaultKey: raw, created: false, vaultId: 'tenant-d' };
    },
  });
  assert.equal(present, true);
  assert.deepEqual(raw, new Uint8Array(32));
});

test('remote snapshot authentication failures expose a stable vault-key mismatch code', async () => {
  const serverKey = new Uint8Array(32).fill(0x31);
  const staleBrowserKey = new Uint8Array(32).fill(0x42);
  const encrypted = await encryptSnapshot(
    { schemaVersion: 1, files: [] },
    serverKey,
    { crypto: webcrypto },
  );

  await assert.rejects(
    loadEncryptedSnapshot('tenant-e', {
      crypto: webcrypto,
      storage: {},
      api: {
        async vaultSnapshot() {
          return {
            snapshot: Buffer.from(encrypted).toString('base64url'),
            etag: '"server"',
          };
        },
      },
      async loadBrowserVault() {
        return { vaultKey: staleBrowserKey.slice() };
      },
    }),
    (error) =>
      error?.code === 'vault_key_mismatch' &&
      /암호를 풀 수 없습니다/u.test(error.message),
  );
  serverKey.fill(0);
  staleBrowserKey.fill(0);
  encrypted.fill(0);
});
