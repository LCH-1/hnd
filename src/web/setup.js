import { api, setCsrfToken } from "./api.js";
import { applyAccountLanguage, currentLocale, startI18n } from "./i18n.js";
import { CONNECTOR_PACKAGE_SPEC } from "./connector-release.js";
import { createPasskey, getPasskey, webAuthnAvailable } from "./webauthn.js";
import {
  adoptBrowserVaultKey,
  createAccountConnection,
  hasLocalVault,
  initializeBrowserVault,
  unlockManagedBrowserVault,
} from "./vault.js";
import {
  $,
  $$,
  downloadText,
  installCopyButtons,
  listFrom,
  setBusy,
  setHidden,
  showNotice,
} from "./ui.js";

startI18n();

const state = {
  step: 0,
  code: "",
  registration: null,
  session: null,
  tenantId: null,
  recoveryCodes: [],
  recoveryConfirmationId: null,
  deviceInvitation: null,
  deviceIdsBeforeInvitation: new Set(),
  pollTimer: null,
  vaultInitialized: null,
  keyManaged: false,
  deviceConnected: false,
  recoveryMode: false,
  ownerSignup: false,
  codeFreeSignup: false,
  installPlatform: "linux",
  includeConnectorInstall: true,
};

let deviceReauthController = null;

const globalError = $("#setup-global-error");

function configureExitControl() {
  $("#setup-exit").textContent = state.session?.authenticated
    ? "로그아웃"
    : "나가기";
}

async function reauthenticate({ signal } = {}) {
  if (!webAuthnAvailable()) {
    throw new Error(
      "이 브라우저는 패스키를 지원하지 않습니다. 최신 브라우저에서 다시 시도하세요.",
    );
  }
  const challenge = await api.reauthOptions();
  const response = await getPasskey(challenge.options || challenge, { signal });
  await api.reauthVerify({ flowId: challenge.flowId, response });
}

async function withRecentAuthentication(
  operation,
  { signal, onPrompt } = {},
) {
  try {
    return await operation();
  } catch (error) {
    if (error?.code !== "reauthentication_required") throw error;
    onPrompt?.(true);
    try {
      await reauthenticate({ signal });
      return operation();
    } finally {
      onPrompt?.(false);
    }
  }
}

function activeTenant(session) {
  return (
    session?.activeTenantId ||
    session?.tenant?.id ||
    session?.tenantId ||
    session?.tenants?.[0]?.id ||
    null
  );
}

function showStep(nextStep, { focus = true } = {}) {
  state.step = Math.max(0, Math.min(6, Number(nextStep)));
  for (const panel of $$(".setup-step")) {
    const active = Number(panel.dataset.step) === state.step;
    setHidden(panel, !active);
    if (active && focus) {
      const heading = panel.querySelector("h2");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }
  }
  for (const indicator of $$("[data-step-indicator]")) {
    const step = Number(indicator.dataset.stepIndicator);
    indicator.classList.toggle("is-complete", step < state.step);
    indicator.classList.toggle("is-current", step === state.step);
    if (step === state.step) indicator.setAttribute("aria-current", "step");
    else indicator.removeAttribute("aria-current");
  }
  showNotice(globalError);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (state.step === 3 && state.recoveryCodes.length === 0) loadRecoveryCodes();
  if (state.step === 4) void configureVaultStep();
  if (state.step === 5) updateCommands();
  if (state.step === 6) {
    $("#complete-device-status").textContent = state.deviceConnected
      ? "자동 동기화 준비"
      : "나중에 연결";
  }
}

async function advanceAfterVault() {
  // The server's device list belongs to the whole account. An existing device
  // does not prove that the PC in front of this user is connected, so always
  // let the user connect this PC or explicitly defer the optional step.
  state.deviceConnected = false;
  showStep(5);
}

