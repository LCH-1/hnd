import {
  createBrowserVault,
  createIndexedDbVaultStorage,
  decryptBytes,
  decryptSnapshot as decryptCanonicalSnapshot,
  deleteBrowserVault,
  encryptSnapshot as encryptCanonicalSnapshot,
  importBrowserVault,
  loadBrowserVault,
  SNAPSHOT_AUTHENTICATION_ERROR_CODE,
} from "../browser/index.mjs";

import { ApiError, api } from "./api.js";
import { base64urlFromBytes, bytesFromBase64url } from "./webauthn.js";

let vaultStorage;

function storage() {
  if (!window.crypto?.subtle || !window.indexedDB) {
    throw new Error(
      "이 브라우저는 안전한 로컬 보관함 저장을 지원하지 않습니다.",
    );
  }
  vaultStorage ||= createIndexedDbVaultStorage();
  return vaultStorage;
}

function vaultId(tenantId) {
  const value = String(tenantId || "default");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("작업 공간 ID 형식이 올바르지 않습니다.");
  }
  return value;
}

function clearBytes(value) {
  if (value instanceof Uint8Array) value.fill(0);
}

function selectedStorage(options = {}) {
  return options.storage ?? storage();
}

function cryptoOptions(options = {}) {
  return options.crypto ? { crypto: options.crypto } : {};
}

function definitelyRejectedBeforeCommit(error) {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 412, 425, 429].includes(error.status)
  );
}

async function inspectRemoteVault(remoteApi, key, options = {}) {
  const status = await remoteApi.vaultStatus();
  if (status?.initialized !== true) return { initialized: false };

  const response = await remoteApi.vaultSnapshot();
  const blob = response?.snapshot || response?.blob;
  if (typeof blob !== "string") {
    throw new Error("서버가 암호화 저장본을 반환하지 않았습니다.");
  }
  const encrypted = new Uint8Array(bytesFromBase64url(blob));
  let plaintext;
  try {
    plaintext = await decryptBytes(encrypted, key, cryptoOptions(options));
  } finally {
    clearBytes(plaintext);
    clearBytes(encrypted);
  }
  return { initialized: true, confirmed: true };
}

function managedVaultKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("서버가 올바른 계정 보관함 키를 반환하지 않았습니다.");
  }
  const key = new Uint8Array(bytesFromBase64url(value));
  if (key.byteLength !== 32 || base64urlFromBytes(key) !== value) {
    clearBytes(key);
    throw new Error("서버가 올바른 계정 보관함 키를 반환하지 않았습니다.");
  }
  return key;
}

async function adoptManagedVaultKey(remoteApi, key) {
  const result = await remoteApi.vaultKeyAdopt({
    vaultKey: base64urlFromBytes(key),
  });
  if (result?.managed !== true && result?.keyManaged !== true) {
    throw new Error("서버가 계정 보관함 키 저장을 확인하지 않았습니다.");
  }
  return result;
}

function initializationUncertainError(initialError, recoveryError) {
  return new Error(
    "서버 반영 여부를 확인하지 못했습니다. 이 브라우저의 암호화 키는 보존했습니다. 연결이 복구되면 같은 버튼으로 다시 시도해 주세요.",
    { cause: recoveryError || initialError },
  );
}

export async function hasLocalVault(tenantId, options = {}) {
  const loader = options.loadBrowserVault ?? loadBrowserVault;
  const result = await loader({
    storage: selectedStorage(options),
    vaultId: vaultId(tenantId),
    ...cryptoOptions(options),
  });
  try {
    return Boolean(result);
  } finally {
    clearBytes(result?.vaultKey);
  }
}

export async function listLocalVaultIds(options = {}) {
  const localStorage = selectedStorage(options);
  if (typeof localStorage.keys !== "function") {
    throw new Error("브라우저 보관함 목록을 확인할 수 없습니다.");
  }
  const prefix = "hnd:vault:";
  const result = [];
  for (const key of await localStorage.keys()) {
    if (typeof key !== "string" || !key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) result.push(id);
  }
  return [...new Set(result)].sort();
}

