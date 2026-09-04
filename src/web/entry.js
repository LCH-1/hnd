import { api, setCsrfToken } from "./api.js";
import { applyAccountLanguage, startI18n, t } from "./i18n.js";
import { getPasskey, webAuthnAvailable } from "./webauthn.js";
import { $, setBusy, setHidden, showNotice } from "./ui.js";

startI18n();

const elements = {
  loading: $("#auth-loading"),
  login: $("#login-panel"),
  setup: $("#owner-setup-panel"),
  error: $("#entry-error"),
  retry: $("#entry-retry"),
  loginButton: $("#passkey-login"),
  signupAction: $("#signup-action"),
  signupLink: $("#signup-link"),
  signupCopy: $("#signup-copy"),
  serverStatus: $("#server-status"),
  serverDot: $("#server-chip .status-dot"),
};

function setServerState(ok) {
  elements.serverStatus.textContent = t(ok ? "서버 정상" : "서버 확인 필요");
  elements.serverDot.className = `status-dot ${ok ? "status-ok" : "status-error"}`;
}

async function checkHealth() {
  try {
    const response = await fetch("/healthz", {
      cache: "no-store",
      credentials: "same-origin",
    });
    setServerState(response.ok);
  } catch {
    setServerState(false);
  }
}

function isOwnerSetup(session) {
  return Boolean(
    session?.needsOwnerSetup ||
      session?.server?.needsOwnerSetup ||
      session?.signup?.mode === "bootstrap" ||
      session?.signup?.firstUser === true,
  );
}

function authenticatedDestination(session) {
  if (session?.requiresPasskey) return "/setup?recovery=1";
  if (session?.recoveryCodesConfirmed === false) return "/setup";
  return "/app";
}

function renderSignup(signup = {}) {
  const visible = signup.allowed === true || signup.requiresCode === true;
  setHidden(elements.signupAction, !visible);
  if (!visible) return;
  const open = signup.mode === "open" && signup.requiresCode !== true;
  elements.signupCopy.textContent = open
    ? t("계정이 없으신가요?")
    : t("초대 코드를 받으셨나요?");
  elements.signupLink.textContent = open ? t("새 계정 만들기") : t("초대받아 가입");
}

async function loadEntry() {
  setHidden(elements.loading, false);
  setHidden(elements.login, true);
  setHidden(elements.setup, true);
  setHidden(elements.retry, true);
  showNotice(elements.error);
  try {
    const session = await api.session();
    if (session?.user?.language) applyAccountLanguage(session.user.language);
    setCsrfToken(session?.csrfToken);
    if (session?.authenticated) {
      window.location.replace(authenticatedDestination(session));
      return;
    }
    setHidden(elements.loading, true);
    if (isOwnerSetup(session)) {
      setHidden(elements.setup, false);
      return;
    }
    setHidden(elements.login, false);
    renderSignup(session?.signup);
    if (!webAuthnAvailable()) {
      elements.loginButton.disabled = true;
      showNotice(
        elements.error,
        "이 브라우저는 패스키를 지원하지 않습니다. 최신 브라우저나 다른 기기를 사용해 주세요.",
        "warning",
      );
    }
  } catch (error) {
    setHidden(elements.loading, true);
    showNotice(elements.error, error.message, "error");
    setHidden(elements.retry, false);
  }
}

async function login() {
  setBusy(elements.loginButton, true, "패스키 확인 중…");
  showNotice(elements.error);
  try {
    const challenge = await api.loginOptions();
    const response = await getPasskey(challenge.options || challenge);
    const result = await api.loginVerify({
      flowId: challenge.flowId,
      response,
    });
    setCsrfToken(result?.csrfToken);
    window.location.assign(authenticatedDestination(result));
  } catch (error) {
    showNotice(elements.error, error.message, "error");
    setBusy(elements.loginButton, false);
  }
}

async function recover(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const code = new FormData(form).get("code")?.toString().trim();
  if (!code) return;
  setBusy(button, true, "확인 중…");
  showNotice(elements.error);
  try {
    const result = await api.recoveryUse({ code });
    setCsrfToken(result?.csrfToken);
    form.reset();
    window.location.assign(authenticatedDestination(result));
  } catch (error) {
    showNotice(elements.error, error.message, "error");
    setBusy(button, false);
  }
}

$("#server-origin-card").textContent = window.location.host;
elements.retry.addEventListener("click", loadEntry);
elements.loginButton.addEventListener("click", login);
$("#recovery-login-form").addEventListener("submit", recover);
checkHealth();
loadEntry();