async function configureVaultStep({ force = false } = {}) {
  const createPanel = $("#vault-create-panel");
  const pairPanel = $("#vault-pair-panel");
  setHidden(createPanel, true);
  setHidden(pairPanel, true);
  showNotice($("#vault-notice"));
  if (!state.tenantId) {
    showNotice(
      $("#vault-notice"),
      "현재 계정의 작업 공간을 확인할 수 없습니다. 다시 로그인해 주세요.",
      "error",
    );
    return;
  }
  try {
    let localVault = await hasLocalVault(state.tenantId);
    if (force || state.vaultInitialized === null || localVault) {
      const status = await api.vaultStatus();
      state.vaultInitialized = status?.initialized === true;
      state.keyManaged = status?.keyManaged === true;
    }
    if (localVault && state.vaultInitialized) {
      if (!state.keyManaged) {
        await withRecentAuthentication(() =>
          adoptBrowserVaultKey(state.tenantId),
        );
        state.keyManaged = true;
      }
      await advanceAfterVault();
      return;
    }
    if (!localVault && state.vaultInitialized && state.keyManaged) {
      await withRecentAuthentication(() =>
        unlockManagedBrowserVault(state.tenantId),
      );
      localVault = true;
      await advanceAfterVault();
      return;
    }
    setHidden(state.vaultInitialized ? pairPanel : createPanel, false);
    $("#step-vault-title").textContent = state.vaultInitialized
      ? "이전 방식 보관함을 전환합니다"
      : localVault
        ? "보존한 암호화 키로 서버 연결을 다시 확인합니다"
        : "이 계정의 첫 보관함을 만듭니다";
    $("#initialize-vault").textContent = localVault
      ? "같은 키로 다시 시도"
      : "보관함 만들기";
    if (localVault && !state.vaultInitialized) {
      showNotice(
        $("#vault-notice"),
        "이 브라우저의 암호화 키는 안전하게 남아 있습니다. 서버 연결이 복구되면 같은 키로 다시 시도합니다.",
        "warning",
      );
    } else if (state.vaultInitialized && !state.keyManaged) {
      showNotice(
        $("#vault-notice"),
        "이전 방식 보관함의 로컬 키가 이 브라우저에 없습니다. 기존 데이터를 자동으로 삭제하지 않았습니다. 앱에서 소유자 초기화를 선택하거나 키가 남은 브라우저에서 전환하세요.",
        "warning",
      );
    }
  } catch (error) {
    const retryWithCreate = state.vaultInitialized === false;
    setHidden(createPanel, !retryWithCreate);
    setHidden(pairPanel, retryWithCreate);
    if (!retryWithCreate) {
      $("#setup-account-vault").textContent =
        state.vaultInitialized === null
          ? "상태 다시 확인"
          : state.keyManaged
            ? "계정으로 다시 열기"
            : "전환 다시 시도";
    }
    showNotice(
      $("#vault-notice"),
      `보관함 상태를 확인할 수 없습니다. 새 키를 만들지 않고 멈췄습니다. ${error.message}`,
      "error",
    );
  }
}

function signupIsOwner(session) {
  return Boolean(
    session?.needsOwnerSetup ||
      session?.server?.needsOwnerSetup ||
      session?.signup?.mode === "bootstrap" ||
      session?.signup?.firstUser === true,
  );
}

function configureStepProgress(codeFree) {
  document.body.classList.toggle("setup-code-free", codeFree);
  const total = codeFree ? 6 : 7;
  for (const indicator of $$("[data-step-indicator]")) {
    const step = Number(indicator.dataset.stepIndicator);
    setHidden(indicator, codeFree && step === 0);
    if (!(codeFree && step === 0)) {
      indicator.firstElementChild.textContent = String(codeFree ? step : step + 1);
    }
  }
  for (const panel of $$(".setup-step")) {
    const step = Number(panel.dataset.step);
    const count = $(".step-count", panel);
    if (!count || (codeFree && step === 0)) continue;
    const current = codeFree ? step : step + 1;
    const label = $("strong", count)?.textContent.trim() || "";
    $("b", count).textContent = `${current} / ${total}`;
    count.setAttribute("aria-label", `${current} / ${total}, ${label}`);
  }
}

