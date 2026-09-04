import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { UsageError, optionBoolean, optionString } from './args.mjs';
import {
  readJson,
  removeFile,
  withFileLock,
  writeJsonAtomic,
  writeTextAtomic,
} from './core/fs.mjs';
import { restoreJournalPath, withStateLock } from './core/mutation-lock.mjs';
import { getAutoSync } from './core/state.mjs';
import { readStdin, readTextInput } from './input.mjs';
import { statePaths } from './paths.mjs';
import { writeJson } from './presentation.mjs';
import {
  captureSyncSnapshot,
  restoreSyncSnapshot,
  validateSyncSnapshot,
} from './sync/capture.mjs';
import {
  SyncClient,
  SyncHttpError,
  enrollDevice,
  joinDevice,
} from './sync/client.mjs';
import {
  decryptBytes,
  decryptSnapshot,
  generateVaultKey,
  parseVaultKey,
  readVaultKey,
  serializeVaultKey,
  writeVaultKey,
} from './sync/crypto.mjs';
import { atomicWriteFile, assertRegularFile, ensurePrivateDirectory } from './sync/io.mjs';
import { mergeSyncSnapshots } from './sync/merge.mjs';

const REMOTE_SCHEMA_VERSION = 1;
const DEVICE_TOKEN_FILE = 'device.token';
const VAULT_KEY_FILE = 'vault.key';
const MAX_DEVICE_TOKEN_BYTES = 256;
const DEVICE_INVITE_PREFIX = 'hndj_';
const MAX_ETAG_HISTORY = 128;
const SYNC_BASE_SCHEMA_VERSION = 1;
const MERGE_REPORT_SCHEMA_VERSION = 1;
const EMPTY_SYNC_SNAPSHOT = Object.freeze({
  schemaVersion: 1,
  files: Object.freeze([]),
});

const ACCOUNT_CONNECTION_GUIDE = [
  'HND 웹에 로그인한 뒤 [기기] → [PC 연결]에서 일회용 연결 코드를 만드세요.',
  '이 PC에서 hnd connect를 실행하고 웹에서 만든 코드를 붙여넣으세요. 첫 PC와 추가 PC의 연결 방법은 같습니다.',
  '기존 PC가 켜져 있거나 초대를 만들어 줄 필요는 없습니다. 서버 계정이 연결 권한과 보호된 보관함 키를 관리합니다.',
].join('\n');

const VAULT_RECOVERY_GUIDE = [
  '서버에 잠시 연결할 수 없으면 마지막 로컬 캐시로 계속 작업합니다.',
  '연결이 복구되면 대기 중인 변경을 자동으로 동기화합니다.',
].join('\n');

function connectionGuide() {
  return `${ACCOUNT_CONNECTION_GUIDE}\n\n${VAULT_RECOVERY_GUIDE}`;
}

function enrollUsage(problem) {
  return [
    problem,
    '',
    '이 명령은 이전 연결 방식과의 호환을 위해 유지됩니다.',
    ACCOUNT_CONNECTION_GUIDE,
    '',
    '사용법:',
    '  hnd sync enroll --url URL --key-stdin --name PC_NAME --vault-key-file PATH',
  ].join('\n');
}

function joinUsage(problem) {
  return [
    problem,
    '',
    ACCOUNT_CONNECTION_GUIDE,
    '',
    '사용법:',
    '  hnd connect --url URL --code-stdin --name PC_NAME',
    '  hnd sync join --url URL --invite-stdin --name PC_NAME  # 이전 별칭',
  ].join('\n');
}

export class RemoteConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RemoteConflictError';
    this.code = 'REMOTE_CONFLICT';
    this.exitCode = 3;
    this.details = details;
  }
}

function writeText(stream, value) {
  const source = String(value ?? '');
  stream.write(source.endsWith('\n') ? source : `${source}\n`);
}

