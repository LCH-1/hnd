import { currentLanguage, currentLocale, t } from "./i18n.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [
  ...root.querySelectorAll(selector),
];

const busyContents = new WeakMap();

export function setHidden(element, hidden) {
  if (!element) return;
  element.hidden = Boolean(hidden);
}

export function setBusy(button, busy, busyText = t("처리 중…")) {
  if (!button) return;
  if (busy) {
    if (!busyContents.has(button)) {
      busyContents.set(
        button,
        [...button.childNodes].map((node) => node.cloneNode(true)),
      );
    }
    button.replaceChildren(document.createTextNode(t(busyText)));
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  } else {
    const contents = busyContents.get(button);
    if (contents) {
      button.replaceChildren(...contents.map((node) => node.cloneNode(true)));
    }
    busyContents.delete(button);
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

export function showNotice(element, message = "", kind = "info") {
  if (!element) return;
  element.textContent = t(message);
  element.dataset.kind = kind;
  element.hidden = !message;
}

export function displayName(user) {
  return (
    user?.displayName ||
    user?.display_name ||
    user?.username ||
    user?.name ||
    t("사용자")
  );
}

export function relativeTime(value) {
  if (!value) return t("기록 없음");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("알 수 없음");
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(currentLanguage(), { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3600)
    return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86400)
    return formatter.format(Math.round(seconds / 3600), "hour");
  if (absolute < 2_592_000)
    return formatter.format(Math.round(seconds / 86400), "day");
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatDate(value) {
  if (!value) return t("기록 없음");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("알 수 없음");
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return t("알 수 없음");
  const units = ["B", "KB", "MB", "GB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

export async function copyText(value, button) {
  const original = button?.textContent;
  try {
    await navigator.clipboard.writeText(String(value));
    if (button) button.textContent = t("복사됨");
  } catch {
    if (button) button.textContent = t("직접 선택");
    throw new Error("자동 복사에 실패했습니다. 내용을 직접 선택해 주세요.");
  } finally {
    if (button)
      window.setTimeout(() => {
        button.textContent = original;
      }, 1800);
  }
}

export function downloadText(
  filename,
  contents,
  type = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function clearChildren(element) {
  element?.replaceChildren();
}

export function element(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value !== undefined && value !== null)
        node.setAttribute(name, String(value));
    }
  }
  return node;
}

export function listFrom(payload, preferredKey) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[preferredKey])) return payload[preferredKey];
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

export function installCopyButtons(root = document) {
  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy-target]");
    if (!button) return;
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;
    try {
      await copyText(target.textContent, button);
    } catch (error) {
      const notice = button
        .closest("[data-copy-region]")
        ?.querySelector('[role="status"]');
      showNotice(notice, error.message, "error");
    }
  });
}

export function toast(message, kind = "success") {
  const region = $("#toast-region");
  if (!region) return;
  const item = element("div", {
    className: `toast toast-${kind}`,
    text: message,
    attrs: { role: kind === "error" ? "alert" : "status" },
  });
  region.append(item);
  window.setTimeout(() => item.remove(), 4200);
}
