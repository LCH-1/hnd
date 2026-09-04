import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { ApiError } from '../src/web/api.js';
import {
  beginBrowserWorkspaceReset,
  disableOfflineWorkspace,
  enableOfflineWorkspace,
  finalizeBrowserWorkspaceReset,
  logoutAfterRevokingOfflineAccess,
  mergeBrowserSnapshots,
  prepareOfflineWorkspaceAccess,
  resetBrowserWorkspaceCache,
  SnapshotDataStore,
} from '../src/web/snapshot-data.js';

function emptySnapshot() {
  return { schemaVersion: 1, files: [] };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function memoryCache() {
  let record = null;
  let resetEpoch = 0;
  const workspaceRecords = {
    snapshotLock: true,
    pcPolicy: true,
    offlineAccess: true,
  };
  let tail = Promise.resolve();
  return {
    async load() {
      return record ? structuredClone(record) : null;
    },
    async getResetEpoch() {
      return resetEpoch;
    },
    async compareAndSet(options) {
      if (options.expectedResetEpoch !== undefined && options.expectedResetEpoch !== resetEpoch) {
        return {
          updated: false,
          currentGeneration: record?.generation ?? 0,
          currentResetEpoch: resetEpoch,
        };
      }
      const generation = record?.generation ?? 0;
      if (generation !== options.expectedGeneration) {
        return {
          updated: false,
          currentGeneration: generation,
          currentResetEpoch: resetEpoch,
        };
      }
      record = {
        snapshot: structuredClone(options.snapshot),
        baseSnapshot:
          options.baseSnapshot === undefined
            ? options.pending
              ? null
              : structuredClone(options.snapshot)
            : options.baseSnapshot
              ? structuredClone(options.baseSnapshot)
              : null,
        etag: options.etag ?? null,
        pending: Boolean(options.pending),
        generation: generation + 1,
        resetEpoch,
      };
      return { updated: true, ...structuredClone(record) };
    },
    async withLock(_tenantId, operation, expectedResetEpoch = resetEpoch) {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        if (expectedResetEpoch !== resetEpoch) {
          const error = new Error('browser workspace reset');
          error.code = 'browser_cache_reset';
          throw error;
        }
        return await operation();
      } finally {
        release();
      }
    },
    async reset() {
      resetEpoch += 1;
      record = null;
      workspaceRecords.snapshotLock = false;
      workspaceRecords.pcPolicy = false;
      workspaceRecords.offlineAccess = false;
      return { resetEpoch };
    },
    async beginReset() {
      resetEpoch += 1;
      if (record) record.resetEpoch = resetEpoch;
      workspaceRecords.snapshotLock = false;
      workspaceRecords.offlineAccess = false;
      return { resetEpoch };
    },
    async finalizeReset(_tenantId, expectedResetEpoch) {
      if (expectedResetEpoch !== resetEpoch) {
        const error = new Error('browser workspace reset');
        error.code = 'browser_cache_reset';
        throw error;
      }
      record = null;
      workspaceRecords.snapshotLock = false;
      workspaceRecords.pcPolicy = false;
      workspaceRecords.offlineAccess = false;
      return { resetEpoch };
    },
    inspect() {
      return {
        ...(record ? structuredClone(record) : null),
        resetEpoch,
        workspaceRecords: structuredClone(workspaceRecords),
      };
    },
  };
}

function controlledRemote() {
  let snapshot = emptySnapshot();
  let etag = '"0"';
  let callCount = 0;
  const starts = [deferred(), deferred()];
  const releases = [deferred(), deferred()];
  return {
    starts,
    releases,
    async load() {
      return { snapshot: structuredClone(snapshot), etag };
    },
    async save(_tenantId, next, expectedEtag) {
      const index = callCount;
      callCount += 1;
      starts[index]?.resolve();
      await releases[index]?.promise;
      if (expectedEtag !== etag) {
        throw new ApiError('precondition failed', { status: 412 });
      }
      snapshot = structuredClone(next);
      etag = `"${callCount}"`;
      return { etag };
    },
    inspect() {
      return { snapshot: structuredClone(snapshot), etag };
    },
  };
}

function immediateRemote(initialSnapshot = emptySnapshot()) {
  let snapshot = structuredClone(initialSnapshot);
  let etag = '"0"';
  let version = 0;
  return {
    async load() {
      return { snapshot: structuredClone(snapshot), etag };
    },
    async save(_tenantId, next, expectedEtag) {
      if (expectedEtag !== etag) {
        throw new ApiError('precondition failed', { status: 412 });
      }
      snapshot = structuredClone(next);
      version += 1;
      etag = `"${version}"`;
      return { etag };
    },
    inspect() {
      return { snapshot: structuredClone(snapshot), etag };
    },
  };
}

function textFile(path, value) {
  const content = Buffer.from(value, 'utf8');
  return {
    path,
    encoding: 'base64',
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
    content: content.toString('base64'),
  };
}

function handoffFile(repositoryId, workId, {
  closed = false,
  updatedAt = '2026-01-01T00:00:00.000Z',
} = {}) {
  const directory = closed ? 'archive' : 'handoffs';
  return textFile(
    `repositories/${repositoryId}/${directory}/${workId}.json`,
    `${JSON.stringify({
      schemaVersion: 1,
      id: workId,
      repoId: repositoryId,
      status: closed ? 'closed' : 'active',
      task: 'merge test',
      objective: 'preserve one logical handoff',
      currentState: 'testing',
      updatedAt,
      closedAt: closed ? updatedAt : null,
      history: [{ at: updatedAt, action: closed ? 'closed' : 'updated' }],
    })}\n`,
  );
}

function storeOptions(cache, remote, localRules = null) {
  return {
    cache,
    loadRemote: () => remote.load(),
    saveRemote: (...args) => remote.save(...args),
    loadLocalRule: localRules
      ? (...args) => localRules.load(...args)
      : async () => null,
    ...(localRules
      ? { saveLocalRule: (...args) => localRules.save(...args) }
      : {}),
  };
}

function localRuleStorage() {
  let rule = null;
  return {
    async load() {
      return rule === null ? null : structuredClone(rule);
    },
    async save(_tenantId, next) {
      rule = next === null ? null : structuredClone(next);
    },
    inspect() {
      return rule === null ? null : structuredClone(rule);
    },
  };
}

