import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { APP_ROUTES, isAppPath, readAppRoute, routePath } from '../src/web/app-routes.js';
import { resolveWebAsset } from '../src/server/web-static.mjs';

test('all app views have direct paths and legacy hash links canonicalize without losing project selection', () => {
  for (const [view, pathname] of Object.entries(APP_ROUTES)) {
    assert.equal(readAppRoute({ pathname }).view, view);
    assert.equal(readAppRoute({ pathname: '/app', hash: `#${view}` }).path, pathname);
    assert.equal(resolveWebAsset(pathname).file, 'app.html');
    assert.equal(resolveWebAsset(`${pathname}/`).file, 'app.html');
  }
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(readAppRoute({ pathname: '/app', hash: `#projects/${id}` }).path, `/project/${id}`);
  assert.equal(readAppRoute({ pathname: `/app/projects/${id}` }).id, id);
  assert.equal(routePath('projects', id), `/project/${id}`);
  assert.equal(readAppRoute({ pathname: '/rule', hash: '#main-content' }).view, 'rules');
});

test('unknown paths, malformed project IDs, APIs and assets are not rewritten to the app', () => {
  for (const pathname of ['/unknown', '/api/web/settings', '/work/extra', '/project/a/b', '/project/%', '/project/%2Fetc', '/project/..', '/web/app.js']) {
    assert.equal(isAppPath(pathname), false, pathname);
  }
  assert.equal(readAppRoute({ pathname: '/app', hash: '#unknown' }).path, '/home');
});

test('offline worker covers every canonical app route and never treats APIs as navigation', async () => {
  const worker = await readFile(new URL('../src/web/sw.js', import.meta.url), 'utf8');
  const context = vm.createContext({ self: { addEventListener() {} } });
  vm.runInContext(worker, context);
  for (const path of [...Object.values(APP_ROUTES), '/project/11111111-1111-4111-8111-111111111111', '/app', '/app/work']) {
    assert.equal(vm.runInContext(`isAppNavigation(${JSON.stringify(path)})`, context), true);
  }
  for (const path of ['/api/web/settings', '/', '/setup', '/work/not-a-route']) {
    assert.equal(vm.runInContext(`isAppNavigation(${JSON.stringify(path)})`, context), false);
  }
});