function assertOptions(options, allowed) {
  const valid = new Set(['cwd', 'json', ...allowed]);
  const unknown = Object.keys(options).filter((name) => !valid.has(name));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown remote option: --${unknown[0].replaceAll('_', '-')}`);
  }
}

function ensureNoExtra(values, usage) {
  if (values.length > 0) throw new UsageError(`Unexpected argument: ${values[0]}\nUsage: ${usage}`);
}

function secretPaths(env) {
  const state = statePaths(env);
  return {
    ...state,
    deviceToken: path.join(state.secrets, DEVICE_TOKEN_FILE),
    vaultKey: path.join(state.secrets, VAULT_KEY_FILE),
  };
}

function syncBasePath(env, etag) {
  if (!/^"[a-f0-9]{64}"$/.test(etag || '')) {
    throw new Error('A strong ETag is required for a sync merge base.');
  }
  return path.join(statePaths(env).cache, 'sync-bases', `${etag.slice(1, -1)}.json`);
}

function validSyncBaseEnvelope(value) {
  return Boolean(
    value
    && Object.keys(value).every((key) => [
      'schemaVersion',
      'etag',
      'snapshotDigest',
      'snapshot',
      'savedAt',
    ].includes(key))
    && value.schemaVersion === SYNC_BASE_SCHEMA_VERSION
    && /^"[a-f0-9]{64}"$/.test(value.etag)
    && /^[a-f0-9]{64}$/.test(value.snapshotDigest)
    && typeof value.savedAt === 'string'
    && value.snapshot?.schemaVersion === 1
    && Array.isArray(value.snapshot.files),
  );
}

async function readSyncBase(env, etag, { optional = false } = {}) {
  if (!etag) return null;
  const envelope = await readJson(syncBasePath(env, etag), {
    optional,
    validate: validSyncBaseEnvelope,
  });
  if (!envelope) return null;
  validateSyncSnapshot(envelope.snapshot);
  const digest = snapshotDigest(envelope.snapshot);
  if (envelope.etag !== etag || envelope.snapshotDigest !== digest) {
    throw new Error('The cached sync merge base failed its integrity check.');
  }
  return envelope.snapshot;
}

async function writeSyncBase(env, etag, snapshot) {
  validateSyncSnapshot(snapshot);
  const envelope = {
    schemaVersion: SYNC_BASE_SCHEMA_VERSION,
    etag,
    snapshotDigest: snapshotDigest(snapshot),
    snapshot,
    savedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(syncBasePath(env, etag), envelope);
  return envelope;
}

async function pruneSyncBases(env, currentEtag) {
  const directory = path.join(statePaths(env).cache, 'sync-bases');
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const keep = currentEtag ? `${currentEtag.slice(1, -1)}.json` : null;
  for (const entry of entries) {
    if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name) && entry.name !== keep) {
      await removeFile(path.join(directory, entry.name));
    }
  }
}

async function saveRemoteCheckpoint(env, config, etag, snapshot, fields = {}) {
  await writeSyncBase(env, etag, snapshot);
  const saved = await saveRemoteConfig(env, {
    ...config,
    ...fields,
    etag,
    snapshotDigest: snapshotDigest(snapshot),
  });
  await pruneSyncBases(env, saved.etag);
  return saved;
}

function normalizeRemoteUrl(value, env = process.env) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError('서버 주소가 올바르지 않습니다. https://hnd.example.com처럼 https://를 포함하고 /app 또는 /setup 경로는 빼세요.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new UsageError('서버 주소에는 http(s) 주소의 기본 경로만 사용할 수 있습니다. 계정 정보, /app 같은 경로, 쿼리는 빼세요.');
  }
  // WHATWG URL retains brackets around an IPv6 hostname in Node.js.
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (url.protocol !== 'https:' && !localHosts.has(url.hostname) && env.HND_ALLOW_INSECURE_HTTP !== '1') {
    throw new UsageError('원격 서버 연결에는 HTTPS가 필요합니다. 신뢰하는 사설 테스트망에서만 HND_ALLOW_INSECURE_HTTP=1을 사용하세요.');
  }
  return url.origin;
}

function validRemoteConfig(value) {
  return Boolean(
    value
    && value.schemaVersion === REMOTE_SCHEMA_VERSION
    && typeof value.baseUrl === 'string'
    && typeof value.device?.id === 'string'
    && (value.etag === null || /^"[a-f0-9]{64}"$/.test(value.etag))
    && (value.etagHistory === undefined || (
      Array.isArray(value.etagHistory)
      && value.etagHistory.length <= MAX_ETAG_HISTORY
      && value.etagHistory.every((etag) => /^"[a-f0-9]{64}"$/.test(etag))
    ))
    && (value.snapshotDigest === null || /^[a-f0-9]{64}$/.test(value.snapshotDigest)),
  );
}

async function readRemoteConfig(env, { optional = false } = {}) {
  const config = await readJson(secretPaths(env).remotes, {
    // A missing file is a normal "not enrolled yet" state. Read it
    // optionally here so required callers can translate that state into an
    // actionable usage error instead of leaking the underlying ENOENT/path.
    optional: true,
    validate: validRemoteConfig,
  });
  if (!config && !optional) {
    throw new UsageError(`이 PC는 아직 HND 서버에 연결되지 않았습니다.\n\n${connectionGuide()}`);
  }
  return config;
}

async function saveRemoteConfig(env, config) {
  const current = await readRemoteConfig(env, { optional: true });
  const now = new Date().toISOString();
  const etagHistory = [...new Set([
    ...(current?.etagHistory || []),
    ...(config.etagHistory || []),
    ...(config.etag ? [config.etag] : []),
  ])].slice(-MAX_ETAG_HISTORY);
  const next = {
    ...config,
    schemaVersion: REMOTE_SCHEMA_VERSION,
    etagHistory,
    enrolledAt: current?.enrolledAt || config.enrolledAt || now,
    updatedAt: now,
  };
  if (!validRemoteConfig(next)) throw new Error('Refusing to write invalid remote configuration.');
  await writeJsonAtomic(secretPaths(env).remotes, next);
  return next;
}

function assertNoKnownRollback(config, receivedEtag) {
  if (
    receivedEtag
    && receivedEtag !== config.etag
    && (config.etagHistory || []).includes(receivedEtag)
  ) {
    throw new RemoteConflictError(
      'The server returned a previously superseded encrypted revision; refusing a possible rollback.',
      { expectedEtag: config.etag, receivedEtag },
    );
  }
}

async function readDeviceToken(env) {
  const filePath = secretPaths(env).deviceToken;
  const metadata = await assertRegularFile(filePath);
  if (metadata.size > MAX_DEVICE_TOKEN_BYTES) throw new Error('Device token file is unexpectedly large.');
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('Device token file permissions are too broad; expected 0600.');
  }
  const token = (await fs.readFile(filePath, 'utf8')).trim();
  if (!/^hndd_[A-Za-z0-9_-]{40,64}$/.test(token)) throw new Error('Device token file is invalid.');
  return token;
}

async function readSuppliedVaultKey(filePath) {
  const resolved = path.resolve(filePath);
  let contents;
  try {
    contents = await fs.readFile(resolved, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new UsageError(
        `암호화 키 파일을 찾을 수 없습니다: ${resolved}\n이 옵션은 이전 연결 또는 복구용입니다. 새 PC는 HND 웹의 [기기] → [PC 연결]에서 코드를 만드세요.`,
      );
    }
    if (error.code === 'EACCES') {
      throw new UsageError(`암호화 키 파일을 읽을 권한이 없습니다: ${resolved}`);
    }
    throw error;
  }
  try {
    return parseVaultKey(contents);
  } catch {
    throw new UsageError(
      '암호화 키 파일 형식이 올바르지 않습니다. 보관해 둔 복구 키 파일을 확인하세요. 새 PC는 HND 웹의 [기기] → [PC 연결]을 사용하세요.',
    );
  }
}

async function createClient(env, urlOverride, clientOptions = {}) {
  const config = await readRemoteConfig(env);
  const configuredUrl = normalizeRemoteUrl(config.baseUrl, env);
  if (urlOverride !== undefined && normalizeRemoteUrl(urlOverride, env) !== configuredUrl) {
    throw new UsageError('The supplied URL does not match the connected HND server. Reconnect this PC to change trust endpoints.');
  }
  return {
    config,
    client: new SyncClient({
      ...clientOptions,
      baseUrl: configuredUrl,
      deviceToken: await readDeviceToken(env),
    }),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function snapshotDigest(snapshot) {
  return createHash('sha256').update(JSON.stringify(stableValue(snapshot))).digest('hex');
}

export function formatDeviceInvite(invitationToken, secret) {
  if (!/^hndi_[A-Za-z0-9_-]{43}$/.test(invitationToken)) {
    throw new Error('Invalid server invitation token.');
  }
  const secretBuffer = Buffer.from(secret);
  if (secretBuffer.byteLength !== 32) throw new Error('Invalid invitation secret.');
  const tokenPart = invitationToken.slice('hndi_'.length);
  const secretPart = secretBuffer.toString('base64url');
  const checksum = createHash('sha256')
    .update(`${tokenPart}.${secretPart}`)
    .digest('base64url')
    .slice(0, 12);
  return `${DEVICE_INVITE_PREFIX}${tokenPart}.${secretPart}.${checksum}`;
}

export function parseDeviceInvite(value) {
  const match = /^hndj_([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{12})$/.exec(String(value));
  if (!match) throw new UsageError('The device invitation is invalid.');
  const expected = createHash('sha256')
    .update(`${match[1]}.${match[2]}`)
    .digest('base64url')
    .slice(0, 12);
  if (match[3] !== expected) throw new UsageError('The device invitation checksum is invalid.');
  const secret = Buffer.from(match[2], 'base64url');
  if (secret.byteLength !== 32 || secret.toString('base64url') !== match[2]) {
    throw new UsageError('The device invitation secret is invalid.');
  }
  return Object.freeze({ invitationToken: `hndi_${match[1]}`, secret });
}

function snapshotIsEmpty(snapshot) {
  for (const file of snapshot.files ?? []) {
    if (file.path !== 'repositories.json') return false;
    try {
      const parsed = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
      if (Object.keys(parsed.repositories ?? {}).length > 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function backupSnapshot(env, snapshot, { reason = 'pull' } = {}) {
  const state = statePaths(env);
  const compactTimestamp = new Date().toISOString().replaceAll(':', '-');
  const filePath = path.join(
    state.cache,
    `pre-${reason}-${compactTimestamp}-${randomUUID().slice(0, 8)}.json`,
  );
  await writeTextAtomic(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return filePath;
}

async function writeMergeReport(env, { baseEtag, remoteEtag, conflicts, mergedDigest }) {
  if (conflicts.length === 0) return null;
  const compactTimestamp = new Date().toISOString().replaceAll(':', '-');
  const filePath = path.join(
    statePaths(env).cache,
    `merge-conflicts-${compactTimestamp}-${randomUUID().slice(0, 8)}.json`,
  );
  await writeJsonAtomic(filePath, {
    schemaVersion: MERGE_REPORT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    baseEtag,
    remoteEtag,
    mergedDigest,
    resolution: 'The local version was retained for every listed conflict.',
    conflicts,
  });
  return filePath;
}

async function resolveMergeBase(env, config, client, key) {
  if (!config.etag) return EMPTY_SYNC_SNAPSHOT;
  const cached = await readSyncBase(env, config.etag, { optional: true });
  if (cached) return cached;

  // Upgrade/recovery path for clients that synced before merge-base caching was
  // introduced. Revisions are content-addressed by the encrypted payload ETag.
  const revision = await client.getRevision(config.etag.slice(1, -1));
  if (!revision) {
    throw new RemoteConflictError(
      'The common sync base is no longer available. Review local changes, then use pull --force or restore a retained revision.',
      { baseEtag: config.etag },
    );
  }
  const snapshot = decryptSnapshot(revision.blob, key);
  const digest = snapshotDigest(snapshot);
  if (config.snapshotDigest && digest !== config.snapshotDigest) {
    throw new RemoteConflictError(
      'The recovered merge base does not match the local sync checkpoint.',
      { baseEtag: config.etag, expectedDigest: config.snapshotDigest, receivedDigest: digest },
    );
  }
  await writeSyncBase(env, config.etag, snapshot);
  return snapshot;
}

function withRemoteOperationLock(env, callback, options = {}) {
  return withFileLock(
    path.join(statePaths(env).locks, 'remote-operation.lock'),
    callback,
    {
      timeoutMs: options.timeoutMs ?? 45_000,
      staleMs: options.staleMs ?? 5 * 60_000,
    },
  );
}

function validRestoreJournal(value) {
  return Boolean(
    value
    && value.schemaVersion === 1
    && typeof value.operationId === 'string'
    && value.previous?.schemaVersion === 1
    && Array.isArray(value.previous.files)
    && value.target?.schemaVersion === 1
    && Array.isArray(value.target.files)
    && typeof value.targetDigest === 'string',
  );
}

async function verifyRestoredSnapshot(env, expectedDigest) {
  const actual = snapshotDigest(await captureSyncSnapshot(statePaths(env).home));
  if (actual !== expectedDigest) {
    throw new Error('Restored state does not match the fully validated target snapshot.');
  }
}

async function recoverRestoreJournal(env) {
  const filePath = restoreJournalPath(env);
  const journal = await readJson(filePath, { optional: true, validate: validRestoreJournal });
  if (!journal) return null;
  await restoreSyncSnapshot(statePaths(env).home, journal.target, { prune: true });
  await verifyRestoredSnapshot(env, journal.targetDigest);
  await removeFile(filePath);
  return { recovered: true, operationId: journal.operationId };
}

async function transactionalRestore(env, target, previous) {
  await recoverRestoreJournal(env);
  const filePath = restoreJournalPath(env);
  const journal = {
    schemaVersion: 1,
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    previous,
    target,
    targetDigest: snapshotDigest(target),
  };
  await writeJsonAtomic(filePath, journal);
  try {
    const restored = await restoreSyncSnapshot(statePaths(env).home, target, { prune: true });
    await verifyRestoredSnapshot(env, journal.targetDigest);
    await removeFile(filePath);
    return restored;
  } catch (error) {
    try {
      await restoreSyncSnapshot(statePaths(env).home, previous, { prune: true });
      await verifyRestoredSnapshot(env, snapshotDigest(previous));
      await removeFile(filePath);
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }
}

async function reconcileBindings(env) {
  const paths = statePaths(env);
  const [bindings, index] = await Promise.all([
    readJson(paths.bindings, { optional: true }),
    readJson(paths.repoIndex, { optional: true }),
  ]);
  if (!bindings?.bindings || !index?.repositories) return { removed: 0 };
  const validIds = new Set(Object.keys(index.repositories));
  let removed = 0;
  for (const [root, binding] of Object.entries(bindings.bindings)) {
    if (!validIds.has(binding?.repoId)) {
      delete bindings.bindings[root];
      removed += 1;
    }
  }
  if (removed > 0) await writeJsonAtomic(paths.bindings, bindings);
  return { removed };
}

async function enroll({ options, rest, env, stdin, stdout, jsonOutput }) {
  assertOptions(options, [
    'url',
    'key',
    'key_stdin',
    'name',
    'vault_key_file',
    'create_vault_key',
  ]);
  ensureNoExtra(
    rest,
    'hnd sync enroll --url URL (--key ONE_TIME_KEY | --key-stdin) [--name DEVICE] (--vault-key-file PATH | --create-vault-key)',
  );
  const remoteUrl = optionString(options, 'url');
  if (!remoteUrl) throw new UsageError(enrollUsage('서버 주소가 없습니다.'));
  const baseUrl = normalizeRemoteUrl(remoteUrl, env);
  const inlineKey = optionString(options, 'key');
  const keyStdin = optionBoolean(options, 'key_stdin');
  if (inlineKey && keyStdin) throw new UsageError('Choose only one of --key or --key-stdin.');
  const enrollmentKey = keyStdin
    ? (await readStdin(stdin)).trim()
    : inlineKey || env.HND_ENROLLMENT_KEY;
  if (!enrollmentKey) {
    throw new UsageError(enrollUsage('일회용 연결 코드가 없습니다.'));
  }
  const name = optionString(options, 'name', env.HOSTNAME || 'unnamed-device');
  const paths = secretPaths(env);
  if (await readRemoteConfig(env, { optional: true })) {
    throw new UsageError('이 PC는 이미 HND 계정에 연결되어 있습니다. 현재 상태는 hnd sync status로 확인하세요.');
  }
  try {
    await assertRegularFile(paths.deviceToken);
    throw new UsageError('A device token already exists without an HND account connection; move it aside before connecting this PC.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await ensurePrivateDirectory(paths.secrets);
  let vaultKey;
  let vaultKeySource = 'existing';
  let hasExistingVaultKey = false;
  try {
    vaultKey = await readVaultKey(paths.vaultKey);
    hasExistingVaultKey = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const vaultKeyFile = optionString(options, 'vault_key_file');
  const createVaultKey = optionBoolean(options, 'create_vault_key');
  if (vaultKeyFile && createVaultKey) {
    throw new UsageError('--vault-key-file과 --create-vault-key 중 하나만 사용하세요.');
  }
  if (hasExistingVaultKey) {
    if (vaultKeyFile) {
      const importedVaultKey = await readSuppliedVaultKey(vaultKeyFile);
      const matchesExisting = vaultKey.equals(importedVaultKey);
      importedVaultKey.fill(0);
      if (!matchesExisting) {
        throw new UsageError(
          '지정한 암호화 키가 이 PC에 이미 저장된 키와 다릅니다. 덮어쓰지 않았습니다.',
        );
      }
    }
  } else {
    if (!vaultKeyFile && !createVaultKey) {
      throw new UsageError(enrollUsage('암호화 키 파일이 없습니다. 이 이전 명령을 계속 사용하려면 보관해 둔 복구 키 파일을 지정하세요.'));
    }
    vaultKey = vaultKeyFile
      ? await readSuppliedVaultKey(vaultKeyFile)
      : generateVaultKey();
    vaultKeySource = vaultKeyFile ? 'imported' : 'generated-explicitly';
    await writeVaultKey(paths.vaultKey, vaultKey);
  }

  const result = await enrollDevice({
    baseUrl,
    enrollmentKey,
    deviceName: name,
    timeoutMs: 30_000,
  });
  await atomicWriteFile(paths.deviceToken, `${result.deviceToken}\n`, { maxBytes: MAX_DEVICE_TOKEN_BYTES });
  const config = await saveRemoteConfig(env, {
    baseUrl,
    device: result.device,
    etag: null,
    snapshotDigest: null,
    lastSyncAt: null,
  });
  const output = { enrolled: true, baseUrl, device: result.device, vaultKeySource, config };
  if (jsonOutput) writeJson(output, stdout);
  else writeText(stdout, `이전 방식 PC 연결 완료: ${result.device.name} (${result.device.id})\n서버: ${baseUrl}`);
}

async function invite({ options, rest, env, stdout, jsonOutput }) {
  assertOptions(options, ['url', 'ttl_minutes']);
  ensureNoExtra(rest, 'hnd sync invite [--ttl-minutes N]');
  // Retired deliberately: account-authorized invitations are issued by the
  // web application. Keep this branch free of local secret and network reads
  // so an old script cannot silently reintroduce a "main PC" dependency.
  void env;
  void stdout;
  void jsonOutput;
  throw new UsageError([
    '`hnd sync invite`는 더 이상 PC 연결 코드를 만들지 않습니다.',
    '',
    ACCOUNT_CONNECTION_GUIDE,
  ].join('\n'));
}

async function join({ subcommand, options, rest, env, stdin, stdout, jsonOutput }) {
  assertOptions(options, ['url', 'invite', 'invite_stdin', 'code', 'code_stdin', 'name']);
  ensureNoExtra(
    rest,
    subcommand === 'connect'
      ? 'hnd connect --url URL (--code CODE | --code-stdin) [--name DEVICE]'
      : 'hnd sync join --url URL (--invite INVITATION | --invite-stdin) [--name DEVICE]',
  );
  const remoteUrl = optionString(options, 'url');
  if (!remoteUrl) throw new UsageError(joinUsage('서버 주소가 없습니다.'));
  const baseUrl = normalizeRemoteUrl(remoteUrl, env);
  const inlineInvite = optionString(options, 'invite');
  const inlineCode = optionString(options, 'code');
  const inviteStdin = optionBoolean(options, 'invite_stdin');
  const codeStdin = optionBoolean(options, 'code_stdin');
  const suppliedMethods = [inlineInvite, inlineCode, inviteStdin, codeStdin].filter(Boolean);
  if (suppliedMethods.length > 1) {
    throw new UsageError('연결 코드는 --code, --code-stdin, --invite, --invite-stdin 중 하나로만 입력하세요.');
  }
  const invitationSource = inviteStdin || codeStdin
    ? (await readStdin(stdin)).trim()
    : inlineInvite || inlineCode || env.HND_DEVICE_INVITATION;
  if (!invitationSource) {
    throw new UsageError(joinUsage('일회용 연결 코드가 없습니다.'));
  }
  const invitation = parseDeviceInvite(invitationSource);
  const name = optionString(options, 'name', env.HOSTNAME || 'unnamed-device');
  const paths = secretPaths(env);
  if (await readRemoteConfig(env, { optional: true })) {
    throw new UsageError('이 PC는 이미 HND 계정에 연결되어 있습니다. 현재 상태는 hnd sync status로 확인하세요.');
  }
  for (const filePath of [paths.deviceToken, paths.vaultKey]) {
    try {
      await assertRegularFile(filePath);
      throw new UsageError(`A secret already exists at ${filePath}; refusing to overwrite it.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await ensurePrivateDirectory(paths.secrets);
  let result;
  try {
    result = await joinDevice({
      baseUrl,
      invitationToken: invitation.invitationToken,
      deviceName: name,
      timeoutMs: 30_000,
    });
  } catch (error) {
    if (error instanceof SyncHttpError) throw error;
    const timedOut = error?.name === 'TimeoutError'
      || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.cause?.code);
    throw new UsageError([
      `HND 서버에 연결하지 못했습니다: ${baseUrl}`,
      timedOut ? '연결 시간이 초과되었습니다.' : `네트워크 오류: ${error?.cause?.message || error.message}`,
      '',
      `먼저 브라우저 또는 curl로 ${baseUrl}/healthz 접속을 확인하세요.`,
      '같은 서버나 같은 공유기 안에서만 실패하면 공유기의 NAT loopback 설정 또는 로컬 DNS/hosts 설정을 확인하세요.',
      '연결에 실패한 동안 hnd setup은 실행해도 서버 연결을 대신하지 않습니다. 문제를 고친 뒤 새 연결 코드로 다시 실행하세요.',
    ].join('\n'), { cause: error });
  }
  const vaultKey = decryptBytes(result.wrappedVaultKey, invitation.secret, { maxBytes: 32 });
  if (vaultKey.byteLength !== 32) throw new Error('The invitation did not contain a valid vault key.');
  await writeVaultKey(paths.vaultKey, vaultKey);
  await atomicWriteFile(paths.deviceToken, `${result.deviceToken}\n`, { maxBytes: MAX_DEVICE_TOKEN_BYTES });
  const config = await saveRemoteConfig(env, {
    baseUrl,
    device: result.device,
    etag: null,
    snapshotDigest: null,
    lastSyncAt: null,
  });
  const output = { joined: true, baseUrl, device: result.device, config };
  if (jsonOutput) writeJson(output, stdout);
  else writeText(stdout, `PC 연결 완료: ${result.device.name} (${result.device.id})\n서버: ${baseUrl}`);
}