function offlineAccessStore() {
  const maxRevokedSessions = 32;
  const states = new Map();
  const grants = new Map();
  const current = (tenantId) =>
    states.get(tenantId) || {
      epoch: 0,
      authorizedSessionId: null,
      revokedSessionIds: [],
    };
  return {
    async prepare(tenantId) {
      return structuredClone(current(tenantId));
    },
    async enable({
      tenantId,
      expectedAccessEpoch,
      sessionId,
      encrypted,
    }) {
      const state = current(tenantId);
      if (
        state.epoch !== expectedAccessEpoch ||
        state.revokedSessionIds.includes(sessionId)
      ) {
        throw new Error(
          '로그아웃 중이거나 이미 로그아웃한 세션에서는 오프라인 작업 권한을 다시 만들 수 없습니다.',
        );
      }
      states.set(tenantId, {
        ...state,
        authorizedSessionId: sessionId,
      });
      grants.set(tenantId, encrypted.slice());
    },
    async revoke({ tenantId, sessionId }) {
      const state = current(tenantId);
      states.set(tenantId, {
        epoch: state.epoch + 1,
        authorizedSessionId: null,
        revokedSessionIds: [
          ...state.revokedSessionIds.filter(
            (revoked) =>
              revoked !== state.authorizedSessionId && revoked !== sessionId,
          ),
          ...new Set([state.authorizedSessionId, sessionId].filter(Boolean)),
        ].slice(-maxRevokedSessions),
      });
      grants.delete(tenantId);
    },
    inspect(tenantId) {
      return {
        state: structuredClone(current(tenantId)),
        granted: grants.has(tenantId),
      };
    },
  };
}

test('logout keeps the server session retryable until offline access revocation succeeds', async () => {
  let revokeAttempts = 0;
  let logoutAttempts = 0;
  let failRevocation = true;
  const options = {
    async disableOfflineWorkspace(tenantId) {
      revokeAttempts += 1;
      assert.equal(tenantId, 'tenant');
      if (failRevocation) throw new Error('local deletion failed');
    },
  };
  const logout = async () => {
    logoutAttempts += 1;
    return { loggedOut: true };
  };

  await assert.rejects(
    logoutAfterRevokingOfflineAccess(['tenant'], logout, options),
    /local deletion failed/u,
  );
  assert.equal(revokeAttempts, 1);
  assert.equal(logoutAttempts, 0);

  failRevocation = false;
  assert.deepEqual(
    await logoutAfterRevokingOfflineAccess(['tenant'], logout, options),
    { loggedOut: true },
  );
  assert.equal(revokeAttempts, 2);
  assert.equal(logoutAttempts, 1);
});

test('logout can be retried after the server request fails with offline access already revoked', async () => {
  let revokeAttempts = 0;
  let logoutAttempts = 0;
  const options = {
    async disableOfflineWorkspace() {
      revokeAttempts += 1;
    },
  };
  const logout = async () => {
    logoutAttempts += 1;
    if (logoutAttempts === 1) throw new Error('server logout failed');
    return { loggedOut: true };
  };

  await assert.rejects(
    logoutAfterRevokingOfflineAccess(['tenant'], logout, options),
    /server logout failed/u,
  );
  assert.equal(revokeAttempts, 1);
  assert.equal(logoutAttempts, 1);

  assert.deepEqual(
    await logoutAfterRevokingOfflineAccess(['tenant'], logout, options),
    { loggedOut: true },
  );
  assert.equal(revokeAttempts, 2);
  assert.equal(logoutAttempts, 2);
});

test('logout revokes each distinct local workspace before ending the server session', async () => {
  const calls = [];
  await logoutAfterRevokingOfflineAccess(
    ['tenant-a', 'tenant-b', 'tenant-a'],
    async () => {
      calls.push('logout');
    },
    {
      sessionId: 'web-session',
      async disableOfflineWorkspace(tenantId, options) {
        calls.push(`revoke:${tenantId}:${options.sessionId}`);
      },
    },
  );
  assert.deepEqual(calls, [
    'revoke:tenant-a:web-session',
    'revoke:tenant-b:web-session',
    'logout',
  ]);
});

test('offline access epoch prevents an in-flight or revoked session from restoring a grant', async () => {
  const accessStore = offlineAccessStore();
  const started = deferred();
  const release = deferred();
  const authorization = await prepareOfflineWorkspaceAccess('tenant', {
    accessStore,
  });
  const enabling = enableOfflineWorkspace('tenant', {
    accessStore,
    expectedAccessEpoch: authorization.epoch,
    expectedResetEpoch: 0,
    sessionId: 'old-session',
    async sealBrowserValue() {
      started.resolve();
      await release.promise;
      return Uint8Array.of(1, 2, 3);
    },
  });
  await started.promise;
  await disableOfflineWorkspace('tenant', {
    accessStore,
    sessionId: 'old-session',
  });
  release.resolve();
  await assert.rejects(enabling, /로그아웃 중이거나 이미 로그아웃한 세션/u);
  assert.deepEqual(accessStore.inspect('tenant'), {
    state: {
      epoch: 1,
      authorizedSessionId: null,
      revokedSessionIds: ['old-session'],
    },
    granted: false,
  });

  const afterLogout = await prepareOfflineWorkspaceAccess('tenant', {
    accessStore,
  });
  await assert.rejects(
    enableOfflineWorkspace('tenant', {
      accessStore,
      expectedAccessEpoch: afterLogout.epoch,
      expectedResetEpoch: 0,
      sessionId: 'old-session',
      sealBrowserValue: async () => Uint8Array.of(4),
    }),
    /로그아웃 중이거나 이미 로그아웃한 세션/u,
  );
  await enableOfflineWorkspace('tenant', {
    accessStore,
    expectedAccessEpoch: afterLogout.epoch,
    expectedResetEpoch: 0,
    sessionId: 'new-session',
    sealBrowserValue: async () => Uint8Array.of(5),
  });
  assert.equal(accessStore.inspect('tenant').granted, true);
});

test('offline revocation blocks both the grant session and the logout session', async () => {
  const accessStore = offlineAccessStore();
  const beforeGrant = await prepareOfflineWorkspaceAccess('tenant', {
    accessStore,
  });
  await enableOfflineWorkspace('tenant', {
    accessStore,
    expectedAccessEpoch: beforeGrant.epoch,
    expectedResetEpoch: 0,
    sessionId: 'grant-session',
    sealBrowserValue: async () => Uint8Array.of(1),
  });
  await disableOfflineWorkspace('tenant', {
    accessStore,
    sessionId: 'logout-session',
  });
  const afterLogout = await prepareOfflineWorkspaceAccess('tenant', {
    accessStore,
  });

  for (const sessionId of ['grant-session', 'logout-session']) {
    await assert.rejects(
      enableOfflineWorkspace('tenant', {
        accessStore,
        expectedAccessEpoch: afterLogout.epoch,
        expectedResetEpoch: 0,
        sessionId,
        sealBrowserValue: async () => Uint8Array.of(2),
      }),
      /로그아웃 중이거나 이미 로그아웃한 세션/u,
    );
  }
  await assert.rejects(
    enableOfflineWorkspace('tenant', {
      accessStore,
      expectedResetEpoch: 0,
      sessionId: 'unversioned-stale-session',
      sealBrowserValue: async () => Uint8Array.of(3),
    }),
    /기준 버전이 올바르지 않습니다/u,
  );
  assert.deepEqual(accessStore.inspect('tenant'), {
    state: {
      epoch: 1,
      authorizedSessionId: null,
      revokedSessionIds: ['grant-session', 'logout-session'],
    },
    granted: false,
  });
});

