import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  mergeSyncSnapshots,
  validateSyncSnapshot,
} from '../src/sync/index.mjs';

function file(relativePath, value) {
  const contents = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8');
  return {
    path: relativePath,
    encoding: 'base64',
    bytes: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
    content: contents.toString('base64'),
  };
}

function snapshot(entries = {}) {
  return {
    schemaVersion: 1,
    files: Object.entries(entries).map(([relativePath, value]) => file(relativePath, value)),
  };
}

function contentsOf(mergedSnapshot, relativePath) {
  const entry = mergedSnapshot.files.find((candidate) => candidate.path === relativePath);
  return entry ? Buffer.from(entry.content, 'base64') : null;
}

function textOf(mergedSnapshot, relativePath) {
  return contentsOf(mergedSnapshot, relativePath)?.toString('utf8') ?? null;
}

test('three-way file rules select unchanged sides and regenerate canonical records', () => {
  const base = snapshot({
    'repositories/z/policy.md': 'z-base',
    'policies/global.md': 'global-base',
    'repositories/a/policy.md': 'a-base',
  });
  const local = snapshot({
    'repositories/z/policy.md': 'z-local',
    'policies/global.md': 'global-base',
    'repositories/a/policy.md': 'a-same',
  });
  const remote = snapshot({
    'repositories/z/policy.md': 'z-base',
    'policies/global.md': 'global-remote',
    'repositories/a/policy.md': 'a-same',
  });

  const result = mergeSyncSnapshots(base, local, remote);
  assert.deepEqual(result.snapshot.files.map((entry) => entry.path), [
    'policies/global.md',
    'repositories/a/policy.md',
    'repositories/z/policy.md',
  ]);
  assert.equal(textOf(result.snapshot, 'policies/global.md'), 'global-remote');
  assert.equal(textOf(result.snapshot, 'repositories/a/policy.md'), 'a-same');
  assert.equal(textOf(result.snapshot, 'repositories/z/policy.md'), 'z-local');
  assert.deepEqual(result.conflicts, []);
  assert.doesNotThrow(() => validateSyncSnapshot(result.snapshot));
  for (const entry of result.snapshot.files) {
    const contents = Buffer.from(entry.content, 'base64');
    assert.equal(entry.bytes, contents.byteLength);
    assert.equal(entry.sha256, createHash('sha256').update(contents).digest('hex'));
  }
});

test('independent additions and deletions merge, while delete-versus-edit keeps local deletion', () => {
  const base = snapshot({
    'repositories/a/policy.md': 'remove-me',
    'repositories/b/policy.md': 'remote-removes',
    'repositories/c/policy.md': 'edit-or-delete',
  });
  const local = snapshot({
    'repositories/b/policy.md': 'remote-removes',
    'repositories/local/policy.md': 'local-add',
  });
  const remote = snapshot({
    'repositories/a/policy.md': 'remove-me',
    'repositories/c/policy.md': 'remote-edit',
    'repositories/remote/policy.md': 'remote-add',
  });

  const { snapshot: merged, conflicts } = mergeSyncSnapshots(base, local, remote);
  assert.equal(textOf(merged, 'repositories/a/policy.md'), null);
  assert.equal(textOf(merged, 'repositories/b/policy.md'), null);
  assert.equal(textOf(merged, 'repositories/c/policy.md'), null);
  assert.equal(textOf(merged, 'repositories/local/policy.md'), 'local-add');
  assert.equal(textOf(merged, 'repositories/remote/policy.md'), 'remote-add');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'repositories/c/policy.md');
  assert.equal(conflicts[0].local, null);
  assert.equal(Buffer.from(conflicts[0].base.content, 'base64').toString('utf8'), 'edit-or-delete');
  assert.equal(Buffer.from(conflicts[0].remote.content, 'base64').toString('utf8'), 'remote-edit');
});

test('incompatible concurrent binary additions keep local bytes and record all versions', () => {
  const localBytes = Buffer.from([0, 255, 1, 254]);
  const remoteBytes = Buffer.from([0, 255, 2, 253]);
  const result = mergeSyncSnapshots(
    snapshot(),
    snapshot({ 'repositories/a/artifact.bin': localBytes }),
    snapshot({ 'repositories/a/artifact.bin': remoteBytes }),
  );

  assert.deepEqual(contentsOf(result.snapshot, 'repositories/a/artifact.bin'), localBytes);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].base, null);
  assert.deepEqual(Buffer.from(result.conflicts[0].local.content, 'base64'), localBytes);
  assert.deepEqual(Buffer.from(result.conflicts[0].remote.content, 'base64'), remoteBytes);
  assert.equal(result.conflicts[0].local.sha256, createHash('sha256').update(localBytes).digest('hex'));
});