async function push({ options, rest, env, stdout, jsonOutput, syncClientOptions }) {
  assertOptions(options, ['url']);
  ensureNoExtra(rest, 'hnd sync push [--url URL]');
  const { config, client } = await createClient(
    env,
    optionString(options, 'url'),
    syncClientOptions,
  );
  const key = await readVaultKey(secretPaths(env).vaultKey);
  const snapshot = await withStateLock(
    () => captureSyncSnapshot(statePaths(env).home),
    { env },
  );
  const digest = snapshotDigest(snapshot);

  if (config.etag && config.snapshotDigest === digest) {
    const checked = await client.getEncryptedSnapshot({ etag: config.etag });
    if (checked.notModified) {
      // Establish a merge base for clients upgraded from an earlier version.
      await writeSyncBase(env, config.etag, snapshot);
      await pruneSyncBases(env, config.etag);
      const output = { pushed: false, unchanged: true, etag: config.etag, snapshotDigest: digest };
      if (jsonOutput) writeJson(output, stdout);
      else writeText(stdout, 'Remote is already up to date.');
      return output;
    }
    throw new RemoteConflictError('The remote changed since the last sync. Pull before pushing.', {
      localEtag: config.etag,
      remoteEtag: checked.etag,
    });
  }

  let result;
  try {
    result = await client.pushSnapshot(snapshot, key, { etag: config.etag });
  } catch (error) {
    if (error instanceof SyncHttpError && error.status === 412) {
      throw new RemoteConflictError('The remote changed since the last sync. Pull or inspect revisions before retrying.', {
        localEtag: config.etag,
        remoteEtag: error.etag,
      });
    }
    throw error;
  }
  await saveRemoteCheckpoint(env, config, result.etag, snapshot, {
    lastSyncAt: new Date().toISOString(),
  });
  const output = { pushed: true, created: result.created, etag: result.etag, snapshotDigest: digest };
  if (jsonOutput) writeJson(output, stdout);
  else writeText(stdout, `Pushed encrypted snapshot ${result.etag}.`);
  return output;
}