test('offline revocation history stays bounded while epochs keep advancing', async () => {
  const accessStore = offlineAccessStore();
  for (let index = 0; index < 40; index += 1) {
    const authorization = await prepareOfflineWorkspaceAccess('tenant', {
      accessStore,
    });
    await enableOfflineWorkspace('tenant', {
      accessStore,
      expectedAccessEpoch: authorization.epoch,
      expectedResetEpoch: 0,
      sessionId: `grant-${index}`,
      sealBrowserValue: async () => Uint8Array.of(index),
    });
    await disableOfflineWorkspace('tenant', {
      accessStore,
      sessionId: `logout-${index}`,
    });
  }

  const { state: access, granted } = accessStore.inspect('tenant');
  assert.equal(access.epoch, 40);
  assert.equal(access.revokedSessionIds.length, 32);
  assert.deepEqual(access.revokedSessionIds.slice(-2), [
    'grant-39',
    'logout-39',
  ]);
  assert.equal(granted, false);
});

test('a stale clean result cannot overwrite a newer pending change from another tab', async () => {
  const cache = memoryCache();
  const remote = controlledRemote();
  const first = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  const second = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  await first.load();
  await second.load();

  const firstSave = first.createKnowledge({
    title: 'first',
    content: 'first body',
    tags: [],
  });
  await remote.starts[0].promise;

  // The second tab observes the first tab's durable pending generation, adds a
  // newer mutation, and starts its own conditional save before the first
  // response is delivered.
  second._adoptCached(await cache.load());
  const secondSave = second.createKnowledge({
    title: 'second',
    content: 'second body',
    tags: [],
  });
  await remote.starts[1].promise;

  remote.releases[0].resolve();
  await firstSave;
  remote.releases[1].resolve();
  await secondSave;

  const cached = cache.inspect();
  assert.equal(cached.pending, false);
  assert.equal(cached.snapshot.files.length, 2);
  assert.equal(first.syncStatus().conflict, true);
  assert.equal(second.syncStatus().conflict, false);
  assert.equal(remote.inspect().snapshot.files.length, 2);
});

test('a truly stale tab fails closed before replacing another tab cache generation', async () => {
  const cache = memoryCache();
  const remote = controlledRemote();
  remote.releases[0].resolve();
  const first = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  const stale = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  await first.load();
  await stale.load();

  await first.createKnowledge({ title: 'winner', content: '', tags: [] });
  await assert.rejects(
    stale.createKnowledge({ title: 'stale', content: '', tags: [] }),
    /다른 탭/u,
  );
  assert.equal(cache.inspect().snapshot.files.length, 1);
  assert.equal(stale.syncStatus().conflict, true);
});

test('412 with the identical plaintext snapshot is idempotently marked clean', async () => {
  const cache = memoryCache();
  let snapshot = emptySnapshot();
  let etag = '"0"';
  let firstAttempt = true;
  const remote = {
    async load() {
      return { snapshot: structuredClone(snapshot), etag };
    },
    async save(_tenantId, next, expectedEtag) {
      if (firstAttempt) {
        firstAttempt = false;
        snapshot = structuredClone(next);
        etag = '"1"';
        throw new ApiError('response lost', { code: 'network_error' });
      }
      assert.equal(expectedEtag, '"0"');
      throw new ApiError('already committed', { status: 412 });
    },
  };
  const store = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  await store.load();
  await store.createKnowledge({ title: 'saved', content: '', tags: [] });
  assert.equal(store.syncStatus().pending, true);
  assert.equal(store.syncStatus().offline, true);

  assert.equal(await store.sync(), true);
  assert.deepEqual(store.syncStatus(), {
    pending: false,
    offline: false,
    conflict: false,
    error: null,
  });
  assert.equal(cache.inspect().pending, false);
  assert.equal(cache.inspect().etag, '"1"');
});

test('a stale pending empty browser snapshot adopts a populated server snapshot', async () => {
  const cache = memoryCache();
  const repositoryId = '11111111-1111-4111-8111-111111111111';
  const index = {
    schemaVersion: 1,
    repositories: {
      [repositoryId]: { id: repositoryId, name: 'server-project' },
    },
  };
  const remote = immediateRemote({
    schemaVersion: 1,
    files: [textFile('repositories.json', `${JSON.stringify(index)}\n`)],
  });
  const seeded = await cache.compareAndSet({
    snapshot: emptySnapshot(),
    etag: '"stale-empty"',
    pending: true,
    expectedGeneration: 0,
  });
  assert.equal(seeded.updated, true);

  const store = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  await store.load();

  assert.deepEqual(store.syncStatus(), {
    pending: false,
    offline: false,
    conflict: false,
    error: null,
  });
  assert.equal((await store.projects()).at(0)?.name, 'server-project');
  assert.equal(cache.inspect().etag, '"0"');
});

test('a non-empty pending browser snapshot still requires an explicit conflict choice', async () => {
  const cache = memoryCache();
  const local = {
    schemaVersion: 1,
    files: [
      textFile(
        'knowledge/11111111-1111-4111-8111-111111111111.json',
        `${JSON.stringify({
          schemaVersion: 1,
          id: '11111111-1111-4111-8111-111111111111',
          title: 'local',
          body: '',
          tags: [],
        })}\n`,
      ),
    ],
  };
  const remote = immediateRemote({
    schemaVersion: 1,
    files: [textFile('policies/global.md', 'server policy\n')],
  });
  await cache.compareAndSet({
    snapshot: local,
    etag: '"stale-local"',
    pending: true,
    expectedGeneration: 0,
  });

  const store = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  await store.load();

  assert.equal(store.syncStatus().pending, true);
  assert.equal(store.syncStatus().conflict, true);
  assert.equal(store.syncStatus().error?.code, 'remote_snapshot_conflict');
  assert.deepEqual(cache.inspect().snapshot, local);
});

