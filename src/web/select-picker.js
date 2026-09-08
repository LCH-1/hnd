import { t } from "./i18n.js";
import { element } from "./ui.js";

// The native select remains the form's source of truth. This enhancement only
// replaces its presentation; form values and change handlers remain native.
let pickerId = 0;

export function createSelectPicker(select, { label } = {}) {
  const originalId = select.id;
  if (!select.id) select.id = `hnd-select-${++pickerId}`;
  const labels = [...(select.labels || [])];
  label ||= select.getAttribute("aria-label") || labels.map((node) =>
    [...node.childNodes].filter((child) => child.nodeType === 3 || child.classList?.contains("sr-only"))
      .map((child) => child.textContent).join("")
  ).join(" ").trim() || select.name;
  const root = select.parentElement;
  const doc = select.ownerDocument;
  const win = doc.defaultView;
  const wasHidden = select.hidden;
  const trigger = element("button", {
    className: "select-picker-trigger",
    attrs: {
      id: `${select.id}-trigger`, type: "button", role: "combobox",
      "aria-haspopup": "listbox", "aria-expanded": "false",
      "aria-controls": `${select.id}-listbox`,
    },
  });
  const value = element("span", { className: "select-picker-value" });
  const valueTitle = element("span", { className: "select-picker-value-title" });
  const valueDetail = element("span", { className: "select-picker-value-detail" });
  value.append(valueTitle, valueDetail);
  const chevron = element("span", {
    className: "select-picker-chevron", attrs: { "aria-hidden": "true" },
  });
  trigger.append(value, chevron);
  const listbox = element("div", {
    className: "select-picker-listbox",
    attrs: { id: `${select.id}-listbox`, role: "listbox" },
  });
  listbox.hidden = true;
  // A popover lives above dialog overflow while staying inside its focus scope.
  const usesPopover = typeof listbox.showPopover === "function";
  if (usesPopover) listbox.setAttribute("popover", "manual");
  const error = element("span", {
    className: "select-picker-error",
    attrs: { id: `${select.id}-error`, role: "alert" },
  });
  error.hidden = true;
  // Keep helper text after the control, matching the native field's order.
  select.after(trigger, listbox, error);
  root.classList.add("select-picker");
  select.hidden = true;

  let entries = [];
  let activeIndex = -1;
  let typed = "";
  let typedAt = 0;
  let validationTimer;

  function close() {
    if (usesPopover && !listbox.hidden) listbox.hidePopover();
    listbox.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    typed = "";
  }

  function highlight(index, { scroll = true } = {}) {
    activeIndex = index;
    for (const [position, entry] of entries.entries()) {
      entry.node.classList.toggle("is-active", position === index);
    }
    const active = entries[index];
    if (!listbox.hidden && active) {
      trigger.setAttribute("aria-activedescendant", active.node.id);
      // Scroll only the list, never the entire work page behind the popup.
      if (scroll) {
        const top = active.node.offsetTop;
        const bottom = top + active.node.offsetHeight;
        if (top < listbox.scrollTop) listbox.scrollTop = top;
        else if (bottom > listbox.scrollTop + listbox.clientHeight) {
          listbox.scrollTop = bottom - listbox.clientHeight;
        }
      }
    }
  }

  function refresh() {
    const activeValue = entries[activeIndex]?.value;
    entries = [...select.options].filter((option) => !option.hidden
      && !(option.parentElement.tagName === "OPTGROUP" && option.parentElement.hidden)).map((option, index) => {
      const title = t(option.dataset.title || option.label || option.textContent);
      const detail = option.dataset.detail ? t(option.dataset.detail) : "";
      const disabled = option.disabled || (option.parentElement.tagName === "OPTGROUP" && option.parentElement.disabled);
      const node = element("div", {
        className: "select-picker-option",
        attrs: {
          id: `${select.id}-option-${index}`, role: "option",
          "data-value": option.value,
          "aria-selected": String(option.value === select.value),
          "aria-disabled": String(disabled),
        },
      });
      const copy = element("span", { className: "select-picker-option-copy" });
      copy.append(element("span", { className: "select-picker-option-title", text: title }));
      if (detail) copy.append(element("span", { className: "select-picker-option-detail", text: detail }));
      node.append(copy, element("span", {
        className: "select-picker-check", attrs: { "aria-hidden": "true" },
      }));
      return { node, value: option.value, title, detail, disabled };
    });
    listbox.replaceChildren(...entries.map((entry) => entry.node));
    const selected = entries.find((entry) => entry.value === select.value);
    const summary = selected
      ? [selected.title, selected.detail].filter(Boolean).join(" · ")
      : "";
    valueTitle.textContent = selected?.title || t("선택 안 됨");
    valueDetail.textContent = selected?.detail || "";
    valueDetail.hidden = !selected?.detail;
    trigger.title = summary;
    trigger.setAttribute("aria-label", `${t(label)}: ${summary}`);
    trigger.disabled = select.disabled;
    listbox.setAttribute("aria-label", t(label));
    root.classList.toggle("has-detail", Boolean(selected?.detail));
    trigger.setAttribute("aria-required", String(Boolean(select.required)));
    if (!select.validity || select.validity.valid || select.disabled) {
      error.hidden = true;
      error.textContent = "";
      trigger.removeAttribute("aria-invalid");
    }
    const description = [select.getAttribute("aria-describedby"), error.hidden ? null : error.id].filter(Boolean).join(" ");
    if (description) trigger.setAttribute("aria-describedby", description);
    else trigger.removeAttribute("aria-describedby");
    if (select.disabled) close();
    const previous = entries.findIndex((entry) => entry.value === activeValue && !entry.disabled);
    const current = entries.findIndex((entry) => entry.value === select.value && !entry.disabled);
    highlight(!listbox.hidden && previous >= 0 ? previous : current, { scroll: !listbox.hidden });
    if (!listbox.hidden) position();
  }

  function open() {
    if (select.disabled) return;
    trigger.dispatchEvent(new win.Event("hnd:select-open", { bubbles: true }));
    refresh();
    listbox.hidden = false;
    if (usesPopover) listbox.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    position();
    const selected = entries.findIndex((entry) => entry.value === select.value && !entry.disabled);
    highlight(selected >= 0 ? selected : entries.findIndex((entry) => !entry.disabled));
  }

  function position() {
    const bounds = trigger.getBoundingClientRect();
    const viewport = win.visualViewport;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportBottom = viewportTop + (viewport?.height || win.innerHeight);
    const below = Math.max(0, viewportBottom - bounds.bottom - 24);
    const above = Math.max(0, bounds.top - viewportTop - 24);
    const opensAbove = below < 240 && above > below;
    listbox.classList.toggle("opens-above", opensAbove);
    listbox.style.maxHeight = `${Math.max(48, Math.min(360, opensAbove ? above : below))}px`;
    const viewportLeft = viewport?.offsetLeft || 0;
    const viewportWidth = viewport?.width || win.innerWidth;
    const width = Math.min(Math.max(bounds.width, entries.some((entry) => entry.detail) ? 340 : 180), viewportWidth - 32);
    listbox.style.width = `${width}px`;
    listbox.style.left = `${Math.max(viewportLeft + 16, Math.min(bounds.left, viewportLeft + viewportWidth - width - 16))}px`;
    listbox.style.top = `${opensAbove ? bounds.top - listbox.getBoundingClientRect().height - 8 : bounds.bottom + 8}px`;
  }

  function choose(index) {
    const entry = entries[index];
    if (!entry || entry.disabled || select.disabled) return;
    const changed = select.value !== entry.value;
    select.value = entry.value;
    close();
    refresh();
    trigger.focus({ preventScroll: true });
    if (changed) {
      select.dispatchEvent(new win.Event("input", { bubbles: true }));
      select.dispatchEvent(new win.Event("change", { bubbles: true }));
    }
  }

  function onClick() {
    if (listbox.hidden) open();
    else close();
  }

  function onKeyDown(event) {
    if (event.isComposing || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape" || (event.altKey && event.key === "ArrowUp")) {
      if (!listbox.hidden) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      return;
    }
    if (event.key === "Tab") return close();
    if (event.altKey && event.key !== "ArrowDown") return;
    if (["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const wasOpen = !listbox.hidden;
      if (!wasOpen) open();
      if (["Enter", " "].includes(event.key)) {
        if (wasOpen) choose(activeIndex);
        return;
      }
      const available = entries.map((entry, index) => entry.disabled ? -1 : index).filter((index) => index >= 0);
      if (!available.length) return;
      if (event.key === "Home") return highlight(available[0]);
      if (event.key === "End") return highlight(available.at(-1));
      if (!wasOpen) return;
      const next = available.indexOf(activeIndex) + (event.key === "ArrowDown" ? 1 : -1);
      highlight(available[Math.max(0, Math.min(available.length - 1, next))]);
      return;
    }
    if (event.key.length === 1 && !event.altKey) {
      event.preventDefault();
      if (listbox.hidden) open();
      const now = Date.now();
      typed = now - typedAt < 700 ? typed + event.key.toLocaleLowerCase() : event.key.toLocaleLowerCase();
      typedAt = now;
      const repeated = [...typed].every((character) => character === typed[0]);
      const query = repeated ? typed[0] : typed;
      const start = repeated ? activeIndex + 1 : Math.max(0, activeIndex);
      for (let offset = 0; offset < entries.length; offset += 1) {
        const index = (start + offset) % entries.length;
        const entry = entries[index];
        if (!entry.disabled && [entry.title, entry.detail].some((text) => text.toLocaleLowerCase().startsWith(query))) {
          highlight(index);
          break;
        }
      }
    }
  }

  function onOptionClick(event) {
    event.preventDefault();
    const option = event.target.closest('[role="option"]');
    if (option && listbox.contains(option)) choose(entries.findIndex((entry) => entry.node === option));
  }

  function onOutsidePointer(event) {
    if (!root.contains(event.target)) close();
  }

  function keepFocus(event) {
    // Keep DOM focus on the combobox for mouse, pen and touch selection.
    // Touch scrolling is handled separately by the list's pan-y touch action.
    if (event.target.closest('[role="option"]')) event.preventDefault();
  }

  function onInvalid(event) {
    // Hidden native fields still validate, but the visible control owns focus.
    event.preventDefault();
    error.textContent = select.validationMessage;
    error.hidden = false;
    trigger.setAttribute("aria-invalid", "true");
    trigger.setAttribute("aria-describedby", [select.getAttribute("aria-describedby"), error.id].filter(Boolean).join(" "));
    const firstInvalid = select.form?.querySelector(":invalid");
    if (firstInvalid && firstInvalid !== select) return;
    trigger.focus();
    // The browser can focus the next native invalid field after this handler.
    // Restore the first invalid control once native validation has finished.
    clearTimeout(validationTimer);
    validationTimer = setTimeout(() => {
      if (select.isConnected && !select.disabled && !select.validity.valid) trigger.focus();
    }, 0);
  }

  function onLabelClick(event) {
    if (trigger.contains(event.target) || listbox.contains(event.target)) return;
    event.preventDefault();
    trigger.focus();
  }

  function onReset() {
    close();
    queueMicrotask(refresh);
  }

  function onOtherOpen(event) {
    if (event.target !== trigger) close();
  }

  function onScroll(event) {
    // Opening/focusing a field in a scrollable dialog can queue a scroll event.
    // Track the control instead of dismissing a popup that has just opened.
    if (!listbox.hidden && !listbox.contains(event.target)) position();
  }

  trigger.addEventListener("click", onClick);
  trigger.addEventListener("keydown", onKeyDown);
  trigger.addEventListener("blur", close);
  listbox.addEventListener("click", onOptionClick);
  listbox.addEventListener("pointerdown", keepFocus);
  select.addEventListener("change", refresh);
  select.addEventListener("invalid", onInvalid);
  select.form?.addEventListener("reset", onReset);
  const dialog = select.closest("dialog");
  dialog?.addEventListener("close", close);
  for (const node of labels) node.addEventListener("click", onLabelClick);
  doc.addEventListener("pointerdown", onOutsidePointer);
  doc.addEventListener("hnd:select-open", onOtherOpen);
  doc.addEventListener("scroll", onScroll, true);
  win.addEventListener("resize", close);
  win.addEventListener("hashchange", close);
  win.visualViewport?.addEventListener("resize", close);
  win.addEventListener("hnd:language", refresh);
  const observer = new win.MutationObserver(refresh);
  observer.observe(select, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["disabled", "required", "hidden", "selected", "value", "aria-describedby", "label", "data-title", "data-detail"],
  });
  refresh();

  return {
    trigger, listbox, refresh, close,
    destroy() {
      clearTimeout(validationTimer);
      close();
      observer.disconnect();
      select.removeEventListener("change", refresh);
      select.removeEventListener("invalid", onInvalid);
      select.form?.removeEventListener("reset", onReset);
      dialog?.removeEventListener("close", close);
      for (const node of labels) node.removeEventListener("click", onLabelClick);
      doc.removeEventListener("pointerdown", onOutsidePointer);
      doc.removeEventListener("hnd:select-open", onOtherOpen);
      doc.removeEventListener("scroll", onScroll, true);
      win.removeEventListener("resize", close);
      win.removeEventListener("hashchange", close);
      win.visualViewport?.removeEventListener("resize", close);
      win.removeEventListener("hnd:language", refresh);
      trigger.remove();
      listbox.remove();
      error.remove();
      root.classList.remove("select-picker", "has-detail");
      select.hidden = wasHidden;
      if (!originalId) select.removeAttribute("id");
    },
  };
}