export async function initializeBrowserVault(tenantId, options = {}) {
  const id = vaultId(tenantId);
  const localStorage = selectedStorage(options);
  const remoteApi = options.api ?? api;
  const creator = options.createBrowserVault ?? createBrowserVault;
  const remover = options.deleteBrowserVault ?? deleteBrowserVault;
  const result = await creator({
    storage: localStorage,
    vaultId: id,
    ...cryptoOptions(options),
  });
  try {
    const encrypted = await encryptCanonicalSnapshot(
      { schemaVersion: 1, files: [] },
      result.vaultKey,
      cryptoOptions(options),
    );
    let recovered = false;
    try {
      await remoteApi.vaultInitialize({
        version: 1,
        algorithm: "AES-256-GCM",
        browserStorage: "indexeddb-wrapped",
        snapshot: base64urlFromBytes(encrypted),
      });
    } catch (initialError) {
      let recovery;
      try {
        recovery = await inspectRemoteVault(remoteApi, result.vaultKey, options);
      } catch (recoveryError) {
        throw initializationUncertainError(initialError, recoveryError);
      }
      if (recovery.confirmed) {
        recovered = true;
      } else {
        // Only a definitive client rejection plus an authoritative empty status
        // proves that the request never reached snapshot storage. Timeouts and
        // server errors may have happened after the commit, so retain the key.
        if (
          recovery.initialized === false &&
          definitelyRejectedBeforeCommit(initialError)
        ) {
          await remover({ storage: localStorage, vaultId: id }).catch(() => {});
          throw initialError;
        }
        throw initializationUncertainError(initialError);
      }
    } finally {
      clearBytes(encrypted);
    }
    await adoptManagedVaultKey(remoteApi, result.vaultKey);
    return { created: result.created, recovered };
  } finally {
    clearBytes(result.vaultKey);
  }
}

function resetUncertainError(initialError, recoveryError) {
  return new Error(
    "서버 반영 여부를 확인하지 못했습니다. 새 보관함의 암호화 키는 이 브라우저에 보존했습니다. 연결이 복구되면 같은 작업을 다시 시도해 주세요.",
    { cause: recoveryError || initialError },
  );
}

async function encryptedSnapshotEtag(encrypted, options = {}) {
  const provider = options.crypto ?? globalThis.crypto;
  if (!provider?.subtle || typeof provider.subtle.digest !== "function") {
    throw new Error("이 브라우저는 보관함 무결성 확인을 지원하지 않습니다.");
  }
  const digest = new Uint8Array(
    await provider.subtle.digest("SHA-256", encrypted),
  );
  try {
    const hex = Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `"${hex}"`;
  } finally {
    clearBytes(digest);
  }
}

async function inspectRemoteReset(remoteApi, expectedSnapshot, expectedEtag) {
  const status = await remoteApi.vaultStatus();
  if (status?.initialized !== true || status?.etag !== expectedEtag) {
    throw new Error("서버 보관함 버전이 이번 초기화 결과와 다릅니다.");
  }
  const response = await remoteApi.vaultSnapshot();
  const blob = response?.snapshot || response?.blob;
  if (blob !== expectedSnapshot || response?.etag !== expectedEtag) {
    throw new Error("서버 저장본이 이번에 만든 빈 보관함과 다릅니다.");
  }
  return { confirmed: true };
}