test('browser and connector changes to different items merge automatically', async () => {
  const repositoryId = '11111111-1111-4111-8111-111111111111';
  const index = {
    schemaVersion: 1,
    repositories: {
      [repositoryId]: { id: repositoryId, name: 'backend' },
    },
  };
  const remote = immediateRemote({
    schemaVersion: 1,
    files: [textFile('repositories.json', `${JSON.stringify(index)}\n`)],
  });
  const browser = new SnapshotDataStore('tenant', storeOptions(memoryCache(), remote));
  const connector = new SnapshotDataStore('tenant', storeOptions(memoryCache(), remote));
  await browser.load();
  await connector.load();

  await connector.createWork({
    repoId: repositoryId,
    name: 'connector task',
    goal: 'record connector progress',
    current: '',
    decision: '',
    rejected: '',
    next: '',
  });
  await browser.createRule({
    scope: 'repo',
    repository: repositoryId,
    content: 'browser rule',
  });

  assert.deepEqual(browser.syncStatus(), {
    pending: false,
    offline: false,
    conflict: false,
    error: null,
  });
  assert.equal((await browser.rules({ scope: 'repo' })).length, 1);
  assert.equal((await browser.work({ repository: repositoryId })).length, 1);
});

test('concurrent handoff moves resolve as one logical record without duplicating unrelated data', async () => {
  const repositoryA = '11111111-1111-4111-8111-111111111111';
  const repositoryB = '22222222-2222-4222-8222-222222222222';
  const workId = '33333333-3333-4333-8333-333333333333';
  const unrelatedId = '44444444-4444-4444-8444-444444444444';
  const activeA = `repositories/${repositoryA}/handoffs/${workId}.json`;
  const activeB = `repositories/${repositoryB}/handoffs/${workId}.json`;
  const archivedA = `repositories/${repositoryA}/archive/${workId}.json`;
  const unrelatedPath = `knowledge/${unrelatedId}.json`;
  const base = {
    schemaVersion: 1,
    files: [textFile(activeA, '{"status":"active","version":"base"}\n')],
  };
  const local = {
    schemaVersion: 1,
    files: [
      textFile(activeB, '{"status":"active","version":"moved"}\n'),
      textFile(unrelatedPath, '{"title":"local-only"}\n'),
    ],
  };
  const remote = {
    schemaVersion: 1,
    files: [
      textFile(archivedA, '{"status":"closed","version":"finished"}\n'),
      textFile('policies/global.md', 'remote-only policy\n'),
    ],
  };

  const localPreferred = await mergeBrowserSnapshots(base, local, remote);
  assert.deepEqual(
    localPreferred.snapshot.files.map((file) => file.path),
    [
      unrelatedPath,
      'policies/global.md',
      activeB,
    ].sort(),
  );
  assert.deepEqual(localPreferred.conflicts, [activeA, archivedA, activeB].sort());
  assert.equal(
    localPreferred.snapshot.files.filter(
      (file) => file.path.endsWith(`/${workId}.json`),
    ).length,
    1,
  );

  const repeated = await mergeBrowserSnapshots(
    base,
    localPreferred.snapshot,
    remote,
  );
  assert.deepEqual(repeated, localPreferred);

  const serverPreferred = await mergeBrowserSnapshots(base, remote, local);
  assert.equal(
    serverPreferred.snapshot.files.filter(
      (file) => file.path.endsWith(`/${workId}.json`),
    ).length,
    1,
  );
  assert.ok(serverPreferred.snapshot.files.some((file) => file.path === archivedA));
  assert.ok(!serverPreferred.snapshot.files.some((file) => file.path === activeB));
  assert.ok(
    serverPreferred.snapshot.files.some((file) => file.path === unrelatedPath),
  );
  assert.ok(
    serverPreferred.snapshot.files.some(
      (file) => file.path === 'policies/global.md',
    ),
  );
});

test('handoff deletion and a concurrent move remain a selectable logical conflict', async () => {
  const repositoryA = '11111111-1111-4111-8111-111111111111';
  const repositoryB = '22222222-2222-4222-8222-222222222222';
  const workId = '33333333-3333-4333-8333-333333333333';
  const active = handoffFile(repositoryA, workId);
  const archived = handoffFile(repositoryB, workId, {
    closed: true,
    updatedAt: '2026-02-01T00:00:00.000Z',
  });
  const base = { schemaVersion: 1, files: [active] };
  const deleted = emptySnapshot();
  const moved = { schemaVersion: 1, files: [archived] };

  const localPreferred = await mergeBrowserSnapshots(base, deleted, moved);
  assert.deepEqual(localPreferred.snapshot.files, []);
  assert.deepEqual(
    localPreferred.conflicts,
    [active.path, archived.path].sort(),
  );

  const serverPreferred = await mergeBrowserSnapshots(base, moved, deleted);
  assert.deepEqual(
    serverPreferred.snapshot.files.map((file) => file.path),
    [archived.path],
  );
  assert.deepEqual(serverPreferred.conflicts, localPreferred.conflicts);
});

test('one-sided duplicate handoffs canonicalize without a false conflict', async () => {
  const repositoryA = '11111111-1111-4111-8111-111111111111';
  const repositoryB = '22222222-2222-4222-8222-222222222222';
  const workId = '33333333-3333-4333-8333-333333333333';
  const active = handoffFile(repositoryA, workId, {
    updatedAt: '2026-03-01T00:00:00.000Z',
  });
  const archived = handoffFile(repositoryB, workId, {
    closed: true,
    updatedAt: '2026-02-01T00:00:00.000Z',
  });
  const base = { schemaVersion: 1, files: [active] };
  const duplicated = { schemaVersion: 1, files: [active, archived] };

  for (const [local, remote] of [
    [base, duplicated],
    [duplicated, base],
  ]) {
    const merged = await mergeBrowserSnapshots(base, local, remote);
    assert.deepEqual(
      merged.snapshot.files.map((file) => file.path),
      [archived.path],
    );
    assert.deepEqual(merged.conflicts, []);
  }
});

test('unchanged duplicate handoffs canonicalize without a false conflict', async () => {
  const repositoryA = '11111111-1111-4111-8111-111111111111';
  const repositoryB = '22222222-2222-4222-8222-222222222222';
  const workId = '33333333-3333-4333-8333-333333333333';
  const active = handoffFile(repositoryA, workId);
  const archived = handoffFile(repositoryB, workId, {
    closed: true,
    updatedAt: '2026-02-01T00:00:00.000Z',
  });
  const duplicated = { schemaVersion: 1, files: [active, archived] };

  const merged = await mergeBrowserSnapshots(
    duplicated,
    duplicated,
    duplicated,
  );

  assert.deepEqual(
    merged.snapshot.files.map((file) => file.path),
    [archived.path],
  );
  assert.deepEqual(merged.conflicts, []);
});

