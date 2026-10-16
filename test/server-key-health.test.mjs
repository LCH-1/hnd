import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SnapshotStore } from '../src/sync/store.mjs';
import { encryptSnapshot, generateVaultKey } from '../src/sync/crypto.mjs';

test('health probes bound envelope checks and retain a detected failure until repair', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hnd-key-health-'));
  const store = await new SnapshotStore(root).init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const key = generateVaultKey();
  try {
    for (const tenant of ['tenant-a', 'tenant-b', 'tenant-c']) {
      await store.putConditional(tenant, encryptSnapshot({ schemaVersion: 1, files: [] }, key), { ifNoneMatch: '*' });
      await store.adoptManagedVaultKey(tenant, key);
    }
  } finally { key.fill(0); }
  const db = store.getDatabase();
  const original = new Map();
  for (const tenant of ['tenant-b', 'tenant-c']) {
    const envelope = Buffer.from(db.prepare('SELECT key_envelope FROM managed_vault_keys WHERE tenant_id = ?').get(tenant).key_envelope);
    original.set(tenant, envelope);
    const damaged = Buffer.from(envelope);
    damaged[damaged.length - 1] ^= 1;
    db.prepare('UPDATE managed_vault_keys SET key_envelope = ? WHERE tenant_id = ?').run(damaged, tenant);
  }
  // A full scan would fail here. One probe checks only the next tenant.
  assert.equal(await store.assertServerMasterKeyHealthy(), true);
  await assert.rejects(store.assertServerMasterKeyHealthy(), /authentication failed/u);
  await assert.rejects(store.assertServerMasterKeyHealthy(), /authentication failed/u);
  db.prepare('UPDATE managed_vault_keys SET key_envelope = ? WHERE tenant_id = ?').run(original.get('tenant-b'), 'tenant-b');
  assert.equal(await store.assertServerMasterKeyHealthy(), true);
  await assert.rejects(store.assertServerMasterKeyHealthy(), /authentication failed/u);
  db.prepare('UPDATE managed_vault_keys SET key_envelope = ? WHERE tenant_id = ?').run(original.get('tenant-c'), 'tenant-c');
  assert.equal(await store.assertServerMasterKeyHealthy(), true);
  assert.equal(await store.assertServerMasterKeyHealthy(), true);
});
