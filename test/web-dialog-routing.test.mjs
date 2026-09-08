import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');

function sourceBetween(start, end) {
  const startAt = appSource.indexOf(start);
  const endAt = appSource.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0 && endAt > startAt, `missing dialog implementation: ${start}`);
  return appSource.slice(startAt, endAt);
}

// These tests run the shipped handlers without booting an authenticated app.
// The fixture deliberately models the two browser behaviours behind the bug:
// hidden.value also changes defaultValue, and name=id shadows form.id.
function field(name, { type = 'text', value: initial = '' } = {}) {
  let value = initial;
  let defaultValue = initial;
  return {
    name, type, disabled: false, checked: false,
    get value() { return value; },
    set value(next) { value = String(next); if (type === 'hidden') defaultValue = value; },
    get defaultValue() { return defaultValue; },
    set defaultValue(next) { defaultValue = String(next); if (type === 'hidden') value = defaultValue; },
    reset() { value = defaultValue; this.checked = false; },
  };
}

function fixture(kind) {
  const title = { rule: '룰', work: '작업', knowledge: '지식' }[kind];
  const fields = [
    field('id', { type: 'hidden' }), field('title'), field('content'),
    field('scope', { value: 'all' }), field('tags'), field('pinned', { type: 'checkbox' }),
  ];
  fields.namedItem = (name) => fields.find((item) => item.name === name) ?? null;
  const heading = { textContent: `${title} 추가` };
  const notice = { textContent: '' };
  const submit = { disabled: false };
  const calls = [];
  let failSave = false;
  let scopeUpdates = 0;
  const form = {
    id: fields.namedItem('id'),
    elements: fields,
    getAttribute: (name) => name === 'id' ? `${kind}-form` : null,
    reset() { for (const control of fields) control.reset(); },
    querySelector(selector) {
      return { '.dialog-head h2': heading, '.notice': notice, '[type="submit"]': submit }[selector] ?? null;
    },
    closest: () => dialog,
  };
  const dialog = {
    open: false,
    querySelector: (selector) => selector === 'form.dialog-form' ? form : null,
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
  const dataStore = Object.fromEntries(['Rule', 'Work', 'Knowledge'].flatMap((resource) => [
    [`create${resource}`, async (values) => {
      if (failSave) throw new Error('Save failed; retry');
      calls.push({ operation: `create${resource}`, values: structuredClone(values) });
    }],
    [`update${resource}`, async (id, values) => {
      if (failSave) throw new Error('Save failed; retry');
      calls.push({ operation: `update${resource}`, id, values: structuredClone(values) });
    }],
  ]));
  const updateScope = (target) => {
    scopeUpdates += 1;
    target.elements.namedItem('scope').disabled = Boolean(target.elements.namedItem('id').value);
  };
  const context = vm.createContext({
    state: { dataStore },
    document: { getElementById: (id) => id === `${kind}-dialog` ? dialog : null },
    $: (selector, root) => root?.querySelector(selector),
    showNotice: (target, message = '') => { if (target) target.textContent = message; },
    populateRepositoryFields() {},
    updateRuleScopeFields: updateScope,
    updateKnowledgeScopeFields: updateScope,
    setBusy: (button, busy) => { button.disabled = busy; },
    closeDialog: (target) => target.close(),
    async returnAfterResourceSave() {},
    toast() {},
    localSaveMessage: (message) => message,
    FormData: class {
      constructor(target) { this.target = target; }
      *[Symbol.iterator]() {
        for (const control of this.target.elements) {
          if (!control.disabled && (control.type !== 'checkbox' || control.checked)) yield [control.name, control.value];
        }
      }
    },
  });
  const definitions = [
    sourceBetween('const dialogFormStates = new WeakMap();', 'async function returnAfterResourceSave('),
    sourceBetween('function fillForm(', 'function formObject('),
    sourceBetween('function formObject(', 'function closeDialog('),
    sourceBetween('async function submitRule(', 'async function submitWork('),
    sourceBetween('async function submitWork(', 'async function submitProject('),
    sourceBetween('async function submitKnowledge(', 'function editDeviceName('),
  ].join('\n');
  vm.runInContext(`${definitions}\nglobalThis.handlers = { openDialog, submitRule, submitWork, submitKnowledge };`, context);
  const resource = kind[0].toUpperCase() + kind.slice(1);
  return {
    fields, form, dialog, heading, notice, calls, title,
    open: (item) => context.handlers.openDialog(`${kind}-dialog`, item),
    save: () => context.handlers[`submit${resource}`]({ preventDefault() {}, currentTarget: form }),
    fail: (enabled) => { failSave = enabled; },
    scopeUpdates: () => scopeUpdates,
  };
}

for (const kind of ['rule', 'work', 'knowledge']) {
  test(`${kind}: cancelling an edit then opening add clears both hidden ID defaults and save mode`, async () => {
    const view = fixture(kind);
    assert.equal(typeof view.form.id, 'object');
    view.open({ id: 'existing-id', title: 'Existing', content: 'Original' });
    assert.equal(view.heading.textContent, `${view.title} 수정`);
    assert.equal(view.fields.namedItem('id').defaultValue, 'existing-id');
    view.dialog.close();
    view.open();
    assert.equal(view.heading.textContent, `${view.title} 추가`);
    assert.equal(view.fields.namedItem('id').value, '');
    assert.equal(view.fields.namedItem('id').defaultValue, '');
    view.fields.namedItem('content').value = 'New record';
    await view.save();
    assert.equal(view.calls[0].operation, `create${kind[0].toUpperCase() + kind.slice(1)}`);
    assert.ok(!Object.hasOwn(view.calls[0].values, 'id'));
    if (kind !== 'work') {
      assert.equal(view.scopeUpdates(), 2);
      assert.equal(view.fields.namedItem('scope').disabled, false);
    }
  });

  test(`${kind}: saved edits do not turn the next add into an update, even with a stale hidden ID`, async () => {
    const view = fixture(kind);
    view.open({ id: 'original-id', title: 'Existing', content: 'Original' });
    view.fields.namedItem('id').value = 'different-hidden-id';
    await view.save();
    assert.equal(view.calls[0].id, 'original-id');
    assert.equal(view.calls[0].values.id, 'original-id');
    view.open();
    view.fields.namedItem('id').value = 'original-id';
    await view.save();
    assert.equal(view.calls[1].operation, `create${kind[0].toUpperCase() + kind.slice(1)}`);
    assert.ok(!Object.hasOwn(view.calls[1].values, 'id'));
  });

  test(`${kind}: invalid edit state blocks saving, and retry preserves a valid edit target`, async () => {
    const view = fixture(kind);
    await view.save();
    assert.equal(view.calls.length, 0);
    assert.match(view.notice.textContent, /창을 다시 열어/u);
    view.open({ title: 'Missing ID', content: 'Keep this input' });
    await view.save();
    assert.equal(view.calls.length, 0);
    assert.equal(view.fields.namedItem('content').value, 'Keep this input');
    view.open({ id: 'retry-id', content: 'Keep after error' });
    view.fail(true);
    await view.save();
    assert.equal(view.dialog.open, true);
    assert.equal(view.calls.length, 0);
    assert.equal(view.fields.namedItem('content').value, 'Keep after error');
    view.fail(false);
    await view.save();
    assert.equal(view.calls[0].id, 'retry-id');
  });
}