async function pull({ options, rest, env, stdout, jsonOutput }) {
  assertOptions(options, ['url', 'force']);
  ensureNoExtra(rest, 'hnd sync pull [--url URL] [--force]');
  const force = optionBoolean(options, 'force');
  const { config, client } = await createClient(env, optionString(options, 'url'));
  const key = await readVaultKey(secretPaths(env).vaultKey);
  await withStateLock(() => recoverRestoreJournal(env), {
    env,
    allowRestoreJournal: true,
  });
  const cachedBase = config.etag
    ? await readSyncBase(env, config.etag, { optional: true })
    : null;
  // If an older installation has no cached base, download the current bytes
  // once instead of accepting a 304 that would leave three-way merge unusable.
  const result = await client.pullSnapshot(key, { etag: cachedBase ? config.etag : undefined });
  if (result.notModified) {
    if (jsonOutput) writeJson({ pulled: false, unchanged: true, etag: config.etag }, stdout);
    else writeText(stdout, 'Local synced state is already current.');
    return;
  }
  if (result.missing) {
    if (jsonOutput) writeJson({ pulled: false, missing: true }, stdout);
    else writeText(stdout, 'The remote has no snapshot yet. Push from the source device first.');
    return;
  }
  assertNoKnownRollback(config, result.etag);
  await writeSyncBase(env, result.etag, result.snapshot);

  const localResult = await withStateLock(async () => {
    await recoverRestoreJournal(env);
    const localSnapshot = await captureSyncSnapshot(statePaths(env).home);
    const localDigest = snapshotDigest(localSnapshot);
    const remoteDigest = snapshotDigest(result.snapshot);
    const locallyChanged = localDigest === remoteDigest
      ? false
      : config.snapshotDigest
        ? localDigest !== config.snapshotDigest
        : !snapshotIsEmpty(localSnapshot);
    if (locallyChanged && !force) {
      throw new RemoteConflictError('Local synced files have unpushed changes. Pull refused; use --force only after reviewing or backing them up.', {
        localDigest,
        lastSyncedDigest: config.snapshotDigest,
        remoteEtag: result.etag,
      });
    }

    const backupPath = locallyChanged ? await backupSnapshot(env, localSnapshot) : null;
    const restored = await transactionalRestore(env, result.snapshot, localSnapshot);
    const reconciliation = await reconcileBindings(env);
    const digest = remoteDigest;
    await saveRemoteCheckpoint(env, config, result.etag, result.snapshot, {
      lastSyncAt: new Date().toISOString(),
    });
    return { localDigest, locallyChanged, backupPath, restored, reconciliation, digest };
  }, { env, allowRestoreJournal: true });
  const { backupPath, restored, reconciliation, digest } = localResult;
  const output = {
    pulled: true,
    etag: result.etag,
    snapshotDigest: digest,
    restored,
    backupPath,
    removedOrphanBindings: reconciliation.removed,
  };
  if (jsonOutput) writeJson(output, stdout);
  else {
    writeText(stdout, `Pulled and verified encrypted snapshot ${result.etag}.`);
    if (backupPath) writeText(stdout, `Previous local synced state backup: ${backupPath}`);
    if (reconciliation.removed) writeText(stdout, `Removed ${reconciliation.removed} orphaned local repository binding(s).`);
  }
}