function configureCodeStep(session) {
  const owner = signupIsOwner(session);
  state.ownerSignup = owner;
  state.codeFreeSignup = Boolean(
    session?.signup &&
      session.signup.allowed !== false &&
      session.signup.requiresCode !== true,
  );
  configureStepProgress(state.codeFreeSignup);
  const accountSection = $("#step-account-title").closest(".setup-step");
  setHidden($("[data-back]", accountSection), state.codeFreeSignup);
  $("#step-account-title").textContent = owner
    ? "소유자 계정을 만드세요"
    : "계정 이름을 정하세요";
  $("#step-code-title").textContent = owner
    ? "작업 공간 선택 코드를 확인합니다"
    : "초대 코드를 확인합니다";
  $("#code-help").textContent = owner
    ? "기존 작업 공간이 여러 개인 서버에서만 선택 코드가 필요합니다. 새 서버는 이 단계 없이 계정을 바로 만듭니다."
    : "서버 소유자에게 받은 1회용 초대 코드를 입력하세요. 코드 원문은 저장하지 않습니다.";
  $("#setup-code").previousElementSibling.textContent = owner
    ? "작업 공간 선택 코드"
    : "초대 코드";
  setHidden($("#bootstrap-command"), !owner || state.codeFreeSignup);
  setHidden($("#owner-account-note"), !owner);
}

function showTenantSelectionFallback(error) {
  state.codeFreeSignup = false;
  configureStepProgress(false);
  const accountSection = $("#step-account-title").closest(".setup-step");
  setHidden($("[data-back]", accountSection), false);
  setHidden($("#bootstrap-command"), false);
  showStep(0);
  showNotice(
    globalError,
    `${error.message} 연결할 작업 공간을 선택한 뒤 1회용 코드를 입력해 주세요.`,
    "warning",
  );
}

function configurePasskeyStep() {
  const section = $("#step-passkey-title").closest(".setup-step");
  $("#step-passkey-title").textContent = state.recoveryMode
    ? "새 패스키를 등록하세요"
    : "패스키로 계정을 보호하세요";
  $(".card-lead", section).textContent = state.recoveryMode
    ? "복구 코드로 들어온 임시 세션은 새 패스키를 등록해야 완료됩니다. 기존 복구 코드는 이미 사용 처리되었습니다."
    : "기기의 화면 잠금, 지문·얼굴 인식, PIN 또는 보안 키를 사용합니다. 생체정보는 HND 서버로 전송되지 않습니다.";
  $("#create-passkey").textContent = state.recoveryMode
    ? "새 패스키 등록"
    : "패스키 만들기";
  setHidden($("[data-back]", section), state.recoveryMode);
}

async function deriveAuthenticatedStep(session) {
  if (session?.onboarding?.complete) {
    window.location.replace("/app");
    return;
  }
  if (session?.requiresPasskey && session?.onboarding?.recovery) {
    state.recoveryMode = true;
    configurePasskeyStep();
    showStep(2, { focus: false });
    return;
  }
  if (session?.recoveryCodesConfirmed !== true) {
    showStep(3, { focus: false });
    return;
  }
  const declared = Number(session?.onboarding?.step);
  if (Number.isInteger(declared) && declared >= 3 && declared <= 6) {
    showStep(declared, { focus: false });
    return;
  }
  state.tenantId = activeTenant(session);
  if (!state.tenantId) {
    showStep(3, { focus: false });
    return;
  }
  try {
    const vault = await api.vaultStatus();
    state.vaultInitialized = vault?.initialized === true;
    state.keyManaged = vault?.keyManaged === true;
    const localVault = await hasLocalVault(state.tenantId);
    if (!vault?.initialized || !localVault) showStep(4, { focus: false });
    else {
      state.deviceConnected = false;
      showStep(5, { focus: false });
    }
  } catch {
    showStep(4, { focus: false });
  }
}

