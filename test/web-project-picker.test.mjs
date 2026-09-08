import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectPicker } from '../src/web/project-picker.js';
import { t as translate } from '../src/web/i18n.js';

class MockElement {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this._text = '';
    this._value = '';
    this.classList = {
      contains: value => this.className.split(/\s+/u).includes(value),
      add: (...values) => { this.className = [...new Set([...this.className.split(/\s+/u).filter(Boolean), ...values])].join(' '); },
      remove: (...values) => { this.className = this.className.split(/\s+/u).filter(value => !values.includes(value)).join(' '); },
      toggle: (value, enabled = !this.classList.contains(value)) => {
        this.classList[enabled ? 'add' : 'remove'](value);
        return enabled;
      },
    };
  }
  get id() { return this.attributes.get('id') || ''; }
  set id(value) { this.attributes.set('id', value); }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get childNodes() { return this.children; }
  get options() { return this.children; }
  get selectedOptions() { return this.options.filter(option => option.value === this.value); }
  get selectedIndex() { return this.options.findIndex(option => option.value === this.value); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get isConnected() { return this.ownerDocument.body.contains(this); }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'value') this.value = value;
    if (name === 'class') this.className = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatchEvent(event) {
    if (!event.target) Object.defineProperty(event, 'target', { configurable: true, value: this });
    Object.defineProperty(event, 'currentTarget', { configurable: true, value: this });
    for (const listener of [...(this.listeners.get(event.type) || [])]) listener(event);
    if (event.bubbles && !event.cancelBubble) this.parentElement?.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  contains(other) { return other === this || this.children.some(child => child.contains(other)); }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attribute = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/u.exec(selector);
    if (attribute) return attribute[2] === undefined ? this.hasAttribute(attribute[1]) : this.getAttribute(attribute[1]) === attribute[2];
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return this.rect || { top: 120, bottom: 160, height: 40, left: 100, right: 332, width: 232 }; }
  scrollIntoView(options) { this.lastScroll = options; }
}

function event(type, values = {}) {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), values);
}