async function mergeRemote({ options, rest, env, stdout, jsonOutput, syncClientOptions }) {
  assertOptions(options, ['url']);
  ensureNoExtra(rest, 'hnd sync merge [--url URL]');
  const { config, client } = await createClient(
    env,
    optionString(options, 'url'),
    syncClientOptions,
  );
  const key = await readVaultKey(secretPaths(env).vaultKey);
  await withStateLock(() => recoverRestoreJournal(env), {
    env,
    allowRestoreJournal: true,
  });

  const remote = await client.pullSnapshot(key);
  if (remote.missing) {
    throw new UsageError('The remote has no snapshot to merge. Push this device first.');
  }
  assertNoKnownRollback(config, remote.etag);

  let base;
  if (config.etag && config.etag === remote.etag) {
    const remoteDigest = snapshotDigest(remote.snapshot);
    if (config.snapshotDigest && config.snapshotDigest !== remoteDigest) {
      throw new RemoteConflictError(
        'The remote snapshot does not match the local sync checkpoint.',
        {
          etag: remote.etag,
          expectedDigest: config.snapshotDigest,
          receivedDigest: remoteDigest,
        },
      );
    }
    base = remote.snapshot;
  } else {
    base = await resolveMergeBase(env, config, client, key);
  }

  // Persist the verified remote generation before touching local synced files.
  // The config continues to reference the old base until the merge commits.
  await writeSyncBase(env, remote.etag, remote.snapshot);

  const result = await withStateLock(async () => {
    await recoverRestoreJournal(env);
    const currentConfig = await readRemoteConfig(env);
    if (currentConfig.etag !== config.etag) {
      throw new RemoteConflictError(
        'The local sync checkpoint changed while preparing the merge. Retry the command.',
        { expectedEtag: config.etag, currentEtag: currentConfig.etag },
      );
    }

    const local = await captureSyncSnapshot(statePaths(env).home);
    const merged = mergeSyncSnapshots(base, local, remote.snapshot);
    const localDigest = snapshotDigest(local);
    const mergedDigest = snapshotDigest(merged.snapshot);
    const remoteDigest = snapshotDigest(remote.snapshot);
    const changedLocally = localDigest !== mergedDigest;
    const backupPath = changedLocally && !snapshotIsEmpty(local)
      ? await backupSnapshot(env, local, { reason: 'merge' })
      : null;
    const conflictPath = await writeMergeReport(env, {
      baseEtag: config.etag,
      remoteEtag: remote.etag,
      conflicts: merged.conflicts,
      mergedDigest,
    });
    const restored = await transactionalRestore(env, merged.snapshot, local);
    const reconciliation = await reconcileBindings(env);
    await saveRemoteCheckpoint(env, currentConfig, remote.etag, remote.snapshot, {
      lastSyncAt: new Date().toISOString(),
      lastMergeAt: new Date().toISOString(),
    });
    return {
      backupPath,
      conflictPath,
      conflicts: merged.conflicts,
      restored,
      reconciliation,
      localDigest,
      mergedDigest,
      remoteDigest,
    };
  }, { env, allowRestoreJournal: true });

  const output = {
    merged: true,
    baseEtag: config.etag,
    remoteEtag: remote.etag,
    mergedSnapshotDigest: result.mergedDigest,
    conflicts: result.conflicts.map((conflict) => conflict.path),
    conflictPath: result.conflictPath,
    backupPath: result.backupPath,
    files: result.restored,
    removedOrphanBindings: result.reconciliation.removed,
    localChanges: result.mergedDigest !== result.remoteDigest,
  };
  if (jsonOutput) {
    writeJson(output, stdout);
  } else {
    writeText(stdout, `Merged local and remote synced state at ${remote.etag}.`);
    if (output.conflicts.length > 0) {
      writeText(stdout, `${output.conflicts.length} conflict(s) kept the local version. Review: ${output.conflictPath}`);
    }
    if (output.backupPath) writeText(stdout, `Previous local synced state backup: ${output.backupPath}`);
    if (output.localChanges) writeText(stdout, 'Review the result, then run hnd sync push.');
  }
  return output;
}