test('resolving a true duplicate handoff conflict honors the selected side', async () => {
  const repositoryA = '11111111-1111-4111-8111-111111111111';
  const repositoryB = '22222222-2222-4222-8222-222222222222';
  const repositoryC = '44444444-4444-4444-8444-444444444444';
  const workId = '33333333-3333-4333-8333-333333333333';
  const active = handoffFile(repositoryA, workId);
  const archived = handoffFile(repositoryB, workId, {
    closed: true,
    updatedAt: '2026-02-01T00:00:00.000Z',
  });
  const moved = handoffFile(repositoryC, workId, {
    updatedAt: '2026-03-01T00:00:00.000Z',
  });
  const base = { schemaVersion: 1, files: [active] };
  const duplicated = { schemaVersion: 1, files: [active, archived] };
  const remoteSnapshot = { schemaVersion: 1, files: [moved] };
  const prepared = await mergeBrowserSnapshots(base, duplicated, remoteSnapshot);

  assert.deepEqual(
    prepared.snapshot.files.map((file) => file.path),
    [archived.path],
  );
  assert.deepEqual(
    prepared.conflicts,
    [active.path, archived.path, moved.path].sort(),
  );

  for (const strategy of ['local', 'server']) {
    const cache = memoryCache();
    const remote = immediateRemote(remoteSnapshot);
    const pending = await cache.compareAndSet({
      snapshot: prepared.snapshot,
      baseSnapshot: base,
      etag: '"0"',
      pending: true,
      expectedGeneration: 0,
      expectedResetEpoch: 0,
    });
    const store = new SnapshotDataStore(
      'tenant',
      storeOptions(cache, remote),
    );
    store._adoptCached(pending);
    store.conflict = true;

    assert.equal(await store.resolveConflict(strategy), true);
    const workFiles = remote.inspect().snapshot.files.filter((file) =>
      file.path.endsWith(`/${workId}.json`),
    );
    assert.deepEqual(
      workFiles.map((file) => file.path),
      [strategy === 'local' ? archived.path : moved.path],
    );
    assert.equal(store.syncStatus().pending, false);
    assert.equal(store.syncStatus().conflict, false);
  }
});

test('opposite cleanup of an existing duplicate preserves the selected side', async () => {
  const repositoryA = '11111111-1111-4111-8111-111111111111';
  const repositoryB = '22222222-2222-4222-8222-222222222222';
  const workId = '33333333-3333-4333-8333-333333333333';
  const active = handoffFile(repositoryA, workId);
  const archived = handoffFile(repositoryB, workId, {
    closed: true,
    updatedAt: '2026-02-01T00:00:00.000Z',
  });
  const base = { schemaVersion: 1, files: [active, archived] };
  const keptActive = { schemaVersion: 1, files: [active] };
  const keptArchive = { schemaVersion: 1, files: [archived] };

  const localPreferred = await mergeBrowserSnapshots(
    base,
    keptActive,
    keptArchive,
  );
  assert.deepEqual(
    localPreferred.snapshot.files.map((file) => file.path),
    [active.path],
  );
  assert.deepEqual(
    localPreferred.conflicts,
    [active.path, archived.path].sort(),
  );

  const serverPreferred = await mergeBrowserSnapshots(
    base,
    keptArchive,
    keptActive,
  );
  assert.deepEqual(
    serverPreferred.snapshot.files.map((file) => file.path),
    [archived.path],
  );
  assert.deepEqual(serverPreferred.conflicts, localPreferred.conflicts);
});

test('a stale tab cannot overwrite a newer browser-only PC rule', async () => {
  const cache = memoryCache();
  const remote = immediateRemote();
  const localRules = localRuleStorage();
  const first = new SnapshotDataStore(
    'tenant',
    storeOptions(cache, remote, localRules),
  );
  const stale = new SnapshotDataStore(
    'tenant',
    storeOptions(cache, remote, localRules),
  );
  await first.load();
  await stale.load();

  await first.createRule({ scope: 'pc', content: 'first browser rule' });
  await assert.rejects(
    stale.createRule({ scope: 'pc', content: 'stale browser rule' }),
    /다른 탭에서 브라우저 룰을 먼저 바꿨습니다/u,
  );
  assert.equal(localRules.inspect().content, 'first browser rule');
  assert.equal(stale.syncStatus().conflict, false);

  const current = new SnapshotDataStore(
    'tenant',
    storeOptions(cache, remote, localRules),
  );
  const staleUpdate = new SnapshotDataStore(
    'tenant',
    storeOptions(cache, remote, localRules),
  );
  await current.load();
  await staleUpdate.load();
  await current.updateRule('pc', {
    scope: 'pc',
    content: 'newer browser rule',
  });
  await assert.rejects(
    staleUpdate.updateRule('pc', {
      scope: 'pc',
      content: 'older browser rule',
    }),
    /다른 탭에서 브라우저 룰을 먼저 바꿨습니다/u,
  );
  assert.equal(localRules.inspect().content, 'newer browser rule');
  assert.equal(staleUpdate.syncStatus().conflict, false);
});

test('authentication and integrity failures need attention while network failures are offline', async () => {
  const cache = memoryCache();
  let loadError = null;
  const remote = {
    async load() {
      if (loadError) throw loadError;
      return { snapshot: emptySnapshot(), etag: '"0"' };
    },
    async save() {
      throw new Error('unused');
    },
  };
  const store = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  await store.load();

  loadError = new ApiError('unauthorized', { status: 401 });
  await store.load({ force: true });
  assert.equal(store.syncStatus().offline, false);
  assert.equal(store.syncStatus().conflict, true);

  loadError = new Error('snapshot authentication failed');
  await store.load({ force: true });
  assert.equal(store.syncStatus().offline, false);
  assert.equal(store.syncStatus().conflict, true);

  loadError = new ApiError('network down', { code: 'network_error' });
  await store.load({ force: true });
  assert.equal(store.syncStatus().offline, true);
  assert.equal(store.syncStatus().conflict, false);
});