export async function resetBrowserVault(tenantId, etag, options = {}) {
  const id = vaultId(tenantId);
  if (typeof etag !== "string" || !etag.trim() || etag.length > 256) {
    throw new Error(
      "현재 보관함 버전을 확인할 수 없습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.",
    );
  }
  const localStorage = selectedStorage(options);
  const remoteApi = options.api ?? api;
  const creator = options.createBrowserVault ?? createBrowserVault;
  const remover = options.deleteBrowserVault ?? deleteBrowserVault;
  const result = await creator({
    storage: localStorage,
    vaultId: id,
    ...cryptoOptions(options),
  });
  let encrypted;
  try {
    encrypted = await encryptCanonicalSnapshot(
      { schemaVersion: 1, files: [] },
      result.vaultKey,
      cryptoOptions(options),
    );
    const expectedSnapshot = base64urlFromBytes(encrypted);
    const expectedEtag = await encryptedSnapshotEtag(encrypted, options);
    let response;
    let recovered = false;
    try {
      response = await remoteApi.vaultReset(
        {
          version: 1,
          algorithm: "AES-256-GCM",
          snapshot: expectedSnapshot,
          confirmation: "RESET_VAULT",
        },
        etag,
      );
    } catch (initialError) {
      // Discard only a key created by this attempt after a request that
      // definitely could not have committed. A retained key can belong to an
      // earlier ambiguous reset and must never be replaced speculatively.
      if (definitelyRejectedBeforeCommit(initialError)) {
        if (result.created === true) {
          await remover({ storage: localStorage, vaultId: id }).catch(() => {});
        }
        throw initialError;
      }

      let recovery;
      try {
        recovery = await inspectRemoteReset(
          remoteApi,
          expectedSnapshot,
          expectedEtag,
        );
      } catch (recoveryError) {
        if (
          initialError instanceof ApiError &&
          [409, 412].includes(initialError.status)
        ) {
          throw initialError;
        }
        throw resetUncertainError(initialError, recoveryError);
      }
      if (recovery.confirmed) {
        recovered = true;
      } else {
        throw resetUncertainError(initialError);
      }
    }
    if (!recovered) {
      const expectedRevisionId = expectedEtag.slice(1, -1);
      if (
        response?.etag !== expectedEtag ||
        response?.revisionId !== expectedRevisionId
      ) {
        throw resetUncertainError(
          new Error("서버가 이번 빈 보관함과 다른 저장 식별자를 반환했습니다."),
        );
      }
    }
    await adoptManagedVaultKey(remoteApi, result.vaultKey);
    if (recovered) {
      return { created: result.created, recovered: true };
    }
    return {
      created: result.created,
      recovered: false,
      etag: response?.etag ?? null,
      revisionId: response?.revisionId ?? null,
    };
  } finally {
    clearBytes(encrypted);
    clearBytes(result.vaultKey);
  }
}

export async function createAccountConnection(options = {}) {
  const ttlSeconds = options.ttlSeconds ?? 900;
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > 604800
  ) {
    throw new Error("PC 연결 코드 유효 시간은 60초에서 7일 사이여야 합니다.");
  }
  const remoteApi = options.api ?? api;
  const issued = await remoteApi.connectionCreate({ ttlSeconds });
  if (
    typeof issued?.connectionCode !== "string" ||
    !/^hndj_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{12}$/.test(
      issued.connectionCode,
    ) ||
    typeof issued?.connectionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(issued.connectionId) ||
    typeof issued?.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(issued.expiresAt))
  ) {
    throw new Error("서버가 완전한 PC 연결 정보를 반환하지 않았습니다.");
  }
  return Object.freeze({
    connectionCode: issued.connectionCode,
    connectionId: issued.connectionId,
    expiresAt: issued.expiresAt,
  });
}

export async function adoptBrowserVaultKey(tenantId, options = {}) {
  const key = await unlockBrowserVault(tenantId, options);
  try {
    return await adoptManagedVaultKey(options.api ?? api, key);
  } finally {
    clearBytes(key);
  }
}

