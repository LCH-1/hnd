import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../src/web/app.html', import.meta.url), 'utf8');
const start = appSource.indexOf('function updateRuleScopeFields(');
const end = appSource.indexOf('function updateKnowledgeScopeFields(', start);
assert.ok(start >= 0 && end > start);

function fixture() {
  const fields = Object.fromEntries([
    'id', 'title', 'scope', 'status', 'activation', 'paths', 'files', 'repository', 'environment',
  ].map((name) => [name, { name, value: '', disabled: false, required: false }]));
  fields.scope.value = 'all';
  const nodes = Object.fromEntries([
    '.rule-scope-fields', '[data-rule-field="repository"]', '[data-rule-field="environment"]',
    '#rule-legacy-help', '#rule-scope-help', '#rule-environment-command',
  ].map((selector) => [selector, { hidden: false, textContent: '', classList: { toggle() {} } }]));
  const groups = Array.from({ length: 3 }, () => ({ hidden: false }));
  const form = {
    elements: { namedItem: (name) => fields[name] ?? null },
    querySelectorAll: (selector) => selector === '[data-rule-record-field]' ? groups : [],
  };
  const dialogFormStates = new WeakMap();
  const context = vm.createContext({
    dialogFormStates,
    $: (selector) => selector === '#rule-form' ? form : nodes[selector],
    setHidden: (node, hidden) => { if (node) node.hidden = hidden; },
  });
  vm.runInContext(appSource.slice(start, end), context);
  return {
    fields, groups, nodes,
    open(mode, id = null) {
      dialogFormStates.set(form, { mode, id });
      context.updateRuleScopeFields(form);
    },
    refresh: () => context.updateRuleScopeFields(form),
  };
}

test('new shared rules require a name and enable all record settings', () => {
  const view = fixture();
  view.open('create');
  assert.equal(view.fields.title.required, true);
  assert.equal(view.fields.scope.disabled, false);
  for (const name of ['title', 'status', 'activation', 'paths', 'files']) {
    assert.equal(view.fields[name].disabled, false, name);
  }
  assert.ok(view.groups.every((group) => !group.hidden));
  assert.equal(view.nodes['#rule-legacy-help'].hidden, true);
  assert.match(markup, /<input name="title"[^>]*\brequired\b/u);
  assert.equal((markup.match(/data-rule-record-field/g) || []).length, 3);
});

test('legacy edits omit unsupported settings and reopening add restores them', () => {
  for (const id of ['policies/global.md', 'repositories/repo/policy.md', 'repositories/repo/environments/dev.md']) {
    const view = fixture();
    view.open('edit', id);
    assert.equal(view.fields.scope.disabled, true);
    assert.equal(view.fields.title.required, false);
    assert.equal(view.nodes['#rule-legacy-help'].hidden, false);
    assert.ok(view.groups.every((group) => group.hidden));
    for (const name of ['title', 'status', 'activation', 'paths', 'files']) {
      assert.equal(view.fields[name].disabled, true, name);
    }
    // Form.reset does not reset disabled/required; the scope helper must do so.
    view.open('create');
    assert.equal(view.fields.title.required, true);
    assert.equal(view.fields.scope.disabled, false);
    assert.equal(view.nodes['#rule-legacy-help'].hidden, true);
    assert.ok(view.groups.every((group) => !group.hidden));
    for (const name of ['title', 'status', 'activation', 'paths', 'files']) {
      assert.equal(view.fields[name].disabled, false, name);
    }
  }
});

test('named edits keep record settings and use explicit edit state rather than the hidden ID', () => {
  const view = fixture();
  view.open('edit', 'rules/11111111-1111-4111-8111-111111111111.json');
  view.fields.id.value = '';
  view.refresh();
  assert.equal(view.fields.scope.disabled, true);
  assert.equal(view.fields.title.required, true);
  assert.equal(view.fields.title.disabled, false);
  assert.ok(view.groups.every((group) => !group.hidden));
  view.fields.id.value = 'policies/global.md';
  view.open('create');
  assert.equal(view.fields.scope.disabled, false);
  assert.equal(view.fields.title.required, true);
});

test('scope-specific required fields and environment help reset without changing named-rule controls', () => {
  const view = fixture();
  view.fields.scope.value = 'env';
  view.fields.environment.value = ' staging ';
  view.open('create');
  assert.equal(view.fields.repository.required, true);
  assert.equal(view.fields.environment.required, true);
  assert.equal(view.nodes['#rule-environment-command'].textContent, 'hnd env set staging');
  view.fields.scope.value = 'repo';
  view.refresh();
  assert.equal(view.fields.environment.disabled, true);
  assert.equal(view.fields.environment.required, false);
  view.fields.scope.value = 'all';
  view.refresh();
  assert.equal(view.fields.repository.disabled, true);
  assert.equal(view.fields.repository.required, false);
  assert.equal(view.fields.title.required, true);
});