async function initialize() {
  $("#setup-loading").hidden = false;
  try {
    const session = await api.session();
    if (session?.user?.language) applyAccountLanguage(session.user.language);
    state.session = session;
    state.tenantId = activeTenant(session);
    setCsrfToken(session?.csrfToken);
    configureExitControl();
    configureCodeStep(session);
    $("#setup-loading").hidden = true;
    if (session?.authenticated) await deriveAuthenticatedStep(session);
    else if (session?.signup?.allowed === false) {
      throw new Error(
        "현재 이 서버는 새 계정 가입을 받지 않습니다. 서버 소유자에게 초대를 요청하세요.",
      );
    } else showStep(state.codeFreeSignup ? 1 : 0, { focus: false });
  } catch (error) {
    $("#setup-loading").hidden = true;
    showNotice(globalError, error.message, "error");
  }
}

$("#code-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const code = new FormData(event.currentTarget).get("code")?.toString().trim();
  if (!code) return;
  state.code = code;
  $("#setup-code").value = "";
  showStep(1);
});

$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  const values = new FormData(form);
  setBusy(button, true, "확인 중…");
  try {
    state.registration = await api.registerOptions({
      username: values.get("username")?.toString().trim(),
      displayName: values.get("displayName")?.toString().trim(),
      code: state.code,
    });
    state.recoveryMode = false;
    configurePasskeyStep();
    showStep(2);
  } catch (error) {
    if (error?.code === "tenant_required" && state.ownerSignup) {
      showTenantSelectionFallback(error);
    } else {
      showNotice(globalError, error.message, "error");
    }
  } finally {
    setBusy(button, false);
  }
});

$("#create-passkey").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const notice = $("#passkey-notice");
  showNotice(notice);
  if (!webAuthnAvailable()) {
    showNotice(
      notice,
      "이 브라우저는 패스키를 지원하지 않습니다. 최신 브라우저에서 다시 시도하세요.",
      "error",
    );
    return;
  }
  if (!state.recoveryMode && !state.registration?.flowId) {
    showNotice(
      notice,
      "계정 생성 정보가 만료되었습니다. 이전 단계에서 다시 준비해 주세요.",
      "error",
    );
    return;
  }
  setBusy(button, true, "기기 확인 중…");
  try {
    if (state.recoveryMode) {
      const options = await api.passkeyAddOptions({ name: "복구 후 패스키" });
      const response = await createPasskey(options.options || options);
      const result = await api.passkeyAddVerify({
        flowId: options.flowId,
        response,
        name: "복구 후 패스키",
      });
      setCsrfToken(result?.csrfToken);
      const session = await api.session();
      setCsrfToken(session?.csrfToken);
      state.session = session;
      state.tenantId = activeTenant(session);
      state.recoveryMode = false;
      state.vaultInitialized = null;
      configurePasskeyStep();
      showStep(3);
    } else {
      const response = await createPasskey(
        state.registration.options || state.registration,
      );
      const result = await api.registerVerify({
        flowId: state.registration.flowId,
        response,
      });
      state.code = "";
      state.registration = null;
      state.session = { ...result, authenticated: true };
      state.tenantId = activeTenant(result);
      setCsrfToken(result?.csrfToken);
      configureExitControl();
      showStep(3);
    }
  } catch (error) {
    showNotice(notice, error.message, "error");
  } finally {
    setBusy(button, false);
  }
});