test('repository maps recursively merge independent keys and fields', () => {
  const baseIndex = JSON.stringify({
    repoA: { name: 'A', revision: 1, settings: { color: 'blue', size: 1 } },
    stable: true,
  });
  const localIndex = JSON.stringify({
    repoA: { name: 'Local A', revision: 1, settings: { color: 'blue', size: 1 } },
    repoLocal: { name: 'local' },
    stable: true,
  });
  const remoteIndex = JSON.stringify({
    repoA: { name: 'A', revision: 2, settings: { color: 'green', size: 1 } },
    repoRemote: { name: 'remote' },
    stable: true,
  });

  const result = mergeSyncSnapshots(
    snapshot({ 'repositories.json': baseIndex }),
    snapshot({ 'repositories.json': localIndex }),
    snapshot({ 'repositories.json': remoteIndex }),
  );
  assert.deepEqual(JSON.parse(textOf(result.snapshot, 'repositories.json')), {
    repoA: {
      name: 'Local A',
      revision: 2,
      settings: { color: 'green', size: 1 },
    },
    repoLocal: { name: 'local' },
    repoRemote: { name: 'remote' },
    stable: true,
  });
  assert.deepEqual(result.conflicts, []);
});

test('same JSON key conflict is local-wins while unrelated remote fields still merge', () => {
  const path = 'repositories/repo-a/repository.json';
  const baseValue = JSON.stringify({ metadata: { revision: 1, owner: 'base' }, tags: ['base'] });
  const localValue = JSON.stringify({ metadata: { revision: 2, owner: 'base', local: true }, tags: ['local'] });
  const remoteValue = JSON.stringify({ metadata: { revision: 3, owner: 'remote' }, tags: ['remote'] });
  const result = mergeSyncSnapshots(
    snapshot({ [path]: baseValue }),
    snapshot({ [path]: localValue }),
    snapshot({ [path]: remoteValue }),
  );

  assert.deepEqual(JSON.parse(textOf(result.snapshot, path)), {
    metadata: {
      local: true,
      owner: 'remote',
      revision: 2,
    },
    tags: ['local'],
  });
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, path);
  assert.equal(Buffer.from(result.conflicts[0].base.content, 'base64').toString('utf8'), baseValue);
  assert.equal(Buffer.from(result.conflicts[0].local.content, 'base64').toString('utf8'), localValue);
  assert.equal(Buffer.from(result.conflicts[0].remote.content, 'base64').toString('utf8'), remoteValue);
});

test('concurrently-created repository metadata objects merge by key', () => {
  const path = 'repositories/new-repo/repository.json';
  const result = mergeSyncSnapshots(
    snapshot(),
    snapshot({ [path]: JSON.stringify({ id: 'repo-id', localRoot: '/work' }) }),
    snapshot({ [path]: JSON.stringify({ id: 'repo-id', remote: 'origin' }) }),
  );
  assert.deepEqual(JSON.parse(textOf(result.snapshot, path)), {
    id: 'repo-id',
    localRoot: '/work',
    remote: 'origin',
  });
  assert.deepEqual(result.conflicts, []);
});

test('invalid JSON at a mergeable path falls back to opaque local-wins conflict handling', () => {
  const path = 'repositories.json';
  const invalidLocal = Buffer.from('{"repo":', 'utf8');
  const result = mergeSyncSnapshots(
    snapshot({ [path]: '{"repo":{"revision":1}}' }),
    snapshot({ [path]: invalidLocal }),
    snapshot({ [path]: '{"repo":{"revision":2}}' }),
  );

  assert.deepEqual(contentsOf(result.snapshot, path), invalidLocal);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, path);
});

test('non-UTF-8 repository JSON bytes are never decoded lossily', () => {
  const path = 'repositories.json';
  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  const result = mergeSyncSnapshots(
    snapshot({ [path]: '{"x":"base"}' }),
    snapshot({ [path]: invalidUtf8 }),
    snapshot({ [path]: '{"x":"remote"}' }),
  );

  assert.deepEqual(contentsOf(result.snapshot, path), invalidUtf8);
  assert.equal(result.conflicts.length, 1);
});

test('invalid input snapshots are rejected before merge and inputs remain unchanged', () => {
  const base = snapshot({ 'policies/global.md': 'base' });
  const local = snapshot({ 'policies/global.md': 'local' });
  const remote = snapshot({ 'policies/global.md': 'remote' });
  const before = [base, local, remote].map((value) => JSON.stringify(value));
  const invalidRemote = structuredClone(remote);
  invalidRemote.files[0].sha256 = '0'.repeat(64);

  assert.throws(() => mergeSyncSnapshots(base, local, invalidRemote), /Digest mismatch/);
  mergeSyncSnapshots(base, local, remote);
  assert.deepEqual([base, local, remote].map((value) => JSON.stringify(value)), before);
});
