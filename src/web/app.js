import { api, setCsrfToken } from "./api.js";
import {
  applyAccountLanguage,
  languagePreference,
  setLanguagePreference,
  startI18n,
  t,
} from "./i18n.js";
import { CONNECTOR_PACKAGE_SPEC } from "./connector-release.js";
import {
  beginBrowserWorkspaceReset,
  disableOfflineWorkspace,
  enableOfflineWorkspace,
  finalizeBrowserWorkspaceReset,
  listOfflineWorkspaceIds,
  logoutAfterRevokingOfflineAccess,
  offlineWorkspaceEnabled,
  prepareOfflineWorkspaceAccess,
  resetBrowserWorkspaceCache,
  SnapshotDataStore,
} from "./snapshot-data.js";
import { createPasskey, getPasskey } from "./webauthn.js";
import {
  adoptBrowserVaultKey,
  createAccountConnection,
  hasLocalVault,
  listLocalVaultIds,
  resetBrowserVault,
  unlockManagedBrowserVault,
} from "./vault.js";
import {
  $,
  $$,
  clearChildren,
  copyText,
  displayName,
  downloadText,
  element,
  formatBytes,
  formatDate,
  installCopyButtons,
  listFrom,
  relativeTime,
  setBusy,
  setHidden,
  showNotice,
  toast,
} from "./ui.js";

startI18n();

const viewMeta = Object.freeze({
  home: ["내 작업 공간", "홈"],
  projects: ["저장소 작업 공간", "프로젝트"],
  rules: ["에이전트 지시", "룰"],
  work: ["세션 인계", "작업"],
  knowledge: ["장기 기억", "지식"],
  devices: ["연결 관리", "기기"],
  revisions: ["암호화 보관본", "저장 기록"],
  security: ["계정 보호", "보안"],
  settings: ["작업 공간 관리", "설정"],
});

const vaultContentViews = new Set([
  "home",
  "projects",
  "rules",
  "work",
  "knowledge",
]);

const state = {
  session: null,
  tenantId: null,
  view: "home",
  loaded: new Set(),
  rules: new Map(),
  work: new Map(),
  knowledge: new Map(),
  projects: new Map(),
  selectedProjectId: null,
  returnAfterDialog: null,
  workStatus: "active",
  vaultLocked: false,
  keyManaged: false,
  legacyResetAllowed: false,
  vaultProblem: null,
  dataStore: null,
  serverOwner: false,
  offlineBoot: false,
  offlineAccessEpoch: null,
  pendingRecoveryCodes: [],
  pendingRecoveryConfirmationId: null,
  deviceInstallPlatform: "linux",
  includeDeviceConnectorInstall: true,
  deviceConnectionCode: null,
  deviceConnection: null,
  deviceIdsBeforeConnection: new Set(),
  deviceConnectionPollTimer: null,
};

let deviceReauthController = null;

const vaultResetChannel =
  typeof globalThis.BroadcastChannel === "function"
    ? new globalThis.BroadcastChannel("hnd:vault-reset")
    : null;

vaultResetChannel?.addEventListener("message", (event) => {
  if (
    event.data?.type === "hnd-vault-reset" &&
    event.data.tenantId === state.tenantId
  ) {
    window.location.reload();
  }
});

function tenantId(session) {
  return (
    session?.activeTenantId ||
    session?.tenant?.id ||
    session?.tenantId ||
    session?.tenants?.[0]?.id ||
    null
  );
}

function webSessionId(session = state.session) {
  const id = session?.session?.id;
  return typeof id === "string" && id ? id : null;
}

async function localTenantIds(currentTenantId = state.tenantId) {
  const [vaultIds, grantIds] = await Promise.all([
    listLocalVaultIds(),
    listOfflineWorkspaceIds(),
  ]);
  const ids = [...vaultIds, ...grantIds];
  if (currentTenantId) ids.push(currentTenantId);
  return [...new Set(ids)];
}

async function enableCurrentOfflineWorkspace() {
  const sessionId = webSessionId();
  if (
    !state.tenantId ||
    !sessionId ||
    !Number.isSafeInteger(state.offlineAccessEpoch)
  ) {
    return false;
  }
  await enableOfflineWorkspace(state.tenantId, {
    expectedAccessEpoch: state.offlineAccessEpoch,
    sessionId,
  });
  return true;
}

function userIsOwner() {
  const user = state.session?.user;
  return (
    user?.role === "owner" || user?.isOwner === true || user?.owner === true
  );
}

function userRole() {
  return state.session?.user?.role || "member";
}

function userCanManageAccounts() {
  return ["owner", "admin"].includes(userRole());
}

async function reauthenticate({ signal } = {}) {
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
    toast("보호된 작업입니다. 패스키를 한 번 더 확인해 주세요.");
    onPrompt?.(true);
    try {
      await reauthenticate({ signal });
      return operation();
    } finally {
      onPrompt?.(false);
    }
  }
}

function stringValue(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

function truncate(value, maximum = 180) {
  const text = stringValue(value).trim();
  return text.length > maximum ? `${text.slice(0, maximum).trimEnd()}…` : text;
}

function createdAt(item) {
  return (
    item?.updatedAt ||
    item?.updated_at ||
    item?.createdAt ||
    item?.created_at ||
    item?.at ||
    null
  );
}

function emptyState(container, title, copy) {
  clearChildren(container);
  const wrapper = element("div", { className: "empty-state" });
  wrapper.append(
    element("strong", { text: title }),
    element("p", { text: copy }),
  );
  container.append(wrapper);
}

function loadingState(container, label = "불러오는 중") {
  clearChildren(container);
  const wrapper = element("div", {
    className: "empty-state",
    attrs: { "aria-busy": "true" },
  });
  wrapper.append(
    element("span", {
      className: "spinner spinner-small",
      attrs: { "aria-hidden": "true" },
    }),
    element("p", { text: label }),
  );
  container.append(wrapper);
}

function closeSidebar() {
  $("#app-sidebar").classList.remove("is-open");
  $("#sidebar-scrim").classList.remove("is-open");
  $("#sidebar-open").setAttribute("aria-expanded", "false");
}

function openSidebar() {
  $("#app-sidebar").classList.add("is-open");
  $("#sidebar-scrim").classList.add("is-open");
  $("#sidebar-open").setAttribute("aria-expanded", "true");
}

function currentView() {
  const hashView = window.location.hash.slice(1).split("/", 1)[0];
  if (Object.hasOwn(viewMeta, hashView)) return hashView;
  const pathView = window.location.pathname
    .replace(/^\/app\/?/, "")
    .split("/", 1)[0];
  return Object.hasOwn(viewMeta, pathView) ? pathView : "home";
}

function currentProjectId() {
  const [view, id] = window.location.hash.slice(1).split("/");
  if (view !== "projects" || !id) return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return null;
  }
}