export async function unlockManagedBrowserVault(tenantId, options = {}) {
  const remoteApi = options.api ?? api;
  const importer = options.importBrowserVault ?? importBrowserVault;
  const response = await remoteApi.vaultKeyUnlock({});
  const key = managedVaultKey(response?.vaultKey);
  try {
    const imported = await importer({
      storage: selectedStorage(options),
      vaultId: vaultId(tenantId),
      vaultKey: key,
      replaceExisting: true,
      ...cryptoOptions(options),
    });
    try {
      return {
        imported: imported?.created === true,
        replaced: imported?.replaced === true,
      };
    } finally {
      clearBytes(imported?.vaultKey);
    }
  } finally {
    clearBytes(key);
  }
}

export async function unlockBrowserVault(tenantId, options = {}) {
  try {
    const loader = options.loadBrowserVault ?? loadBrowserVault;
    const result = await loader({
      storage: selectedStorage(options),
      vaultId: vaultId(tenantId),
      ...cryptoOptions(options),
    });
    if (!result) {
      throw new Error(
        "이 브라우저에는 오프라인 보관함 키가 없습니다. 서버에 연결한 뒤 패스키로 계정 보관함을 열어 주세요.",
      );
    }
    return result.vaultKey;
  } catch (error) {
    if (error?.message?.startsWith("이 브라우저에는")) throw error;
    throw new Error(
      "브라우저 보관함을 열 수 없습니다. 브라우저 데이터가 지워졌거나 손상되었습니다.",
      { cause: error },
    );
  }
}

export async function removeLocalVault(tenantId) {
  await deleteBrowserVault({
    storage: storage(),
    vaultId: vaultId(tenantId),
  });
}

export async function exportVaultKeyFile(tenantId) {
  const key = await unlockBrowserVault(tenantId);
  try {
    return `hnd-vault-v1:${base64urlFromBytes(key)}\n`;
  } finally {
    clearBytes(key);
  }
}

export async function loadEncryptedSnapshot(tenantId, options = {}) {
  const response = await (options.api ?? api).vaultSnapshot();
  const blob = response?.snapshot || response?.blob;
  if (typeof blob !== "string") {
    throw new Error("서버가 암호화 저장본을 반환하지 않았습니다.");
  }
  const key = await unlockBrowserVault(tenantId, options);
  try {
    return {
      snapshot: await decryptCanonicalSnapshot(
        bytesFromBase64url(blob),
        key,
        cryptoOptions(options),
      ),
      etag: response.etag || null,
    };
  } catch (error) {
    const unreadable = new Error(
      "저장본의 암호를 풀 수 없습니다. 올바른 보관함이 있는지 확인해 주세요.",
      { cause: error },
    );
    // Only an authenticated-encryption failure is evidence that the local key
    // and the current server ciphertext do not match. Malformed envelopes or
    // authenticated non-JSON payloads cannot be repaired by replacing the key,
    // and must not expose the destructive managed-vault reconnect action.
    if (error?.code === SNAPSHOT_AUTHENTICATION_ERROR_CODE) {
      unreadable.code = "vault_key_mismatch";
    }
    throw unreadable;
  } finally {
    clearBytes(key);
  }
}

export async function saveEncryptedSnapshot(tenantId, snapshot, etag) {
  const key = await unlockBrowserVault(tenantId);
  let encrypted;
  try {
    encrypted = await encryptCanonicalSnapshot(snapshot, key);
    const saved = await api.vaultSaveSnapshot(
      { snapshot: base64urlFromBytes(encrypted) },
      etag,
    );
    return {
      etag: saved?.etag || null,
      revisionId: saved?.revisionId || null,
    };
  } finally {
    clearBytes(key);
    clearBytes(encrypted);
  }
}

export async function sealBrowserValue(tenantId, value) {
  const key = await unlockBrowserVault(tenantId);
  try {
    return await encryptCanonicalSnapshot(value, key);
  } finally {
    clearBytes(key);
  }
}

export async function openBrowserValue(tenantId, encrypted) {
  const key = await unlockBrowserVault(tenantId);
  try {
    return await decryptCanonicalSnapshot(encrypted, key);
  } finally {
    clearBytes(key);
  }
}
