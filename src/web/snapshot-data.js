import { ApiError } from "./api.js";
import {
  loadEncryptedSnapshot,
  openBrowserValue,
  saveEncryptedSnapshot,
  sealBrowserValue,
} from "./vault.js";

const SNAPSHOT_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 4096;
const MAX_POLICY_BYTES = 32 * 1024 - 1024;
const DEFAULT_STALE_HOURS = 72;
const GLOBAL_POLICY_PATH = "policies/global.md";
const REPOSITORY_INDEX_PATH = "repositories.json";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?$/;
const REPO_POLICY_PATTERN = /^repositories\/([0-9a-f-]{36})\/policy\.md$/i;
const ENV_POLICY_PATTERN =
  /^repositories\/([0-9a-f-]{36})\/environments\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\.md$/i;
const ACTIVE_WORK_PATTERN =
  /^repositories\/([0-9a-f-]{36})\/handoffs\/([0-9a-f-]{36})\.json$/i;
const CLOSED_WORK_PATTERN =
  /^repositories\/([0-9a-f-]{36})\/archive\/([0-9a-f-]{36})\.json$/i;
const KNOWLEDGE_PATTERN = /^knowledge\/([0-9a-f-]{36})\.json$/i;
const textEncoder = new TextEncoder();
const strictTextDecoder = new TextDecoder("utf-8", { fatal: true });

const LOCAL_DATABASE_NAME = "hnd-browser-content-v1";
const LOCAL_DATABASE_VERSION = 1;
const LOCAL_STORE_NAME = "encrypted-content";
const CACHE_RECORD_SCHEMA_VERSION = 4;
const CACHE_LOCK_SCHEMA_VERSION = 2;
const CACHE_RESET_SCHEMA_VERSION = 1;
const CACHE_LOCK_LEASE_MS = 15_000;
const CACHE_LOCK_WAIT_MS = 3_000;
let localDatabasePromise;

class SnapshotCacheConflictError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "SnapshotCacheConflictError";
    this.code = "browser_cache_conflict";
  }
}

class SnapshotCacheResetError extends SnapshotCacheConflictError {
  constructor(options = {}) {
    super(
      "이 브라우저의 보관함이 초기화되었습니다. 이전에 열어 둔 화면의 변경은 저장하지 않았습니다. 페이지를 새로고침해 주세요.",
      options,
    );
    this.name = "SnapshotCacheResetError";
    this.code = "browser_cache_reset";
  }
}

class RemoteSnapshotConflictError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "RemoteSnapshotConflictError";
    this.code = "remote_snapshot_conflict";
  }
}

function compareCodePoints(left, right) {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  while (true) {
    const leftStep = leftIterator.next();
    const rightStep = rightIterator.next();
    if (leftStep.done || rightStep.done) {
      if (leftStep.done && rightStep.done) return 0;
      return leftStep.done ? -1 : 1;
    }
    const difference =
      leftStep.value.codePointAt(0) - rightStep.value.codePointAt(0);
    if (difference !== 0) return difference;
  }
}

function normalizedSearch(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .trim();
}