test('a reset installs a monotonic cache tombstone and a fresh store loads the new remote workspace', async () => {
  const cache = memoryCache();
  const oldSnapshot = emptySnapshot();
  const newSnapshot = {
    schemaVersion: 1,
    files: [
      textFile(
        'knowledge/11111111-1111-4111-8111-111111111111.json',
        `${JSON.stringify({
          schemaVersion: 1,
          id: '11111111-1111-4111-8111-111111111111',
          title: '새 보관함',
          body: '새 서버 저장본',
          tags: [],
          createdAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
        })}\n`,
      ),
    ],
  };
  let snapshot = oldSnapshot;
  let etag = '"old"';
  const remote = {
    async load() {
      return { snapshot: structuredClone(snapshot), etag };
    },
    async save(_tenantId, next, expectedEtag) {
      if (expectedEtag !== etag) {
        throw new ApiError('precondition failed', { status: 412 });
      }
      snapshot = structuredClone(next);
      etag = '"saved"';
      return { etag };
    },
  };
  const old = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  await old.load();
  assert.equal(cache.inspect().resetEpoch, 0);
  assert.equal(cache.inspect().generation, 1);

  snapshot = newSnapshot;
  etag = '"reset"';
  assert.deepEqual(
    await resetBrowserWorkspaceCache('tenant', { cache }),
    { resetEpoch: 1 },
  );
  const afterReset = cache.inspect();
  assert.equal(afterReset.snapshot, undefined);
  assert.equal(afterReset.resetEpoch, 1);
  assert.deepEqual(afterReset.workspaceRecords, {
    snapshotLock: false,
    pcPolicy: false,
    offlineAccess: false,
  });

  const fresh = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  await fresh.load();
  assert.deepEqual(
    (await fresh.knowledge()).map((entry) => entry.title),
    ['새 보관함'],
  );
  assert.equal(cache.inspect().resetEpoch, 1);
  assert.equal(cache.inspect().generation, 1);
  assert.equal(cache.inspect().etag, '"reset"');

  assert.deepEqual(
    await resetBrowserWorkspaceCache('tenant', { cache }),
    { resetEpoch: 2 },
  );
  assert.equal(cache.inspect().resetEpoch, 2);
});

test('a tab opened before reset cannot write or resolve after the reset tombstone', async () => {
  const cache = memoryCache();
  let saves = 0;
  const remote = {
    async load() {
      return { snapshot: emptySnapshot(), etag: '"0"' };
    },
    async save() {
      saves += 1;
      return { etag: '"1"' };
    },
  };
  const stale = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  await stale.load();
  await resetBrowserWorkspaceCache('tenant', { cache });

  await assert.rejects(
    stale.createKnowledge({ title: 'discarded', content: '', tags: [] }),
    /보관함이 초기화/u,
  );
  await assert.rejects(stale.resolveConflict('local'), /보관함이 초기화/u);
  assert.equal(saves, 0);
  assert.equal(cache.inspect().snapshot, undefined);
  assert.equal(stale.syncStatus().conflict, true);
});

test('a reset racing an old remote save keeps the reset server snapshot and rejects the old operation', async () => {
  const cache = memoryCache();
  const saveStarted = deferred();
  const releaseSave = deferred();
  let snapshot = emptySnapshot();
  let etag = '"0"';
  let saves = 0;
  const remote = {
    async load() {
      return { snapshot: structuredClone(snapshot), etag };
    },
    async save(_tenantId, next, expectedEtag) {
      saves += 1;
      saveStarted.resolve();
      await releaseSave.promise;
      if (expectedEtag !== etag) {
        throw new ApiError('precondition failed', { status: 412 });
      }
      snapshot = structuredClone(next);
      etag = '"saved"';
      return { etag };
    },
  };
  const stale = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  await stale.load();
  const pendingWrite = stale.createKnowledge({
    title: 'old tab',
    content: '',
    tags: [],
  });
  await saveStarted.promise;

  // The server reset installs a different ETag before this request is allowed
  // to reach its conditional write. The browser tombstone then invalidates the
  // old tab's cache generation.
  snapshot = emptySnapshot();
  etag = '"reset"';
  await resetBrowserWorkspaceCache('tenant', { cache });
  releaseSave.resolve();

  await assert.rejects(pendingWrite, /보관함이 초기화/u);
  assert.equal(saves, 1);
  assert.deepEqual(snapshot, emptySnapshot());
  assert.equal(etag, '"reset"');
  assert.equal(cache.inspect().snapshot, undefined);
});

test('the pre-reset barrier stops an in-flight old-tab conflict resolution before it can save', async () => {
  const cache = memoryCache();
  const remoteReadStarted = deferred();
  const releaseRemoteRead = deferred();
  const pendingSnapshot = {
    schemaVersion: 1,
    files: [
      textFile(
        'knowledge/22222222-2222-4222-8222-222222222222.json',
        `${JSON.stringify({
          schemaVersion: 1,
          id: '22222222-2222-4222-8222-222222222222',
          title: 'old local change',
          body: '',
          tags: [],
          createdAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
        })}\n`,
      ),
    ],
  };
  let phase = 'initial';
  let saves = 0;
  const remote = {
    async load() {
      if (phase === 'initial') {
        return { snapshot: emptySnapshot(), etag: '"old"' };
      }
      remoteReadStarted.resolve();
      await releaseRemoteRead.promise;
      // This is the ETag and empty snapshot installed by the server reset.
      return { snapshot: emptySnapshot(), etag: '"reset"' };
    },
    async save() {
      saves += 1;
      return { etag: '"should-not-save"' };
    },
  };
  const stale = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  await stale.load();
  const pending = await cache.compareAndSet({
    snapshot: pendingSnapshot,
    etag: '"old"',
    pending: true,
    expectedGeneration: cache.inspect().generation,
    expectedResetEpoch: 0,
  });
  stale._adoptCached(pending);
  stale.conflict = true;

  phase = 'resolve';
  const resolution = stale.resolveConflict('local');
  await remoteReadStarted.promise;

  const barrier = await beginBrowserWorkspaceReset('tenant', { cache });
  assert.deepEqual(barrier, { resetEpoch: 1 });
  assert.equal(cache.inspect().resetEpoch, 1);
  assert.equal(cache.inspect().generation, 2);
  assert.equal(cache.inspect().workspaceRecords.offlineAccess, false);

  releaseRemoteRead.resolve();
  await assert.rejects(resolution, /보관함이 초기화/u);
  assert.equal(saves, 0);

  // The old cache remains readable by a *new* instance until a definitively
  // confirmed server reset is finalized.
  const recoveryStore = new SnapshotDataStore(
    'tenant',
    storeOptions(cache, {
      async load() {
        return { snapshot: pendingSnapshot, etag: '"old"' };
      },
      async save() {
        throw new Error('unused');
      },
    }),
  );
  await recoveryStore.load();
  assert.equal((await recoveryStore.knowledge())[0].title, 'old local change');

  await finalizeBrowserWorkspaceReset('tenant', barrier.resetEpoch, { cache });
  assert.equal(cache.inspect().snapshot, undefined);
  assert.equal(cache.inspect().resetEpoch, 1);
  assert.deepEqual(cache.inspect().workspaceRecords, {
    snapshotLock: false,
    pcPolicy: false,
    offlineAccess: false,
  });
});

