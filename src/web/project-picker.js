import { t } from "./i18n.js";
import { element } from "./ui.js";

// The native select remains the form's source of truth. This enhancement only
// replaces its presentation; filtering still uses the existing change handler.
export function createProjectPicker(select, { label = "프로젝트 필터" } = {}) {
  const root = select.parentElement;
  const doc = select.ownerDocument;
  const win = doc.defaultView;
  const wasHidden = select.hidden;
  const trigger = element("button", {
    className: "project-picker-trigger",
    attrs: {
      id: `${select.id}-trigger`, type: "button", role: "combobox",
      "aria-haspopup": "listbox", "aria-expanded": "false",
      "aria-controls": `${select.id}-listbox`,
    },
  });
  const value = element("span", { className: "project-picker-value" });
  const valueTitle = element("span", { className: "project-picker-value-title" });
  const valueDetail = element("span", { className: "project-picker-value-detail" });
  value.append(valueTitle, valueDetail);
  const chevron = element("span", {
    className: "project-picker-chevron", attrs: { "aria-hidden": "true" },
  });
  trigger.append(value, chevron);
  const listbox = element("div", {
    className: "project-picker-listbox",
    attrs: { id: `${select.id}-listbox`, role: "listbox" },
  });
  listbox.hidden = true;
  root.append(trigger, listbox);
  root.classList.add("project-picker");
  select.hidden = true;

  let entries = [];
  let activeIndex = -1;
  let typed = "";
  let typedAt = 0;

  function close() {
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
    entries = [...select.options].map((option, index) => {
      const title = t(option.dataset.title || option.textContent);
      const detail = option.dataset.detail ? t(option.dataset.detail) : "";
      const node = element("div", {
        className: "project-picker-option",
        attrs: {
          id: `${select.id}-option-${index}`, role: "option",
          "data-value": option.value,
          "aria-selected": String(option.value === select.value),
          "aria-disabled": String(option.disabled),
        },
      });
      if (!option.value) node.classList.add("project-picker-all");
      const copy = element("span", { className: "project-picker-option-copy" });
      copy.append(element("span", { className: "project-picker-option-title", text: title }));
      if (detail) copy.append(element("span", { className: "project-picker-option-detail", text: detail }));
      node.append(copy, element("span", {
        className: "project-picker-check", attrs: { "aria-hidden": "true" },
      }));
      return { node, value: option.value, title, detail, disabled: option.disabled };
    });
    listbox.replaceChildren(...entries.map((entry) => entry.node));
    const selected = entries.find((entry) => entry.value === select.value);
    const summary = selected
      ? [selected.title, selected.detail].filter(Boolean).join(" · ")
      : "";
    valueTitle.textContent = selected?.title || t("모든 프로젝트");
    valueDetail.textContent = selected?.detail || "";
    valueDetail.hidden = !selected?.detail;
    trigger.title = summary;
    trigger.setAttribute("aria-label", `${t(label)}: ${summary}`);
    trigger.disabled = select.disabled;
    listbox.setAttribute("aria-label", t(label));
    root.classList.toggle("has-project", Boolean(select.value));
    if (select.disabled) close();
    const previous = entries.findIndex((entry) => entry.value === activeValue && !entry.disabled);
    const current = entries.findIndex((entry) => entry.value === select.value && !entry.disabled);
    highlight(!listbox.hidden && previous >= 0 ? previous : current, { scroll: !listbox.hidden });
  }

  function open() {
    if (select.disabled) return;
    refresh();
    listbox.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const bounds = trigger.getBoundingClientRect();
    const viewport = win.visualViewport;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportBottom = viewportTop + (viewport?.height || win.innerHeight);
    const below = Math.max(0, viewportBottom - bounds.bottom - 24);
    const above = Math.max(0, bounds.top - viewportTop - 24);
    const opensAbove = below < 240 && above > below;
    listbox.classList.toggle("opens-above", opensAbove);
    listbox.style.maxHeight = `${Math.max(48, Math.min(360, opensAbove ? above : below))}px`;
    const selected = entries.findIndex((entry) => entry.value === select.value && !entry.disabled);
    highlight(selected >= 0 ? selected : entries.findIndex((entry) => !entry.disabled));
  }

  function choose(index) {
    const entry = entries[index];
    if (!entry || entry.disabled || select.disabled) return;
    const changed = select.value !== entry.value;
    select.value = entry.value;
    close();
    refresh();
    trigger.focus({ preventScroll: true });
    if (changed) select.dispatchEvent(new win.Event("change", { bubbles: true }));
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

  trigger.addEventListener("click", onClick);
  trigger.addEventListener("keydown", onKeyDown);
  trigger.addEventListener("blur", close);
  listbox.addEventListener("click", onOptionClick);
  listbox.addEventListener("pointerdown", keepFocus);
  select.addEventListener("change", refresh);
  doc.addEventListener("pointerdown", onOutsidePointer);
  win.addEventListener("resize", close);
  win.addEventListener("hnd:language", refresh);
  const observer = new win.MutationObserver(refresh);
  observer.observe(select, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["disabled", "label", "data-title", "data-detail"],
  });
  refresh();

  return {
    trigger, listbox, refresh, close,
    destroy() {
      observer.disconnect();
      select.removeEventListener("change", refresh);
      doc.removeEventListener("pointerdown", onOutsidePointer);
      win.removeEventListener("resize", close);
      win.removeEventListener("hnd:language", refresh);
      trigger.remove();
      listbox.remove();
      root.classList.remove("project-picker", "has-project");
      select.hidden = wasHidden;
    },
  };
}