async function status({ options, rest, env, stdout, jsonOutput }) {
  assertOptions(options, []);
  ensureNoExtra(rest, 'hnd sync status [--json]');
  const config = await readRemoteConfig(env, { optional: true });
  if (!config) {
    const output = { enrolled: false };
    if (jsonOutput) writeJson(output, stdout);
    else writeText(stdout, `HND 계정 연결: 안 됨\n\n${connectionGuide()}`);
    return;
  }
  const snapshot = await withStateLock(
    () => captureSyncSnapshot(statePaths(env).home),
    { env },
  );
  const digest = snapshotDigest(snapshot);
  const mergeBasePresent = config.etag
    ? Boolean(await readSyncBase(env, config.etag, { optional: true }))
    : false;
  const { readAutoSyncPending } = await import('./sync/auto.mjs');
  const output = {
    enrolled: true,
    baseUrl: config.baseUrl,
    device: config.device,
    etag: config.etag,
    lastSyncAt: config.lastSyncAt,
    lastMergeAt: config.lastMergeAt ?? null,
    mergeBasePresent,
    localSnapshotDigest: digest,
    localChanges: config.snapshotDigest === null ? !snapshotIsEmpty(snapshot) : digest !== config.snapshotDigest,
    automatic: {
      enabled: await getAutoSync({ env }),
      pending: await readAutoSyncPending({ env }),
    },
    credentialsPresent: {
      deviceToken: await fs.access(secretPaths(env).deviceToken).then(() => true, () => false),
      vaultKey: await fs.access(secretPaths(env).vaultKey).then(() => true, () => false),
    },
  };
  if (jsonOutput) writeJson(output, stdout);
  else {
    const pending = output.automatic.pending
      ? `${output.automatic.pending.kind}: ${output.automatic.pending.reason}`
      : '없음';
    writeText(
      stdout,
      `HND 계정 연결: 완료\n서버: ${output.baseUrl}\n기기: ${output.device.name} (${output.device.id})\n자동 동기화: ${output.automatic.enabled ? '켜짐' : '꺼짐'}\n대기 작업: ${pending}\n로컬 변경: ${output.localChanges ? '있음' : '없음'}\n마지막 동기화: ${output.lastSyncAt ?? '없음'}`,
    );
  }
}