async function loadRecoveryCodes() {
  const loading = $("#recovery-loading");
  const content = $("#recovery-content");
  const notice = $("#recovery-notice");
  state.recoveryCodes = [];
  state.recoveryConfirmationId = null;
  $("#recovery-next").disabled = true;
  setHidden($("#recovery-retry"), true);
  setHidden(loading, false);
  setHidden(content, true);
  showNotice(notice);
  try {
    const result = await withRecentAuthentication(() => api.recoveryCreate());
    const codes = Array.isArray(result?.codes)
      ? result.codes
      : result?.recoveryCode
        ? [result.recoveryCode]
        : [];
    if (codes.length === 0)
      throw new Error("서버가 복구 코드를 반환하지 않았습니다.");
    const confirmationId = result?.confirmationId || null;
    if (!confirmationId) {
      throw new Error("서버가 복구 코드 확인 정보를 반환하지 않았습니다.");
    }
    state.recoveryCodes = codes.map(String);
    state.recoveryConfirmationId = confirmationId;
    $("#recovery-confirmed").checked = false;
    $("#recovery-next").disabled = true;
    $("#recovery-codes").textContent = state.recoveryCodes.join("\n");
    setHidden(content, false);
  } catch (error) {
    showNotice(notice, error.message, "error");
    setHidden($("#recovery-retry"), false);
  } finally {
    setHidden(loading, true);
  }
}

$("#recovery-retry").addEventListener("click", loadRecoveryCodes);

$("#download-recovery").addEventListener("click", () => {
  if (state.recoveryCodes.length === 0) return;
  downloadText("hnd-recovery-codes.txt", `${state.recoveryCodes.join("\n")}\n`);
});

$("#recovery-confirmed").addEventListener("change", (event) => {
  $("#recovery-next").disabled = !event.currentTarget.checked;
});
$("#recovery-next").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const notice = $("#recovery-notice");
  if (!state.recoveryConfirmationId) {
    showNotice(notice, "복구 코드를 다시 만든 뒤 저장해 주세요.", "error");
    return;
  }
  setBusy(button, true, "확인 중…");
  showNotice(notice);
  try {
    await withRecentAuthentication(() =>
      api.recoveryConfirm({ confirmationId: state.recoveryConfirmationId }),
    );
    showStep(4);
  } catch (error) {
    showNotice(notice, error.message, "error");
  } finally {
    setBusy(button, false);
  }
});

$("#initialize-vault").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const notice = $("#vault-notice");
  showNotice(notice);
  if (!state.tenantId) {
    showNotice(
      notice,
      "현재 계정의 작업 공간을 확인할 수 없습니다. 다시 로그인해 주세요.",
      "error",
    );
    return;
  }
  setBusy(button, true, "보관함 만드는 중…");
  try {
    await withRecentAuthentication(() =>
      initializeBrowserVault(state.tenantId),
    );
    state.vaultInitialized = true;
    state.keyManaged = true;
    await advanceAfterVault();
  } catch (error) {
    showNotice(notice, error.message, "error");
    await configureVaultStep({ force: true });
  } finally {
    setBusy(button, false);
  }
});

$("#setup-account-vault").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  showNotice($("#vault-notice"));
  setBusy(button, true, "보관함 여는 중…");
  try {
    if (state.vaultInitialized === null) {
      await configureVaultStep({ force: true });
      return;
    }
    if (state.keyManaged) {
      await withRecentAuthentication(() =>
        unlockManagedBrowserVault(state.tenantId),
      );
    } else if (await hasLocalVault(state.tenantId)) {
      await withRecentAuthentication(() =>
        adoptBrowserVaultKey(state.tenantId),
      );
      state.keyManaged = true;
    } else {
      throw new Error(
        "전환할 로컬 키가 없습니다. 앱에서 소유자 초기화를 선택하거나 키가 남은 브라우저를 사용하세요.",
      );
    }
    await advanceAfterVault();
  } catch (error) {
    showNotice($("#vault-notice"), error.message, "error");
  } finally {
    setBusy(button, false);
  }
});