function requiredText(
  value,
  label,
  { allowEmpty = false, singleLine = false, max = 8000 } = {},
) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label}에 올바른 글을 입력해 주세요.`);
  }
  const text = value.trim();
  if (!allowEmpty && !text) throw new Error(`${label}을 입력해 주세요.`);
  if (text.length > max || (singleLine && /[\r\n]/.test(text))) {
    throw new Error(`${label}이 너무 길거나 형식이 올바르지 않습니다.`);
  }
  return text;
}

function lines(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function addHours(iso, hours) {
  return new Date(
    new Date(iso).getTime() + hours * 60 * 60 * 1000,
  ).toISOString();
}

function assertUuid(value, label) {
  if (!UUID_PATTERN.test(String(value || ""))) {
    throw new Error(`${label} ID 형식이 올바르지 않습니다.`);
  }
  return String(value);
}

function assertAllowedPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/")
  ) {
    throw new Error("암호화 저장본에 잘못된 파일 경로가 있습니다.");
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("암호화 저장본에 안전하지 않은 파일 경로가 있습니다.");
  }
  if (
    value !== GLOBAL_POLICY_PATH &&
    value !== REPOSITORY_INDEX_PATH &&
    !value.startsWith("repositories/") &&
    !value.startsWith("knowledge/")
  ) {
    throw new Error(`동기화 범위 밖의 파일이 있습니다: ${value}`);
  }
  return value;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("암호화 저장본에 잘못된 base64 내용이 있습니다.");
  }
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  if (bytesToBase64(bytes) !== value) {
    throw new Error("암호화 저장본의 base64 내용이 정규 형식이 아닙니다.");
  }
  return bytes;
}

function bytesToHex(bytes) {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(bytes) {
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
}

function fileBytes(file) {
  const bytes = base64ToBytes(file.content);
  if (file.bytes !== bytes.byteLength) {
    throw new Error(`저장본 파일 크기가 맞지 않습니다: ${file.path}`);
  }
  return bytes;
}

async function validateSnapshot(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    !Array.isArray(snapshot.files)
  ) {
    throw new Error("지원하지 않거나 손상된 암호화 저장본입니다.");
  }
  if (snapshot.files.length > MAX_FILES) {
    throw new Error("암호화 저장본의 파일 수가 너무 많습니다.");
  }
  const seen = new Set();
  let totalBytes = 0;
  for (const file of snapshot.files) {
    if (
      !file ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      file.encoding !== "base64" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256 || "")
    ) {
      throw new Error("암호화 저장본에 손상된 파일 정보가 있습니다.");
    }
    const path = assertAllowedPath(file.path);
    if (seen.has(path)) throw new Error(`저장본 경로가 겹칩니다: ${path}`);
    seen.add(path);
    const bytes = fileBytes(file);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(`파일이 허용 크기를 넘습니다: ${path}`);
    }
    if ((await sha256(bytes)) !== file.sha256) {
      throw new Error(`저장본 파일의 확인값이 맞지 않습니다: ${path}`);
    }
    totalBytes += bytes.byteLength;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error("암호화 저장본의 전체 크기가 너무 큽니다.");
  }
  return snapshot;
}

async function makeTextFile(path, text) {
  assertAllowedPath(path);
  const bytes = textEncoder.encode(text);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(`파일이 허용 크기를 넘습니다: ${path}`);
  }
  return {
    path,
    encoding: "base64",
    bytes: bytes.byteLength,
    sha256: await sha256(bytes),
    content: bytesToBase64(bytes),
  };
}

async function replaceTextFile(snapshot, path, text) {
  const files = snapshot.files.filter((file) => file.path !== path);
  if (text !== null) files.push(await makeTextFile(path, text));
  files.sort((left, right) => compareCodePoints(left.path, right.path));
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, files };
}

function fileAt(snapshot, path) {
  return snapshot.files.find((file) => file.path === path) || null;
}

function textOf(file, label = "파일") {
  try {
    return strictTextDecoder.decode(fileBytes(file));
  } catch (error) {
    throw new Error(`${label}을 UTF-8 글로 읽을 수 없습니다.`, {
      cause: error,
    });
  }
}

function jsonOf(file, label) {
  try {
    const value = JSON.parse(textOf(file, label));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("JSON object required");
    }
    return value;
  } catch (error) {
    throw new Error(`${label} JSON이 손상되었습니다.`, { cause: error });
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function repositoryIndex(snapshot) {
  const file = fileAt(snapshot, REPOSITORY_INDEX_PATH);
  if (!file) return { schemaVersion: STATE_SCHEMA_VERSION, repositories: {} };
  const value = jsonOf(file, "저장소 목록");
  if (
    value.schemaVersion !== STATE_SCHEMA_VERSION ||
    !value.repositories ||
    typeof value.repositories !== "object" ||
    Array.isArray(value.repositories)
  ) {
    throw new Error("저장소 목록 형식이 올바르지 않습니다.");
  }
  return value;
}

function repositoriesFrom(snapshot) {
  const index = repositoryIndex(snapshot);
  return Object.entries(index.repositories)
    .map(([id, repository]) => {
      assertUuid(id, "저장소");
      if (
        !repository ||
        typeof repository !== "object" ||
        repository.id !== id
      ) {
        throw new Error("저장소 목록의 ID가 서로 맞지 않습니다.");
      }
      return { ...structuredClone(repository), id };
    })
    .sort(
      (left, right) =>
        String(left.name || "").localeCompare(String(right.name || ""), "ko") ||
        left.id.localeCompare(right.id),
    );
}

function resolveRepository(snapshot, value) {
  const repositories = repositoriesFrom(snapshot);
  const requested = String(value || "").trim();
  if (!requested && repositories.length === 1) return repositories[0];
  if (!requested) {
    throw new Error(
      repositories.length === 0
        ? "먼저 PC에서 저장소를 연결하고 동기화해 주세요."
        : "작업할 저장소를 선택해 주세요.",
    );
  }
  const direct = repositories.find((repository) => repository.id === requested);
  if (direct) return direct;
  const key = normalizedSearch(requested);
  const named = repositories.filter(
    (repository) => normalizedSearch(repository.name) === key,
  );
  if (named.length === 1) return named[0];
  if (named.length > 1)
    throw new Error("같은 이름의 저장소가 여러 개입니다. ID를 입력해 주세요.");
  throw new Error("암호화 저장본에서 해당 저장소를 찾을 수 없습니다.");
}

function repositoryMetadata(values, current) {
  const now = new Date().toISOString();
  return {
    ...current,
    schemaVersion: STATE_SCHEMA_VERSION,
    id: current.id,
    name: requiredText(values.name, "프로젝트 이름", {
      max: 100,
      singleLine: true,
    }),
    description: requiredText(values.description || "", "프로젝트 설명", {
      allowEmpty: true,
      max: 500,
    }),
    remoteAliases: Array.isArray(current.remoteAliases)
      ? current.remoteAliases
      : [],
    rootCommits: Array.isArray(current.rootCommits) ? current.rootCommits : [],
    createdAt: current.createdAt || now,
    updatedAt: now,
  };
}

function openLocalDatabase() {
  if (localDatabasePromise) return localDatabasePromise;
  localDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DATABASE_NAME, LOCAL_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(LOCAL_STORE_NAME)) {
        request.result.createObjectStore(LOCAL_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error || new Error("브라우저 로컬 룰 저장소를 열 수 없습니다."),
      );
    request.onblocked = () =>
      reject(new Error("다른 탭이 브라우저 로컬 룰 저장소를 사용 중입니다."));
  });
  return localDatabasePromise;
}

async function localOperation(mode, operation) {
  const database = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(LOCAL_STORE_NAME, mode);
    const request = operation(transaction.objectStore(LOCAL_STORE_NAME));
    let value;
    request.onsuccess = () => {
      value = request.result;
    };
    request.onerror = () =>
      reject(
        request.error || new Error("브라우저 로컬 룰 요청에 실패했습니다."),
      );
    transaction.oncomplete = () => resolve(value);
    transaction.onabort = () =>
      reject(
        transaction.error ||
          new Error("브라우저 로컬 룰 저장이 취소되었습니다."),
      );
    transaction.onerror = () => {};
  });
}

function offlineAccessKey(tenantId) {
  const id = String(tenantId || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error("오프라인 작업 공간 ID가 올바르지 않습니다.");
  }
  return `offline-access:${id}`;
}

export async function enableOfflineWorkspace(tenantId) {
  const expectedResetEpoch = await loadSnapshotResetEpoch(tenantId);
  const encrypted = await sealBrowserValue(tenantId, {
    schemaVersion: 1,
    tenantId: String(tenantId),
    enabled: true,
  });
  try {
    const copy = encrypted.buffer.slice(
      encrypted.byteOffset,
      encrypted.byteOffset + encrypted.byteLength,
    );
    await mutateLocalRecordAtResetEpoch(tenantId, expectedResetEpoch, (store) =>
      store.put({ schemaVersion: 1, encrypted: copy }, offlineAccessKey(tenantId)),
    );
  } finally {
    encrypted.fill(0);
  }
}

export async function disableOfflineWorkspace(tenantId) {
  const expectedResetEpoch = await loadSnapshotResetEpoch(tenantId);
  await mutateLocalRecordAtResetEpoch(tenantId, expectedResetEpoch, (store) =>
    store.delete(offlineAccessKey(tenantId)),
  );
}

export async function offlineWorkspaceEnabled(tenantId) {
  const record = await localOperation("readonly", (store) =>
    store.get(offlineAccessKey(tenantId)),
  );
  if (!record) return false;
  if (
    record.schemaVersion !== 1 ||
    !(
      record.encrypted instanceof ArrayBuffer ||
      ArrayBuffer.isView(record.encrypted)
    )
  ) {
    throw new Error("오프라인 작업 허용 정보가 손상되었습니다.");
  }
  const value = await openBrowserValue(tenantId, record.encrypted);
  return (
    value?.schemaVersion === 1 &&
    value?.tenantId === String(tenantId) &&
    value?.enabled === true
  );
}

function localRuleKey(tenantId) {
  return `pc-policy:${tenantId}`;
}

async function loadLocalRule(tenantId) {
  const record = await localOperation("readonly", (store) =>
    store.get(localRuleKey(tenantId)),
  );
  if (!record) return null;
  if (
    record.schemaVersion !== 1 ||
    !(
      record.encrypted instanceof ArrayBuffer ||
      ArrayBuffer.isView(record.encrypted)
    )
  ) {
    throw new Error("브라우저 로컬 룰 정보가 손상되었습니다.");
  }
  let value;
  try {
    value = await openBrowserValue(tenantId, record.encrypted);
  } catch (error) {
    throw new Error("브라우저 로컬 룰의 암호를 풀 수 없습니다.", {
      cause: error,
    });
  }
  const rule = value?.rule;
  if (
    value?.schemaVersion !== 1 ||
    !rule ||
    rule.id !== "pc" ||
    rule.scope !== "pc" ||
    typeof rule.content !== "string"
  ) {
    throw new Error("브라우저 로컬 룰 내용이 손상되었습니다.");
  }
  return rule;
}

async function saveLocalRule(tenantId, rule, expectedResetEpoch = undefined) {
  const resetEpoch =
    expectedResetEpoch === undefined
      ? await loadSnapshotResetEpoch(tenantId)
      : expectedResetEpoch;
  if (rule === null) {
    await mutateLocalRecordAtResetEpoch(tenantId, resetEpoch, (store) =>
      store.delete(localRuleKey(tenantId)),
    );
    return;
  }
  const encrypted = await sealBrowserValue(tenantId, {
    schemaVersion: 1,
    rule,
  });
  try {
    const copy = encrypted.buffer.slice(
      encrypted.byteOffset,
      encrypted.byteOffset + encrypted.byteLength,
    );
    await mutateLocalRecordAtResetEpoch(tenantId, resetEpoch, (store) =>
      store.put({ schemaVersion: 1, encrypted: copy }, localRuleKey(tenantId)),
    );
  } finally {
    encrypted.fill(0);
  }
}

function snapshotCacheKey(tenantId) {
  return `snapshot:${tenantId}`;
}

function snapshotLockKey(tenantId) {
  return `snapshot-lock:${tenantId}`;
}

function snapshotResetEpochKey(tenantId) {
  // Reuse the strict tenant identifier validation used by the other local
  // workspace records before constructing an IndexedDB key.
  offlineAccessKey(tenantId);
  return `snapshot-reset:${tenantId}`;
}

function resetEpochFromRecord(record) {
  if (record === undefined) return 0;
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.schemaVersion !== CACHE_RESET_SCHEMA_VERSION ||
    !Number.isSafeInteger(record.epoch) ||
    record.epoch < 1
  ) {
    throw new Error("브라우저 보관함 초기화 버전이 손상되었습니다.");
  }
  return record.epoch;
}

async function loadSnapshotResetEpoch(tenantId) {
  const record = await localOperation("readonly", (store) =>
    store.get(snapshotResetEpochKey(tenantId)),
  );
  return resetEpochFromRecord(record);
}

async function mutateLocalRecordAtResetEpoch(
  tenantId,
  expectedResetEpoch,
  operation,
) {
  if (
    !Number.isSafeInteger(expectedResetEpoch) ||
    expectedResetEpoch < 0
  ) {
    throw new TypeError("브라우저 보관함 초기화 버전이 올바르지 않습니다.");
  }
  const database = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(LOCAL_STORE_NAME, "readwrite");
    const store = transaction.objectStore(LOCAL_STORE_NAME);
    const epochRequest = store.get(snapshotResetEpochKey(tenantId));
    let failure;
    let value;
    epochRequest.onsuccess = () => {
      try {
        const currentResetEpoch = resetEpochFromRecord(epochRequest.result);
        if (currentResetEpoch !== expectedResetEpoch) {
          failure = new SnapshotCacheResetError();
          transaction.abort();
          return;
        }
        const request = operation(store);
        request.onsuccess = () => {
          value = request.result;
        };
        request.onerror = () => {
          failure =
            request.error || new Error("브라우저 로컬 정보 저장에 실패했습니다.");
        };
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    epochRequest.onerror = () => {
      failure =
        epochRequest.error ||
        new Error("브라우저 보관함 초기화 버전을 확인하지 못했습니다.");
    };
    transaction.oncomplete = () => resolve(value);
    transaction.onabort = () =>
      reject(
        failure ||
          transaction.error ||
          new Error("브라우저 로컬 정보 저장이 취소되었습니다."),
      );
    transaction.onerror = () => {};
  });
}

async function resetLocalWorkspaceRecords(tenantId) {
  const database = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(LOCAL_STORE_NAME, "readwrite");
    const store = transaction.objectStore(LOCAL_STORE_NAME);
    const resetKey = snapshotResetEpochKey(tenantId);
    const epochRequest = store.get(resetKey);
    let failure;
    let nextResetEpoch;
    epochRequest.onsuccess = () => {
      try {
        const currentResetEpoch = resetEpochFromRecord(epochRequest.result);
        if (currentResetEpoch >= Number.MAX_SAFE_INTEGER) {
          throw new Error("브라우저 보관함 초기화 버전을 더 늘릴 수 없습니다.");
        }
        nextResetEpoch = currentResetEpoch + 1;
        store.delete(snapshotCacheKey(tenantId));
        store.delete(snapshotLockKey(tenantId));
        store.delete(localRuleKey(tenantId));
        store.delete(offlineAccessKey(tenantId));
        store.put(
          {
            schemaVersion: CACHE_RESET_SCHEMA_VERSION,
            epoch: nextResetEpoch,
          },
          resetKey,
        );
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    epochRequest.onerror = () => {
      failure =
        epochRequest.error ||
        new Error("브라우저 보관함 초기화 버전을 확인하지 못했습니다.");
    };
    transaction.oncomplete = () => resolve({ resetEpoch: nextResetEpoch });
    transaction.onabort = () =>
      reject(
        failure ||
          transaction.error ||
          new Error("브라우저 보관함 로컬 정리가 취소되었습니다."),
      );
    transaction.onerror = () => {};
  });
}

// A vault reset is a two-phase operation. Before asking the server to replace
// its ciphertext, advance this local epoch. Existing store instances remember
// the old value and subsequently fail closed. Keep the encrypted cache record
// (but stamp it with the new epoch) so a definitive server-side rejection does
// not strand a browser that still has the original vault key.
async function beginLocalWorkspaceReset(tenantId) {
  const database = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(LOCAL_STORE_NAME, "readwrite");
    const store = transaction.objectStore(LOCAL_STORE_NAME);
    const resetKey = snapshotResetEpochKey(tenantId);
    const epochRequest = store.get(resetKey);
    const recordRequest = store.get(snapshotCacheKey(tenantId));
    let failure;
    let nextResetEpoch;
    let epochReady = false;
    let recordReady = false;
    let begun = false;
    const begin = () => {
      if (!epochReady || !recordReady || begun || failure) return;
      begun = true;
      try {
        const currentResetEpoch = resetEpochFromRecord(epochRequest.result);
        if (currentResetEpoch >= Number.MAX_SAFE_INTEGER) {
          throw new Error("브라우저 보관함 초기화 버전을 더 늘릴 수 없습니다.");
        }
        nextResetEpoch = currentResetEpoch + 1;
        const currentRecord = recordRequest.result;
        if (currentRecord) {
          const currentGeneration = assertCacheRecordShape(currentRecord);
          if (cacheRecordResetEpoch(currentRecord) !== currentResetEpoch) {
            throw new Error(
              "브라우저 암호화 로컬 사본의 초기화 버전이 맞지 않습니다.",
            );
          }
          store.put(
            {
              schemaVersion:
                currentRecord.schemaVersion === CACHE_RECORD_SCHEMA_VERSION
                  ? CACHE_RECORD_SCHEMA_VERSION
                  : 3,
              // Schema v1 did not persist a generation and is represented as
              // zero above. Schema v3 requires a positive generation, so the
              // epoch migration gives that legacy record its first durable
              // generation without changing its encrypted content.
              generation: Math.max(1, currentGeneration),
              resetEpoch: nextResetEpoch,
              encrypted: encryptedArrayBuffer(currentRecord.encrypted),
              ...(currentRecord.schemaVersion === CACHE_RECORD_SCHEMA_VERSION
                ? {
                    baseEncrypted: currentRecord.baseEncrypted
                      ? encryptedArrayBuffer(currentRecord.baseEncrypted)
                      : null,
                  }
                : {}),
              etag: currentRecord.etag,
              pending: currentRecord.pending,
            },
            snapshotCacheKey(tenantId),
          );
        }
        // A lock from the previous epoch must never block the reset or be
        // releasable by an old tab after it has observed the tombstone. Turn
        // off offline entry before the server POST as well: otherwise a fresh
        // offline tab could edit the preserved cache during the reset window
        // and have that edit erased by the confirmed reset's final cleanup.
        store.delete(snapshotLockKey(tenantId));
        store.delete(offlineAccessKey(tenantId));
        store.put(
          {
            schemaVersion: CACHE_RESET_SCHEMA_VERSION,
            epoch: nextResetEpoch,
          },
          resetKey,
        );
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    epochRequest.onsuccess = () => {
      epochReady = true;
      begin();
    };
    epochRequest.onerror = () => {
      failure =
        epochRequest.error ||
        new Error("브라우저 보관함 초기화 버전을 확인하지 못했습니다.");
    };
    recordRequest.onsuccess = () => {
      recordReady = true;
      begin();
    };
    recordRequest.onerror = () => {
      failure =
        recordRequest.error || new Error("브라우저 로컬 사본을 읽지 못했습니다.");
    };
    transaction.oncomplete = () => resolve({ resetEpoch: nextResetEpoch });
    transaction.onabort = () =>
      reject(
        failure ||
          transaction.error ||
          new Error("브라우저 보관함 초기화 준비가 취소되었습니다."),
      );
    transaction.onerror = () => {};
  });
}

async function finalizeLocalWorkspaceReset(tenantId, expectedResetEpoch) {
  if (
    !Number.isSafeInteger(expectedResetEpoch) ||
    expectedResetEpoch < 1
  ) {
    throw new TypeError("브라우저 보관함 초기화 버전이 올바르지 않습니다.");
  }
  const database = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(LOCAL_STORE_NAME, "readwrite");
    const store = transaction.objectStore(LOCAL_STORE_NAME);
    const epochRequest = store.get(snapshotResetEpochKey(tenantId));
    let failure;
    epochRequest.onsuccess = () => {
      try {
        if (resetEpochFromRecord(epochRequest.result) !== expectedResetEpoch) {
          throw new SnapshotCacheResetError();
        }
        store.delete(snapshotCacheKey(tenantId));
        store.delete(snapshotLockKey(tenantId));
        store.delete(localRuleKey(tenantId));
        store.delete(offlineAccessKey(tenantId));
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    epochRequest.onerror = () => {
      failure =
        epochRequest.error ||
        new Error("브라우저 보관함 초기화 버전을 확인하지 못했습니다.");
    };
    transaction.oncomplete = () => resolve({ resetEpoch: expectedResetEpoch });
    transaction.onabort = () =>
      reject(
        failure ||
          transaction.error ||
          new Error("브라우저 보관함 로컬 정리가 취소되었습니다."),
      );
    transaction.onerror = () => {};
  });
}

function encryptedArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  throw new Error("브라우저 암호화 로컬 사본이 손상되었습니다.");
}

function cacheRecordGeneration(record) {
  if (record?.schemaVersion === 1 && record.generation === undefined) return 0;
  if (
    [2, 3, CACHE_RECORD_SCHEMA_VERSION].includes(record?.schemaVersion) &&
    Number.isSafeInteger(record.generation) &&
    record.generation >= 1
  ) {
    return record.generation;
  }
  throw new Error("브라우저 암호화 로컬 사본 버전이 손상되었습니다.");
}

function cacheRecordResetEpoch(record) {
  if ([1, 2].includes(record?.schemaVersion)) return 0;
  if (
    [3, CACHE_RECORD_SCHEMA_VERSION].includes(record?.schemaVersion) &&
    Number.isSafeInteger(record.resetEpoch) &&
    record.resetEpoch >= 0
  ) {
    return record.resetEpoch;
  }
  throw new Error("브라우저 암호화 로컬 사본 초기화 버전이 손상되었습니다.");
}

function assertCacheRecordShape(record) {
  const generation = cacheRecordGeneration(record);
  if (
    typeof record.pending !== "boolean" ||
    !(record.etag === null || typeof record.etag === "string") ||
    !(
      record.encrypted instanceof ArrayBuffer ||
      ArrayBuffer.isView(record.encrypted)
    ) ||
    (record.schemaVersion === CACHE_RECORD_SCHEMA_VERSION &&
      !(
        record.baseEncrypted === null ||
        record.baseEncrypted instanceof ArrayBuffer ||
        ArrayBuffer.isView(record.baseEncrypted)
      ))
  ) {
    throw new Error("브라우저 암호화 로컬 사본이 손상되었습니다.");
  }
  return generation;
}

async function compareAndSetLocalSnapshotRecord(
  tenantId,
  expectedGeneration,
  expectedResetEpoch,
  nextRecord,
) {
  const database = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(LOCAL_STORE_NAME, "readwrite");
    const store = transaction.objectStore(LOCAL_STORE_NAME);
    const epochRequest = store.get(snapshotResetEpochKey(tenantId));
    const recordRequest = store.get(snapshotCacheKey(tenantId));
    let failure;
    let updated = false;
    let currentGeneration = 0;
    let currentResetEpoch = 0;
    let epochReady = false;
    let recordReady = false;
    let compared = false;
    const compare = () => {
      if (!epochReady || !recordReady || compared || failure) return;
      compared = true;
      try {
        currentResetEpoch = resetEpochFromRecord(epochRequest.result);
        if (recordRequest.result) {
          currentGeneration = assertCacheRecordShape(recordRequest.result);
          if (cacheRecordResetEpoch(recordRequest.result) !== currentResetEpoch) {
            throw new Error(
              "브라우저 암호화 로컬 사본의 초기화 버전이 맞지 않습니다.",
            );
          }
        }
        if (currentResetEpoch !== expectedResetEpoch) return;
        if (currentGeneration !== expectedGeneration) return;
        const put = store.put(nextRecord, snapshotCacheKey(tenantId));
        put.onsuccess = () => {
          updated = true;
        };
        put.onerror = () => {
          failure = put.error || new Error("브라우저 로컬 사본 동시 저장에 실패했습니다.");
        };
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    epochRequest.onsuccess = () => {
      epochReady = true;
      compare();
    };
    epochRequest.onerror = () => {
      failure =
        epochRequest.error ||
        new Error("브라우저 보관함 초기화 버전을 확인하지 못했습니다.");
    };
    recordRequest.onsuccess = () => {
      recordReady = true;
      compare();
    };
    recordRequest.onerror = () => {
      failure =
        recordRequest.error ||
        new Error("브라우저 로컬 사본 동시 저장 확인에 실패했습니다.");
    };
    transaction.oncomplete = () =>
      resolve({ updated, currentGeneration, currentResetEpoch });
    transaction.onabort = () =>
      reject(
        failure ||
          transaction.error ||
          new Error("브라우저 로컬 사본 동시 저장이 취소되었습니다."),
      );
    transaction.onerror = () => {};
  });
}

function lockRecordIsWellFormed(record) {
  return (
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    [1, CACHE_LOCK_SCHEMA_VERSION].includes(record.schemaVersion) &&
    typeof record.owner === "string" &&
    record.owner.length >= 16 &&
    Number.isSafeInteger(record.expiresAt) &&
    record.expiresAt > 0 &&
    (record.schemaVersion === 1 ||
      (Number.isSafeInteger(record.resetEpoch) && record.resetEpoch >= 0))
  );
}

function lockRecordResetEpoch(record) {
  return record.schemaVersion === 1 ? 0 : record.resetEpoch;
}

async function tryAcquireSnapshotLock(
  tenantId,
  owner,
  now,
  expectedResetEpoch,
) {
  const database = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(LOCAL_STORE_NAME, "readwrite");
    const store = transaction.objectStore(LOCAL_STORE_NAME);
    const epochRequest = store.get(snapshotResetEpochKey(tenantId));
    let failure;
    let acquired = false;
    epochRequest.onsuccess = () => {
      let currentResetEpoch;
      try {
        currentResetEpoch = resetEpochFromRecord(epochRequest.result);
      } catch (error) {
        failure = error;
        transaction.abort();
        return;
      }
      if (currentResetEpoch !== expectedResetEpoch) {
        failure = new SnapshotCacheResetError();
        transaction.abort();
        return;
      }
      const request = store.get(snapshotLockKey(tenantId));
      request.onsuccess = () => {
        const current = request.result;
        if (current && !lockRecordIsWellFormed(current)) {
          failure = new Error("브라우저 저장 잠금이 손상되었습니다.");
          transaction.abort();
          return;
        }
        if (
          current &&
          lockRecordResetEpoch(current) === currentResetEpoch &&
          current.owner !== owner &&
          current.expiresAt > now
        ) {
          return;
        }
        const put = store.put(
          {
            schemaVersion: CACHE_LOCK_SCHEMA_VERSION,
            resetEpoch: currentResetEpoch,
            owner,
            expiresAt: now + CACHE_LOCK_LEASE_MS,
          },
          snapshotLockKey(tenantId),
        );
        put.onsuccess = () => {
          acquired = true;
        };
        put.onerror = () => {
          failure = put.error || new Error("브라우저 저장 잠금을 만들지 못했습니다.");
        };
      };
      request.onerror = () => {
        failure = request.error || new Error("브라우저 저장 잠금을 확인하지 못했습니다.");
      };
    };
    epochRequest.onerror = () => {
      failure =
        epochRequest.error ||
        new Error("브라우저 보관함 초기화 버전을 확인하지 못했습니다.");
    };
    transaction.oncomplete = () => resolve(acquired);
    transaction.onabort = () =>
      reject(
        failure ||
          transaction.error ||
          new Error("브라우저 저장 잠금 요청이 취소되었습니다."),
      );
    transaction.onerror = () => {};
  });
}

async function releaseSnapshotLock(tenantId, owner, expectedResetEpoch) {
  const database = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(LOCAL_STORE_NAME, "readwrite");
    const store = transaction.objectStore(LOCAL_STORE_NAME);
    const epochRequest = store.get(snapshotResetEpochKey(tenantId));
    let failure;
    epochRequest.onsuccess = () => {
      let currentResetEpoch;
      try {
        currentResetEpoch = resetEpochFromRecord(epochRequest.result);
      } catch (error) {
        failure = error;
        transaction.abort();
        return;
      }
      // A reset deletes the old lock atomically. Never let an old operation
      // remove a lock that belongs to the new workspace epoch.
      if (currentResetEpoch !== expectedResetEpoch) return;
      const request = store.get(snapshotLockKey(tenantId));
      request.onsuccess = () => {
        const current = request.result;
        if (
          !current ||
          !lockRecordIsWellFormed(current) ||
          lockRecordResetEpoch(current) !== expectedResetEpoch ||
          current.owner !== owner
        ) {
          return;
        }
        const remove = store.delete(snapshotLockKey(tenantId));
        remove.onerror = () => {
          failure =
            remove.error || new Error("브라우저 저장 잠금을 풀지 못했습니다.");
        };
      };
      request.onerror = () => {
        failure = request.error || new Error("브라우저 저장 잠금을 확인하지 못했습니다.");
      };
    };
    epochRequest.onerror = () => {
      failure =
        epochRequest.error ||
        new Error("브라우저 보관함 초기화 버전을 확인하지 못했습니다.");
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        failure ||
          transaction.error ||
          new Error("브라우저 저장 잠금 해제가 취소되었습니다."),
      );
    transaction.onerror = () => {};
  });
}

function newLockOwner() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes).replaceAll("/", "_").replaceAll("+", "-");
}

function waitForLock(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withSnapshotLock(tenantId, operation, expectedResetEpoch) {
  if (
    !Number.isSafeInteger(expectedResetEpoch) ||
    expectedResetEpoch < 0
  ) {
    throw new TypeError("브라우저 보관함 초기화 버전이 올바르지 않습니다.");
  }
  const owner = newLockOwner();
  const deadline = Date.now() + CACHE_LOCK_WAIT_MS;
  let acquired = false;
  while (!acquired) {
    acquired = await tryAcquireSnapshotLock(
      tenantId,
      owner,
      Date.now(),
      expectedResetEpoch,
    );
    if (acquired) break;
    if (Date.now() >= deadline) {
      throw new SnapshotCacheConflictError(
        "다른 탭이 저장 중입니다. 현재 입력을 유지한 채 잠시 후 다시 시도해 주세요.",
      );
    }
    await waitForLock(25 + Math.floor(Math.random() * 25));
  }

  let lockLost = false;
  const renewal = setInterval(() => {
    void tryAcquireSnapshotLock(
      tenantId,
      owner,
      Date.now(),
      expectedResetEpoch,
    )
      .then((renewed) => {
        if (!renewed) lockLost = true;
      })
      .catch(() => {
        lockLost = true;
      });
  }, Math.floor(CACHE_LOCK_LEASE_MS / 3));
  try {
    const result = await operation();
    if (lockLost) {
      throw new SnapshotCacheConflictError(
        "브라우저 저장 잠금을 확인할 수 없어 변경을 확정하지 않았습니다.",
      );
    }
    return result;
  } finally {
    clearInterval(renewal);
    await releaseSnapshotLock(tenantId, owner, expectedResetEpoch).catch(
      () => {},
    );
  }
}

async function loadCachedSnapshot(tenantId) {
  const database = await openLocalDatabase();
  const { record, resetEpoch } = await new Promise((resolve, reject) => {
    const transaction = database.transaction(LOCAL_STORE_NAME, "readonly");
    const store = transaction.objectStore(LOCAL_STORE_NAME);
    const epochRequest = store.get(snapshotResetEpochKey(tenantId));
    const recordRequest = store.get(snapshotCacheKey(tenantId));
    let failure;
    let currentResetEpoch;
    epochRequest.onerror = () => {
      failure =
        epochRequest.error ||
        new Error("브라우저 보관함 초기화 버전을 확인하지 못했습니다.");
    };
    recordRequest.onerror = () => {
      failure =
        recordRequest.error || new Error("브라우저 로컬 사본을 읽지 못했습니다.");
    };
    transaction.oncomplete = () => {
      try {
        currentResetEpoch = resetEpochFromRecord(epochRequest.result);
        const currentRecord = recordRequest.result;
        if (
          currentRecord &&
          cacheRecordResetEpoch(currentRecord) !== currentResetEpoch
        ) {
          throw new Error(
            "브라우저 암호화 로컬 사본의 초기화 버전이 맞지 않습니다.",
          );
        }
        resolve({ record: currentRecord, resetEpoch: currentResetEpoch });
      } catch (error) {
        reject(error);
      }
    };
    transaction.onabort = () =>
      reject(
        failure ||
          transaction.error ||
          new Error("브라우저 로컬 사본 읽기가 취소되었습니다."),
      );
    transaction.onerror = () => {};
  });
  if (!record) return null;
  const generation = assertCacheRecordShape(record);
  let snapshot;
  let baseSnapshot;
  try {
    snapshot = await openBrowserValue(tenantId, record.encrypted);
    baseSnapshot = record.schemaVersion === CACHE_RECORD_SCHEMA_VERSION
      ? record.baseEncrypted
        ? await openBrowserValue(tenantId, record.baseEncrypted)
        : null
      : record.pending ? null : structuredClone(snapshot);
    await validateSnapshot(snapshot);
    if (baseSnapshot) await validateSnapshot(baseSnapshot);
  } catch (error) {
    throw new Error("마지막 브라우저 저장본을 안전하게 열 수 없습니다.", {
      cause: error,
    });
  }
  return {
    snapshot,
    baseSnapshot,
    etag: record.etag,
    pending: record.pending,
    generation,
    resetEpoch,
    encrypted: encryptedArrayBuffer(record.encrypted),
  };
}

async function compareAndSetCachedSnapshot({
  tenantId,
  snapshot,
  baseSnapshot,
  etag,
  pending,
  expectedGeneration,
  expectedResetEpoch,
}) {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
    throw new TypeError("브라우저 로컬 사본의 기준 버전이 올바르지 않습니다.");
  }
  if (
    !Number.isSafeInteger(expectedResetEpoch) ||
    expectedResetEpoch < 0
  ) {
    throw new TypeError("브라우저 보관함 초기화 버전이 올바르지 않습니다.");
  }
  if (baseSnapshot !== null && baseSnapshot !== undefined) {
    await validateSnapshot(baseSnapshot);
  }
  const normalizedBase = baseSnapshot === undefined
    ? pending ? null : snapshot
    : baseSnapshot;
  const encrypted = await sealBrowserValue(tenantId, snapshot);
  let baseEncrypted = null;
  try {
    baseEncrypted = normalizedBase
      ? await sealBrowserValue(tenantId, normalizedBase)
      : null;
    const record = {
      schemaVersion: CACHE_RECORD_SCHEMA_VERSION,
      generation: expectedGeneration + 1,
      resetEpoch: expectedResetEpoch,
      encrypted: encryptedArrayBuffer(encrypted),
      baseEncrypted: baseEncrypted
        ? encryptedArrayBuffer(baseEncrypted)
        : null,
      etag: etag || null,
      pending: Boolean(pending),
    };
    const compared = await compareAndSetLocalSnapshotRecord(
      tenantId,
      expectedGeneration,
      expectedResetEpoch,
      record,
    );
    if (!compared.updated) {
      return {
        updated: false,
        currentGeneration: compared.currentGeneration,
        currentResetEpoch: compared.currentResetEpoch,
      };
    }
    return {
      updated: true,
      snapshot: structuredClone(snapshot),
      baseSnapshot: normalizedBase ? structuredClone(normalizedBase) : null,
      etag: record.etag,
      pending: record.pending,
      generation: record.generation,
      resetEpoch: record.resetEpoch,
    };
  } finally {
    encrypted.fill(0);
    baseEncrypted?.fill(0);
  }
}

const browserSnapshotCache = Object.freeze({
  load: loadCachedSnapshot,
  getResetEpoch: loadSnapshotResetEpoch,
  compareAndSet: compareAndSetCachedSnapshot,
  withLock: withSnapshotLock,
  beginReset: beginLocalWorkspaceReset,
  finalizeReset: finalizeLocalWorkspaceReset,
  reset: resetLocalWorkspaceRecords,
});

export async function beginBrowserWorkspaceReset(tenantId, options = {}) {
  const cache = options.cache ?? browserSnapshotCache;
  if (!cache || typeof cache.beginReset !== "function") {
    throw new TypeError("브라우저 보관함 초기화 준비를 지원하지 않습니다.");
  }
  const result = await cache.beginReset(String(tenantId || ""));
  if (
    !result ||
    !Number.isSafeInteger(result.resetEpoch) ||
    result.resetEpoch < 1
  ) {
    throw new Error("브라우저 보관함 초기화 준비 결과가 올바르지 않습니다.");
  }
  return { resetEpoch: result.resetEpoch };
}

export async function finalizeBrowserWorkspaceReset(
  tenantId,
  expectedResetEpoch,
  options = {},
) {
  const cache = options.cache ?? browserSnapshotCache;
  if (!cache || typeof cache.finalizeReset !== "function") {
    throw new TypeError("브라우저 보관함 로컬 정리를 지원하지 않습니다.");
  }
  if (
    !Number.isSafeInteger(expectedResetEpoch) ||
    expectedResetEpoch < 1
  ) {
    throw new TypeError("브라우저 보관함 초기화 버전이 올바르지 않습니다.");
  }
  const result = await cache.finalizeReset(
    String(tenantId || ""),
    expectedResetEpoch,
  );
  if (result?.resetEpoch !== expectedResetEpoch) {
    throw new Error("브라우저 보관함 로컬 정리 결과가 올바르지 않습니다.");
  }
  return { resetEpoch: expectedResetEpoch };
}

// Compatibility helper for callers that need an immediate local wipe without
// a preceding server reset. Server-backed reset flows must instead call begin
// before the POST and finalize after its confirmed response.
export async function resetBrowserWorkspaceCache(tenantId, options = {}) {
  const cache = options.cache ?? browserSnapshotCache;
  if (!cache || typeof cache.reset !== "function") {
    throw new TypeError("브라우저 보관함 캐시 초기화를 지원하지 않습니다.");
  }
  const result = await cache.reset(String(tenantId || ""));
  if (
    !result ||
    !Number.isSafeInteger(result.resetEpoch) ||
    result.resetEpoch < 1
  ) {
    throw new Error("브라우저 보관함 캐시 초기화 결과가 올바르지 않습니다.");
  }
  return { resetEpoch: result.resetEpoch };
}

function snapshotsEqual(left, right) {
  if (
    left?.schemaVersion !== right?.schemaVersion ||
    left?.files?.length !== right?.files?.length
  ) {
    return false;
  }
  return left.files.every((file, index) => {
    const other = right.files[index];
    return (
      file.path === other?.path &&
      file.encoding === other.encoding &&
      file.bytes === other.bytes &&
      file.sha256 === other.sha256 &&
      file.content === other.content
    );
  });
}

function snapshotFiles(snapshot) {
  return new Map(snapshot.files.map((file) => [file.path, file]));
}

function snapshotFilesEqual(left, right) {
  if (left === null || right === null) return left === right;
  return (
    left.path === right.path &&
    left.encoding === right.encoding &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.content === right.content
  );
}

const MISSING_JSON_VALUE = Symbol("missing JSON member");

function jsonValueEqual(left, right) {
  if (left === MISSING_JSON_VALUE || right === MISSING_JSON_VALUE)
    return left === right;
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValueEqual(value, right[index]))
    );
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftKeys = Object.keys(left).sort(compareCodePoints);
  const rightKeys = Object.keys(right).sort(compareCodePoints);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && jsonValueEqual(left[key], right[key]),
    )
  );
}

function mergeJsonValue(base, local, remote) {
  if (jsonValueEqual(local, remote)) return { value: local, conflicted: false };
  if (jsonValueEqual(local, base)) return { value: remote, conflicted: false };
  if (jsonValueEqual(remote, base)) return { value: local, conflicted: false };
  const localObject = local && typeof local === "object" && !Array.isArray(local);
  const remoteObject = remote && typeof remote === "object" && !Array.isArray(remote);
  const baseObject = base && typeof base === "object" && !Array.isArray(base);
  if (localObject && remoteObject && (base === MISSING_JSON_VALUE || baseObject)) {
    const keys = new Set([
      ...(base === MISSING_JSON_VALUE ? [] : Object.keys(base)),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]);
    const value = {};
    let conflicted = false;
    for (const key of [...keys].sort(compareCodePoints)) {
      const merged = mergeJsonValue(
        base !== MISSING_JSON_VALUE && Object.hasOwn(base, key)
          ? base[key]
          : MISSING_JSON_VALUE,
        Object.hasOwn(local, key) ? local[key] : MISSING_JSON_VALUE,
        Object.hasOwn(remote, key) ? remote[key] : MISSING_JSON_VALUE,
      );
      conflicted ||= merged.conflicted;
      if (merged.value !== MISSING_JSON_VALUE) value[key] = merged.value;
    }
    return { value, conflicted };
  }
  return { value: local, conflicted: true };
}

function mergeableJsonPath(path) {
  return (
    path === REPOSITORY_INDEX_PATH ||
    /^repositories\/[^/]+\/repository\.json$/.test(path) ||
    KNOWLEDGE_PATTERN.test(path)
  );
}

function parsedJsonFile(file) {
  if (file === null) return MISSING_JSON_VALUE;
  try {
    const value = JSON.parse(textOf(file));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

async function mergeJsonFile(path, base, local, remote) {
  if (!mergeableJsonPath(path) || local === null || remote === null) return null;
  const parsedBase = parsedJsonFile(base);
  const parsedLocal = parsedJsonFile(local);
  const parsedRemote = parsedJsonFile(remote);
  if (
    parsedLocal === null ||
    parsedRemote === null ||
    (base !== null && parsedBase === null)
  ) {
    return null;
  }
  const merged = mergeJsonValue(parsedBase, parsedLocal, parsedRemote);
  return {
    file: await makeTextFile(path, jsonText(merged.value)),
    conflicted: merged.conflicted,
  };
}

export async function mergeBrowserSnapshots(base, local, remote) {
  await Promise.all([
    validateSnapshot(base),
    validateSnapshot(local),
    validateSnapshot(remote),
  ]);
  const baseFiles = snapshotFiles(base);
  const localFiles = snapshotFiles(local);
  const remoteFiles = snapshotFiles(remote);
  const paths = new Set([
    ...baseFiles.keys(),
    ...localFiles.keys(),
    ...remoteFiles.keys(),
  ]);
  const files = [];
  const conflicts = [];
  for (const path of [...paths].sort(compareCodePoints)) {
    const baseFile = baseFiles.get(path) ?? null;
    const localFile = localFiles.get(path) ?? null;
    const remoteFile = remoteFiles.get(path) ?? null;
    let file;
    let conflicted = false;
    if (snapshotFilesEqual(localFile, remoteFile)) file = localFile;
    else if (snapshotFilesEqual(localFile, baseFile)) file = remoteFile;
    else if (snapshotFilesEqual(remoteFile, baseFile)) file = localFile;
    else {
      const mergedJson = await mergeJsonFile(path, baseFile, localFile, remoteFile);
      if (mergedJson) {
        file = mergedJson.file;
        conflicted = mergedJson.conflicted;
      } else {
        file = localFile;
        conflicted = true;
      }
    }
    if (file !== null) files.push(structuredClone(file));
    if (conflicted) conflicts.push(path);
  }
  const snapshot = { schemaVersion: SNAPSHOT_SCHEMA_VERSION, files };
  await validateSnapshot(snapshot);
  return { snapshot, conflicts };
}

function snapshotIsEmpty(snapshot) {
  return (
    snapshot?.schemaVersion === SNAPSHOT_SCHEMA_VERSION &&
    Array.isArray(snapshot.files) &&
    snapshot.files.length === 0
  );
}

function rulePath(snapshot, values) {
  const scope = values.scope === "all" ? "global" : values.scope;
  if (scope === "global") return GLOBAL_POLICY_PATH;
  if (scope === "pc") return "pc";
  if (!["repo", "env"].includes(scope))
    throw new Error("룰 범위를 선택해 주세요.");
  const repository = resolveRepository(
    snapshot,
    values.repository || values.repo || values.repoId,
  );
  if (scope === "repo") return `repositories/${repository.id}/policy.md`;
  const environment = String(values.environment || values.env || "").trim();
  if (!ENVIRONMENT_PATTERN.test(environment)) {
    throw new Error(
      "환경 이름은 영문, 숫자, 점, 밑줄, 하이픈 1~64자로 입력해 주세요.",
    );
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(environment)) {
    throw new Error("이 환경 이름은 Windows에서 사용할 수 없습니다.");
  }
  const existing = snapshot.files
    .map((file) => ENV_POLICY_PATTERN.exec(file.path))
    .filter(
      (match) =>
        match &&
        match[1].toLowerCase() === repository.id.toLowerCase() &&
        match[2].toLowerCase() === environment.toLowerCase(),
    );
  if (existing.length > 1) {
    throw new Error("대소문자만 다른 환경 룰이 겹쳐 있어 먼저 정리가 필요합니다.");
  }
  const portableEnvironment = existing[0]?.[2] || environment;
  return `repositories/${repository.id}/environments/${portableEnvironment}.md`;
}

function policyContent(value) {
  const content = requiredText(value, "룰 내용", { max: MAX_POLICY_BYTES });
  if (textEncoder.encode(content).byteLength > MAX_POLICY_BYTES) {
    throw new Error("룰 내용이 허용 크기를 넘습니다.");
  }
  return content;
}

function ruleFromFile(snapshot, file) {
  if (file.path === GLOBAL_POLICY_PATH) {
    return { id: file.path, scope: "all", content: textOf(file, "전체 룰") };
  }
  let match = REPO_POLICY_PATTERN.exec(file.path);
  if (match && UUID_PATTERN.test(match[1])) {
    const repository = resolveRepository(snapshot, match[1]);
    return {
      id: file.path,
      scope: "repo",
      repository: repository.id,
      repo: repository.id,
      repositoryName: repository.name || repository.id,
      content: textOf(file, "저장소 룰"),
    };
  }
  match = ENV_POLICY_PATTERN.exec(file.path);
  if (match && UUID_PATTERN.test(match[1])) {
    const repository = resolveRepository(snapshot, match[1]);
    return {
      id: file.path,
      scope: "env",
      repository: repository.id,
      repo: repository.id,
      repositoryName: repository.name || repository.id,
      environment: match[2],
      env: match[2],
      content: textOf(file, "환경 룰"),
    };
  }
  return null;
}

function workFromFile(file) {
  const match =
    ACTIVE_WORK_PATTERN.exec(file.path) || CLOSED_WORK_PATTERN.exec(file.path);
  if (!match || !UUID_PATTERN.test(match[1]) || !UUID_PATTERN.test(match[2]))
    return null;
  const handoff = jsonOf(file, "작업 인계");
  const expectedStatus = ACTIVE_WORK_PATTERN.test(file.path)
    ? "active"
    : "closed";
  if (
    handoff.schemaVersion !== STATE_SCHEMA_VERSION ||
    handoff.id !== match[2] ||
    handoff.repoId !== match[1] ||
    handoff.status !== expectedStatus ||
    typeof handoff.task !== "string" ||
    typeof handoff.objective !== "string" ||
    typeof handoff.currentState !== "string"
  ) {
    throw new Error(`작업 파일의 내용과 경로가 맞지 않습니다: ${file.path}`);
  }
  return {
    ...handoff,
    repository: handoff.repoId,
    name: handoff.task,
    goal: handoff.objective,
    current: handoff.currentState,
    next: (handoff.nextSteps || []).join("\n"),
    decision: (handoff.decisions || []).join("\n"),
    rejected: (handoff.failedApproaches || []).join("\n"),
    status: handoff.status === "closed" ? "done" : "active",
    _rawStatus: handoff.status,
    _path: file.path,
  };
}

function workRecord(values, current = null) {
  const now = new Date().toISOString();
  const staleHours = Number.isFinite(current?.staleHours)
    ? current.staleHours
    : DEFAULT_STALE_HOURS;
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    id: current?.id || crypto.randomUUID(),
    repoId: values.repoId,
    status: current?._rawStatus || current?.status || "active",
    task: requiredText(values.name, "작업 이름", {
      max: 200,
      singleLine: true,
    }),
    objective: requiredText(values.goal, "목표"),
    currentState: requiredText(values.current || "", "현재 상태", {
      allowEmpty: true,
    }),
    decisions: lines(values.decision),
    failedApproaches: lines(values.rejected),
    changedFiles: current?.changedFiles || [],
    validation: current?.validation || [],
    nextSteps: lines(values.next),
    openQuestions: current?.openQuestions || [],
    notes: current?.notes || [],
    worktree: current?.worktree || "web",
    branch: current?.branch ?? null,
    head: current?.head ?? null,
    staleHours,
    staleAt: addHours(now, staleHours),
    createdAt: current?.createdAt || now,
    updatedAt: now,
    closedAt: current?.closedAt || null,
  };
}

function knowledgeFromFile(snapshot, file) {
  const match = KNOWLEDGE_PATTERN.exec(file.path);
  if (!match || !UUID_PATTERN.test(match[1])) return null;
  const entry = jsonOf(file, "지식");
  const scope = entry.scope === undefined ? "global" : entry.scope;
  const repoId = entry.repoId ?? null;
  const environment = entry.environment ?? null;
  if (
    entry.schemaVersion !== STATE_SCHEMA_VERSION ||
    entry.id !== match[1] ||
    typeof entry.title !== "string" ||
    typeof entry.body !== "string" ||
    !Array.isArray(entry.tags) ||
    !entry.tags.every((tag) => typeof tag === "string") ||
    !["global", "repo", "env"].includes(scope) ||
    (scope === "global" && (repoId !== null || environment !== null)) ||
    (scope === "repo" && (!UUID_PATTERN.test(repoId || "") || environment !== null)) ||
    (scope === "env" &&
      (!UUID_PATTERN.test(repoId || "") ||
        !ENVIRONMENT_PATTERN.test(environment || "")))
  ) {
    throw new Error(`지식 파일의 내용과 경로가 맞지 않습니다: ${file.path}`);
  }
  const repository = repoId ? resolveRepository(snapshot, repoId) : null;
  return {
    ...entry,
    scope,
    repoId,
    repository: repoId,
    repositoryName: repository?.name || null,
    environment,
    content: entry.body,
    _path: file.path,
  };
}

function normalizedTags(value) {
  const result = [];
  const seen = new Set();
  for (const source of Array.isArray(value) ? value : lines(value)) {
    const tag = requiredText(String(source), "태그", { max: 48 });
    const key = normalizedSearch(tag);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }
  if (result.length > 20)
    throw new Error("태그는 최대 20개까지 저장할 수 있습니다.");
  return result;
}

function knowledgeLocation(snapshot, values, current = null) {
  const requested = values.scope ?? current?.scope ?? "all";
  const scope = requested === "all" ? "global" : requested;
  if (scope === "global") {
    return { scope, repoId: null, environment: null };
  }
  if (!["repo", "env"].includes(scope)) {
    throw new Error("지식 범위를 선택해 주세요.");
  }
  const repository = resolveRepository(
    snapshot,
    values.repository || values.repo || values.repoId || current?.repoId,
  );
  if (scope === "repo") {
    return { scope, repoId: repository.id, environment: null };
  }
  const environment = String(
    values.environment ?? current?.environment ?? "",
  ).trim();
  if (!ENVIRONMENT_PATTERN.test(environment)) {
    throw new Error(
      "환경 이름은 영문, 숫자, 점, 밑줄, 하이픈 1~64자로 입력해 주세요.",
    );
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(environment)) {
    throw new Error("이 환경 이름은 Windows에서 사용할 수 없습니다.");
  }
  return { scope, repoId: repository.id, environment };
}

function knowledgeRecord(snapshot, values, current = null) {
  const now = new Date().toISOString();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    id: current?.id || crypto.randomUUID(),
    title: requiredText(values.title, "제목", { max: 200 }),
    body: requiredText(values.content ?? values.body ?? "", "본문", {
      allowEmpty: true,
      max: MAX_FILE_BYTES / 2,
    }),
    tags: normalizedTags(values.tags || []),
    ...knowledgeLocation(snapshot, values, current),
    createdAt: current?.createdAt || now,
    updatedAt: now,
  };
}

function findWork(snapshot, id) {
  assertUuid(id, "작업");
  for (const file of snapshot.files) {
    const match =
      ACTIVE_WORK_PATTERN.exec(file.path) ||
      CLOSED_WORK_PATTERN.exec(file.path);
    if (match?.[2] === id) return workFromFile(file);
  }
  throw new Error("해당 작업을 찾을 수 없습니다.");
}

function findKnowledge(snapshot, id) {
  assertUuid(id, "지식");
  const file = fileAt(snapshot, `knowledge/${id}.json`);
  if (!file) throw new Error("해당 지식을 찾을 수 없습니다.");
  return knowledgeFromFile(snapshot, file);
}

export class SnapshotDataStore {
  constructor(tenantId, options = {}) {
    this.tenantId = String(tenantId || "");
    if (!this.tenantId) throw new Error("현재 작업 공간을 확인할 수 없습니다.");
    this.cache = options.cache ?? browserSnapshotCache;
    this.loadRemote = options.loadRemote ?? loadEncryptedSnapshot;
    this.saveRemote = options.saveRemote ?? saveEncryptedSnapshot;
    this.loadLocalRule = options.loadLocalRule ?? loadLocalRule;
    this.snapshot = null;
    this.baseSnapshot = null;
    this.etag = null;
    this.cacheGeneration = 0;
    this.resetEpoch = null;
    this.localRule = null;
    this.pending = false;
    this.offline = false;
    this.conflict = false;
    this.syncError = null;
    this.writeQueue = Promise.resolve();
  }

  _adoptCached(record, { clearError = true } = {}) {
    if (
      !record ||
      !Number.isSafeInteger(record.generation) ||
      record.generation < 0
    ) {
      throw new Error("브라우저 로컬 사본 버전을 확인할 수 없습니다.");
    }
    this.snapshot = structuredClone(record.snapshot);
    this.baseSnapshot = record.baseSnapshot
      ? structuredClone(record.baseSnapshot)
      : null;
    this.etag = record.etag ?? null;
    this.cacheGeneration = record.generation;
    this.pending = Boolean(record.pending);
    if (clearError) {
      this.offline = false;
      this.conflict = false;
      this.syncError = null;
    }
  }

  _setSyncFailure(error, { conflict = false } = {}) {
    const transient =
      error instanceof ApiError &&
      (error.status === 0 ||
        error.status === 408 ||
        error.status === 429 ||
        error.status >= 500);
    this.offline = !conflict && transient;
    this.conflict = conflict || !transient;
    this.syncError = error;
  }

  async _currentResetEpoch() {
    if (typeof this.cache.getResetEpoch !== "function") return 0;
    const epoch = await this.cache.getResetEpoch(this.tenantId);
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new Error("브라우저 보관함 초기화 버전을 확인할 수 없습니다.");
    }
    return epoch;
  }

  async _assertResetEpoch() {
    const current = await this._currentResetEpoch();
    if (this.resetEpoch === null) {
      this.resetEpoch = current;
      return current;
    }
    if (current !== this.resetEpoch) {
      const error = new SnapshotCacheResetError();
      this._setSyncFailure(error, { conflict: true });
      throw error;
    }
    return current;
  }

  async _withCacheLock(operation) {
    await this._assertResetEpoch();
    return this.cache.withLock(
      this.tenantId,
      async () => {
        await this._assertResetEpoch();
        const result = await operation();
        await this._assertResetEpoch();
        return result;
      },
      this.resetEpoch,
    );
  }

  async _compareAndSetCache(options) {
    await this._assertResetEpoch();
    const saved = await this.cache.compareAndSet({
      ...options,
      tenantId: this.tenantId,
      expectedResetEpoch: this.resetEpoch,
    });
    if (
      Number.isSafeInteger(saved?.currentResetEpoch) &&
      saved.currentResetEpoch !== this.resetEpoch
    ) {
      const error = new SnapshotCacheResetError();
      this._setSyncFailure(error, { conflict: true });
      throw error;
    }
    await this._assertResetEpoch();
    return saved;
  }

  async _validatedCache() {
    await this._assertResetEpoch();
    const cached = await this.cache.load(this.tenantId);
    await this._assertResetEpoch();
    if (
      Number.isSafeInteger(cached?.resetEpoch) &&
      cached.resetEpoch !== this.resetEpoch
    ) {
      throw new SnapshotCacheResetError();
    }
    if (cached) await validateSnapshot(cached.snapshot);
    return cached;
  }

  async _adoptCurrentCacheAfterMiss(message) {
    const latest = await this._validatedCache();
    if (latest) this._adoptCached(latest, { clearError: false });
    const error = new SnapshotCacheConflictError(message);
    this._setSyncFailure(error, { conflict: true });
    return latest;
  }

  async load({ force = false } = {}) {
    await this._assertResetEpoch();
    if (this.snapshot && !force) return this;
    const [cached, localRule] = await Promise.all([
      this._validatedCache(),
      this.loadLocalRule(this.tenantId),
    ]);
    // The cache read and the local-only rule read are separate IndexedDB
    // transactions. Do not adopt either result if a reset committed between
    // them: the epoch is the tombstone that prevents an old tab from treating
    // its pre-reset in-memory state as the current workspace.
    await this._assertResetEpoch();
    this.localRule = localRule;
    if (cached) {
      this._adoptCached(cached);
      if (this.pending) {
        await this._syncPending();
        return this;
      }
    }

    try {
      const remote = await this.loadRemote(this.tenantId);
      await validateSnapshot(remote.snapshot);
      const expectedGeneration = cached?.generation ?? 0;
      const saved = await this._withCacheLock(
        () =>
          this._compareAndSetCache({
            snapshot: remote.snapshot,
            baseSnapshot: remote.snapshot,
            etag: remote.etag,
            pending: false,
            expectedGeneration,
          }),
      );
      if (saved.updated) {
        this._adoptCached(saved);
      } else {
        const latest = await this._validatedCache();
        if (!latest) {
          throw new SnapshotCacheConflictError(
            "다른 탭의 로컬 사본 변경을 확인할 수 없어 서버 저장본을 적용하지 않았습니다.",
          );
        }
        this._adoptCached(latest);
        if (latest.pending) await this._syncPending();
      }
    } catch (error) {
      if (error instanceof SnapshotCacheResetError) throw error;
      if (!cached) throw error;
      this._setSyncFailure(error);
    }
    return this;
  }

  repositories() {
    if (!this.snapshot) throw new Error("암호화 저장본을 먼저 열어 주세요.");
    return repositoriesFrom(this.snapshot);
  }

  async projects({ q } = {}) {
    await this.load();
    const query = normalizedSearch(q);
    return repositoriesFrom(this.snapshot).filter((repository) =>
      !query
        ? true
        : normalizedSearch(
            `${repository.name || ""} ${repository.description || ""} ${(repository.remoteAliases || []).join(" ")}`,
          ).includes(query),
    );
  }

  async project(id) {
    await this.load();
    const repository = resolveRepository(this.snapshot, id);
    const [rules, work, knowledge] = await Promise.all([
      this.rules({ repository: repository.id }),
      this.work({ status: "all", repository: repository.id }),
      this.knowledge({ repository: repository.id }),
    ]);
    const environments = [...new Set(
      [...rules, ...knowledge]
        .filter((item) => item.scope === "env" && item.environment)
        .map((item) => item.environment),
    )].sort((left, right) => left.localeCompare(right, "en"));
    return {
      repository,
      rules,
      work,
      knowledge,
      environments,
      activeWork: work.filter((item) => item.status === "active"),
    };
  }

  async updateProject(id, values) {
    return this._commit(async (snapshot) => {
      const current = resolveRepository(snapshot, id);
      const metadata = repositoryMetadata(values, current);
      const index = repositoryIndex(snapshot);
      index.repositories[current.id] = metadata;
      let next = await replaceTextFile(
        snapshot,
        REPOSITORY_INDEX_PATH,
        jsonText(index),
      );
      const mirrorPath = `repositories/${current.id}/repository.json`;
      next = await replaceTextFile(next, mirrorPath, jsonText(metadata));
      return { snapshot: next, value: structuredClone(metadata) };
    });
  }

  async _commit(mutator) {
    const run = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await this.load();
        let result;
        try {
          await this._withCacheLock(async () => {
            const latest = await this._validatedCache();
            if (!latest && this.cacheGeneration !== 0) {
              throw new SnapshotCacheConflictError(
                "다른 탭에서 브라우저 로컬 사본을 지웠습니다. 현재 입력을 덮어쓰지 않았습니다.",
              );
            }
            if (latest && latest.generation !== this.cacheGeneration) {
              if (!snapshotsEqual(this.snapshot, latest.snapshot)) {
                throw new SnapshotCacheConflictError(
                  "다른 탭에서 먼저 내용을 바꿨습니다. 현재 입력을 덮어쓰지 않았으니 새로고침 후 다시 저장해 주세요.",
                );
              }
              this._adoptCached(latest);
            }

            result = await mutator(structuredClone(this.snapshot));
            await validateSnapshot(result.snapshot);
            const saved = await this._compareAndSetCache({
              snapshot: result.snapshot,
              baseSnapshot: this.baseSnapshot,
              etag: this.etag,
              pending: true,
              expectedGeneration: this.cacheGeneration,
            });
            if (!saved.updated) {
              throw new SnapshotCacheConflictError(
                "다른 탭의 저장과 겹쳐 현재 입력을 로컬 사본에 덮어쓰지 않았습니다.",
              );
            }
            this._adoptCached(saved);
          });
        } catch (error) {
          if (error instanceof SnapshotCacheConflictError) {
            await this._adoptCurrentCacheAfterMiss(error.message).catch(() => {
              this._setSyncFailure(error, { conflict: true });
            });
          }
          throw error;
        }
        await this._syncPending();
        return result.value;
      });
    this.writeQueue = run;
    return run;
  }

  async _markClean(etag, target) {
    return this._withCacheLock(async () => {
      const latest = await this._validatedCache();
      if (!latest) {
        await this._adoptCurrentCacheAfterMiss(
          "동기화 중 브라우저 로컬 사본이 사라져 서버 저장 결과를 확정하지 않았습니다.",
        );
        return false;
      }
      if (
        latest.generation !== target.generation ||
        !snapshotsEqual(latest.snapshot, target.snapshot)
      ) {
        this._adoptCached(latest, { clearError: false });
        if (
          !latest.pending &&
          latest.etag === etag &&
          snapshotsEqual(latest.snapshot, target.snapshot)
        ) {
          this.offline = false;
          this.conflict = false;
          this.syncError = null;
          return true;
        }
        this._setSyncFailure(
          new SnapshotCacheConflictError(
            "다른 탭의 더 새로운 로컬 변경을 보존했습니다. 그 변경을 다시 동기화해야 합니다.",
          ),
          { conflict: true },
        );
        return false;
      }
      const saved = await this._compareAndSetCache({
        snapshot: target.snapshot,
        baseSnapshot: target.snapshot,
        etag,
        pending: false,
        expectedGeneration: target.generation,
      });
      if (!saved.updated) {
        await this._adoptCurrentCacheAfterMiss(
          "다른 탭의 변경 때문에 서버 저장 결과로 로컬 사본을 덮지 않았습니다.",
        );
        return false;
      }
      this._adoptCached(saved);
      return true;
    });
  }

  async _syncPending(mergeAttempt = 0) {
    let target;
    try {
      target = await this._withCacheLock(async () => {
        const latest = await this._validatedCache();
        if (!latest) {
          if (!this.pending) return null;
          throw new SnapshotCacheConflictError(
            "보류 중인 브라우저 로컬 사본을 찾을 수 없어 자동 전송을 멈췄습니다.",
          );
        }
        if (
          latest.generation !== this.cacheGeneration ||
          !snapshotsEqual(latest.snapshot, this.snapshot)
        ) {
          this._adoptCached(latest);
        }
        if (!this.pending) return null;
        return {
          snapshot: structuredClone(this.snapshot),
          baseSnapshot: this.baseSnapshot
            ? structuredClone(this.baseSnapshot)
            : null,
          etag: this.etag,
          generation: this.cacheGeneration,
          resetEpoch: this.resetEpoch,
        };
      });
    } catch (error) {
      this._setSyncFailure(error, { conflict: true });
      if (error instanceof SnapshotCacheResetError) throw error;
      return false;
    }
    if (!target) return true;

    try {
      await this._assertResetEpoch();
      const saved = await this.saveRemote(
        this.tenantId,
        target.snapshot,
        target.etag,
      );
      if (typeof saved?.etag !== "string" || !saved.etag) {
        throw new Error("서버가 저장본 ETag를 반환하지 않았습니다.");
      }
      return await this._markClean(saved.etag, target);
    } catch (error) {
      if (error instanceof SnapshotCacheResetError) {
        this._setSyncFailure(error, { conflict: true });
        throw error;
      }
      if (error instanceof ApiError && [409, 412].includes(error.status)) {
        let remote;
        try {
          remote = await this.loadRemote(this.tenantId);
          await validateSnapshot(remote.snapshot);
        } catch (refreshError) {
          this._setSyncFailure(refreshError);
          return false;
        }
        if (snapshotsEqual(target.snapshot, remote.snapshot)) {
          return await this._markClean(remote.etag, target);
        }
        if (target.baseSnapshot) {
          let merged;
          try {
            merged = await mergeBrowserSnapshots(
              target.baseSnapshot,
              target.snapshot,
              remote.snapshot,
            );
          } catch (mergeError) {
            this._setSyncFailure(mergeError, { conflict: true });
            return false;
          }
          const hasConflicts = merged.conflicts.length > 0;
          const prepared = await this._withCacheLock(async () => {
            const latest = await this._validatedCache();
            if (
              !latest ||
              latest.generation !== target.generation ||
              !snapshotsEqual(latest.snapshot, target.snapshot)
            ) {
              if (latest) this._adoptCached(latest, { clearError: false });
              this._setSyncFailure(
                new SnapshotCacheConflictError(
                  "병합하는 동안 다른 탭의 변경을 발견해 현재 로컬 사본을 보존했습니다.",
                ),
                { conflict: true },
              );
              return false;
            }
            const saved = await this._compareAndSetCache({
              snapshot: merged.snapshot,
              baseSnapshot: hasConflicts
                ? target.baseSnapshot
                : remote.snapshot,
              etag: hasConflicts ? target.etag : remote.etag,
              pending: true,
              expectedGeneration: target.generation,
            });
            if (!saved.updated) {
              await this._adoptCurrentCacheAfterMiss(
                "다른 탭의 변경 때문에 병합 결과를 적용하지 않았습니다.",
              );
              return false;
            }
            this._adoptCached(saved);
            return true;
          });
          if (!prepared) return false;
          if (!hasConflicts) {
            if (mergeAttempt >= 4) {
              this._setSyncFailure(
                new RemoteSnapshotConflictError(
                  "서버 변경이 계속 이어져 자동 병합을 잠시 멈췄습니다. 작업이 끝난 뒤 다시 동기화해 주세요.",
                  { cause: error },
                ),
                { conflict: true },
              );
              return false;
            }
            return this._syncPending(mergeAttempt + 1);
          }
          this._setSyncFailure(
            new RemoteSnapshotConflictError(
              `같은 항목을 동시에 변경했습니다. ${merged.conflicts.length}개 항목을 확인해 주세요.`,
              { cause: error },
            ),
            { conflict: true },
          );
          return false;
        }
        // A newly opened browser can have an empty initialization snapshot
        // waiting to upload while a connected PC has already populated the
        // account. There is no browser-authored content to preserve in that
        // exact case, so prefer the server copy instead of trapping the user
        // in a conflict with an empty project list. Any non-empty local copy
        // still fails closed and requires an explicit choice.
        if (
          snapshotIsEmpty(target.snapshot) &&
          !snapshotIsEmpty(remote.snapshot)
        ) {
          return await this._withCacheLock(async () => {
            const latest = await this._validatedCache();
            if (
              !latest ||
              latest.generation !== target.generation ||
              !snapshotsEqual(latest.snapshot, target.snapshot)
            ) {
              if (latest) this._adoptCached(latest, { clearError: false });
              this._setSyncFailure(
                new SnapshotCacheConflictError(
                  "서버본을 받기 전에 다른 탭의 변경을 발견해 로컬 사본을 보존했습니다.",
                ),
                { conflict: true },
              );
              return false;
            }
            const adopted = await this._compareAndSetCache({
              snapshot: remote.snapshot,
              baseSnapshot: remote.snapshot,
              etag: remote.etag,
              pending: false,
              expectedGeneration: target.generation,
            });
            if (!adopted.updated) {
              await this._adoptCurrentCacheAfterMiss(
                "다른 탭의 변경 때문에 서버본을 적용하지 않았습니다.",
              );
              return false;
            }
            this._adoptCached(adopted);
            return true;
          });
        }
        try {
          await this._adoptCurrentCacheAfterMiss(
            "서버의 새 변경과 겹쳤습니다. 기준 저장본이 없는 이전 브라우저 캐시라 자동 병합하지 못했습니다.",
          );
        } catch (cacheError) {
          if (cacheError instanceof SnapshotCacheResetError) {
            this._setSyncFailure(cacheError, { conflict: true });
            throw cacheError;
          }
        }
        this._setSyncFailure(
          new RemoteSnapshotConflictError(
            "서버의 새 변경과 겹쳤습니다. 기준 저장본이 없는 이전 브라우저 캐시라 자동 병합하지 못했습니다.",
            { cause: error },
          ),
          { conflict: true },
        );
        return false;
      }
      this._setSyncFailure(error);
      return false;
    }
  }

  async sync() {
    const run = this.writeQueue
      .catch(() => {})
      .then(async () => {
        const alreadyLoaded = Boolean(this.snapshot);
        await this.load();
        if (!alreadyLoaded) return !this.pending;
        return this._syncPending();
      });
    this.writeQueue = run;
    return run;
  }

  async resolveConflict(strategy) {
    if (!["local", "server"].includes(strategy)) {
      throw new TypeError("동기화할 저장본을 선택해 주세요.");
    }
    const run = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await this.load();
        const target = await this._validatedCache();
        if (!target?.pending) {
          throw new Error("서버로 보내지 못한 로컬 변경이 없습니다.");
        }

        if (strategy === "local") {
          try {
            return await this._withCacheLock(async () => {
              const latest = await this._validatedCache();
              if (
                !latest ||
                latest.generation !== target.generation ||
                !snapshotsEqual(latest.snapshot, target.snapshot)
              ) {
                if (latest) this._adoptCached(latest, { clearError: false });
                this._setSyncFailure(
                  new SnapshotCacheConflictError(
                    "선택하는 동안 다른 탭에서 내용을 바꿨습니다. 서버는 바꾸지 않았습니다.",
                  ),
                  { conflict: true },
                );
                return false;
              }

              const remote = await this.loadRemote(this.tenantId);
              await validateSnapshot(remote.snapshot);
              if (typeof remote.etag !== "string" || !remote.etag) {
                throw new Error("서버 저장본의 버전을 확인할 수 없습니다.");
              }
              let selectedSnapshot = target.snapshot;
              if (target.baseSnapshot) {
                const localPreferred = await mergeBrowserSnapshots(
                  target.baseSnapshot,
                  target.snapshot,
                  remote.snapshot,
                );
                selectedSnapshot = localPreferred.snapshot;
              }
              const beforeWrite = await this._validatedCache();
              if (
                !beforeWrite ||
                beforeWrite.generation !== target.generation ||
                !snapshotsEqual(beforeWrite.snapshot, target.snapshot)
              ) {
                if (beforeWrite)
                  this._adoptCached(beforeWrite, { clearError: false });
                this._setSyncFailure(
                  new SnapshotCacheConflictError(
                    "서버에 올리기 전에 다른 탭의 변경을 발견했습니다. 서버는 바꾸지 않았습니다.",
                  ),
                  { conflict: true },
                );
                return false;
              }
              let cleanEtag = remote.etag;
              if (!snapshotsEqual(selectedSnapshot, remote.snapshot)) {
                await this._assertResetEpoch();
                const saved = await this.saveRemote(
                  this.tenantId,
                  selectedSnapshot,
                  remote.etag,
                );
                if (typeof saved?.etag !== "string" || !saved.etag) {
                  throw new Error("서버가 저장본 버전을 반환하지 않았습니다.");
                }
                cleanEtag = saved.etag;
              }
              const clean = await this._compareAndSetCache({
                snapshot: selectedSnapshot,
                baseSnapshot: selectedSnapshot,
                etag: cleanEtag,
                pending: false,
                expectedGeneration: target.generation,
              });
              if (!clean.updated) {
                this._setSyncFailure(
                  new SnapshotCacheConflictError(
                    "다른 탭의 변경 때문에 서버 저장 결과를 확정하지 않았습니다.",
                  ),
                  { conflict: true },
                );
                return false;
              }
              this._adoptCached(clean);
              return true;
            });
          } catch (error) {
            this._setSyncFailure(error, {
              conflict:
                error instanceof ApiError && [409, 412].includes(error.status),
            });
            if (error instanceof SnapshotCacheResetError) throw error;
            return false;
          }
        }

        let remote;
        try {
          remote = await this.loadRemote(this.tenantId);
          await validateSnapshot(remote.snapshot);
          if (typeof remote.etag !== "string" || !remote.etag) {
            throw new Error("서버 저장본의 버전을 확인할 수 없습니다.");
          }
        } catch (error) {
          this._setSyncFailure(error);
          return false;
        }

        let selectedSnapshot = remote.snapshot;
        if (target.baseSnapshot) {
          const serverPreferred = await mergeBrowserSnapshots(
            target.baseSnapshot,
            remote.snapshot,
            target.snapshot,
          );
          selectedSnapshot = serverPreferred.snapshot;
        }

        return this._withCacheLock(async () => {
          const latest = await this._validatedCache();
          if (
            !latest ||
            latest.generation !== target.generation ||
            !snapshotsEqual(latest.snapshot, target.snapshot)
          ) {
            await this._adoptCurrentCacheAfterMiss(
              "선택하는 동안 다른 탭에서 내용을 바꿨습니다. 로컬 변경을 보존했습니다.",
            );
            return false;
          }
          let cleanEtag = remote.etag;
          if (!snapshotsEqual(selectedSnapshot, remote.snapshot)) {
            const remoteSaved = await this.saveRemote(
              this.tenantId,
              selectedSnapshot,
              remote.etag,
            );
            if (typeof remoteSaved?.etag !== "string" || !remoteSaved.etag) {
              throw new Error("서버가 저장본 버전을 반환하지 않았습니다.");
            }
            cleanEtag = remoteSaved.etag;
          }
          const saved = await this._compareAndSetCache({
            snapshot: selectedSnapshot,
            baseSnapshot: selectedSnapshot,
            etag: cleanEtag,
            pending: false,
            expectedGeneration: target.generation,
          });
          if (!saved.updated) {
            await this._adoptCurrentCacheAfterMiss(
              "다른 탭의 변경 때문에 서버본을 적용하지 않았습니다.",
            );
            return false;
          }
          this._adoptCached(saved);
          return true;
        });
      });
    this.writeQueue = run;
    return run;
  }

  syncStatus() {
    return {
      pending: this.pending,
      offline: this.offline,
      conflict: this.conflict,
      error: this.syncError,
    };
  }

  hasLocalContent() {
    if (!this.snapshot) return false;
    return this.snapshot.files.length > 0 || Boolean(this.localRule);
  }

  async rules({ q, scope, repository } = {}) {
    await this.load();
    const rules = this.snapshot.files
      .map((file) => ruleFromFile(this.snapshot, file))
      .filter(Boolean);
    if (this.localRule) rules.push(structuredClone(this.localRule));
    const query = normalizedSearch(q);
    const selectedScope = scope === "global" ? "all" : String(scope || "");
    return rules
      .filter((rule) => !selectedScope || rule.scope === selectedScope)
      .filter((rule) =>
        !repository
          ? true
          : rule.repository === repository || rule.repo === repository,
      )
      .filter((rule) =>
        !query
          ? true
          : normalizedSearch(
              `${rule.content} ${rule.repositoryName || ""} ${rule.environment || ""}`,
            ).includes(query),
      )
      .sort((left, right) => {
        const order = { all: 0, repo: 1, env: 2, pc: 3 };
        return (
          (order[left.scope] ?? 9) - (order[right.scope] ?? 9) ||
          left.id.localeCompare(right.id)
        );
      });
  }

  async createRule(values) {
    await this.load();
    const path = rulePath(this.snapshot, values);
    const content = policyContent(values.content);
    if (path === "pc") {
      if (this.localRule)
        throw new Error(
          "이 브라우저 룰은 이미 있습니다. 기존 룰을 수정해 주세요.",
        );
      const now = new Date().toISOString();
      const rule = {
        id: "pc",
        scope: "pc",
        content,
        createdAt: now,
        updatedAt: now,
      };
      await this._assertResetEpoch();
      await saveLocalRule(this.tenantId, rule, this.resetEpoch);
      await this._assertResetEpoch();
      this.localRule = rule;
      return structuredClone(rule);
    }
    return this._commit(async (snapshot) => {
      if (fileAt(snapshot, path))
        throw new Error("같은 범위의 룰이 이미 있습니다.");
      return {
        snapshot: await replaceTextFile(snapshot, path, content),
        value: { id: path, content },
      };
    });
  }

  async updateRule(id, values) {
    await this.load();
    const targetPath = rulePath(this.snapshot, values);
    if (targetPath !== id) {
      throw new Error(
        "수정 중에는 룰 범위를 바꿀 수 없습니다. 새 범위에 룰을 추가해 주세요.",
      );
    }
    const content = policyContent(values.content);
    if (id === "pc") {
      if (!this.localRule) throw new Error("수정할 브라우저 룰이 없습니다.");
      const rule = {
        ...this.localRule,
        content,
        updatedAt: new Date().toISOString(),
      };
      await this._assertResetEpoch();
      await saveLocalRule(this.tenantId, rule, this.resetEpoch);
      await this._assertResetEpoch();
      this.localRule = rule;
      return structuredClone(rule);
    }
    return this._commit(async (snapshot) => {
      if (!fileAt(snapshot, id)) throw new Error("수정할 룰이 없습니다.");
      return {
        snapshot: await replaceTextFile(snapshot, id, content),
        value: { id, content },
      };
    });
  }

  async deleteRule(id) {
    await this.load();
    if (id === "pc") {
      await this._assertResetEpoch();
      await saveLocalRule(this.tenantId, null, this.resetEpoch);
      await this._assertResetEpoch();
      this.localRule = null;
      return true;
    }
    return this._commit(async (snapshot) => {
      if (!fileAt(snapshot, id)) throw new Error("삭제할 룰이 없습니다.");
      return {
        snapshot: await replaceTextFile(snapshot, id, null),
        value: true,
      };
    });
  }

  async work({ status = "active", q, repository } = {}) {
    await this.load();
    const query = normalizedSearch(q);
    return this.snapshot.files
      .map(workFromFile)
      .filter(Boolean)
      .filter((item) => status === "all" || item.status === status)
      .filter((item) =>
        !repository ? true : item.repoId === repository,
      )
      .filter((item) =>
        !query
          ? true
          : normalizedSearch(
              `${item.name} ${item.goal} ${item.current} ${item.next} ${item.decision} ${item.rejected}`,
            ).includes(query),
      )
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      );
  }

  async createWork(values) {
    await this.load();
    const repository = resolveRepository(
      this.snapshot,
      values.repository || values.repo || values.repoId,
    );
    const record = workRecord({ ...values, repoId: repository.id });
    const path = `repositories/${repository.id}/handoffs/${record.id}.json`;
    return this._commit(async (snapshot) => ({
      snapshot: await replaceTextFile(snapshot, path, jsonText(record)),
      value: workFromFile(await makeTextFile(path, jsonText(record))),
    }));
  }

  async updateWork(id, values) {
    return this._commit(async (snapshot) => {
      const current = findWork(snapshot, id);
      const repository = resolveRepository(
        snapshot,
        values.repository || values.repo || values.repoId || current.repoId,
      );
      const record = workRecord({ ...values, repoId: repository.id }, current);
      const directory = record.status === "closed" ? "archive" : "handoffs";
      const path = `repositories/${repository.id}/${directory}/${record.id}.json`;
      let next = await replaceTextFile(snapshot, current._path, null);
      if (path !== current._path && fileAt(next, path)) {
        throw new Error("옮길 위치에 같은 작업 ID가 이미 있습니다.");
      }
      next = await replaceTextFile(next, path, jsonText(record));
      return { snapshot: next, value: { ...record, _path: path } };
    });
  }

  async finishWork(id) {
    return this._commit(async (snapshot) => {
      const current = findWork(snapshot, id);
      if (current.status === "done") return { snapshot, value: current };
      const now = new Date().toISOString();
      const record = {
        ...current,
        status: "closed",
        updatedAt: now,
        closedAt: now,
      };
      delete record.name;
      delete record.goal;
      delete record.current;
      delete record.next;
      delete record.decision;
      delete record.rejected;
      delete record.repository;
      delete record._rawStatus;
      delete record._path;
      const path = `repositories/${record.repoId}/archive/${record.id}.json`;
      let next = await replaceTextFile(snapshot, current._path, null);
      next = await replaceTextFile(next, path, jsonText(record));
      return { snapshot: next, value: { ...record, _path: path } };
    });
  }

  async knowledge({ q, scope, repository, repoId, environment } = {}) {
    await this.load();
    const terms = normalizedSearch(q).split(/\s+/u).filter(Boolean);
    const requestedScope = scope === "all-scopes" || !scope
      ? null
      : scope === "all" ? "global" : scope;
    const requestedRepository = String(repository || repoId || "").trim();
    const requestedEnvironment = String(environment || "").trim();
    return this.snapshot.files
      .map((file) => knowledgeFromFile(this.snapshot, file))
      .filter(Boolean)
      .filter((entry) => requestedScope === null || entry.scope === requestedScope)
      .filter((entry) => !requestedRepository || entry.repoId === requestedRepository)
      .filter((entry) => !requestedEnvironment || entry.environment === requestedEnvironment)
      .map((entry) => {
        if (terms.length === 0) return { ...entry, score: 0 };
        const title = normalizedSearch(entry.title);
        const body = normalizedSearch(entry.body);
        const tags = normalizedSearch(entry.tags.join(" "));
        if (
          !terms.every(
            (term) =>
              title.includes(term) ||
              body.includes(term) ||
              tags.includes(term),
          )
        ) {
          return null;
        }
        const score = terms.reduce(
          (total, term) =>
            total +
            (title.includes(term) ? 8 : 0) +
            (tags.includes(term) ? 4 : 0) +
            (body.includes(term) ? 1 : 0),
          0,
        );
        return { ...entry, score };
      })
      .filter(Boolean)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      );
  }

  async createKnowledge(values) {
    return this._commit(async (snapshot) => {
      const record = knowledgeRecord(snapshot, values);
      const path = `knowledge/${record.id}.json`;
      return {
        snapshot: await replaceTextFile(snapshot, path, jsonText(record)),
        value: { ...record, content: record.body, _path: path },
      };
    });
  }

  async updateKnowledge(id, values) {
    return this._commit(async (snapshot) => {
      const current = findKnowledge(snapshot, id);
      const record = knowledgeRecord(snapshot, values, current);
      const path = `knowledge/${record.id}.json`;
      return {
        snapshot: await replaceTextFile(snapshot, path, jsonText(record)),
        value: { ...record, content: record.body, _path: path },
      };
    });
  }

  async deleteKnowledge(id) {
    return this._commit(async (snapshot) => {
      const current = findKnowledge(snapshot, id);
      return {
        snapshot: await replaceTextFile(snapshot, current._path, null),
        value: true,
      };
    });
  }

  async recentWork(limit = 4) {
    return (await this.work({ status: "active" })).slice(0, limit);
  }

  async recentKnowledge(limit = 4) {
    return (await this.knowledge()).slice(0, limit);
  }

  snapshotBytes() {
    if (!this.snapshot) return 0;
    return this.snapshot.files.reduce((sum, file) => sum + file.bytes, 0);
  }
}