async function revisions({ options, rest, env, stdout }) {
  assertOptions(options, ['url']);
  ensureNoExtra(rest, 'hnd sync revisions');
  const { client } = await createClient(env, optionString(options, 'url'));
  writeJson({ revisions: await client.listRevisions() }, stdout);
}

async function restoreRevision({ options, rest, env, stdout, jsonOutput }) {
  assertOptions(options, ['url', 'force']);
  const revisionId = rest.shift();
  if (!revisionId || !/^[a-f0-9]{64}$/.test(revisionId)) {
    throw new UsageError('A 64-character revision ID is required.');
  }
  ensureNoExtra(rest, 'hnd sync restore REVISION_ID --force');
  if (!optionBoolean(options, 'force')) {
    throw new UsageError('Revision restore replaces synced files; review revisions and pass --force explicitly.');
  }
  const { config, client } = await createClient(env, optionString(options, 'url'));
  const key = await readVaultKey(secretPaths(env).vaultKey);
  await withStateLock(() => recoverRestoreJournal(env), {
    env,
    allowRestoreJournal: true,
  });
  const [revision, latest] = await Promise.all([
    client.getRevision(revisionId),
    client.getEncryptedSnapshot(),
  ]);
  if (!revision) throw new UsageError(`Remote revision not found: ${revisionId}`);
  if (latest.missing) throw new Error('The remote revision exists but the latest snapshot is missing.');
  assertNoKnownRollback(config, latest.etag);

  const restoredSnapshot = decryptSnapshot(revision.blob, key);
  const latestSnapshot = decryptSnapshot(latest.blob, key);
  await writeSyncBase(env, latest.etag, latestSnapshot);
  const localResult = await withStateLock(async () => {
    await recoverRestoreJournal(env);
    const localSnapshot = await captureSyncSnapshot(statePaths(env).home);
    const backupPath = snapshotIsEmpty(localSnapshot) ? null : await backupSnapshot(env, localSnapshot);
    const restored = await transactionalRestore(env, restoredSnapshot, localSnapshot);
    const reconciliation = await reconcileBindings(env);

    // Keep the latest remote digest as the optimistic-concurrency baseline. A
    // historical restore is intentionally local-dirty, so the next push promotes
    // it as a new revision instead of pretending the server already changed.
    await saveRemoteCheckpoint(env, config, latest.etag, latestSnapshot, {
      lastRestoreAt: new Date().toISOString(),
    });
    return { localSnapshot, backupPath, restored, reconciliation };
  }, { env, allowRestoreJournal: true });
  const { backupPath, restored, reconciliation } = localResult;
  const output = {
    restored: true,
    revisionId,
    revisionEtag: revision.etag,
    currentRemoteEtag: latest.etag,
    backupPath,
    files: restored,
    removedOrphanBindings: reconciliation.removed,
    localChanges: snapshotDigest(restoredSnapshot) !== snapshotDigest(latestSnapshot),
  };
  if (jsonOutput) writeJson(output, stdout);
  else {
    writeText(stdout, `Restored revision ${revisionId} locally.`);
    if (backupPath) writeText(stdout, `Previous local synced state backup: ${backupPath}`);
    if (output.localChanges) writeText(stdout, 'Run hnd sync push to promote this revision as the latest snapshot.');
  }
}

async function devices({ options, rest, env, stdout }) {
  assertOptions(options, ['url']);
  ensureNoExtra(rest, 'hnd sync devices');
  const { client } = await createClient(env, optionString(options, 'url'));
  writeJson({ devices: await client.listDevices() }, stdout);
}

async function revoke({ options, rest, env, stdout, jsonOutput }) {
  assertOptions(options, ['url']);
  const deviceId = rest.shift();
  if (!deviceId) throw new UsageError('Device ID is required.');
  ensureNoExtra(rest, 'hnd sync revoke DEVICE_ID');
  const { client } = await createClient(env, optionString(options, 'url'));
  await client.revokeDevice(deviceId);
  if (jsonOutput) writeJson({ revoked: true, deviceId }, stdout);
  else writeText(stdout, `Revoked device ${deviceId}.`);
}