function updateCommands() {
  const origin = window.location.origin;
  const shellQuote = (value) =>
    `'${String(value).replaceAll("'", `'"'"'`)}'`;
  const powerShellQuote = (value) =>
    `'${String(value).replaceAll("'", "''")}'`;
  const windows = state.installPlatform === "windows";
  for (const button of $$('[data-install-platform]')) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.installPlatform === state.installPlatform),
    );
  }
  for (const button of $$('[data-install-mode]')) {
    button.setAttribute(
      "aria-pressed",
      String(
        (button.dataset.installMode === "install") ===
          state.includeConnectorInstall,
      ),
    );
  }
  const platformName = windows
    ? "Windows PowerShell"
    : state.installPlatform === "macos"
      ? "macOS 터미널"
      : "Linux 터미널";
  $("#install-platform-help").textContent = state.includeConnectorInstall
    ? `${platformName}에서 hnd 설치부터 시작합니다.`
    : `${platformName}에서 기존 hnd를 그대로 사용합니다.`;
  const name = $("#first-device-name").value.trim() || "내 노트북";
  const connectionCode = state.deviceInvitation?.invitation || "";
  if (state.deviceInvitation) state.deviceInvitation.expectedName = name;
  const commandReady = Boolean(connectionCode);
  const copyButton = document.querySelector(
    '[data-copy-target="connect-command"]',
  );
  if (copyButton) copyButton.disabled = !commandReady;
  if (!commandReady) {
    $("#connect-command code").textContent =
      "# 연결 코드를 만들면 이곳에 한 번에 실행할 명령이 표시됩니다.";
    return;
  }
  if (windows) {
    $("#connect-command code").textContent = [
      ...(state.includeConnectorInstall
        ? [`npm install --global ${powerShellQuote(CONNECTOR_PACKAGE_SPEC)}`]
        : []),
      `${powerShellQuote(connectionCode)} | hnd connect --url ${powerShellQuote(origin)} --code-stdin --name ${powerShellQuote(name)}`,
      "hnd setup",
    ].join("\n");
  } else {
    $("#connect-command code").textContent = [
      ...(state.includeConnectorInstall
        ? [`${state.installPlatform === "linux" ? "sudo -H " : ""}npm install --global ${shellQuote(CONNECTOR_PACKAGE_SPEC)} &&`]
        : []),
      `printf '%s\\n' ${shellQuote(connectionCode)} | hnd connect --url ${shellQuote(origin)} --code-stdin --name ${shellQuote(name)} &&`,
      "hnd setup",
    ].join("\n");
  }
}

for (const button of $$('[data-install-platform]')) {
  button.addEventListener("click", () => {
    state.installPlatform = button.dataset.installPlatform;
    updateCommands();
  });
}
for (const button of $$('[data-install-mode]')) {
  button.addEventListener("click", () => {
    state.includeConnectorInstall = button.dataset.installMode === "install";
    updateCommands();
  });
}
$("#first-device-name").addEventListener("input", updateCommands);

function activeDeviceIds(payload) {
  return new Set(
    listFrom(payload, "devices")
      .filter((device) => !device.revokedAt && !device.revoked_at)
      .map((device) => device.id)
      .filter(Boolean),
  );
}

function clearSetupDeviceInvitation() {
  state.deviceInvitation = null;
  state.deviceIdsBeforeInvitation = new Set();
  $("#device-invitation").textContent = "";
  $("#device-invitation-expiry").textContent = "";
  setHidden($("#device-invitation-wrap"), true);
  updateCommands();
}

$("#create-device-invitation").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  updateCommands();
  showNotice($("#pc-notice"));
  stopConnectionPolling();
  clearSetupDeviceInvitation();
  setHidden($("#pc-waiting"), true);
  setBusy(button, true, "코드 만드는 중…");
  deviceReauthController?.abort();
  deviceReauthController = new AbortController();
  try {
    state.deviceIdsBeforeInvitation = activeDeviceIds(await api.devices());
    const connection = await withRecentAuthentication(
      () => createAccountConnection({ ttlSeconds: 900 }),
      {
        signal: deviceReauthController.signal,
        onPrompt: (active) => setHidden($("#cancel-device-auth"), !active),
      },
    );
    if (typeof connection?.connectionCode !== "string") {
      throw new Error("서버가 완전한 연결 코드를 반환하지 않았습니다.");
    }
    state.deviceInvitation = {
      invitation: connection.connectionCode,
      connectionId: connection.connectionId,
      expiresAt: connection.expiresAt,
      expectedName: $("#first-device-name").value.trim() || "내 노트북",
      issuedAt: Date.now(),
    };
    $("#device-invitation").textContent = connection.connectionCode;
    $("#device-invitation-expiry").textContent = connection.expiresAt
      ? `${new Date(connection.expiresAt).toLocaleTimeString(currentLocale())}까지 유효`
      : "15분 동안 유효";
    setHidden($("#device-invitation-wrap"), false);
    setHidden($("#pc-waiting"), false);
    updateCommands();
    startConnectionPolling();
  } catch (error) {
    showNotice($("#pc-notice"), error.message, "error");
  } finally {
    deviceReauthController = null;
    setHidden($("#cancel-device-auth"), true);
    setBusy(button, false);
  }
});

