import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { SnapshotDataStore } from '../src/web/snapshot-data.js';

const appSource = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');
const repositoryA = '11111111-1111-4111-8111-111111111111';
const repositoryB = '22222222-2222-4222-8222-222222222222';
const workA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workDone = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function sourceBetween(start, end) {
  const startAt = appSource.indexOf(start);
  const endAt = appSource.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0 && endAt > startAt, `missing work filter implementation: ${start}`);
  return appSource.slice(startAt, endAt);
}

function handoffFile(repoId, id, task, closed = false) {
  const content = Buffer.from(JSON.stringify({
    schemaVersion: 1, id, repoId, task,
    status: closed ? 'closed' : 'active',
    objective: task, currentState: 'In progress',
    updatedAt: '2026-09-08T00:00:00.000Z',
  }));
  return {
    path: `repositories/${repoId}/${closed ? 'archive' : 'handoffs'}/${id}.json`,
    encoding: 'base64', bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
    content: content.toString('base64'),
  };
}

function node(tagName, { text = '', attrs = {} } = {}) {
  return {
    tagName: tagName.toUpperCase(), textContent: text, attrs,
    value: attrs.value || '', children: [], listeners: {},
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
  };
}

function fixture() {
  let repositories = [
    { id: repositoryA, name: '<img src=x onerror=alert(1)>', remoteAliases: ['github.com/example/a'] },
    { id: repositoryB, name: 'Project B', remoteAliases: ['github.com/example/b'] },
  ];
  const repository = node('select');
  repository.name = 'repository';
  repository.append(node('option', { attrs: { value: '' } }));
  const query = { ...node('input'), name: 'q', value: '' };
  const fields = [repository, query];
  fields.namedItem = (name) => fields.find((item) => item.name === name) ?? null;
  const form = node('form');
  form.elements = fields;
  repository.form = form;
  const statusButtons = ['active', 'done', 'all'].map((value) => ({
    ...node('button'), name: 'status', value,
  }));
  const container = node('div');
  const notice = node('div');
  const calls = [];
  const dataStore = {
    snapshot: { schemaVersion: 1, files: [
      handoffFile(repositoryA, workA, 'Alpha shared task'),
      handoffFile(repositoryB, workB, 'Beta shared task'),
      handoffFile(repositoryA, workDone, 'Alpha completed task', true),
    ] },
    async load() {},
    repositories: () => repositories,
    async work(values) {
      calls.push(structuredClone(values));
      return SnapshotDataStore.prototype.work.call(this, values);
    },
  };
  const state = { workStatus: 'active', loaded: new Set(), dataStore, work: new Map() };
  const context = vm.createContext({
    state,
    $: (selector) => ({
      '#work-filter': form, '#work-project-filter': repository,
      '#work-list': container, '#work-error': notice,
      '#work-filter [name="q"]': query,
    })[selector],
    $$: () => statusButtons,
    element: node,
    clearChildren: (target) => { target.children = []; },
    loadingState: (target) => { target.children = []; target.empty = null; },
    emptyState: (target, title, copy) => { target.empty = { title, copy }; },
    showNotice: (target, message = '') => { target.textContent = message; },
    truncate: (value) => value,
    t: (value) => value,
    relativeTime: (value) => value,
    createdAt: () => '',
    WORK_STATUS_TONES: {},
    FormData: class {
      constructor(target) { this.target = target; }
      *[Symbol.iterator]() {
        for (const control of this.target.elements) yield [control.name, control.value];
      }
    },
  });
  vm.runInContext([
    sourceBetween('function projectRemote(', 'function renderProjectEmpty('),
    sourceBetween('function workStatus(', 'async function loadKnowledge('),
    sourceBetween('function formObject(', 'async function saveDialogResource('),
    sourceBetween('async function applyWorkFilter(', '$("#knowledge-filter").addEventListener('),
  ].filter(Boolean).join('\n'), context);
  return {
    repository, query, form, container, notice, calls, state, dataStore,
    load: () => context.loadWork(),
    change: () => repository.listeners.change({ preventDefault() {}, currentTarget: repository }),
    search: (isComposing = false) => query.listeners.keydown({
      key: 'Enter', isComposing, preventDefault() {}, currentTarget: query,
    }),
    submit: (status) => form.listeners.submit({
      preventDefault() {}, currentTarget: form,
      submitter: statusButtons.find((button) => button.value === status),
    }),
    repositories: (next) => { repositories = next; },
    ids: () => [...state.work.keys()].sort(),
  };
}