async function setView(view, { force = false } = {}) {
  const selected = Object.hasOwn(viewMeta, view) ? view : "home";
  const enteringProjects = selected === "projects" && state.view !== "projects";
  const requestedProjectId = selected === "projects" ? currentProjectId() : null;
  if (enteringProjects) force = true;
  if (selected === "projects" && requestedProjectId !== state.selectedProjectId) {
    state.selectedProjectId = requestedProjectId;
    force = true;
  }
  state.view = selected;
  const [kicker, title] = viewMeta[selected];
  $("#page-kicker").textContent = kicker;
  $("#page-title").textContent = title;
  for (const link of $$("[data-view-link]")) {
    if (link.dataset.viewLink === selected)
      link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const gated = state.vaultLocked && vaultContentViews.has(selected);
  setHidden($("#vault-gate"), !gated);
  setHidden($("#view-container"), gated);
  updateVaultLockControls();
  closeSidebar();
  if (gated) return;
  for (const panel of $$(".app-view"))
    setHidden(panel, panel.dataset.view !== selected);
  if (force) state.loaded.delete(selected);
  if (
    force &&
    state.dataStore &&
    ["home", "projects", "rules", "work", "knowledge"].includes(selected)
  ) {
    await state.dataStore.load({ force: true });
  }
  if (!state.loaded.has(selected)) await loadView(selected);
}

async function loadView(view) {
  const loaders = {
    home: loadOverview,
    projects: loadProjects,
    rules: loadRules,
    work: loadWork,
    knowledge: loadKnowledge,
    devices: loadDevices,
    revisions: loadRevisions,
    security: loadSecurity,
    settings: loadSettings,
  };
  try {
    await loaders[view]?.();
    state.loaded.add(view);
  } catch (error) {
    showNotice($(`#${view}-error`), error.message, "error");
    if (view === "devices") setHidden($("#devices-retry"), false);
  }
}

function updateSyncChip(overview = {}) {
  const chip = $("#sync-chip");
  const dot = $(".status-dot", chip);
  const text = $("span:last-child", chip);
  const local = state.dataStore?.syncStatus() || {};
  const attention =
    local.conflict ||
    overview.attention ||
    overview.needsAttention ||
    overview.sync?.attention;
  const pending = local.pending || overview.pending || overview.sync?.pending;
  if (attention) {
    dot.className = "status-dot status-error";
    text.textContent = "확인 필요";
    chip.title = "동기화 상태를 확인해 주세요. 눌러서 해결 방법 보기";
    chip.setAttribute("aria-label", "확인 필요. 홈에서 해결 방법 보기");
  } else if (pending) {
    dot.className = "status-dot status-warning";
    text.textContent = "전송 대기";
    chip.title = "서버로 보낼 변경이 있습니다. 눌러서 동기화 상태 보기";
    chip.setAttribute("aria-label", chip.title);
  } else if (local.offline) {
    dot.className = "status-dot status-warning";
    text.textContent = "로컬 사본";
    chip.title = "서버 연결을 기다리고 있습니다. 눌러서 동기화 상태 보기";
    chip.setAttribute("aria-label", chip.title);
  } else {
    dot.className = "status-dot status-ok";
    text.textContent = "서버 연결됨";
    chip.title = "서버 연결됨. 눌러서 동기화 상태 보기";
    chip.setAttribute("aria-label", chip.title);
  }
  updateSyncActions(local);
}

function updateSyncActions(sync = {}) {
  const panel = $("#sync-actions");
  if (!panel) return;
  const needsAction = sync.conflict || sync.pending || sync.offline;
  const keyMismatch = sync.error?.code === "vault_key_mismatch";
  const hasResolvableConflict = Boolean(
    sync.conflict &&
      sync.pending &&
      sync.error?.code === "remote_snapshot_conflict",
  );
  setHidden(panel, false);
  panel.dataset.state = sync.conflict
    ? "attention"
    : sync.offline
      ? "offline"
      : sync.pending
        ? "pending"
        : "ok";
  setHidden($("#sync-retry"), !needsAction || keyMismatch || hasResolvableConflict);
  setHidden($("#sync-reconnect-vault"), !keyMismatch);
  setHidden($("#sync-use-server"), !hasResolvableConflict);
  setHidden($("#sync-keep-local"), !hasResolvableConflict);
  if (keyMismatch) {
    $("#sync-actions-title").textContent = "브라우저 보관함 키가 오래되었습니다";
    $("#sync-actions-copy").textContent = state.dataStore?.hasLocalContent()
      ? "서버 프로젝트를 열려면 계정 보관함을 다시 연결해야 합니다. 전송하지 못한 이 브라우저 변경은 확인 후 교체합니다."
      : "계정 보관함 키를 다시 받아 서버의 프로젝트를 자동으로 불러옵니다.";
  } else if (!needsAction) {
    $("#sync-actions-title").textContent = "변경 사항이 모두 저장되었습니다";
    $("#sync-actions-copy").textContent =
      "연결이 끊겨도 로컬 사본으로 계속 작업하고 복구 뒤 자동 전송합니다.";
  } else if (hasResolvableConflict) {
    $("#sync-actions-title").textContent = "같은 항목의 변경을 확인해 주세요";
    $("#sync-actions-copy").textContent =
      "서로 다른 변경은 자동으로 합쳤습니다. 같은 항목에서 사용할 내용만 선택하세요.";
  } else if (sync.offline) {
    $("#sync-actions-title").textContent = "서버 연결을 기다리는 중입니다";
    $("#sync-actions-copy").textContent =
      "로컬 변경은 안전하게 남아 있으며 연결되면 자동으로 전송합니다.";
  } else {
    $("#sync-actions-title").textContent = "전송할 변경이 있습니다";
    $("#sync-actions-copy").textContent =
      "자동 전송 중입니다. 필요하면 지금 다시 시도할 수 있습니다.";
  }
}

function canReplaceStaleManagedCache(dataStore, { offline, keyManaged }) {
  return Boolean(
    !offline &&
      keyManaged &&
      dataStore?.syncStatus().error?.code === "vault_key_mismatch" &&
      !dataStore.hasLocalContent(),
  );
}

async function recoverStaleManagedCache(dataStore, resolved) {
  if (
    !canReplaceStaleManagedCache(dataStore, {
      offline: resolved.offline,
      keyManaged: state.keyManaged,
    })
  ) {
    return dataStore;
  }

  // The old local snapshot is provably empty. Remove only browser-local
  // workspace records, retrieve the account-managed key, then rebuild the
  // cache from the authoritative encrypted server snapshot.
  await resetBrowserWorkspaceCache(state.tenantId);
  await withRecentAuthentication(() =>
    unlockManagedBrowserVault(state.tenantId),
  );
  const recovered = new SnapshotDataStore(state.tenantId);
  await recovered.load();
  await enableCurrentOfflineWorkspace().catch(() => {});
  return recovered;
}

async function reconnectManagedVault(event) {
  const button = event.currentTarget;
  const hasLocalContent = state.dataStore?.hasLocalContent() === true;
  if (hasLocalContent) {
    const confirmed = await confirmAction(
      "서버 프로젝트로 다시 연결할까요?",
      "아직 서버로 보내지 못한 이 브라우저의 로컬 변경은 삭제되고 현재 서버본으로 교체됩니다.",
      "서버본으로 다시 연결",
      "danger",
    );
    if (!confirmed) return;
  }

  setBusy(button, true, "연결 중…");
  try {
    if (hasLocalContent) {
      await withRecentAuthentication(() =>
        unlockManagedBrowserVault(state.tenantId),
      );
      await resetBrowserWorkspaceCache(state.tenantId);
    } else {
      await resetBrowserWorkspaceCache(state.tenantId);
      await withRecentAuthentication(() =>
        unlockManagedBrowserVault(state.tenantId),
      );
    }
    const recovered = new SnapshotDataStore(state.tenantId);
    await recovered.load();
    await enableCurrentOfflineWorkspace().catch(() => {});
    state.dataStore = recovered;
    state.vaultLocked = false;
    state.vaultProblem = null;
    state.loaded.clear();
    updateSyncChip();
    await setView("home", { force: true });
    toast("계정 보관함을 다시 연결했습니다.");
  } catch (error) {
    updateSyncChip();
    showNotice($("#home-error"), error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function loadOverview() {
  const errorElement = $("#home-error");
  showNotice(errorElement);
  for (const id of [
    "metric-last-save",
    "metric-devices",
    "metric-revisions",
    "metric-storage",
  ])
    $(id.startsWith("#") ? id : `#${id}`).textContent = "확인 중";
  let overview = {};
  let metadataError = null;
  try {
    try {
      overview = await api.overview();
    } catch (error) {
      metadataError = error;
      const [devices, revisions] = await Promise.all([
        api.devices().catch(() => ({ devices: [] })),
        api.revisions().catch(() => ({ revisions: [] })),
      ]);
      overview = {
        devices: listFrom(devices, "devices"),
        revisions: listFrom(revisions, "revisions"),
      };
    }
    const [recentActivity, recentKnowledge, diagnostics] = await Promise.all([
      state.dataStore.activity(4),
      state.dataStore.recentKnowledge(4),
      state.dataStore.diagnostics(),
    ]);
    const devices = Array.isArray(overview.devices) ? overview.devices : [];
    const revisions = Array.isArray(overview.revisions)
      ? overview.revisions
      : [];
    const activeDevices = Number.isFinite(overview.deviceCount)
      ? overview.deviceCount
      : devices.filter((item) => !(item.revokedAt || item.revoked_at)).length;
    const revisionCount = Number.isFinite(overview.revisionCount)
      ? overview.revisionCount
      : revisions.length;
    const currentRevision =
      overview.currentRevision ||
      revisions.find((item) => item.current) ||
      revisions[0];
    const lastSave =
      overview.lastSavedAt ||
      overview.lastSyncAt ||
      currentRevision?.createdAt ||
      currentRevision?.created_at;
    const bytes =
      overview.storageBytes ??
      overview.snapshotBytes ??
      currentRevision?.bytes ??
      state.dataStore.snapshotBytes();
    $("#metric-last-save").textContent = relativeTime(lastSave);
    $("#metric-devices").textContent = `${activeDevices}대`;
    $("#metric-revisions").textContent = `${revisionCount}개`;
    $("#metric-storage").textContent = formatBytes(bytes);
    renderCompactList(
      $("#home-work-list"),
      recentActivity,
      "아직 변경 기록이 없습니다.",
      "activity",
    );
    renderCompactList(
      $("#home-knowledge-list"),
      recentKnowledge,
      "저장한 지식이 없습니다.",
      "knowledge",
    );
    renderDiagnostics(diagnostics);
    updateSyncChip(overview);
    const sync = state.dataStore.syncStatus();
    if (sync.conflict) {
      showNotice(errorElement, sync.error?.message, "warning");
    } else if (metadataError || sync.offline) {
      showNotice(
        errorElement,
        "서버 운영 정보는 불러오지 못했지만 마지막 암호화 로컬 사본으로 열었습니다.",
        "warning",
      );
    }
  } catch (error) {
    showNotice(errorElement, error.message, "error");
    throw error;
  }
}

const WORK_STATUS_TONES = {
  todo: "",
  in_progress: "progress",
  blocked: "attention",
  done: "active",
};

const KNOWLEDGE_TYPE_LABELS = {
  note: "메모",
  decision: "결정",
  solution: "해결법",
  failure: "실패",
  caution: "주의사항",
  command: "명령",
  architecture: "설계",
  runbook: "런북",
};

const ACTIVITY_ACTION_LABELS = {
  created: "추가",
  updated: "수정",
  closed: "완료",
  approved: "승인",
  rejected: "거절",
};

const ACTIVITY_ACTION_TONES = {
  created: "progress",
  updated: "progress",
  closed: "active",
  approved: "active",
  rejected: "attention",
};

function renderCompactList(container, values, emptyCopy, type) {
  clearChildren(container);
  // 로딩 자리표시자는 내용을 가운데로 모은다. 실제 행을 그릴 때는 그 클래스를
  // 떼어내야 행이 위에서부터 좌우로 펼쳐진다.
  container.className = "compact-list";
  const items = Array.isArray(values) ? values.slice(0, 4) : [];
  if (items.length === 0) {
    const item = element("div", { className: "empty-state" });
    item.append(element("p", { text: emptyCopy }));
    container.append(item);
    return;
  }
  for (const value of items) {
    const item = element("div", {
      className: `compact-item${["work", "activity"].includes(type) ? " activity-item" : ""}`,
    });
    if (["work", "activity"].includes(type)) {
      const timestamp = createdAt(value);
      const copy = element("div", { className: "activity-copy" });
      copy.append(
        element("strong", {
          text: value.title || value.name || value.goal || "이름 없는 기록",
        }),
      );
      if (type !== "activity") {
        copy.append(
          element("span", {
            text: truncate(value.next || value.current || value.goal, 90),
          }),
        );
      }
      const tone = type === "activity"
        ? ACTIVITY_ACTION_TONES[value.action] || "progress"
        : "progress";
      item.append(
        element("time", {
          className: "activity-time",
          text: relativeTime(timestamp),
          attrs: timestamp ? { datetime: timestamp } : {},
        }),
        copy,
      );
      if (type === "activity") {
        item.append(
          element("span", {
            className: "tag activity-kind",
            text: t({ work: "작업", knowledge: "지식", rule: "룰" }[value.kind] || "기록"),
          }),
        );
      }
      item.append(
        element("span", {
          className: `status-badge ${tone} activity-status`,
          text: type === "activity"
            ? t(ACTIVITY_ACTION_LABELS[value.action] || value.action)
            : t("진행 중"),
        }),
      );
    } else {
      const copy = element("div", { className: "knowledge-item-copy" });
      copy.append(
        element("strong", { text: value.title || "제목 없는 지식" }),
        element("span", { text: truncate(value.content, 90) }),
      );
      item.append(
        element("span", {
          className: "knowledge-item-ic",
          attrs: { "aria-hidden": "true" },
          text: t(KNOWLEDGE_TYPE_LABELS[value.type] || "메모").slice(0, 2),
        }),
        copy,
      );
    }
    container.append(item);
  }
}

function renderDiagnostics(value) {
  const container = $("#home-diagnostics");
  clearChildren(container);
  const items = [
    ["차단 작업", value.blockedWork, "#work"],
    ["지식 검토", value.knowledgeAttention ?? value.pendingKnowledge + value.reviewKnowledge, "#knowledge"],
    ["초안 룰", value.draftRules, "#rules"],
    ["큰 룰", value.largeRules, "#rules"],
  ];
  const attention = items.filter(([, count]) => count > 0);
  if (attention.length === 0) {
    container.append(element("span", { className: "status-ok", text: t("확인할 항목 없음") }));
    return;
  }
  for (const [label, count, href] of attention) {
    const link = element("a", { text: `${t(label)} ${count}` });
    link.href = href;
    container.append(link);
  }
}

function projectRemote(repository) {
  const aliases = Array.isArray(repository?.remoteAliases)
    ? repository.remoteAliases
    : [];
  const remote = String(aliases[0] || "").replace(/^github\.com\//iu, "");
  return remote || "Git 원격 없음";
}

function repositoryOptionLabel(repository) {
  const name = repository?.name || repository?.id || "이름 없는 저장소";
  return `${name} · ${projectRemote(repository)}`;
}

function renderProjectEmpty(container) {
  clearChildren(container);
  const empty = element("section", { className: "project-empty" });
  const copy = element("div", { className: "project-empty-copy" });
  copy.append(
    element("h3", { text: "Git 저장소에서 첫 세션을 시작하세요" }),
    element("p", {
      text: "PC 연결과 hnd setup을 마친 상태를 기준으로 안내합니다. 프로젝트를 웹에서 미리 만들 필요가 없습니다.",
    }),
  );
  const steps = element("ol", { className: "setup-ledger setup-ledger-compact" });
  for (const [number, title, description] of [
    ["1", "Git 저장소 열기", "연결된 PC에서 실제로 작업할 Git 저장소 폴더를 엽니다."],
    ["2", "AI 세션 시작", "Claude Code, Codex 또는 Cursor를 평소처럼 시작합니다."],
    ["3", "첫 동기화 확인", "첫 입력과 응답이 끝나면 프로젝트와 룰·작업이 이곳에 표시됩니다."],
  ]) {
    const row = element("li");
    const body = element("div");
    body.append(
      element("strong", { text: title }),
      element("p", { text: description }),
    );
    row.append(element("span", { text: number }), body);
    steps.append(row);
  }
  empty.append(copy, steps);
  container.append(empty);
}

function projectDataEmpty(container, message) {
  clearChildren(container);
  container.append(element("p", { className: "project-data-empty", text: message }));
}

function renderProjectRules(project) {
  const container = $("#project-rules-list");
  clearChildren(container);
  state.rules = new Map(project.rules.map((item) => [String(item.id), item]));
  if (project.rules.length === 0) {
    projectDataEmpty(container, "이 프로젝트에 저장된 룰이 없습니다.");
    return;
  }
  for (const rule of project.rules.slice(0, 6)) {
    const row = element("div", { className: "project-data-row" });
    const body = element("div");
    body.append(
      element("strong", {
        text: rule.title || (rule.scope === "env"
          ? `${rule.environment} ${t("환경")}`
          : t("프로젝트 전체")),
      }),
      element("p", { text: truncate(rule.content, 150) }),
    );
    row.append(
      element("span", {
        className: "scope-badge",
        text: ruleScopeLabel(rule.scope),
      }),
      body,
      element("button", {
        className: "text-button",
        text: "수정",
        attrs: {
          type: "button",
          "data-action": "edit-rule",
          "data-id": rule.id,
        },
      }),
    );
    container.append(row);
  }
}

function renderProjectWork(project) {
  const container = $("#project-work-list");
  clearChildren(container);
  state.work = new Map(project.work.map((item) => [String(item.id), item]));
  if (project.activeWork.length === 0) {
    projectDataEmpty(container, "현재 진행 중인 작업이 없습니다.");
    return;
  }
  for (const work of project.activeWork.slice(0, 6)) {
    const row = element("div", { className: "project-data-row" });
    const body = element("div");
    body.append(
      element("strong", { text: work.name || "이름 없는 작업" }),
      element("p", { text: truncate(work.current || work.goal, 150) }),
    );
    row.append(
      element("span", { className: "status-badge active", text: "진행 중" }),
      body,
      element("button", {
        className: "text-button",
        text: "열기",
        attrs: {
          type: "button",
          "data-action": "edit-work",
          "data-id": work.id,
        },
      }),
    );
    container.append(row);
  }
}

function renderProjectKnowledge(project) {
  const container = $("#project-knowledge-list");
  clearChildren(container);
  state.knowledge = new Map(
    project.knowledge.map((item) => [String(item.id), item]),
  );
  if (project.knowledge.length === 0) {
    projectDataEmpty(container, "이 프로젝트에 저장한 지식이 없습니다.");
    return;
  }
  for (const note of project.knowledge.slice(0, 6)) {
    const row = element("div", { className: "project-data-row" });
    const body = element("div");
    body.append(
      element("strong", { text: note.title || "제목 없는 지식" }),
      element("p", { text: truncate(note.content || note.body, 150) }),
    );
    row.append(
      element("span", {
        className: "scope-badge",
        text: note.scope === "env" ? note.environment : "프로젝트",
      }),
      body,
      element("button", {
        className: "text-button",
        text: "수정",
        attrs: {
          type: "button",
          "data-action": "edit-knowledge",
          "data-id": note.id,
        },
      }),
    );
    container.append(row);
  }
}

function renderProjectBriefing(project) {
  const container = $("#project-briefing-items");
  clearChildren(container);
  const next = project.briefing?.nextWork;
  const pinned = project.briefing?.pinnedKnowledge || [];
  if (next) {
    const item = element("div", { className: "briefing-item" });
    item.append(
      element("span", { text: t("다음 작업") }),
      element("strong", { text: next.name || "이름 없는 작업" }),
      element("p", { text: truncate(next.current || next.goal, 140) }),
    );
    container.append(item);
  }
  for (const knowledge of pinned.slice(0, 2)) {
    const item = element("div", { className: "briefing-item" });
    item.append(
      element("span", { text: t("고정 지식") }),
      element("strong", { text: knowledge.title }),
      element("p", { text: truncate(knowledge.content, 140) }),
    );
    container.append(item);
  }
  if (!next && pinned.length === 0) {
    container.append(element("p", {
      className: "project-data-empty",
      text: t("진행 작업이나 고정 지식이 생기면 이곳에 요약됩니다."),
    }));
  }
  const attention = project.briefing?.attentionCount || 0;
  $("#project-briefing-copy").textContent = attention > 0
    ? `${t("바로 확인할 항목")} ${attention}`
    : t("현재 차단되거나 검토가 필요한 항목이 없습니다.");
}

async function renderProjectDetail(id) {
  setHidden($("#projects-index"), true);
  setHidden($("#project-detail"), false);
  showNotice($("#project-detail-error"));
  const project = await state.dataStore.project(id);
  const repository = project.repository;
  state.projects.set(repository.id, repository);
  $("#project-detail-name").textContent = repository.name || repository.id;
  $("#project-detail-description").textContent =
    repository.description || "프로젝트 설명이 없습니다.";
  $("#project-detail-remote").textContent = projectRemote(repository);
  $("#project-detail-updated").textContent = relativeTime(repository.updatedAt);
  $("#project-detail-id").textContent = repository.id;
  $("#project-rule-count").textContent = String(project.rules.length);
  $("#project-env-count").textContent = String(project.environments.length);
  $("#project-work-count").textContent = String(project.activeWork.length);
  $("#project-knowledge-count").textContent = String(project.knowledge.length);
  renderProjectRules(project);
  renderProjectWork(project);
  renderProjectKnowledge(project);
  renderProjectBriefing(project);
}

async function loadProjects(values = {}) {
  showNotice($("#projects-error"));
  if (state.selectedProjectId) {
    try {
      await renderProjectDetail(state.selectedProjectId);
      updateSyncChip();
    } catch (error) {
      setHidden($("#projects-index"), false);
      setHidden($("#project-detail"), true);
      showNotice($("#projects-error"), error.message, "error");
    }
    return;
  }
  setHidden($("#projects-index"), false);
  setHidden($("#project-detail"), true);
  const container = $("#projects-list");
  loadingState(container, "프로젝트를 불러오는 중");
  const repositories = await state.dataStore.projects(values);
  updateSyncChip();
  state.projects = new Map(
    repositories.map((repository) => [String(repository.id), repository]),
  );
  clearChildren(container);
  if (repositories.length === 0) {
    if (String(values.q || "").trim()) {
      emptyState(
        container,
        "검색 결과가 없습니다",
        "다른 이름, 설명 또는 Git 원격 주소로 검색해 보세요.",
      );
    } else {
      renderProjectEmpty(container);
    }
    return;
  }
  const details = await Promise.all(
    repositories.map((repository) =>
      state.dataStore.project(repository.id).catch(() => ({
        repository,
        rules: [],
        environments: [],
        activeWork: [],
        knowledge: [],
      })),
    ),
  );
  for (const project of details) {
    const repository = project.repository;
    const row = element("a", {
      className: "project-row",
      attrs: { href: `#projects/${encodeURIComponent(repository.id)}` },
    });
    const identity = element("div", { className: "project-row-identity" });
    identity.append(
      element("span", { className: "project-mark", attrs: { "aria-hidden": "true" } }),
      element("div"),
    );
    identity.lastElementChild.append(
      element("strong", { text: repository.name || repository.id }),
      element("p", {
        text: repository.description || "프로젝트 설명이 없습니다.",
      }),
    );
    const remote = element("div", { className: "project-row-remote" });
    remote.append(
      element("span", { text: "Git 원격" }),
      element("strong", { text: projectRemote(repository) }),
    );
    const stats = element("div", { className: "project-row-stats" });
    stats.append(
      element("span", { text: `${t("룰")} ${project.rules.length}` }),
      element("span", { text: `${t("환경")} ${project.environments.length}` }),
      element("span", { text: `${t("작업")} ${project.activeWork.length}` }),
      element("span", { text: `${t("지식")} ${project.knowledge.length}` }),
    );
    row.append(identity, remote, stats);
    container.append(row);
  }
}

function ruleScopeLabel(scope) {
  return (
    {
      all: "전체",
      global: "전체",
      repo: "저장소",
      env: "환경",
      pc: "이전 브라우저 룰",
      local: "PC 전용",
    }[scope] ||
    scope ||
    "범위 없음"
  );
}

async function loadRules(values = {}) {
  const container = $("#rules-list");
  loadingState(container, "룰을 불러오는 중");
  showNotice($("#rules-error"));
  const items = await state.dataStore.rules(values);
  state.rules = new Map(items.map((item) => [String(item.id), item]));
  clearChildren(container);
  if (items.length === 0) {
    emptyState(
      container,
      "저장된 룰이 없습니다",
      "첫 룰을 추가하면 연결된 에이전트에 다음 동기화부터 적용됩니다.",
    );
    return;
  }
  for (const rule of items) {
    const card = element("article", { className: "resource-card" });
    const content = element("div");
    const badge = element("span", {
      className: "scope-badge",
      text: ruleScopeLabel(rule.scope),
    });
    const context =
      rule.scope === "pc"
        ? "에이전트에는 적용되지 않습니다. 확인 후 삭제해 주세요."
        : [
            rule.repositoryName || rule.repository || rule.repo,
            rule.environment || rule.env,
          ]
            .filter(Boolean)
            .join(" · ");
    const ruleTitle = rule.title || context || `${ruleScopeLabel(rule.scope)} 룰`;
    const ruleContext = [
      context,
      rule._record
        ? rule.status === "draft"
          ? t("초안")
          : rule.activation === "manual"
            ? t("수동")
            : t("자동")
        : null,
      ...(rule.paths || []),
      ...(rule.files || []),
    ].filter(Boolean).join(" · ");
    content.append(badge, element("h3", { text: ruleTitle }));
    if (ruleContext)
      content.append(element("small", { className: "rule-context", text: ruleContext }));
    content.append(element("p", { text: truncate(rule.content || rule.text, 500) }));
    const actions = element("div", { className: "resource-actions" });
    if (rule.scope !== "pc") {
      actions.append(
        element("button", {
          className: "text-button",
          text: "수정",
          attrs: {
            type: "button",
            "data-action": "edit-rule",
            "data-id": rule.id,
          },
        }),
      );
    }
    actions.append(
      element("button", {
        className: "text-button danger",
        text: "삭제",
        attrs: {
          type: "button",
          "data-action": "delete-rule",
          "data-id": rule.id,
        },
      }),
    );
    card.append(content, actions);
    container.append(card);
  }
}

function workStatus(item) {
  return (
    item.status || (item.completedAt || item.completed_at ? "done" : "active")
  );
}

async function loadWork(values = {}) {
  const container = $("#work-list");
  loadingState(container, "작업을 불러오는 중");
  showNotice($("#work-error"));
  const items = await state.dataStore.work({
    status: state.workStatus,
    ...values,
  });
  state.work = new Map(items.map((item) => [String(item.id), item]));
  clearChildren(container);
  if (items.length === 0) {
    emptyState(
      container,
      state.workStatus === "done"
        ? "완료한 작업이 없습니다"
        : "진행 중인 작업이 없습니다",
      "새 작업을 만들고 중요한 판단과 다음 할 일을 남겨보세요.",
    );
    return;
  }
  for (const work of items) {
    const card = element("article", { className: "work-card" });
    const workflowLabel = {
      todo: "할 일",
      in_progress: "진행 중",
      blocked: "차단됨",
      done: "완료",
    }[work.workflowStatus] || (workStatus(work) === "done" ? "완료" : "진행 중");
    const workTone = WORK_STATUS_TONES[work.workflowStatus]
      ?? (workStatus(work) === "done" ? "active" : "progress");
    card.append(
      element("span", {
        className: `status-badge ${workTone}`.trim(),
        text: t(workflowLabel),
      }),
    );
    card.append(
      element("h3", { text: work.name || work.goal || "이름 없는 작업" }),
    );
    card.append(
      element("p", {
        text: truncate(work.current || work.goal || work.next, 260),
      }),
    );
    const meta = element("div", { className: "card-meta" });
    const priority = { urgent: "긴급", high: "높음", normal: "보통", low: "낮음" }[work.priority] || "보통";
    meta.append(element("span", {
      text: `${t(priority)} · ${t(work.ready ? "시작 가능" : work.workflowStatus === "blocked" ? "차단됨" : "선행 작업 대기")} · ${relativeTime(createdAt(work))}`,
    }));
    const actions = element("div", { className: "resource-actions" });
    actions.append(
      element("button", {
        className: "text-button",
        text: "열기",
        attrs: {
          type: "button",
          "data-action": "edit-work",
          "data-id": work.id,
        },
      }),
    );
    if (workStatus(work) !== "done")
      actions.append(
        element("button", {
          className: "text-button",
          text: "완료",
          attrs: {
            type: "button",
            "data-action": "finish-work",
            "data-id": work.id,
          },
        }),
      );
    meta.append(actions);
    card.append(meta);
    container.append(card);
  }
}

async function loadKnowledge(values = {}) {
  const container = $("#knowledge-list");
  const filter = $("#knowledge-filter");
  populateRepositoryFields(filter);
  updateKnowledgeFilterFields(filter);
  loadingState(container, "지식을 불러오는 중");
  showNotice($("#knowledge-error"));
  const items = await state.dataStore.knowledge(values);
  state.knowledge = new Map(items.map((item) => [String(item.id), item]));
  clearChildren(container);
  if (items.length === 0) {
    emptyState(
      container,
      "저장한 지식이 없습니다",
      "오래 기억할 결정, 제약, 문제 해결 배경을 직접 남겨보세요.",
    );
    return;
  }
  for (const note of items) {
    const card = element("article", { className: "knowledge-card" });
    const tags = element("div", { className: "tags" });
    const scope = note.scope === "env"
      ? `${t("환경")} · ${note.repositoryName || t("프로젝트")} / ${note.environment}`
      : note.scope === "repo"
        ? `${t("프로젝트")} · ${note.repositoryName || t("프로젝트")}`
        : t("공통");
    tags.append(element("span", { className: "tag tag-scope", text: scope }));
    const typeLabel = KNOWLEDGE_TYPE_LABELS[note.type] || "메모";
    tags.append(element("span", { className: "tag", text: t(typeLabel) }));
    if (note.pinned)
      tags.append(element("span", { className: "tag tag-pinned", text: t("고정") }));
    if (note.approval === "pending")
      tags.append(element("span", { className: "tag tag-review", text: t("검토 필요") }));
    const values = Array.isArray(note.tags)
      ? note.tags
      : stringValue(note.tags)
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
    for (const tag of values.slice(0, 5))
      tags.append(element("span", { className: "tag", text: tag }));
    card.append(
      tags,
      element("h3", { text: note.title || "제목 없는 지식" }),
      element("p", { text: truncate(note.content || note.body, 280) }),
    );
    if (note.sources?.length) {
      card.append(element("small", {
        className: "knowledge-source",
        text: `${t("출처")} · ${note.sources[0].label || note.sources[0].ref}${note.sources[0].commit ? ` @ ${note.sources[0].commit}` : ""}`,
      }));
    }
    const meta = element("div", { className: "card-meta" });
    meta.append(element("span", { text: relativeTime(createdAt(note)) }));
    const actions = element("div", { className: "resource-actions" });
    if (note.approval === "pending") {
      actions.append(
        element("button", {
          className: "text-button",
          text: t("승인"),
          attrs: { type: "button", "data-action": "approve-knowledge", "data-id": note.id },
        }),
        element("button", {
          className: "text-button danger",
          text: t("거절"),
          attrs: { type: "button", "data-action": "reject-knowledge", "data-id": note.id },
        }),
      );
    }
    actions.append(
      element("button", {
        className: "text-button",
        text: t("도움 됨"),
        attrs: { type: "button", "data-action": "feedback-helpful", "data-id": note.id },
      }),
      element("button", {
        className: "text-button",
        text: t("틀림"),
        attrs: { type: "button", "data-action": "feedback-wrong", "data-id": note.id },
      }),
      element("button", {
        className: "text-button",
        text: "수정",
        attrs: { type: "button", "data-action": "edit-knowledge", "data-id": note.id },
      }),
      element("button", {
        className: "text-button danger",
        text: "삭제",
        attrs: { type: "button", "data-action": "delete-knowledge", "data-id": note.id },
      }),
    );
    meta.append(actions);
    card.append(meta);
    container.append(card);
  }
}

async function loadDevices() {
  const body = $("#devices-table");
  const connectButton = $("#connect-device");
  const connectHelp = $("#connect-device-help");
  connectButton.disabled = true;
  connectButton.textContent = "기기 확인 중…";
  setHidden($("#devices-retry"), true);
  const connectionUnavailable = state.offlineBoot || !state.keyManaged;
  connectHelp.textContent = state.offlineBoot
    ? "서버에 다시 연결하면 새 PC를 연결할 수 있습니다."
    : "이전 방식 보관함을 계정형으로 전환한 뒤 새 PC를 연결할 수 있습니다.";
  setHidden(connectHelp, !connectionUnavailable);
  clearChildren(body);
  showNotice($("#devices-error"));
  const row = element("tr");
  const cell = element("td", {
    text: "기기 목록을 불러오는 중…",
    attrs: { colspan: 6 },
  });
  row.append(cell);
  body.append(row);
  const payload = await api.devices();
  const items = listFrom(payload, "devices");
  connectButton.textContent = "PC 연결";
  connectButton.disabled = connectionUnavailable;
  setHidden(connectHelp, !connectionUnavailable);
  clearChildren(body);
  if (items.length === 0) {
    const empty = element("tr");
    empty.append(
      element("td", {
        text: connectionUnavailable
          ? "아직 연결된 PC가 없습니다. 이전 보관함 전환을 마치면 계정에서 연결 코드를 만들 수 있습니다."
          : "아직 연결된 PC가 없습니다. 위의 ‘PC 연결’에서 이 계정의 일회용 코드를 만드세요.",
        attrs: { colspan: 6 },
      }),
    );
    body.append(empty);
    return;
  }
  for (const device of items) {
    const revoked = Boolean(device.revokedAt || device.revoked_at);
    const current =
      device.current === true || device.id === payload.currentDeviceId;
    const tr = element("tr");
    const name = element("td");
    name.append(
      element("strong", { text: device.name || "이름 없는 기기" }),
      element("span", {
        text: current ? "현재 브라우저" : stringValue(device.id).slice(0, 12),
      }),
    );
    tr.append(name);
    tr.append(
      element("td", { text: device.type === "browser" ? "브라우저" : "PC" }),
    );
    tr.append(
      element("td", {
        text: formatDate(device.createdAt || device.created_at),
      }),
    );
    tr.append(
      element("td", {
        text: relativeTime(device.lastSeenAt || device.last_seen_at),
      }),
    );
    const status = element("td");
    status.append(
      element("span", {
        className: `status-badge ${revoked ? "revoked" : "active"}`,
        text: revoked ? "폐기됨" : "연결됨",
      }),
    );
    tr.append(status);
    const action = element("td");
    if (!revoked && userCanManageAccounts()) {
      const actions = element("div", { className: "table-actions" });
      actions.append(
        element("button", {
          className: "text-button",
          text: "이름 변경",
          attrs: {
            type: "button",
            "data-action": "rename-device",
            "data-id": device.id,
            "data-name": device.name || "이름 없는 기기",
            "data-device-meta": current
              ? "현재 브라우저"
              : stringValue(device.id).slice(0, 12),
          },
        }),
        element("button", {
          className: "text-button danger",
          text: "연결 끊기",
          attrs: {
            type: "button",
            "data-action": "revoke-device",
            "data-id": device.id,
            disabled: current ? "disabled" : null,
          },
        }),
      );
      action.append(actions);
    }
    tr.append(action);
    body.append(tr);
  }
}

async function loadRevisions() {
  const body = $("#revisions-table");
  clearChildren(body);
  showNotice($("#revisions-error"));
  const loading = element("tr");
  loading.append(
    element("td", { text: "저장 기록을 불러오는 중…", attrs: { colspan: 5 } }),
  );
  body.append(loading);
  const payload = await api.revisions();
  const items = listFrom(payload, "revisions");
  clearChildren(body);
  if (items.length === 0) {
    const row = element("tr");
    row.append(
      element("td", {
        text: "아직 저장 기록이 없습니다.",
        attrs: { colspan: 5 },
      }),
    );
    body.append(row);
    return;
  }
  for (const revision of items) {
    const tr = element("tr");
    tr.append(
      element("td", {
        text: formatDate(revision.createdAt || revision.created_at),
      }),
    );
    tr.append(element("td", { text: formatBytes(revision.bytes) }));
    const id = stringValue(revision.id || revision.revisionId);
    const idCell = element("td");
    idCell.append(element("code", { text: id.slice(0, 12) }));
    tr.append(idCell);
    const current = element("td");
    current.append(
      element("span", {
        className: "status-badge active",
        text: revision.current ? "현재" : "보관",
      }),
    );
    tr.append(current);
    const action = element("td");
    action.append(
      element("button", {
        className: "text-button",
        text: "명령 복사",
        attrs: { type: "button", "data-action": "copy-restore", "data-id": id },
      }),
    );
    tr.append(action);
    body.append(tr);
  }
}

async function loadSecurity() {
  showNotice($("#security-error"));
  const [passkeyPayload, sessionPayload, localVault] = await Promise.all([
    api.passkeys(),
    api.webSessions(),
    hasLocalVault(state.tenantId),
  ]);
  renderSecurityItems(
    $("#passkeys-list"),
    listFrom(passkeyPayload, "passkeys"),
    "passkey",
  );
  renderSecurityItems(
    $("#sessions-list"),
    listFrom(sessionPayload, "sessions"),
    "session",
  );
  const vault = $("#browser-vault-status");
  $(".status-dot", vault).className =
    `status-dot ${localVault && !state.vaultProblem ? "status-ok" : "status-warning"}`;
  $("strong", vault).textContent = state.vaultProblem
    ? "보관함 연결 확인 필요"
    : localVault
      ? "이 브라우저에 보관함 있음"
      : "보관함 연결 필요";
}

function renderSecurityItems(container, items, type) {
  clearChildren(container);
  if (items.length === 0) {
    container.append(
      element("p", {
        className: "panel-copy",
        text:
          type === "passkey"
            ? "등록된 패스키가 없습니다."
            : "활성 웹 세션이 없습니다.",
      }),
    );
    return;
  }
  for (const item of items) {
    const row = element("div", { className: "settings-item" });
    const copy = element("div");
    copy.append(
      element("strong", {
        text:
          item.name ||
          (type === "passkey" ? "패스키" : item.browser || "웹 세션"),
      }),
      element("span", {
        text: `${relativeTime(item.lastUsedAt || item.last_seen_at || item.createdAt)}${item.current ? " · 현재" : ""}`,
      }),
    );
    row.append(copy);
    if (!item.current)
      row.append(
        element("button", {
          className: "text-button danger",
          text: type === "passkey" ? "삭제" : "종료",
          attrs: {
            type: "button",
            "data-action":
              type === "passkey" ? "delete-passkey" : "revoke-session",
            "data-id": item.id,
          },
        }),
      );
    container.append(row);
  }
}

function accountRoleLabel(role) {
  return { owner: "소유자", admin: "관리자", member: "사용자" }[role] || role;
}

function renderAccountMembers(values) {
  const container = $("#account-members-list");
  clearChildren(container);
  if (!Array.isArray(values) || values.length === 0) {
    emptyState(container, "계정이 없습니다", "아직 이 작업 공간에 등록된 계정이 없습니다.");
    return;
  }
  for (const membership of values) {
    const user = membership.user || membership;
    const row = element("div", { className: "settings-item" });
    const copy = element("div");
    copy.append(
      element("strong", { text: displayName(user) }),
      element("span", {
        text: `${user.username || "사용자 이름 없음"} · ${accountRoleLabel(membership.role)}`,
      }),
    );
    row.append(
      copy,
      element("span", { text: relativeTime(membership.joinedAt || user.createdAt) }),
    );
    container.append(row);
  }
}

function renderAccountInvites(values) {
  const container = $("#account-invites-list");
  clearChildren(container);
  if (!Array.isArray(values) || values.length === 0) {
    emptyState(container, "만든 코드가 없습니다", "새 가입 코드를 만들면 사용 여부가 여기에 표시됩니다.");
    return;
  }
  for (const invitation of values) {
    const status = invitation.usedAt
      ? "사용됨"
      : invitation.expired
        ? "만료"
        : "사용 가능";
    const row = element("div", { className: "settings-item" });
    const copy = element("div");
    copy.append(
      element("strong", { text: `${accountRoleLabel(invitation.role)} 가입 코드` }),
      element("span", {
        text: invitation.expiresAt
          ? `${formatDate(invitation.expiresAt)}까지`
          : "만료 시각 없음",
      }),
    );
    row.append(copy, element("span", { text: status }));
    container.append(row);
  }
}

async function loadAccountManagement() {
  const panel = $("#account-management");
  setHidden(panel, false);
  showNotice($("#account-management-error"));
  const ownerRole = $("#account-owner-role");
  ownerRole.disabled = !userIsOwner();
  ownerRole.hidden = !userIsOwner();
  if (!userIsOwner() && $("#account-invite-role").value === "owner") {
    $("#account-invite-role").value = "member";
  }
  try {
    const [members, invites] = await Promise.all([
      api.accountMembers(),
      api.accountInvites(),
    ]);
    renderAccountMembers(listFrom(members, "members"));
    renderAccountInvites(listFrom(invites, "invites"));
  } catch (error) {
    showNotice($("#account-management-error"), error.message, "error");
  }
}

async function loadSettings() {
  showNotice($("#settings-error"));
  const payload = await api.settings();
  const user = payload.user || state.session.user || {};
  $("#settings-username").value = user.username || "";
  $("#settings-display-name").value = displayName(user);
  $("#settings-language").value = user.language || languagePreference();
  state.serverOwner = payload.serverOwner === true;
  setHidden($("#server-settings-form"), !state.serverOwner);
  if (state.serverOwner) {
    $("#signup-mode").value =
      payload.signupMode || payload.signup?.mode || "open";
    $("#revision-retention").value =
      payload.revisionRetention || payload.retention || 50;
  }
  if (userCanManageAccounts()) await loadAccountManagement();
  else setHidden($("#account-management"), true);
}

function openDialog(id, item) {
  const dialog = document.getElementById(id);
  if (!dialog) return;
  const form = $("form.dialog-form", dialog);
  form?.reset();
  showNotice($(".notice", form));
  if (form) populateRepositoryFields(form);
  if (item && form) fillForm(form, item);
  if (form?.id === "rule-form") {
    $(".dialog-head h2", form).textContent = item ? "룰 수정" : "룰 추가";
    updateRuleScopeFields(form);
  }
  if (form?.id === "knowledge-form") {
    $(".dialog-head h2", form).textContent = item ? "지식 수정" : "지식 추가";
    updateKnowledgeScopeFields(form);
  }
  if (form?.id === "project-form") {
    $(".dialog-head h2", form).textContent = "프로젝트 설정";
  }
  dialog.showModal();
}

async function returnAfterResourceSave(defaultView) {
  const destination = state.returnAfterDialog;
  state.returnAfterDialog = null;
  if (destination?.startsWith("#projects/")) {
    await setView("projects", { force: true });
    return;
  }
  await setView(defaultView, { force: true });
}

function updateRuleScopeFields(form = $("#rule-form")) {
  const scope = form.elements.namedItem("scope")?.value || "all";
  const fields = $(".rule-scope-fields", form);
  const repositoryLabel = $('[data-rule-field="repository"]', form);
  const environmentLabel = $('[data-rule-field="environment"]', form);
  const repository = form.elements.namedItem("repository");
  const environment = form.elements.namedItem("environment");
  const editing = Boolean(form.elements.namedItem("id")?.value);
  const needsRepository = ["repo", "env"].includes(scope);
  const needsEnvironment = scope === "env";

  setHidden(fields, !needsRepository);
  fields?.classList.toggle("is-single", scope === "repo");
  setHidden(repositoryLabel, !needsRepository);
  setHidden(environmentLabel, !needsEnvironment);
  if (repository) {
    repository.disabled = !needsRepository;
    repository.required = needsRepository;
  }
  if (environment) {
    environment.disabled = !needsEnvironment;
    environment.required = needsEnvironment;
  }
  const scopeControl = form.elements.namedItem("scope");
  if (scopeControl) scopeControl.disabled = editing;

  const help = $("#rule-scope-help");
  if (help) {
    help.textContent = {
      all: "모든 저장소와 환경에 적용됩니다.",
      repo: "선택한 저장소의 모든 환경에 적용됩니다.",
      env: "선택한 저장소에서 이 환경을 고른 PC에만 적용됩니다.",
    }[scope] || "적용 범위를 선택해 주세요.";
    if (editing) help.textContent += " 수정 중에는 범위를 바꿀 수 없습니다.";
  }
  updateRuleEnvironmentCommand(form);
}

function updateRuleEnvironmentCommand(form = $("#rule-form")) {
  const output = $("#rule-environment-command");
  const environment = form.elements.namedItem("environment")?.value.trim();
  if (output) output.textContent = `hnd env set ${environment || "이름"}`;
}

function updateKnowledgeScopeFields(form = $("#knowledge-form")) {
  const scope = form.elements.namedItem("scope")?.value || "global";
  const fields = $(".knowledge-scope-fields", form);
  const repositoryLabel = $('[data-knowledge-field="repository"]', form);
  const environmentLabel = $('[data-knowledge-field="environment"]', form);
  const repository = form.elements.namedItem("repository");
  const environment = form.elements.namedItem("environment");
  const needsRepository = ["repo", "env"].includes(scope);
  const needsEnvironment = scope === "env";

  setHidden(fields, !needsRepository);
  fields?.classList.toggle("is-single", scope === "repo");
  setHidden(repositoryLabel, !needsRepository);
  setHidden(environmentLabel, !needsEnvironment);
  if (repository) {
    repository.disabled = !needsRepository;
    repository.required = needsRepository;
  }
  if (environment) {
    environment.disabled = !needsEnvironment;
    environment.required = needsEnvironment;
  }
  const help = $("#knowledge-scope-help");
  if (help) {
    help.textContent = {
      global: "모든 프로젝트에서 함께 찾을 수 있습니다.",
      repo: "선택한 프로젝트의 모든 환경에서 찾을 수 있습니다.",
      env: "선택한 프로젝트의 이 환경에서 사용하는 지식입니다.",
    }[scope] || "저장할 범위를 선택해 주세요.";
  }
}

function updateKnowledgeFilterFields(form = $("#knowledge-filter")) {
  const scope = form.elements.namedItem("scope")?.value || "all-scopes";
  const repositoryLabel = $('[data-knowledge-filter-field="repository"]', form);
  const environmentLabel = $('[data-knowledge-filter-field="environment"]', form);
  const repository = form.elements.namedItem("repository");
  const environment = form.elements.namedItem("environment");
  const needsRepository = ["repo", "env"].includes(scope);
  const needsEnvironment = scope === "env";
  setHidden(repositoryLabel, !needsRepository);
  setHidden(environmentLabel, !needsEnvironment);
  if (repository) {
    repository.disabled = !needsRepository;
    repository.required = needsRepository;
  }
  if (environment) {
    environment.disabled = !needsEnvironment;
    environment.required = needsEnvironment;
  }
}

function populateRepositoryFields(form) {
  const repositories = state.dataStore?.repositories() || [];
  const workSelect = form.elements.namedItem("repository");
  if (workSelect?.tagName === "SELECT") {
    const selected = workSelect.value;
    clearChildren(workSelect);
    workSelect.append(
      element("option", {
        text: repositories.length ? "저장소 선택" : "연결된 저장소 없음",
        attrs: { value: "" },
      }),
    );
    for (const repository of repositories) {
      workSelect.append(
        element("option", {
          text: repositoryOptionLabel(repository),
          attrs: { value: repository.id },
        }),
      );
    }
    workSelect.value =
      selected || (repositories.length === 1 ? repositories[0].id : "");
  }
  const datalist = document.getElementById("repository-options");
  if (datalist) {
    clearChildren(datalist);
    for (const repository of repositories) {
      datalist.append(
        element("option", {
          attrs: {
            value: repository.id,
            label: repositoryOptionLabel(repository),
          },
        }),
      );
    }
  }
}

function localSaveMessage(defaultMessage) {
  const sync = state.dataStore.syncStatus();
  updateSyncChip();
  if (sync.conflict)
    return "로컬에 저장했습니다. 서버에서 같은 항목이 바뀌어 확인이 필요합니다.";
  if (sync.pending)
    return "로컬에 저장했습니다. 서버 연결 시 자동으로 전송합니다.";
  return defaultMessage;
}

async function retrySync(event) {
  const button = event.currentTarget;
  setBusy(button, true, "동기화 중…");
  try {
    const synced = await state.dataStore.sync();
    updateSyncChip();
    await setView("home", { force: true });
    const status = state.dataStore.syncStatus();
    if (synced && !status.pending) toast("서버와 동기화했습니다.");
    else if (status.conflict)
      toast("변경이 계속 겹칩니다. 보존할 저장본을 선택해 주세요.", "error");
    else toast("로컬에 보관했습니다. 서버 연결 시 다시 전송합니다.");
  } catch (error) {
    updateSyncChip();
    showNotice($("#home-error"), error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function resolveSyncConflict(event, strategy) {
  const useLocal = strategy === "local";
  const confirmed = await confirmAction(
    useLocal ? "이 항목에 내 변경을 사용할까요?" : "이 항목에 서버 변경을 사용할까요?",
    useLocal
      ? "겹친 항목에는 이 브라우저의 변경을 적용합니다. 자동으로 합친 다른 변경은 그대로 유지합니다."
      : "겹친 항목에는 서버 변경을 적용합니다. 이 브라우저에서 바꾼 다른 항목은 그대로 유지합니다.",
    useLocal ? "내 변경 사용" : "서버 변경 사용",
    "danger",
  );
  if (!confirmed) return;
  const button = event.currentTarget;
  setBusy(button, true, "처리 중…");
  try {
    const resolved = await state.dataStore.resolveConflict(strategy);
    updateSyncChip();
    await setView("home", { force: true });
    if (resolved) toast("선택한 저장본으로 동기화를 마쳤습니다.");
    else toast("동기화하지 못했습니다. 로컬 변경은 그대로 보존했습니다.", "error");
  } catch (error) {
    updateSyncChip();
    showNotice($("#home-error"), error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function fillForm(form, item) {
  for (const field of form.elements) {
    if (!field.name) continue;
    const aliases = {
      content: ["content", "text", "body"],
      repository: ["repository", "repo"],
      environment: ["environment", "env"],
      displayName: ["displayName", "display_name"],
      next: ["next", "nextAction"],
      sourceRef: ["sourceRef"],
      sourceCommit: ["sourceCommit"],
    }[field.name] || [field.name];
    let value = aliases
      .map((key) => item[key])
      .find((candidate) => candidate !== undefined);
    if (field.name === "sourceRef") value = item.sources?.[0]?.ref;
    if (field.name === "sourceCommit") value = item.sources?.[0]?.commit;
    if (["dependencies", "paths", "files"].includes(field.name) && Array.isArray(value)) {
      value = value.join("\n");
    }
    if (field.type === "checkbox") field.checked = Boolean(value);
    else if (value !== undefined)
      field.value = Array.isArray(value) ? value.join(", ") : value;
  }
}

function formObject(form) {
  return Object.fromEntries(
    [...new FormData(form)].map(([key, value]) => [
      key,
      typeof value === "string" ? value.trim() : value,
    ]),
  );
}

function closeDialog(dialog) {
  dialog?.close();
}

function confirmAction(title, message, actionLabel = "계속", tone = "normal") {
  const dialog = $("#confirm-dialog");
  const accept = $("#confirm-accept");
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  accept.textContent = actionLabel;
  accept.className = `button ${tone === "danger" ? "button-danger" : "button-primary"}`;
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "confirm"),
      { once: true },
    ),
  );
}

async function submitRule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const values = formObject(form);
  values.scope = form.elements.namedItem("scope").value;
  const notice = $(".notice", form);
  setBusy(button, true, "저장 중…");
  showNotice(notice);
  try {
    if (values.id) await state.dataStore.updateRule(values.id, values);
    else await state.dataStore.createRule(values);
    closeDialog(form.closest("dialog"));
    await returnAfterResourceSave("rules");
    toast(localSaveMessage("룰을 저장했습니다."));
  } catch (error) {
    showNotice(notice, error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function submitWork(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const values = formObject(form);
  const notice = $(".notice", form);
  setBusy(button, true, "저장 중…");
  showNotice(notice);
  try {
    if (values.id) await state.dataStore.updateWork(values.id, values);
    else await state.dataStore.createWork(values);
    closeDialog(form.closest("dialog"));
    await returnAfterResourceSave("work");
    toast(localSaveMessage("작업을 저장했습니다."));
  } catch (error) {
    showNotice(notice, error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function submitProject(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const values = formObject(form);
  const notice = $(".notice", form);
  setBusy(button, true, "저장 중…");
  showNotice(notice);
  try {
    await state.dataStore.updateProject(values.id, values);
    closeDialog(form.closest("dialog"));
    await setView("projects", { force: true });
    toast(localSaveMessage("프로젝트 설정을 저장했습니다."));
  } catch (error) {
    showNotice(notice, error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function submitKnowledge(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const values = formObject(form);
  const notice = $(".notice", form);
  values.tags = values.tags
    ? values.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];
  values.pinned = form.elements.namedItem("pinned").checked;
  setBusy(button, true, "저장 중…");
  showNotice(notice);
  try {
    if (values.id) await state.dataStore.updateKnowledge(values.id, values);
    else await state.dataStore.createKnowledge(values);
    closeDialog(form.closest("dialog"));
    await returnAfterResourceSave("knowledge");
    toast(localSaveMessage("지식을 저장했습니다."));
  } catch (error) {
    showNotice(notice, error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function editDeviceName(button) {
  const row = button.closest("tr");
  const nameCell = row?.cells?.[0];
  const actionCell = row?.cells?.[5];
  if (!row || !nameCell || !actionCell) return;
  const originalName = button.dataset.name || "이름 없는 기기";
  const metadata = button.dataset.deviceMeta || button.dataset.id.slice(0, 12);
  const fieldId = `device-name-${button.dataset.id}`;
  const errorId = `${fieldId}-error`;
  const rowActions = [...actionCell.querySelectorAll("button")].map(
    (control) => ({ control, disabled: control.disabled }),
  );

  const restore = (name = originalName) => {
    clearChildren(nameCell);
    nameCell.append(
      element("strong", { text: name }),
      element("span", { text: metadata }),
    );
    button.dataset.name = name;
    for (const state of rowActions) state.control.disabled = state.disabled;
  };

  const form = element("form", {
    className: "device-rename-form",
    attrs: { "aria-label": `${originalName} 이름 변경` },
  });
  const label = element("label", {
    className: "sr-only",
    text: "새 PC 이름",
    attrs: { for: fieldId },
  });
  const input = element("input", {
    attrs: {
      id: fieldId,
      name: "name",
      type: "text",
      value: originalName,
      minlength: 1,
      maxlength: 100,
      required: "required",
      autocomplete: "off",
      "aria-describedby": errorId,
    },
  });
  const controls = element("div", { className: "device-rename-actions" });
  const save = element("button", {
    className: "text-button",
    text: "저장",
    attrs: { type: "submit" },
  });
  const cancel = element("button", {
    className: "text-button",
    text: "취소",
    attrs: { type: "button" },
  });
  const error = element("span", {
    className: "device-rename-error",
    attrs: { id: errorId, role: "alert", hidden: "hidden" },
  });
  controls.append(save, cancel);
  form.append(label, input, controls, error);
  clearChildren(nameCell);
  nameCell.append(form);
  for (const state of rowActions) state.control.disabled = true;
  input.focus();
  input.select();

  cancel.addEventListener("click", () => {
    restore();
    button.focus();
  });
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancel.click();
  });
  input.addEventListener("input", () => {
    input.setCustomValidity("");
    error.hidden = true;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) {
      input.setCustomValidity("PC 이름을 입력해 주세요.");
      input.reportValidity();
      return;
    }
    if (name === originalName) {
      restore();
      button.focus();
      return;
    }
    setBusy(save, true, "저장 중…");
    cancel.disabled = true;
    error.hidden = true;
    try {
      const result = await api.renameDevice(button.dataset.id, name);
      const savedName = result?.device?.name || name;
      restore(savedName);
      button.focus();
      toast("PC 이름을 변경했습니다.");
    } catch (renameError) {
      error.textContent = renameError.message;
      error.hidden = false;
      input.focus();
    } finally {
      setBusy(save, false);
      cancel.disabled = false;
    }
  });
}

async function handleAction(button) {
  const { action, id, target } = button.dataset;
  if (action === "refresh") {
    await setView(target, { force: true });
    return;
  }
  if (action === "edit-rule") {
    state.returnAfterDialog = state.view === "projects" ? window.location.hash : null;
    openDialog("rule-dialog", state.rules.get(id));
    return;
  }
  if (action === "edit-work") {
    state.returnAfterDialog = state.view === "projects" ? window.location.hash : null;
    openDialog("work-dialog", state.work.get(id));
    return;
  }
  if (action === "edit-knowledge") {
    state.returnAfterDialog = state.view === "projects" ? window.location.hash : null;
    openDialog("knowledge-dialog", state.knowledge.get(id));
    return;
  }
  if (["approve-knowledge", "reject-knowledge"].includes(action)) {
    await state.dataStore.reviewKnowledge(
      id,
      action === "approve-knowledge" ? "approve" : "reject",
    );
    await setView("knowledge", { force: true });
    toast(localSaveMessage(action === "approve-knowledge" ? "지식을 승인했습니다." : "지식 후보를 거절했습니다."));
    return;
  }
  if (["feedback-helpful", "feedback-wrong", "feedback-irrelevant"].includes(action)) {
    await state.dataStore.feedbackKnowledge(id, action.replace("feedback-", ""));
    toast(localSaveMessage("지식 평가를 반영했습니다."));
    return;
  }
  if (action === "back-projects") {
    window.location.hash = "projects";
    return;
  }
  if (action === "edit-project") {
    const project = state.projects.get(state.selectedProjectId);
    if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
    openDialog("project-dialog", project);
    return;
  }
  if (action === "new-project-rule") {
    state.returnAfterDialog = window.location.hash;
    openDialog("rule-dialog");
    const form = $("#rule-form");
    form.elements.namedItem("scope").value = "repo";
    form.elements.namedItem("repository").value = state.selectedProjectId;
    updateRuleScopeFields(form);
    return;
  }
  if (action === "new-project-work") {
    state.returnAfterDialog = window.location.hash;
    openDialog("work-dialog");
    $("#work-form").elements.namedItem("repository").value = state.selectedProjectId;
    return;
  }
  if (action === "new-project-knowledge") {
    state.returnAfterDialog = window.location.hash;
    openDialog("knowledge-dialog");
    const form = $("#knowledge-form");
    form.elements.namedItem("scope").value = "repo";
    form.elements.namedItem("repository").value = state.selectedProjectId;
    updateKnowledgeScopeFields(form);
    return;
  }
  if (action === "copy-restore") {
    await copyText(`hnd sync restore ${id} --force`, button);
    return;
  }
  if (action === "rename-device") {
    editDeviceName(button);
    return;
  }
  if (
    action === "delete-rule" &&
    (await confirmAction(
      "룰을 삭제할까요?",
      "연결된 기기에는 다음 동기화부터 삭제가 반영됩니다.",
      "삭제",
      "danger",
    ))
  ) {
    await state.dataStore.deleteRule(id);
    await setView("rules", { force: true });
    toast(localSaveMessage("룰을 삭제했습니다."));
    return;
  }
  if (
    action === "delete-knowledge" &&
    (await confirmAction(
      "지식을 삭제할까요?",
      "삭제한 내용은 현재 목록에서 제거됩니다.",
      "삭제",
      "danger",
    ))
  ) {
    await state.dataStore.deleteKnowledge(id);
    await returnAfterResourceSave("knowledge");
    toast(localSaveMessage("지식을 삭제했습니다."));
    return;
  }
  if (
    action === "finish-work" &&
    (await confirmAction(
      "작업을 완료할까요?",
      "작업은 완료 목록으로 이동합니다.",
      "완료",
    ))
  ) {
    await state.dataStore.finishWork(id);
    await setView("work", { force: true });
    toast(localSaveMessage("작업을 완료했습니다."));
    return;
  }
  if (
    action === "revoke-device" &&
    (await confirmAction(
      "기기 연결을 끊을까요?",
      "앞으로 서버 접근은 막지만 이 기기의 로컬 사본은 원격으로 지울 수 없습니다.",
      "연결 끊기",
      "danger",
    ))
  ) {
    await withRecentAuthentication(() => api.revokeDevice(id));
    await setView("devices", { force: true });
    toast("기기 연결을 끊었습니다.");
    return;
  }
  if (
    action === "delete-passkey" &&
    (await confirmAction(
      "패스키를 삭제할까요?",
      "다른 패스키나 복구 코드를 먼저 확인하세요.",
      "삭제",
      "danger",
    ))
  ) {
    await withRecentAuthentication(() => api.deletePasskey(id));
    await setView("security", { force: true });
    toast("패스키를 삭제했습니다.");
    return;
  }
  if (
    action === "revoke-session" &&
    (await confirmAction(
      "웹 세션을 종료할까요?",
      "선택한 브라우저에서 다시 로그인해야 합니다.",
      "종료",
      "danger",
    ))
  ) {
    await withRecentAuthentication(() => api.revokeSession(id));
    await setView("security", { force: true });
    toast("웹 세션을 종료했습니다.");
  }
}

async function addPasskey() {
  const button = $("#add-passkey");
  setBusy(button, true, "기기 확인 중…");
  showNotice($("#security-error"));
  try {
    const options = await withRecentAuthentication(() =>
      api.passkeyAddOptions({ name: "추가 패스키" }),
    );
    const response = await createPasskey(options.options || options);
    await api.passkeyAddVerify({
      flowId: options.flowId,
      response,
      name: "추가 패스키",
    });
    await setView("security", { force: true });
    toast("패스키를 추가했습니다.");
  } catch (error) {
    showNotice($("#security-error"), error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function renewRecovery() {
  if (
    !(await confirmAction(
      "복구 코드를 재발급할까요?",
      "기존 복구 코드는 즉시 사용할 수 없게 됩니다.",
      "재발급",
      "danger",
    ))
  )
    return;
  try {
    const result = await withRecentAuthentication(() => api.recoveryCreate());
    const codes = Array.isArray(result.codes)
      ? result.codes
      : result.recoveryCode
        ? [result.recoveryCode]
        : [];
    if (codes.length === 0)
      throw new Error("서버가 복구 코드를 반환하지 않았습니다.");
    if (!result.confirmationId) {
      throw new Error("서버가 복구 코드 확인 정보를 반환하지 않았습니다.");
    }
    state.pendingRecoveryCodes = codes.map(String);
    state.pendingRecoveryConfirmationId = result.confirmationId;
    $("#app-recovery-codes").textContent = state.pendingRecoveryCodes.join("\n");
    $("#app-recovery-confirmed").checked = false;
    $("#app-recovery-finish").disabled = true;
    showNotice($("#app-recovery-error"));
    $("#recovery-dialog").showModal();
  } catch (error) {
    showNotice($("#security-error"), error.message, "error");
  }
}

async function submitAccountInvite(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const values = new FormData(form);
  setBusy(button, true, "코드 만드는 중…");
  showNotice($("#account-management-error"));
  try {
    const invitation = await withRecentAuthentication(() =>
      api.createAccountInvite({
        role: values.get("role")?.toString(),
        ttlSeconds: Number(values.get("ttlSeconds")),
      }),
    );
    if (typeof invitation?.code !== "string") {
      throw new Error("서버가 가입 코드를 반환하지 않았습니다.");
    }
    $("#account-invite-code").textContent = invitation.code;
    $("#account-invite-expiry").textContent = invitation.expiresAt
      ? `${formatDate(invitation.expiresAt)}까지`
      : "한 번만 사용 가능";
    setHidden($("#account-invite-secret"), false);
    await loadAccountManagement();
    toast("가입 코드를 만들었습니다.");
  } catch (error) {
    showNotice($("#account-management-error"), error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function unlockVaultFromAccount(event) {
  const button = event.currentTarget;
  setBusy(button, true, "보관함 여는 중…");
  showNotice($("#vault-pair-notice"));
  try {
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
        "이전 보관함을 전환할 로컬 키가 없습니다. 소유자는 아래에서 새 보관함으로 시작할 수 있습니다.",
      );
    }
    const dataStore = new SnapshotDataStore(state.tenantId);
    await dataStore.load();
    await enableCurrentOfflineWorkspace().catch(() => {});
    state.dataStore = dataStore;
    state.vaultLocked = false;
    state.legacyResetAllowed = false;
    state.vaultProblem = null;
    state.loaded.clear();
    updateVaultLockControls();
    await setView(currentView(), { force: true });
    toast("계정 보관함을 열었습니다.");
  } catch (error) {
    showNotice($("#vault-pair-notice"), error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function updateVaultLockControls() {
  setHidden(
    $("#vault-reset-option"),
    !state.vaultLocked || !state.legacyResetAllowed || !userIsOwner(),
  );
  if (state.keyManaged) {
    $("#vault-gate-title").textContent = "계정 보관함을 여세요";
    $(".vault-gate-lead").textContent = state.vaultProblem
      ? "서버 저장본과 로컬 사본을 함께 열지 못했습니다. 패스키로 계정 키를 다시 확인할 수 있습니다."
      : "로그인은 완료됐습니다. 패스키로 확인하면 이 브라우저에 오프라인 사본을 준비합니다.";
    $("#vault-account-unlock").textContent = "패스키로 보관함 열기";
  } else {
    $("#vault-gate-title").textContent = "이전 방식 보관함을 전환하세요";
    $(".vault-gate-lead").textContent =
      "이 보관함은 계정에 암호화 키를 맡기기 전 방식입니다. 기존 로컬 키가 있으면 한 번만 전환할 수 있습니다.";
    $("#vault-account-unlock").textContent = "기존 로컬 키로 전환";
  }
}

function openVaultResetDialog() {
  if (!state.vaultLocked || !state.legacyResetAllowed || !userIsOwner())
    return;
  const form = $("#vault-reset-form");
  form.reset();
  $("#vault-reset-submit").disabled = true;
  showNotice($("#vault-reset-notice"));
  $("#vault-reset-dialog").showModal();
  queueMicrotask(() => $("#vault-reset-confirmation").focus());
}

function updateVaultResetConfirmation() {
  $("#vault-reset-submit").disabled =
    $("#vault-reset-confirmation").value !== "보관함 초기화";
}

function announceVaultReset(tenantId) {
  const message = { type: "hnd-vault-reset", tenantId };
  vaultResetChannel?.postMessage(message);
  globalThis.navigator?.serviceWorker?.controller?.postMessage(message);
}

async function submitVaultReset(event) {
  event.preventDefault();
  const button = $("#vault-reset-submit");
  showNotice($("#vault-reset-notice"));
  if (
    !state.vaultLocked ||
    !state.legacyResetAllowed ||
    !userIsOwner()
  ) {
    showNotice(
      $("#vault-reset-notice"),
      "서버 관리 키와 로컬 키가 모두 없는 이전 방식 보관함만 소유자가 초기화할 수 있습니다.",
      "error",
    );
    return;
  }
  if ($("#vault-reset-confirmation").value !== "보관함 초기화") {
    showNotice(
      $("#vault-reset-notice"),
      "확인 문구를 정확히 입력해 주세요.",
      "error",
    );
    return;
  }
  setBusy(button, true, "초기화 중…");
  try {
    const status = await api.vaultStatus();
    if (status?.initialized !== true || typeof status?.etag !== "string") {
      throw new Error(
        "현재 보관함 상태를 확인할 수 없습니다. 새로고침 후 다시 시도해 주세요.",
      );
    }
    if (status?.keyManaged === true) {
      state.legacyResetAllowed = false;
      updateVaultLockControls();
      throw new Error(
        "이 보관함은 계정이 관리 중입니다. 초기화하지 않고 패스키로 다시 열어 주세요.",
      );
    }
    if (await hasLocalVault(state.tenantId)) {
      state.legacyResetAllowed = false;
      updateVaultLockControls();
      throw new Error(
        "이 브라우저에 기존 로컬 키가 남아 있어 초기화를 중단했습니다. 먼저 기존 키로 전환해 주세요.",
      );
    }
    const { resetEpoch } = await beginBrowserWorkspaceReset(state.tenantId);
    // Reload older app tabs before changing the server snapshot. Newer tabs
    // also observe the durable epoch barrier and fail closed if they race.
    announceVaultReset(state.tenantId);
    await withRecentAuthentication(() =>
      resetBrowserVault(state.tenantId, status.etag),
    );
    await finalizeBrowserWorkspaceReset(state.tenantId, resetEpoch);
    announceVaultReset(state.tenantId);
    const dataStore = new SnapshotDataStore(state.tenantId);
    await dataStore.load();
    await enableCurrentOfflineWorkspace().catch(() => {});
    state.dataStore = dataStore;
    state.vaultLocked = false;
    state.keyManaged = true;
    state.legacyResetAllowed = false;
    state.vaultProblem = null;
    state.loaded.clear();
    updateVaultLockControls();
    $("#vault-reset-dialog").close();
    window.history.replaceState(null, "", "#home");
    await setView("home");
    toast("새 보관함을 만들었습니다.");
  } catch (error) {
    showNotice($("#vault-reset-notice"), error.message, "error");
  } finally {
    setBusy(button, false);
    updateVaultResetConfirmation();
  }
}

async function resolveAppSession() {
  try {
    const session = await api.session();
    if (!session?.authenticated) {
      const localVaults = await localTenantIds(null);
      await Promise.all(
        localVaults.map((id) => disableOfflineWorkspace(id)),
      );
      window.location.replace("/");
      return null;
    }
    if (session.requiresPasskey) {
      window.location.replace("/setup?recovery=1");
      return null;
    }
    if (session.recoveryCodesConfirmed === false) {
      window.location.replace("/setup");
      return null;
    }
    const activeTenantId = tenantId(session);
    if (!activeTenantId) {
      throw new Error("현재 계정의 작업 공간을 확인할 수 없습니다.");
    }
    let offlineAccessEpoch = null;
    try {
      offlineAccessEpoch = (
        await prepareOfflineWorkspaceAccess(activeTenantId)
      ).epoch;
    } catch {
      offlineAccessEpoch = null;
    }
    if (Number.isSafeInteger(offlineAccessEpoch)) {
      await enableOfflineWorkspace(activeTenantId, {
        expectedAccessEpoch: offlineAccessEpoch,
        sessionId: webSessionId(session),
      }).catch(() => {});
    }
    return {
      session,
      tenantId: activeTenantId,
      offline: false,
      offlineAccessEpoch,
    };
  } catch (error) {
    if (error?.retryable !== true) throw error;
    const localVaults = await listLocalVaultIds();
    const enabledVaults = [];
    for (const id of localVaults) {
      if ((await offlineWorkspaceEnabled(id)) && (await hasLocalVault(id))) {
        enabledVaults.push(id);
      }
    }
    if (enabledVaults.length !== 1) {
      throw new Error(
        enabledVaults.length === 0
          ? "서버에 연결할 수 없고 이 브라우저에서 열 수 있는 로컬 사본도 없습니다."
          : "오프라인 작업 공간이 여러 개입니다. 서버 연결 후 사용할 공간을 선택해 주세요.",
        { cause: error },
      );
    }
    const localTenantId = enabledVaults[0];
    const offlineAccessEpoch = (
      await prepareOfflineWorkspaceAccess(localTenantId)
    ).epoch;
    return {
      tenantId: localTenantId,
      offline: true,
      offlineAccessEpoch,
      session: {
        authenticated: true,
        activeTenantId: localTenantId,
        user: {
          displayName: "오프라인 사용자",
          role: "member",
        },
      },
    };
  }
}

const AVATAR_VARIANTS = 6;

function accountInitials(name) {
  const text = String(name).trim();
  const latin = text.match(/^[A-Za-z]/u);
  return latin ? text.slice(0, 2).toUpperCase() : text.slice(0, 1);
}

// 같은 계정은 늘 같은 색을 받는다. 계정마다 색만 달라지고 무늬는 공유한다.
function avatarVariant(name) {
  const text = String(name);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100000;
  }
  return String(hash % AVATAR_VARIANTS);
}

function renderSession(session, offline) {
  const user = session.user || {};
  const name = displayName(user);
  $("#account-name").textContent = name;
  const avatar = $("#account-avatar");
  avatar.textContent = accountInitials(name);
  avatar.dataset.avatar = avatarVariant(name);
  $("#account-role").textContent = offline
    ? "오프라인 작업"
    : userIsOwner()
      ? "작업 공간 소유자"
      : userRole() === "admin"
        ? "작업 공간 관리자"
        : "HND 계정";
}

function updateDeviceCommands() {
  const origin = window.location.origin;
  const shellQuote = (value) =>
    `'${String(value).replaceAll("'", `'"'"'`)}'`;
  const powerShellQuote = (value) =>
    `'${String(value).replaceAll("'", "''")}'`;
  const windows = state.deviceInstallPlatform === "windows";
  const name = $("#device-name").value.trim() || "desktop";
  if (state.deviceConnection) state.deviceConnection.expectedName = name;
  for (const button of $$('[data-device-platform]')) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.devicePlatform === state.deviceInstallPlatform),
    );
  }
  for (const button of $$('[data-device-install-mode]')) {
    button.setAttribute(
      "aria-pressed",
      String(
        (button.dataset.deviceInstallMode === "install") ===
          state.includeDeviceConnectorInstall,
      ),
    );
  }
  const platformName = windows
    ? "Windows PowerShell"
    : state.deviceInstallPlatform === "macos"
      ? "macOS 터미널"
      : "Linux 터미널";
  $("#device-platform-help").textContent =
    state.includeDeviceConnectorInstall
      ? `${platformName}에서 hnd 설치부터 시작합니다.`
      : `${platformName}에서 기존 hnd를 그대로 사용합니다.`;
  const connectionCode = state.deviceConnectionCode || "";
  const copyButton = document.querySelector(
    '[data-copy-target="device-join-command"]',
  );
  if (copyButton) copyButton.disabled = !connectionCode;
  if (!connectionCode) {
    $("#device-join-command code").textContent =
      "# 연결 코드를 만들면 이곳에 한 번에 실행할 명령이 표시됩니다.";
    return;
  }
  if (windows) {
    $("#device-join-command code").textContent = [
      ...(state.includeDeviceConnectorInstall
        ? [`npm install --global ${powerShellQuote(CONNECTOR_PACKAGE_SPEC)}`]
        : []),
      `${powerShellQuote(connectionCode)} | hnd connect --url ${powerShellQuote(origin)} --code-stdin --name ${powerShellQuote(name)}`,
      "hnd setup",
    ].join("\n");
    return;
  }
  $("#device-join-command code").textContent = [
    ...(state.includeDeviceConnectorInstall
      ? [`${state.deviceInstallPlatform === "linux" ? "sudo -H " : ""}npm install --global ${shellQuote(CONNECTOR_PACKAGE_SPEC)} &&`]
      : []),
    `printf '%s\\n' ${shellQuote(connectionCode)} | hnd connect --url ${shellQuote(origin)} --code-stdin --name ${shellQuote(name)} &&`,
    "hnd setup",
  ].join("\n");
}

function activeDeviceIds(payload) {
  return new Set(
    listFrom(payload, "devices")
      .filter((device) => !device.revokedAt && !device.revoked_at)
      .map((device) => device.id)
      .filter(Boolean),
  );
}

function stopDeviceConnectionPolling() {
  if (state.deviceConnectionPollTimer) {
    window.clearInterval(state.deviceConnectionPollTimer);
  }
  state.deviceConnectionPollTimer = null;
}

function renderDeviceConnectionStatus(status = "idle", device = null) {
  const panel = $("#device-connection-status");
  const title = $("#device-connection-status-title");
  const copy = $("#device-connection-status-copy");
  const check = $("#check-device-connection");
  panel.dataset.state = status;
  setHidden($("#device-connection-spinner"), status !== "waiting");
  setHidden($("#device-connection-success"), status !== "connected");
  setHidden(check, status !== "waiting");
  check.disabled = status !== "waiting";
  if (status === "waiting") {
    title.textContent = "PC 연결을 기다리는 중";
    copy.textContent = "새 PC에서 명령이 끝나면 이 화면이 자동으로 바뀝니다.";
    return;
  }
  if (status === "connected") {
    title.textContent = "PC 연결 성공";
    const connectedAt = device?.createdAt || device?.created_at;
    copy.textContent = [
      device?.name || t("새 PC"),
      connectedAt ? formatDate(connectedAt) : t("서버 등록 완료"),
    ].join(" · ");
    return;
  }
  if (status === "expired") {
    title.textContent = "연결 코드가 만료되었습니다";
    copy.textContent = "새 연결 명령을 만들어 다시 시도하세요.";
    return;
  }
  title.textContent = "연결 명령 대기";
  copy.textContent = "연결 명령을 만들면 서버 확인을 시작합니다.";
}

function clearDeviceInvitation({ preserveStatus = false } = {}) {
  stopDeviceConnectionPolling();
  state.deviceConnectionCode = null;
  state.deviceConnection = null;
  state.deviceIdsBeforeConnection = new Set();
  $("#device-invitation").textContent = "";
  $("#device-invitation-expiry").textContent = "";
  setHidden($("#device-invitation-wrap"), true);
  showNotice($("#device-dialog-notice"));
  if (!preserveStatus) renderDeviceConnectionStatus();
  updateDeviceCommands();
}

async function checkDeviceConnection({ quiet = false } = {}) {
  const connection = state.deviceConnection;
  if (!connection || !state.deviceConnectionCode) {
    if (!quiet) {
      showNotice(
        $("#device-dialog-notice"),
        "먼저 연결 명령을 만들어 주세요.",
        "warning",
      );
    }
    return false;
  }
  try {
    const payload = await api.devices();
    if (state.deviceConnection?.connectionId !== connection.connectionId) {
      return false;
    }
    const devices = listFrom(payload, "devices").filter(
      (device) => !device.revokedAt && !device.revoked_at,
    );
    const connected = devices.find((device) => {
      if (!device.id || state.deviceIdsBeforeConnection.has(device.id)) {
        return false;
      }
      if (device.name !== connection.expectedName) return false;
      const created = Date.parse(device.createdAt || device.created_at || "");
      return !Number.isFinite(created) || created >= connection.issuedAt - 5_000;
    });
    const expiresAt = Date.parse(connection.expiresAt || "");
    if (!connected && Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      clearDeviceInvitation({ preserveStatus: true });
      renderDeviceConnectionStatus("expired");
      return false;
    }
    if (!connected) return false;
    clearDeviceInvitation({ preserveStatus: true });
    renderDeviceConnectionStatus("connected", connected);
    showNotice($("#device-dialog-notice"));
    toast(`${connected.name || t("새 PC")} ${t("연결 성공")}`);
    if (state.view === "devices") {
      void loadDevices().catch((error) =>
        showNotice($("#devices-error"), error.message, "error"),
      );
    }
    return true;
  } catch (error) {
    if (!quiet) showNotice($("#device-dialog-notice"), error.message, "error");
    return false;
  }
}

function startDeviceConnectionPolling() {
  stopDeviceConnectionPolling();
  state.deviceConnectionPollTimer = window.setInterval(
    () => checkDeviceConnection({ quiet: true }),
    2500,
  );
}

async function createDeviceConnectionCode(event) {
  const button = event.currentTarget;
  clearDeviceInvitation();
  setBusy(button, true, "코드 만드는 중…");
  deviceReauthController?.abort();
  deviceReauthController = new AbortController();
  try {
    state.deviceIdsBeforeConnection = activeDeviceIds(await api.devices());
    const result = await withRecentAuthentication(
      () => createAccountConnection({ ttlSeconds: 900 }),
      {
        signal: deviceReauthController.signal,
        onPrompt: (active) => setHidden($("#cancel-device-auth"), !active),
      },
    );
    if (
      typeof result?.connectionCode !== "string" ||
      typeof result?.connectionId !== "string"
    ) {
      throw new Error("서버가 완전한 연결 코드를 반환하지 않았습니다.");
    }
    $("#device-invitation").textContent = result.connectionCode;
    state.deviceConnectionCode = result.connectionCode;
    state.deviceConnection = {
      connectionId: result.connectionId,
      expiresAt: result.expiresAt,
      expectedName: $("#device-name").value.trim() || "desktop",
      issuedAt: Date.now(),
    };
    $("#device-invitation-expiry").textContent = result.expiresAt
      ? `${formatDate(result.expiresAt)}까지`
      : "15분 동안 유효";
    setHidden($("#device-invitation-wrap"), false);
    updateDeviceCommands();
    renderDeviceConnectionStatus("waiting");
    startDeviceConnectionPolling();
    toast("이 계정의 PC 연결 코드를 만들었습니다.");
  } catch (error) {
    showNotice($("#device-dialog-notice"), error.message, "error");
  } finally {
    deviceReauthController = null;
    setHidden($("#cancel-device-auth"), true);
    setBusy(button, false);
  }
}

async function initialize() {
  try {
    const resolved = await resolveAppSession();
    if (!resolved) return;
    state.session = resolved.session;
    if (resolved.session?.user?.language) {
      applyAccountLanguage(resolved.session.user.language);
    }
    state.tenantId = resolved.tenantId;
    state.offlineBoot = resolved.offline;
    state.offlineAccessEpoch = resolved.offlineAccessEpoch;
    setCsrfToken(resolved.session.csrfToken);
    renderSession(resolved.session, resolved.offline);
    updateDeviceCommands();
    setHidden($("#app-shell"), false);
    setHidden($("#app-loading"), true);
    setHidden($("#app-error-gate"), true);
    const [vaultStatus, initialLocalVault] = await Promise.all([
      resolved.offline ? null : api.vaultStatus(),
      hasLocalVault(state.tenantId),
    ]);
    let localVault = initialLocalVault;
    state.keyManaged = resolved.offline
      ? false
      : vaultStatus?.keyManaged === true;
    state.legacyResetAllowed = Boolean(
      !resolved.offline &&
        vaultStatus?.initialized === true &&
        !state.keyManaged &&
        !localVault,
    );
    if (!localVault && vaultStatus?.initialized === false) {
      window.location.replace("/setup");
      return;
    }
    if (!localVault && state.keyManaged && !resolved.offline) {
      try {
        await withRecentAuthentication(() =>
          unlockManagedBrowserVault(state.tenantId),
        );
        localVault = true;
        state.legacyResetAllowed = false;
      } catch (error) {
        state.vaultLocked = true;
        state.vaultProblem = error;
        updateVaultLockControls();
        showNotice($("#vault-pair-notice"), error.message, "warning");
        await setView(currentView());
        return;
      }
    }
    if (!localVault) {
      state.vaultLocked = true;
      state.vaultProblem = null;
      updateVaultLockControls();
      await setView(currentView());
    } else {
      let dataStore = new SnapshotDataStore(state.tenantId);
      try {
        await dataStore.load();
        dataStore = await recoverStaleManagedCache(dataStore, resolved);
      } catch (error) {
        if (resolved.offline) throw error;
        state.dataStore = null;
        state.vaultLocked = true;
        state.vaultProblem = error;
        updateVaultLockControls();
        showNotice(
          $("#vault-pair-notice"),
          state.keyManaged
            ? "서버 저장본과 이 브라우저의 오프라인 사본을 함께 열지 못했습니다. 패스키로 계정 보관함을 다시 열어 주세요."
            : "이전 방식 보관함의 로컬 키로 저장본을 열지 못했습니다. 키는 그대로 보존했으며 자동으로 초기화하지 않았습니다.",
          "warning",
        );
        await setView(currentView());
        return;
      }
      if (!resolved.offline && vaultStatus?.initialized && !state.keyManaged) {
        try {
          await withRecentAuthentication(() =>
            adoptBrowserVaultKey(state.tenantId),
          );
          state.keyManaged = true;
          state.legacyResetAllowed = false;
        } catch (error) {
          state.dataStore = null;
          state.vaultLocked = true;
          state.vaultProblem = error;
          updateVaultLockControls();
          showNotice($("#vault-pair-notice"), error.message, "warning");
          await setView(currentView());
          return;
        }
      }
      state.dataStore = dataStore;
      await setView(currentView());
    }
  } catch (error) {
    setHidden($("#app-loading"), true);
    setHidden($("#app-shell"), false);
    setHidden($("#vault-gate"), true);
    setHidden($("#view-container"), true);
    setHidden($("#app-error-gate"), false);
    $("#app-error-copy").textContent = error.message;
  }
}

window.addEventListener("hashchange", () => setView(currentView()));
let lastProjectRevalidationAt = 0;

async function revalidateProjectsOnReturn() {
  if (
    state.view !== "projects" ||
    !state.dataStore ||
    document.querySelector("dialog[open]")
  ) return;
  const now = Date.now();
  if (now - lastProjectRevalidationAt < 5_000) return;
  lastProjectRevalidationAt = now;
  try {
    await setView("projects", { force: true });
  } catch (error) {
    showNotice($("#projects-error"), error.message, "error");
  }
}

window.addEventListener("focus", () => void revalidateProjectsOnReturn());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void revalidateProjectsOnReturn();
  }
});
window.addEventListener("online", async () => {
  if (!state.dataStore) return;
  let unauthenticatedSession = false;
  try {
    const session = await api.session();
    if (!session?.authenticated) {
      unauthenticatedSession = true;
      const localVaults = await localTenantIds();
      await Promise.all(
        localVaults.map((id) =>
          disableOfflineWorkspace(id, { sessionId: webSessionId() }),
        ),
      );
      window.location.replace("/");
      return;
    }
    if (session.requiresPasskey) {
      window.location.replace("/setup?recovery=1");
      return;
    }
    if (session.recoveryCodesConfirmed === false) {
      window.location.replace("/setup");
      return;
    }
    const activeTenantId = tenantId(session);
    if (activeTenantId !== state.tenantId) {
      throw new Error("로그인된 작업 공간이 로컬 사본과 다릅니다.");
    }
    state.session = session;
    state.offlineBoot = false;
    setCsrfToken(session.csrfToken);
    const vaultStatus = await api.vaultStatus();
    state.keyManaged = vaultStatus?.keyManaged === true;
    state.legacyResetAllowed = false;
    if (vaultStatus?.initialized === true && !state.keyManaged) {
      await withRecentAuthentication(() =>
        adoptBrowserVaultKey(state.tenantId),
      );
      state.keyManaged = true;
    }
    renderSession(session, false);
    await enableCurrentOfflineWorkspace().catch(() => {});
    await state.dataStore.sync();
    updateSyncChip();
    if (["home", "projects", "devices"].includes(state.view)) {
      await setView(state.view, { force: true });
    }
  } catch (error) {
    updateSyncChip();
    if (unauthenticatedSession) {
      toast(
        `${t("로그아웃 상태를 안전하게 반영하지 못했습니다. 페이지를 새로고침해 다시 시도해 주세요.")} ${error.message}`,
        "error",
      );
    } else if (!state.keyManaged) {
      toast(
        `계정 보관함 전환을 마치지 못했습니다. 새로고침해 다시 시도해 주세요. ${error.message}`,
        "error",
      );
    }
  }
});
$("#sidebar-open").addEventListener("click", openSidebar);
$("#sidebar-close").addEventListener("click", closeSidebar);
$("#sidebar-scrim").addEventListener("click", closeSidebar);
$("#app-retry").addEventListener("click", () => window.location.reload());
$("#sync-retry").addEventListener("click", retrySync);
$("#sync-reconnect-vault").addEventListener("click", reconnectManagedVault);
$("#sync-keep-local").addEventListener("click", (event) =>
  resolveSyncConflict(event, "local"),
);
$("#sync-use-server").addEventListener("click", (event) =>
  resolveSyncConflict(event, "server"),
);
$("#connect-device").addEventListener("click", () => {
  if (state.offlineBoot || !state.keyManaged) return;
  clearDeviceInvitation();
  updateDeviceCommands();
  $("#device-dialog").showModal();
});
$("#devices-retry").addEventListener("click", () =>
  setView("devices", { force: true }),
);
$("#logout-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "…");
  try {
    const localVaults = await localTenantIds();
    await logoutAfterRevokingOfflineAccess(
      localVaults,
      () => api.logout(),
      { sessionId: webSessionId() },
    );
    window.location.replace("/");
  } catch (error) {
    toast(error.message, "error");
    setBusy(button, false);
  }
});
document.addEventListener("click", async (event) => {
  const opener = event.target.closest("[data-open-dialog]");
  if (opener) {
    state.returnAfterDialog = null;
    openDialog(opener.dataset.openDialog);
  }
  const closer = event.target.closest("[data-close-dialog]");
  if (closer) closeDialog(closer.closest("dialog"));
  const action = event.target.closest("[data-action]");
  if (action) {
    try {
      await handleAction(action);
    } catch (error) {
      toast(error.message, "error");
    }
  }
});
$("#project-filter").addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadProjects(formObject(event.currentTarget));
  state.loaded.add("projects");
});
$("#rule-filter").addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadRules(formObject(event.currentTarget));
  state.loaded.add("rules");
});
$("#work-filter").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitter = event.submitter;
  if (submitter?.name === "status") {
    state.workStatus = submitter.value;
    for (const button of $$(".segmented button", event.currentTarget))
      button.setAttribute("aria-pressed", String(button === submitter));
  }
  const query = new FormData(event.currentTarget).get("q")?.toString().trim();
  await loadWork({ q: query });
  state.loaded.add("work");
});
$("#knowledge-filter").addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadKnowledge(formObject(event.currentTarget));
  state.loaded.add("knowledge");
});
$('#knowledge-filter [name="scope"]').addEventListener("change", (event) => {
  const form = event.currentTarget.form;
  populateRepositoryFields(form);
  updateKnowledgeFilterFields(form);
});
$("#rule-form").addEventListener("submit", submitRule);
$('#rule-form [name="scope"]').addEventListener("change", (event) =>
  updateRuleScopeFields(event.currentTarget.form),
);
$('#rule-form [name="environment"]').addEventListener("input", (event) =>
  updateRuleEnvironmentCommand(event.currentTarget.form),
);
$("#work-form").addEventListener("submit", submitWork);
$("#project-form").addEventListener("submit", submitProject);
$("#knowledge-form").addEventListener("submit", submitKnowledge);
$('#knowledge-form [name="scope"]').addEventListener("change", (event) =>
  updateKnowledgeScopeFields(event.currentTarget.form),
);
$("#vault-account-unlock").addEventListener("click", unlockVaultFromAccount);
$("#open-vault-reset").addEventListener("click", openVaultResetDialog);
$("#vault-reset-confirmation").addEventListener(
  "input",
  updateVaultResetConfirmation,
);
$("#vault-reset-form").addEventListener("submit", submitVaultReset);
$("#add-passkey").addEventListener("click", addPasskey);
$("#renew-recovery").addEventListener("click", renewRecovery);
$("#app-download-recovery").addEventListener("click", () => {
  if (state.pendingRecoveryCodes.length === 0) return;
  downloadText(
    "hnd-recovery-codes.txt",
    `${state.pendingRecoveryCodes.join("\n")}\n`,
  );
});
$("#app-recovery-confirmed").addEventListener("change", (event) => {
  $("#app-recovery-finish").disabled = !event.currentTarget.checked;
});
$("#recovery-confirm-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#app-recovery-finish");
  if (!state.pendingRecoveryConfirmationId) return;
  setBusy(button, true, "확인 중…");
  showNotice($("#app-recovery-error"));
  try {
    await withRecentAuthentication(() =>
      api.recoveryConfirm({
        confirmationId: state.pendingRecoveryConfirmationId,
      }),
    );
    state.pendingRecoveryCodes = [];
    state.pendingRecoveryConfirmationId = null;
    $("#app-recovery-codes").textContent = "";
    $("#recovery-dialog").close();
    toast("새 복구 코드 저장을 확인했습니다.");
  } catch (error) {
    showNotice($("#app-recovery-error"), error.message, "error");
  } finally {
    setBusy(button, false);
  }
});
$("#recovery-dialog").addEventListener("cancel", (event) => {
  if (state.pendingRecoveryConfirmationId) event.preventDefault();
});
$("#account-invite-form").addEventListener("submit", submitAccountInvite);
$("#create-device-invitation").addEventListener(
  "click",
  createDeviceConnectionCode,
);
$("#cancel-device-auth").addEventListener("click", () => {
  deviceReauthController?.abort();
});
$("#device-name").addEventListener("input", updateDeviceCommands);
$("#check-device-connection").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "확인 중…");
  await checkDeviceConnection();
  setBusy(button, false);
});
$("#device-dialog").addEventListener("close", () => {
  deviceReauthController?.abort();
  clearDeviceInvitation();
});
for (const button of $$('[data-device-platform]')) {
  button.addEventListener("click", () => {
    state.deviceInstallPlatform = button.dataset.devicePlatform;
    updateDeviceCommands();
  });
}
for (const button of $$('[data-device-install-mode]')) {
  button.addEventListener("click", () => {
    state.includeDeviceConnectorInstall =
      button.dataset.deviceInstallMode === "install";
    updateDeviceCommands();
  });
}
$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  setBusy(button, true, "저장 중…");
  try {
    await api.updateSettings({
      displayName: $("#settings-display-name").value.trim(),
      language: $("#settings-language").value,
    });
    state.session.user.displayName = $("#settings-display-name").value.trim();
    state.session.user.language = $("#settings-language").value;
    setLanguagePreference(state.session.user.language);
    $("#account-name").textContent = displayName(state.session.user);
    toast("계정 설정을 저장했습니다.");
  } catch (error) {
    showNotice($("#settings-error"), error.message, "error");
  } finally {
    setBusy(button, false);
  }
});
$("#server-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  setBusy(button, true, "저장 중…");
  try {
    await withRecentAuthentication(() =>
      api.updateSettings({
        signupMode: $("#signup-mode").value,
        revisionRetention: Number($("#revision-retention").value),
      }),
    );
    toast("서버 설정을 저장했습니다.");
  } catch (error) {
    showNotice($("#settings-error"), error.message, "error");
  } finally {
    setBusy(button, false);
  }
});
installCopyButtons();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
}
initialize();