$("#cancel-device-auth").addEventListener("click", () => {
  deviceReauthController?.abort();
});

async function checkConnection({ quiet = false } = {}) {
  if (!state.deviceInvitation?.invitation) {
    if (!quiet)
      showNotice(
        $("#pc-notice"),
        "먼저 일회용 연결 코드를 만들어 주세요.",
        "warning",
      );
    return false;
  }
  try {
    const expiresAt = Date.parse(state.deviceInvitation.expiresAt || "");
    const devices = listFrom(await api.devices(), "devices").filter(
      (device) => !device.revokedAt && !device.revoked_at,
    );
    const connected = devices.find((device) => {
      if (!device.id || state.deviceIdsBeforeInvitation.has(device.id))
        return false;
      if (device.name !== state.deviceInvitation.expectedName) return false;
      const createdAt = Date.parse(device.createdAt || device.created_at || "");
      return (
        !Number.isFinite(createdAt) ||
        createdAt >= state.deviceInvitation.issuedAt - 5_000
      );
    });
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now() && !connected) {
      stopConnectionPolling();
      clearSetupDeviceInvitation();
      setHidden($("#pc-waiting"), true);
      showNotice(
        $("#pc-notice"),
        "연결 코드가 만료되었습니다. 새 코드를 만들어 다시 연결해 주세요.",
        "warning",
      );
      return false;
    }
    if (!connected) return false;
    stopConnectionPolling();
    setHidden($("#pc-waiting"), true);
    state.deviceConnected = true;
    $("#pc-next").disabled = false;
    clearSetupDeviceInvitation();
    showNotice(
      $("#pc-notice"),
      `${connected.name || "PC"} 연결을 확인했습니다.`,
      "success",
    );
    return true;
  } catch (error) {
    if (!quiet) showNotice($("#pc-notice"), error.message, "error");
    return false;
  }
}

function startConnectionPolling() {
  stopConnectionPolling();
  state.pollTimer = window.setInterval(
    () => checkConnection({ quiet: true }),
    2500,
  );
}

function stopConnectionPolling() {
  if (state.pollTimer) window.clearInterval(state.pollTimer);
  state.pollTimer = null;
}

$("#check-device").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "확인 중…");
  await checkConnection();
  setBusy(button, false);
});
$("#pc-next").addEventListener("click", () => {
  state.deviceConnected = true;
  showStep(6);
});
$("#skip-device").addEventListener("click", () => {
  stopConnectionPolling();
  clearSetupDeviceInvitation();
  state.deviceConnected = false;
  showStep(6);
});

for (const back of $$("[data-back]")) {
  back.addEventListener("click", () => showStep(state.step - 1));
}

$("#setup-exit").addEventListener("click", async (event) => {
  event.preventDefault();
  const control = event.currentTarget;
  if (!state.session?.authenticated) {
    window.location.assign("/");
    return;
  }
  control.setAttribute("aria-disabled", "true");
  control.textContent = "로그아웃 중…";
  showNotice(globalError);
  try {
    await api.logout();
    window.location.replace("/");
  } catch (error) {
    showNotice(globalError, error.message, "error");
    control.removeAttribute("aria-disabled");
    configureExitControl();
  }
});

window.addEventListener("beforeunload", stopConnectionPolling);
installCopyButtons();
initialize();