test('an explicit local conflict choice replaces the server snapshot and clears pending state', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const initial = {
    schemaVersion: 1,
    files: [textFile(`knowledge/${id}.json`, `${JSON.stringify({
      schemaVersion: 1,
      id,
      title: 'base',
      body: '',
      tags: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })}\n`)],
  };
  const remote = immediateRemote(initial);
  const local = new SnapshotDataStore(
    'tenant',
    storeOptions(memoryCache(), remote),
  );
  const other = new SnapshotDataStore(
    'tenant',
    storeOptions(memoryCache(), remote),
  );
  await local.load();
  await other.load();
  await other.updateKnowledge(id, { title: 'server', content: '', tags: [], scope: 'global' });
  await local.updateKnowledge(id, { title: 'local', content: '', tags: [], scope: 'global' });
  assert.equal(local.syncStatus().pending, true);
  assert.equal(local.syncStatus().conflict, true);

  const late = new SnapshotDataStore(
    'tenant',
    storeOptions(memoryCache(), remote),
  );
  await late.load();
  await late.createKnowledge({
    title: 'late server note',
    content: 'must survive the conflict choice',
    tags: [],
    scope: 'global',
  });

  assert.equal(await local.resolveConflict('local'), true);
  assert.deepEqual(local.syncStatus(), {
    pending: false,
    offline: false,
    conflict: false,
    error: null,
  });
  assert.equal(remote.inspect().snapshot.files.length, 2);
  assert.deepEqual(
    (await local.knowledge()).map((entry) => entry.title).sort(),
    ['late server note', 'local'],
  );
});

test('an explicit server conflict choice discards only the pending local snapshot', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const initial = {
    schemaVersion: 1,
    files: [textFile(`knowledge/${id}.json`, `${JSON.stringify({
      schemaVersion: 1,
      id,
      title: 'base',
      body: '',
      tags: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })}\n`)],
  };
  const remote = immediateRemote(initial);
  const local = new SnapshotDataStore(
    'tenant',
    storeOptions(memoryCache(), remote),
  );
  const other = new SnapshotDataStore(
    'tenant',
    storeOptions(memoryCache(), remote),
  );
  await local.load();
  await other.load();
  await other.updateKnowledge(id, { title: 'server', content: '', tags: [], scope: 'global' });
  await local.updateKnowledge(id, { title: 'local', content: '', tags: [], scope: 'global' });
  assert.equal(local.syncStatus().conflict, true);

  const late = new SnapshotDataStore(
    'tenant',
    storeOptions(memoryCache(), remote),
  );
  await late.load();
  await late.createKnowledge({
    title: 'late server note',
    content: 'must survive the conflict choice',
    tags: [],
    scope: 'global',
  });

  assert.equal(await local.resolveConflict('server'), true);
  assert.deepEqual(local.syncStatus(), {
    pending: false,
    offline: false,
    conflict: false,
    error: null,
  });
  assert.deepEqual(
    (await local.knowledge()).map((entry) => entry.title).sort(),
    ['late server note', 'server'],
  );
});

test('local conflict resolution rechecks the cache before mutating the server', async () => {
  const cache = memoryCache();
  const remoteRead = deferred();
  let saveCalls = 0;
  const remote = {
    async load() {
      await remoteRead.promise;
      return { snapshot: emptySnapshot(), etag: '"remote"' };
    },
    async save() {
      saveCalls += 1;
      return { etag: '"saved"' };
    },
  };
  const store = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  const initial = emptySnapshot();
  const first = await cache.compareAndSet({
    snapshot: initial,
    etag: '"stale"',
    pending: true,
    expectedGeneration: 0,
  });
  store._adoptCached(first);
  store.conflict = true;

  const resolution = store.resolveConflict('local');
  await new Promise((resolve) => setImmediate(resolve));
  const newer = await cache.compareAndSet({
    snapshot: initial,
    etag: '"stale"',
    pending: true,
    expectedGeneration: first.generation,
  });
  assert.equal(newer.updated, true);
  remoteRead.resolve();

  assert.equal(await resolution, false);
  assert.equal(saveCalls, 0);
  assert.equal(cache.inspect().generation, newer.generation);
});

test('_markClean rejects an unrelated clean record from another tab', async () => {
  const cache = memoryCache();
  const remote = immediateRemote();
  const store = new SnapshotDataStore('tenant', storeOptions(cache, remote));
  await store.load();
  const target = cache.inspect();

  const otherCache = memoryCache();
  const other = new SnapshotDataStore(
    'tenant',
    storeOptions(otherCache, immediateRemote()),
  );
  await other.load();
  await other.createKnowledge({ title: 'other', content: '', tags: [] });
  const otherSnapshot = otherCache.inspect().snapshot;
  const replacement = await cache.compareAndSet({
    snapshot: otherSnapshot,
    etag: '"other"',
    pending: false,
    expectedGeneration: target.generation,
  });
  assert.equal(replacement.updated, true);

  assert.equal(await store._markClean('"saved"', target), false);
  assert.equal(store.syncStatus().conflict, true);
  assert.equal(cache.inspect().etag, '"other"');
});

test('one repository keeps separate prod and test environment rules', async () => {
  const repositoryId = '11111111-1111-4111-8111-111111111111';
  const index = {
    schemaVersion: 1,
    repositories: {
      [repositoryId]: { id: repositoryId, name: 'backend' },
    },
  };
  const initial = {
    schemaVersion: 1,
    files: [textFile('repositories.json', `${JSON.stringify(index)}\n`)],
  };
  const store = new SnapshotDataStore(
    'tenant',
    storeOptions(memoryCache(), immediateRemote(initial)),
  );
  await store.load();

  await store.createRule({
    scope: 'env',
    repository: repositoryId,
    environment: 'prod',
    content: '배포 전 전체 검증을 실행한다.',
  });
  await store.createRule({
    scope: 'env',
    repository: repositoryId,
    environment: 'test',
    content: '테스트 데이터를 사용한다.',
  });

  const rules = await store.rules({ scope: 'env' });
  assert.deepEqual(
    rules.map((rule) => [rule.repositoryName, rule.environment, rule.content]),
    [
      ['backend', 'prod', '배포 전 전체 검증을 실행한다.'],
      ['backend', 'test', '테스트 데이터를 사용한다.'],
    ],
  );
  await assert.rejects(
    store.createRule({
      scope: 'env',
      repository: repositoryId,
      environment: 'PROD',
      content: '대소문자 중복',
    }),
    /같은 범위/u,
  );
  await assert.rejects(
    store.createRule({
      scope: 'env',
      repository: repositoryId,
      environment: 'CON',
      content: '이식 불가',
    }),
    /Windows/u,
  );
});

