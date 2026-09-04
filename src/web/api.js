import { t } from "./i18n.js";

const DEFAULT_BASE = "/api/web";

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status ?? 0;
    this.code = options.code ?? null;
    this.details = options.details ?? null;
    this.retryable =
      options.retryable ?? (this.status === 0 || this.status >= 500);
  }
}

let csrfToken = null;
let csrfRefreshPromise = null;

function apiBase() {
  const configured = document
    .querySelector('meta[name="hnd-api-base"]')
    ?.content?.trim();
  return (configured || DEFAULT_BASE).replace(/\/$/, "");
}

function endpoint(pathname) {
  return `${apiBase()}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function rememberCsrf(value) {
  if (typeof value === "string" && value.length >= 16 && value.length <= 512) {
    csrfToken = value;
  }
}

async function refreshCsrf(options = {}) {
  if (!csrfRefreshPromise) {
    const pending = request("/auth/session", {
      timeout: options.timeout,
      signal: options.signal,
      retryInvalidCsrf: false,
    });
    csrfRefreshPromise = pending;
    const clearPending = () => {
      if (csrfRefreshPromise === pending) csrfRefreshPromise = null;
    };
    pending.then(clearPending, clearPending);
  }
  const session = await csrfRefreshPromise;
  if (session?.authenticated !== true) {
    throw new ApiError("로그인이 필요합니다.", {
      status: 401,
      code: "unauthorized",
      retryable: false,
    });
  }
}

function errorMessage(status, body) {
  const errorCode =
    typeof body?.error === "string" && body.error.trim()
      ? body.error.trim()
      : typeof body?.code === "string" && body.code.trim()
        ? body.code.trim()
        : null;
  const knownErrors = {
    unauthorized: "로그인이 필요합니다.",
    forbidden: "이 작업을 수행할 권한이 없습니다.",
    invalid_code: "코드가 올바르지 않거나 만료되었습니다.",
    invalid_account_code: "시작 또는 초대 코드가 올바르지 않거나 만료되었습니다.",
    authentication_failed: "패스키 확인에 실패했습니다. 다시 시도해 주세요.",
    registration_failed: "패스키를 등록하지 못했습니다. 다시 시도해 주세요.",
    invalid_csrf:
      "보안 확인 정보가 갱신되었습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.",
    invalid_auth_flow: "로그인 요청이 만료되었습니다. 처음부터 다시 시도해 주세요.",
    username_taken: "이미 사용 중인 사용자 이름입니다.",
    invalid_display_name: "표시 이름을 확인해 주세요.",
    invalid_language: "언어 설정을 확인해 주세요.",
    invalid_device_name: "PC 이름은 공백 없이 1~100자로 입력해 주세요.",
    device_not_found: "연결된 PC를 찾을 수 없습니다. 목록을 새로 확인해 주세요.",
    invalid_recovery_code: "복구 코드가 올바르지 않거나 이미 사용되었습니다.",
    invalid_recovery_confirmation: "현재 복구 코드를 다시 확인해 주세요.",
    recovery_codes_changed: "복구 코드가 바뀌었습니다. 새 코드를 다시 저장해 주세요.",
    recovery_passkey_required: "계정 복구를 마치려면 새 패스키를 등록해야 합니다.",
    reauthentication_required: "보호된 작업입니다. 패스키를 한 번 더 확인해 주세요.",
    active_devices_present: "활성 PC를 모두 해제한 뒤 보관함을 초기화해 주세요.",
    vault_not_initialized: "아직 보관함이 없습니다. 보관함 만들기를 이용해 주세요.",
    legacy_vault_key_unavailable:
      "이전 방식 보관함에는 서버가 관리하는 키가 없습니다. 기존 키가 남아 있으면 이 브라우저에서 전환하고, 없으면 소유자가 새 보관함으로 시작해야 합니다.",
    vault_key_unavailable:
      "계정 보관함 키를 열 수 없습니다. 서버 키 파일과 백업 상태를 확인해 주세요.",
    vault_key_conflict:
      "현재 저장본과 다른 보관함 키가 이미 등록되어 있습니다. 데이터를 덮어쓰지 않았습니다.",
    vault_already_managed:
      "이 보관함은 이미 계정이 관리 중입니다. 초기화하지 않고 패스키로 다시 열어 주세요.",
    legacy_invites_disabled:
      "기존 기기 초대는 사용하지 않습니다. 로그인한 계정의 기기 화면에서 PC 연결 코드를 만드세요.",
    invalid_confirmation: "보관함 초기화 확인 문구를 정확히 입력해 주세요.",
    precondition_required: "최신 보관함 상태를 확인한 뒤 다시 시도해 주세요.",
    precondition_failed: "다른 기기에서 보관함을 변경했습니다. 새로고침 후 다시 시도해 주세요.",
    signup_disabled: "현재 이 서버는 새 계정 가입을 받지 않습니다.",
    invite_required: "유효한 초대 코드가 필요합니다.",
    bootstrap_required: "서버에서 만든 시작 코드가 필요합니다.",
    bootstrap_closed:
      "다른 브라우저에서 첫 소유자 계정 설정을 먼저 마쳤습니다. 로그인 화면에서 다시 확인해 주세요.",
    tenant_required:
      "기존 작업 공간이 여러 개라 자동으로 선택할 수 없습니다.",
    enrollment_not_found: "연결 코드를 찾을 수 없거나 더 이상 사용할 수 없습니다.",
    conflict: "다른 기기에서 먼저 변경했습니다. 새로고침 후 다시 시도하세요.",
    rate_limited: "요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.",
  };
  if (errorCode && knownErrors[errorCode]) return t(knownErrors[errorCode]);
  if (typeof body?.message === "string" && body.message.trim())
    return body.message.trim();
  if (errorCode) return errorCode;
  const known = {
    400: "입력 내용을 확인해 주세요.",
    401: "로그인이 필요합니다.",
    403: "이 작업을 수행할 권한이 없습니다.",
    404: "요청한 정보를 찾을 수 없습니다.",
    409: "다른 변경과 충돌했습니다. 새로고침 후 다시 시도하세요.",
    412: "저장된 내용이 바뀌었습니다. 새로고침 후 다시 시도하세요.",
    413: "보낼 수 있는 크기를 초과했습니다.",
    429: "요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.",
  };
  return t(known[status] || "요청을 처리하지 못했습니다.");
}

async function parseResponse(response) {
  if (response.status === 204 || response.status === 205) return null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      throw new ApiError("서버 응답을 읽을 수 없습니다.", {
        status: response.status,
        code: "invalid_json",
      });
    }
  }
  const text = await response.text();
  return text ? { message: text } : null;
}

export async function request(pathname, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");

  let body = options.body;
  if (
    body !== undefined &&
    body !== null &&
    !(body instanceof FormData) &&
    !(body instanceof Blob)
  ) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
    headers.set("X-Hnd-CSRF", csrfToken);
  }

  const controller = new AbortController();
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 20_000;
  const timeoutId = window.setTimeout(
    () => controller.abort("timeout"),
    timeout,
  );
  const onAbort = () => controller.abort(options.signal?.reason || "cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let response;
  try {
    response = await fetch(endpoint(pathname), {
      method,
      headers,
      body,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ApiError(
        "서버 응답이 늦습니다. 연결을 확인하고 다시 시도하세요.",
        {
          code: "timeout",
          retryable: true,
        },
      );
    }
    throw new ApiError(
      "서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.",
      {
        code: "network_error",
        details: error,
        retryable: true,
      },
    );
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", onAbort);
  }

  const parsed = await parseResponse(response);
  const responseEtag = response.headers.get("etag");
  if (
    responseEtag &&
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    !parsed.etag
  ) {
    parsed.etag = responseEtag;
  }
  rememberCsrf(response.headers.get("x-hnd-csrf"));
  rememberCsrf(parsed?.csrfToken);

  if (!response.ok) {
    const responseCode = parsed?.code || parsed?.error || null;
    if (
      responseCode === "invalid_csrf" &&
      !["GET", "HEAD", "OPTIONS"].includes(method) &&
      options.retryInvalidCsrf !== false
    ) {
      // Another same-session tab can refresh `/auth/session` while this tab is
      // open, rotating the shared CSRF token. The rejected mutation has not
      // reached its route handler, so refresh once and safely replay it.
      await refreshCsrf({ timeout: options.timeout, signal: options.signal });
      return request(pathname, { ...options, retryInvalidCsrf: false });
    }
    throw new ApiError(errorMessage(response.status, parsed), {
      status: response.status,
      code: responseCode,
      details: parsed,
      retryable:
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500,
    });
  }
  return parsed;
}

function resourcePath(collection, id) {
  if (typeof id !== "string" || !id)
    throw new TypeError("리소스 ID가 필요합니다.");
  return `${collection}/${encodeURIComponent(id)}`;
}

export function setCsrfToken(value) {
  rememberCsrf(value);
}

export const api = Object.freeze({
  bootstrap: () => request("/bootstrap"),
  session: () => request("/auth/session"),
  loginOptions: () =>
    request("/auth/login/options", { method: "POST", body: {} }),
  loginVerify: (payload) =>
    request("/auth/login/verify", { method: "POST", body: payload }),
  registerOptions: (payload) =>
    request("/auth/register/options", { method: "POST", body: payload }),
  registerVerify: (payload) =>
    request("/auth/register/verify", { method: "POST", body: payload }),
  reauthOptions: () =>
    request("/auth/reauth/options", { method: "POST", body: {} }),
  reauthVerify: (payload) =>
    request("/auth/reauth/verify", { method: "POST", body: payload }),
  logout: () => request("/auth/logout", { method: "POST", body: {} }),

  recoveryCreate: () =>
    request("/recovery/codes", { method: "POST", body: {} }),
  recoveryConfirm: (payload) =>
    request("/recovery/confirm", { method: "POST", body: payload }),
  recoveryUse: (payload) =>
    request("/recovery/use", { method: "POST", body: payload }),

  vaultStatus: () => request("/vault/status"),
  vaultInitialize: (payload) =>
    request("/vault/initialize", { method: "POST", body: payload }),
  vaultSnapshot: () => request("/vault/snapshot"),
  vaultSaveSnapshot: (payload, etag) =>
    request("/vault/snapshot", {
      method: "PUT",
      headers: etag ? { "If-Match": etag } : { "If-None-Match": "*" },
      body: payload,
    }),
  vaultReset: (payload, etag) =>
    request("/vault/reset", {
      method: "POST",
      headers: etag ? { "If-Match": etag } : {},
      body: payload,
    }),
  vaultKeyUnlock: (payload = {}) =>
    request("/vault/key/unlock", { method: "POST", body: payload }),
  vaultKeyAdopt: (payload) =>
    request("/vault/key/adopt", { method: "POST", body: payload }),
  connectionCreate: (payload) =>
    request("/connections", { method: "POST", body: payload }),

  enrollmentCreate: (payload) =>
    request("/enrollments", { method: "POST", body: payload }),
  enrollmentStatus: (id) => request(resourcePath("/enrollments", id)),

  accountInvites: () => request("/account/invites"),
  createAccountInvite: (payload) =>
    request("/account/invites", { method: "POST", body: payload }),
  accountMembers: () => request("/account/members"),

  overview: () => request("/overview"),

  devices: () => request("/devices"),
  renameDevice: (id, name) =>
    request(resourcePath("/devices", id), {
      method: "PATCH",
      body: { name },
    }),
  revokeDevice: (id) =>
    request(`${resourcePath("/devices", id)}/revoke`, {
      method: "POST",
      body: {},
    }),
  revisions: () => request("/revisions"),

  passkeys: () => request("/security/passkeys"),
  passkeyAddOptions: (payload) =>
    request("/security/passkeys/options", { method: "POST", body: payload }),
  passkeyAddVerify: (payload) =>
    request("/security/passkeys/verify", { method: "POST", body: payload }),
  deletePasskey: (id) =>
    request(resourcePath("/security/passkeys", id), { method: "DELETE" }),
  webSessions: () => request("/security/sessions"),
  revokeSession: (id) =>
    request(resourcePath("/security/sessions", id), { method: "DELETE" }),

  settings: () => request("/settings"),
  updateSettings: (payload) =>
    request("/settings", { method: "PUT", body: payload }),
});