function fixture(t) {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const document = new MockElement('document', null);
  document.ownerDocument = document;
  document.body = new MockElement('body', document);
  document.append(document.body);
  document.activeElement = null;
  document.createElement = tag => new MockElement(tag, document);
  document.getElementById = id => document.querySelector(`#${id}`);
  const observers = [];
  class MockMutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  document.defaultView = document;
  document.innerHeight = 900;
  document.Event = Event;
  document.MutationObserver = MockMutationObserver;
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: document },
    MutationObserver: { configurable: true, value: MockMutationObserver },
    window: { configurable: true, value: document },
  });
  function restoreGlobals() {
    for (const [name, descriptor] of [['document', oldDocument], ['MutationObserver', oldObserver], ['window', oldWindow]]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
  const form = document.createElement('form');
  const wrapper = document.createElement('div');
  const select = document.createElement('select');
  select.id = 'work-project-filter';
  select.name = 'repository';
  wrapper.append(select);
  form.append(wrapper);
  document.body.append(form);
  function option(value, title, detail = '') {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = detail ? `${title} · ${detail}` : title;
    if (value) {
      node.dataset.title = title;
      node.dataset.detail = detail;
    }
    return node;
  }
  select.append(
    option('', '모든 프로젝트'),
    option('a', 'backend', 'example/education-backend'),
    option('b', 'backend', 'example/calendar-backend'),
    option('c', '<img src=x onerror=alert(1)>', 'Git 원격 없음'),
  );
  const changes = [];
  form.addEventListener('change', change => changes.push({ value: select.value, target: change.target }));
  const picker = createProjectPicker(select);
  t.after(() => { try { picker.destroy(); } finally { restoreGlobals(); } });
  const key = (value, extras = {}) => {
    const current = event('keydown', { key: value, ...extras });
    picker.trigger.dispatchEvent(current);
    return current;
  };
  const click = target => target.dispatchEvent(event('click'));
  return {
    ...picker, select, form, wrapper, document, changes, observers, key, click, option,
    options: () => picker.listbox.querySelectorAll('[role="option"]'),
    selected: () => picker.listbox.querySelectorAll('[aria-selected="true"]'),
    active: () => document.getElementById(picker.trigger.getAttribute('aria-activedescendant')),
    mutation: () => { for (const observer of observers.filter(item => !item.disconnected)) observer.callback([]); },
  };
}

test('project picker retains a hidden form value and uses safe, separately styled project and remote text', t => {
  const view = fixture(t);
  assert.equal(view.select.hidden, true);
  assert.equal(view.select.name, 'repository');
  assert.equal(view.trigger.getAttribute('type'), 'button');
  assert.equal(view.trigger.getAttribute('role'), 'combobox');
  assert.equal(view.trigger.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(view.trigger.getAttribute('aria-controls'), view.listbox.id);
  assert.equal(view.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(view.listbox.getAttribute('role'), 'listbox');
  assert.equal(view.listbox.hidden, true);
  assert.equal(view.select.value, '');
  assert.equal(view.options().length, 4);
  assert.equal(view.selected().length, 1);
  const names = view.options().map(node => node.querySelector('.project-picker-option-title').textContent);
  assert.deepEqual(names, [translate('모든 프로젝트'), 'backend', 'backend', '<img src=x onerror=alert(1)>']);
  assert.equal(view.options()[1].querySelector('.project-picker-option-detail').textContent, 'example/education-backend');
  assert.equal(view.options()[2].querySelector('.project-picker-option-detail').textContent, 'example/calendar-backend');
  assert.equal(view.listbox.querySelector('img'), null);
});

test('choosing a project emits one bubbling native change and reopening highlights the actual selection', t => {
  const view = fixture(t);
  view.click(view.trigger);
  assert.equal(view.trigger.getAttribute('aria-expanded'), 'true');
  view.click(view.options()[2]);
  assert.equal(view.select.value, 'b');
  assert.deepEqual(view.changes, [{ value: 'b', target: view.select }]);
  assert.equal(view.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(view.document.activeElement, view.trigger);
  assert.match(view.trigger.textContent, /backend/u);
  view.click(view.trigger);
  assert.equal(view.active()?.dataset.value, 'b');
  assert.equal(view.selected()[0].dataset.value, 'b');
  view.click(view.options()[0]);
  assert.equal(view.select.value, '');
  assert.equal(view.changes.length, 2);
});

test('keyboard navigation changes only the active option until Enter or Space commits', t => {
  const view = fixture(t);
  view.key('ArrowDown');
  assert.equal(view.trigger.getAttribute('aria-expanded'), 'true');
  view.key('End');
  assert.equal(view.active()?.dataset.value, 'c');
  assert.equal(view.select.value, '');
  assert.equal(view.changes.length, 0);
  view.key('Home');
  assert.equal(view.active()?.dataset.value, '');
  view.key('ArrowDown');
  assert.equal(view.active()?.dataset.value, 'a');
  view.key('Enter');
  assert.equal(view.select.value, 'a');
  assert.equal(view.changes.length, 1);
  view.key(' ');
  view.key('ArrowDown');
  view.key(' ');
  assert.equal(view.select.value, 'b');
  assert.equal(view.changes.length, 2);
});

test('Escape, Tab, outside pointer, and blur dismiss pending choices without changing filters', t => {
  const view = fixture(t);
  for (const dismiss of [
    () => view.key('Escape'),
    () => assert.equal(view.key('Tab').defaultPrevented, false),
    () => view.document.body.dispatchEvent(event('pointerdown')),
    () => view.trigger.dispatchEvent(event('blur', { relatedTarget: view.document.body })),
  ]) {
    view.click(view.trigger);
    view.key('End');
    dismiss();
    assert.equal(view.trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(view.select.value, '');
    assert.equal(view.changes.length, 0);
  }
});

test('typeahead matches repository names and remotes without committing or intercepting IME and shortcut keys', t => {
  const view = fixture(t);
  view.click(view.trigger);
  view.key('b');
  assert.equal(view.active()?.querySelector('.project-picker-option-title').textContent, 'backend');
  assert.equal(view.select.value, '');
  assert.equal(view.key('Enter', { isComposing: true }).defaultPrevented, false);
  assert.equal(view.key('x', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(view.changes.length, 0);
  view.close();
  view.click(view.trigger);
  for (const letter of 'example/calendar') view.key(letter);
  assert.equal(view.active()?.dataset.value, 'b');
  assert.equal(view.select.value, '');
});

test('native changes and option metadata refresh keep the displayed value and removed-project selection intact', t => {
  const view = fixture(t);
  view.select.value = 'a';
  view.select.dispatchEvent(event('change'));
  assert.equal(view.selected()[0].dataset.value, 'a');
  view.select.replaceChildren(view.option('', '모든 프로젝트'), view.option('a', '연결 해제된 프로젝트'));
  view.mutation();
  assert.equal(view.select.value, 'a');
  assert.equal(view.options().length, 2);
  assert.equal(view.selected()[0].dataset.value, 'a');
  assert.equal(view.trigger.textContent, translate('연결 해제된 프로젝트'));
  view.select.disabled = true;
  view.mutation();
  assert.equal(view.trigger.disabled, true);
});

test('disabled options are skipped by keyboard and cannot change the form through pointer selection', t => {
  const view = fixture(t);
  view.select.options[1].disabled = true;
  view.mutation();
  view.click(view.trigger);
  view.click(view.options()[1]);
  assert.equal(view.select.value, '');
  assert.equal(view.changes.length, 0);
  view.key('Home');
  view.key('ArrowDown');
  assert.equal(view.active()?.dataset.value, 'b');
  view.key('Enter');
  assert.equal(view.select.value, 'b');
});

test('an empty option list is safe to open, navigate, and dismiss without a phantom selection', t => {
  const view = fixture(t);
  view.select.replaceChildren();
  view.mutation();
  view.key('Enter');
  view.key('Home');
  view.key('End');
  view.key('ArrowDown');
  view.key('Enter');
  assert.equal(view.options().length, 0);
  assert.equal(view.select.value, '');
  assert.equal(view.changes.length, 0);
  view.key('Escape');
  assert.equal(view.trigger.getAttribute('aria-expanded'), 'false');
});

test('popup height follows the visual viewport and opens above the control when below is too short', t => {
  const view = fixture(t);
  view.document.innerHeight = 640;
  view.trigger.rect = { top: 304, bottom: 348, height: 44, left: 16, right: 304, width: 288 };
  view.click(view.trigger);
  assert.ok(Number.parseFloat(view.listbox.style.maxHeight) <= 640 - 348 - 24);
  assert.equal(view.listbox.classList.contains('opens-above'), false);
  view.close();
  view.trigger.rect = { top: 520, bottom: 564, height: 44, left: 16, right: 304, width: 288 };
  view.click(view.trigger);
  assert.equal(view.listbox.classList.contains('opens-above'), true);
  assert.ok(Number.parseFloat(view.listbox.style.maxHeight) <= 360);
  view.close();
  view.document.visualViewport = { offsetTop: 0, height: 380 };
  view.trigger.rect = { top: 120, bottom: 164, height: 44, left: 16, right: 304, width: 288 };
  view.click(view.trigger);
  assert.ok(Number.parseFloat(view.listbox.style.maxHeight) <= 380 - 164 - 24);
});

test('destroy removes custom UI and observers and restores the native select', t => {
  const view = fixture(t);
  view.destroy();
  assert.equal(view.select.hidden, false);
  assert.equal(view.wrapper.contains(view.trigger), false);
  assert.equal(view.wrapper.contains(view.listbox), false);
  assert.ok(view.observers.every(observer => observer.disconnected));
});