test('projects expose scoped data and web metadata changes synchronize through the snapshot', async () => {
  const repositoryId = '22222222-2222-4222-8222-222222222222';
  const index = {
    schemaVersion: 1,
    repositories: {
      [repositoryId]: {
        schemaVersion: 1,
        id: repositoryId,
        name: 'api',
        remoteAliases: ['github.com/example/api'],
        rootCommits: ['abc123'],
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    },
  };
  const initial = {
    schemaVersion: 1,
    files: [
      textFile('repositories.json', `${JSON.stringify(index)}\n`),
      textFile(`repositories/${repositoryId}/repository.json`, `${JSON.stringify(index.repositories[repositoryId])}\n`),
    ],
  };
  const remote = immediateRemote(initial);
  const store = new SnapshotDataStore(
    'tenant',
    storeOptions(memoryCache(), remote),
  );
  await store.load();
  await store.createRule({
    scope: 'repo',
    repository: repositoryId,
    content: '프로젝트 룰',
  });
  await store.createRule({
    scope: 'env',
    repository: repositoryId,
    environment: 'prod',
    content: '운영 환경 룰',
  });
  await store.createWork({
    repository: repositoryId,
    name: '배포 준비',
    goal: '배포한다',
    current: '검증 중',
  });
  await store.createKnowledge({
    title: '공통 지식',
    content: '모든 프로젝트',
    tags: ['shared'],
    scope: 'global',
  });
  await store.createKnowledge({
    title: '프로젝트 지식',
    content: '이 프로젝트',
    tags: ['project'],
    scope: 'repo',
    repository: repositoryId,
  });
  await store.createKnowledge({
    title: '운영 지식',
    content: '운영 환경',
    tags: ['prod'],
    scope: 'env',
    repository: repositoryId,
    environment: 'prod',
  });

  const project = await store.project(repositoryId);
  assert.equal(project.repository.name, 'api');
  assert.deepEqual(project.environments, ['prod']);
  assert.equal(project.rules.length, 2);
  assert.equal(project.activeWork.length, 1);
  assert.deepEqual(
    project.knowledge
      .map((entry) => [entry.scope, entry.title])
      .sort(([left], [right]) => left.localeCompare(right)),
    [['env', '운영 지식'], ['repo', '프로젝트 지식']],
  );
  assert.deepEqual(
    (await store.knowledge({ scope: 'global' })).map((entry) => entry.title),
    ['공통 지식'],
  );
  assert.deepEqual(
    (await store.knowledge({
      scope: 'env',
      repository: repositoryId,
      environment: 'prod',
    })).map((entry) => entry.title),
    ['운영 지식'],
  );

  const updated = await store.updateProject(repositoryId, {
    name: 'platform-api',
    description: '인증과 수업 API',
  });
  assert.equal(updated.name, 'platform-api');
  assert.equal(updated.description, '인증과 수업 API');
  assert.equal((await store.projects({ q: '수업' })).length, 1);

  const files = new Map(
    remote.inspect().snapshot.files.map((file) => [
      file.path,
      Buffer.from(file.content, 'base64').toString('utf8'),
    ]),
  );
  const remoteIndex = JSON.parse(files.get('repositories.json'));
  const remoteMirror = JSON.parse(files.get(`repositories/${repositoryId}/repository.json`));
  assert.equal(remoteIndex.repositories[repositoryId].name, 'platform-api');
  assert.equal(remoteMirror.description, '인증과 수업 API');
});

test('web knowledge review, named rules, task readiness, diagnostics, and briefing stay syncable', async () => {
  const repositoryId = '33333333-3333-4333-8333-333333333333';
  const repository = {
    schemaVersion: 1,
    id: repositoryId,
    name: 'knowledge-app',
    remoteAliases: ['github.com/example/knowledge-app'],
    rootCommits: ['abc123'],
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
  };
  const initial = {
    schemaVersion: 1,
    files: [textFile('repositories.json', `${JSON.stringify({
      schemaVersion: 1,
      repositories: { [repositoryId]: repository },
    })}\n`)],
  };
  const remote = immediateRemote(initial);
  const store = new SnapshotDataStore('tenant', storeOptions(memoryCache(), remote));
  await store.load();

  const rule = await store.createRule({
    title: 'SQL boundary',
    scope: 'repo',
    repository: repositoryId,
    content: 'Run migration checks.',
    status: 'draft',
    activation: 'always',
    paths: 'database/**',
    files: '**/*.sql',
  });
  assert.equal(rule._record, true);
  assert.equal((await store.rules({ q: 'SQL boundary' }))[0].status, 'draft');

  const work = await store.createWork({
    repository: repositoryId,
    name: 'Document recovery',
    goal: 'Write a recovery runbook',
    current: 'Ready to begin',
    priority: 'high',
    workflowStatus: 'in_progress',
    claimedBy: 'codex-session',
  });
  assert.equal(work.claimedBy, 'codex-session');
  assert.ok(Number.isFinite(Date.parse(work.claimExpiresAt)));

  const suggested = await store.createKnowledge({
    title: 'Restore order',
    content: 'Restore the database before the encrypted blobs.',
    tags: ['recovery'],
    scope: 'repo',
    repository: repositoryId,
    type: 'runbook',
    state: 'review_needed',
    approval: 'pending',
    pinned: true,
    sourceRef: 'https://example.invalid/runbook',
  });
  assert.equal(suggested.sources[0].kind, 'url');
  assert.equal((await store.recentKnowledge()).length, 0);

  let diagnostics = await store.diagnostics();
  assert.equal(diagnostics.draftRules, 1);
  assert.equal(diagnostics.knowledgeAttention, 1);
  await store.reviewKnowledge(suggested.id, 'approve');
  await store.feedbackKnowledge(suggested.id, 'helpful');
  assert.equal((await store.recentKnowledge())[0].feedback.helpful, 1);

  const project = await store.project(repositoryId);
  assert.equal(project.briefing.nextWork.id, work.id);
  assert.equal(project.briefing.pinnedKnowledge[0].id, suggested.id);
  assert.ok((await store.activity()).some((item) => item.action === 'approved'));
  diagnostics = await store.diagnostics();
  assert.equal(diagnostics.knowledgeAttention, 0);
});