async function keyCommand({ options, rest, env, stdin, stdout, jsonOutput }) {
  const action = rest.shift();
  ensureNoExtra(rest, `hnd sync key ${action || '<export|import>'}`);
  const keyPath = secretPaths(env).vaultKey;
  if (action === 'export') {
    assertOptions(options, ['file', 'stdout']);
    const key = await readVaultKey(keyPath);
    const file = optionString(options, 'file');
    const toStdout = optionBoolean(options, 'stdout');
    if (Boolean(file) === Boolean(toStdout)) {
      throw new UsageError('Choose exactly one of --file PATH or --stdout.');
    }
    if (file) {
      const destination = path.resolve(file);
      await writeVaultKey(destination, key);
      if (jsonOutput) writeJson({ exported: true, path: destination }, stdout);
      else writeText(stdout, `Exported vault key to ${destination}. Protect this file like a password.`);
    } else {
      stdout.write(serializeVaultKey(key));
    }
    return;
  }
  if (action === 'import') {
    assertOptions(options, ['file', 'stdin']);
    try {
      await assertRegularFile(keyPath);
      throw new UsageError('A vault key already exists; refusing to overwrite it.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const source = await readTextInput(options, { stream: stdin });
    const key = parseVaultKey(source);
    await writeVaultKey(keyPath, key);
    if (jsonOutput) writeJson({ imported: true }, stdout);
    else writeText(stdout, 'Imported vault key.');
    return;
  }
  throw new UsageError('Sync key command must be export or import.');
}

/**
 * Reports enrollment without reading or returning either local secret.
 * Automatic hooks use this as a mutation-free fast path.
 */
export async function remoteSyncConfigured(env = process.env) {
  return Boolean(await readRemoteConfig(env, { optional: true }));
}

/**
 * A conflict attention marker is resolved only after a manual operation makes
 * the local snapshot the acknowledged remote checkpoint (normally sync push,
 * or a reviewed pull). Merely running another background pass is insufficient.
 */
export async function remoteSyncConflictResolved(
  env = process.env,
  { lockTimeoutMs = 2_000 } = {},
) {
  return withRemoteOperationLock(env, async () => {
    const config = await readRemoteConfig(env, { optional: true });
    if (!config) return true;
    const snapshot = await withStateLock(
      () => captureSyncSnapshot(statePaths(env).home),
      { env },
    );
    const digest = snapshotDigest(snapshot);
    if (config.snapshotDigest) return digest === config.snapshotDigest;
    return snapshotIsEmpty(snapshot);
  }, { timeoutMs: lockTimeoutMs });
}

/**
 * Converges local and remote synced state while sharing the exact operation
 * lock, validation, restore journal, merge base, and backup behavior used by
 * the manual sync commands. It intentionally has no user-facing output.
 *
 * A changed remote is merged three ways, with the existing local-wins conflict
 * report behavior, and the result is pushed with optimistic concurrency. A
 * small bounded retry handles another device winning the race during merge.
 */
export async function reconcileRemoteAutomatically({
  env = process.env,
  timeoutMs = 2_000,
  lockTimeoutMs = 1_000,
  maxConflictRetries = 1,
  fetchImpl,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('timeoutMs must be an integer from 1 to 60000');
  }
  if (
    !Number.isSafeInteger(maxConflictRetries)
    || maxConflictRetries < 1
    || maxConflictRetries > 8
  ) {
    throw new TypeError('maxConflictRetries must be an integer from 1 to 8');
  }
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 60_000) {
    throw new TypeError('lockTimeoutMs must be an integer from 1 to 60000');
  }
  if (!await remoteSyncConfigured(env)) {
    return Object.freeze({ status: 'not_configured', changed: false, attempts: 0, conflicts: 0 });
  }

  const sink = Object.freeze({ write: () => true });
  const syncClientOptions = fetchImpl === undefined
    ? { timeoutMs }
    : { timeoutMs, fetchImpl };
  const context = {
    options: {},
    rest: [],
    env,
    stdout: sink,
    jsonOutput: false,
    syncClientOptions,
  };

  return withRemoteOperationLock(env, async () => {
    // Recheck after waiting for a manual command that may have changed local
    // enrollment state in a future version.
    if (!await remoteSyncConfigured(env)) {
      return Object.freeze({ status: 'not_configured', changed: false, attempts: 0, conflicts: 0 });
    }

    let attempts = 1;
    try {
      const pushed = await push(context);
      return Object.freeze({
        status: 'synced',
        changed: pushed.pushed,
        attempts,
        conflicts: 0,
      });
    } catch (error) {
      if (!(error instanceof RemoteConflictError)) throw error;
    }

    let conflictCount = 0;
    for (let retry = 0; retry < maxConflictRetries; retry += 1) {
      attempts += 1;
      const merged = await mergeRemote(context);
      conflictCount += merged.conflicts.length;
      if (merged.conflicts.length > 0) {
        // mergeRemote has safely incorporated independent remote edits and
        // retained the local side of same-file conflicts, with a review report.
        // Never publish that policy decision from a background hook.
        return Object.freeze({
          status: 'needs_attention',
          reason: 'conflict',
          changed: true,
          attempts,
          conflicts: conflictCount,
        });
      }
      try {
        const pushed = await push(context);
        return Object.freeze({
          status: 'synced',
          changed: true,
          attempts,
          conflicts: conflictCount,
          pushed: pushed.pushed,
        });
      } catch (error) {
        if (!(error instanceof RemoteConflictError)) throw error;
        if (retry === maxConflictRetries - 1) throw error;
      }
    }

    // The loop either returns or throws. Keep an explicit terminal guard so a
    // future edit cannot accidentally report success without convergence.
    throw new RemoteConflictError('Automatic sync could not converge after bounded retries.');
  }, { timeoutMs: lockTimeoutMs });
}

export async function remoteMain(context) {
  const { subcommand, options } = context;
  if (subcommand === 'enroll') return enroll(context);
  if (subcommand === 'invite') return invite(context);
  if (subcommand === 'join') return join(context);
  if (subcommand === 'connect') return join(context);
  if (subcommand === 'push') return withRemoteOperationLock(context.env, () => push(context));
  if (subcommand === 'pull') return withRemoteOperationLock(context.env, () => pull(context));
  if (subcommand === 'merge') return withRemoteOperationLock(context.env, () => mergeRemote(context));
  if (subcommand === 'status') return status(context);
  if (subcommand === 'revisions') return revisions(context);
  if (subcommand === 'restore') {
    return withRemoteOperationLock(context.env, () => restoreRevision(context));
  }
  if (subcommand === 'devices') return devices(context);
  if (subcommand === 'revoke') return revoke(context);
  if (subcommand === 'key') return keyCommand(context);
  throw new UsageError('Sync command must be connect, enroll, invite, join, push, pull, merge, status, revisions, restore, devices, revoke, or key.');
}