test('work project options are safe text, include all projects, and do not auto-select one project', async () => {
  const [markup, styles] = await Promise.all([
    readFile(new URL('../src/web/app.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(markup, /<select id="work-project-filter" name="repository">/u);
  assert.match(styles, /#work-filter\s*\{\s*flex-wrap:\s*wrap;/u);
  assert.match(styles, /#work-filter \.segmented\s*\{\s*flex-shrink:\s*0;/u);
  assert.match(styles, /#work-filter \.segmented button\s*\{\s*white-space:\s*nowrap;/u);
  assert.match(styles, /@media \(max-width: 620px\)\s*\{\s*#work-filter \.filter-select\s*\{[^}]*flex:\s*0 0 auto;/u);
  const view = fixture();
  await view.load();
  assert.deepEqual(view.ids(), [workA, workB]);
  assert.equal(view.repository.value, '');
  assert.equal(view.repository.children[0].textContent, '모든 프로젝트');
  assert.equal(view.repository.children[1].textContent, '<img src=x onerror=alert(1)> · example/a');
  assert.equal(view.repository.children[1].children.length, 0);
  view.repositories([{ id: repositoryA, name: 'Only one project' }]);
  await view.load();
  assert.equal(view.repository.value, '');
  assert.equal(view.repository.children.length, 2);
});

test('project changes immediately combine with status and search and persist through subsequent reloads', async () => {
  const view = fixture();
  await view.load();
  view.repository.value = repositoryA;
  view.query.value = '  alpha  ';
  await view.change();
  assert.deepEqual(view.ids(), [workA]);
  assert.deepEqual(view.calls.at(-1), { repository: repositoryA, q: 'alpha', status: 'active' });
  await view.submit('done');
  assert.deepEqual(view.ids(), [workDone]);
  assert.equal(view.repository.value, repositoryA);
  await view.load();
  assert.deepEqual(view.ids(), [workDone]);
  assert.deepEqual(view.calls.at(-1), { repository: repositoryA, q: 'alpha', status: 'done' });
  await view.submit('all');
  assert.deepEqual(view.ids(), [workA, workDone]);
  view.repository.value = repositoryB;
  await view.change();
  assert.deepEqual(view.ids(), []);
  assert.match(view.container.empty.title, /선택한 프로젝트/u);
  assert.match(view.container.empty.copy, /프로젝트, 상태 또는 검색어/u);
  view.query.value = 'shared';
  await view.submit();
  assert.deepEqual(view.ids(), [workB]);
  view.repository.value = '';
  await view.change();
  assert.deepEqual(view.ids(), [workA, workB]);
});

test('refresh retains a removed project filter instead of widening the view to all projects', async () => {
  const view = fixture();
  await view.load();
  view.repository.value = repositoryA;
  view.repositories([{ id: repositoryB, name: 'Project B' }]);
  await view.load();
  assert.equal(view.repository.value, repositoryA);
  assert.deepEqual(view.ids(), [workA]);
  assert.equal(view.repository.children.at(-1).textContent, '연결 해제된 프로젝트');
  view.dataStore.snapshot.files = view.dataStore.snapshot.files.filter((file) => !file.path.includes(repositoryA));
  await view.load();
  assert.deepEqual(view.ids(), []);
  assert.match(view.container.empty.title, /선택한 프로젝트/u);
});

test('search Enter preserves the selected status and project and leaves IME composition alone', async () => {
  const view = fixture();
  await view.load();
  view.repository.value = repositoryA;
  await view.submit('done');
  view.query.value = 'completed';
  await view.search();
  assert.deepEqual(view.ids(), [workDone]);
  assert.deepEqual(view.calls.at(-1), { repository: repositoryA, q: 'completed', status: 'done' });
  const calls = view.calls.length;
  await view.search(true);
  assert.equal(view.calls.length, calls);
});

test('a slow earlier project response or error cannot overwrite the most recent project results', async () => {
  for (const failEarlier of [false, true]) {
    const view = fixture();
    await view.load();
    const original = view.dataStore.work;
    let resolveEarlier;
    let rejectEarlier;
    let calls = 0;
    view.dataStore.work = async function (values) {
      if (++calls === 1) return new Promise((resolve, reject) => {
        resolveEarlier = resolve;
        rejectEarlier = reject;
      });
      return original.call(this, values);
    };
    view.repository.value = repositoryA;
    const earlier = view.change();
    view.repository.value = repositoryB;
    await view.change();
    if (failEarlier) rejectEarlier(new Error('outdated response'));
    else resolveEarlier([{ id: workA, name: 'Outdated project A', status: 'active' }]);
    await earlier;
    assert.deepEqual(view.ids(), [workB]);
    assert.equal(view.repository.value, repositoryB);
    assert.equal(view.notice.textContent, '');
  }
});

test('a filter load failure is shown without clearing selection and can be retried', async () => {
  const view = fixture();
  await view.load();
  view.repository.value = repositoryA;
  const original = view.dataStore.work;
  view.dataStore.work = async () => { throw new Error('Cannot load project work'); };
  await view.change();
  assert.equal(view.notice.textContent, 'Cannot load project work');
  assert.equal(view.repository.value, repositoryA);
  view.dataStore.work = original;
  await view.change();
  assert.deepEqual(view.ids(), [workA]);
  assert.equal(view.notice.textContent, '');
});
