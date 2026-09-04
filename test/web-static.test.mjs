import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveWebAsset,
  sendWebAsset,
  WebStaticError,
} from '../src/server/web-static.mjs';

test('web assets resolve only the entry, setup, app shell, and fixed same-origin files', () => {
  assert.equal(resolveWebAsset('/').file, 'index.html');
  assert.equal(resolveWebAsset('/setup').file, 'setup.html');
  assert.equal(resolveWebAsset('/app/knowledge').file, 'app.html');
  assert.equal(resolveWebAsset('/web/app.js').file, 'app.js');
  assert.equal(resolveWebAsset('/web/i18n.js').file, 'i18n.js');
  assert.equal(resolveWebAsset('/web/connector-release.js').file, 'connector-release.js');
  assert.equal(resolveWebAsset('/web/snapshot-data.js').source, 'web');
  assert.equal(resolveWebAsset('/web/hnd-icon.png').contentType, 'image/png');
  assert.equal(resolveWebAsset('/site.webmanifest').file, 'site.webmanifest');
  assert.equal(resolveWebAsset('/sw.js').file, 'sw.js');
  assert.equal(resolveWebAsset('/browser/index.mjs').source, 'browser');
  assert.equal(resolveWebAsset('/browser/../package.json'), null);
  assert.equal(resolveWebAsset('/web/../package.json'), null);
  assert.equal(resolveWebAsset('/private.txt'), null);
});

test('every relative browser module import is present in the static allowlist', async () => {
  const pending = ['/web/entry.js', '/web/setup.js', '/web/app.js'];
  const visited = new Set();
  const importPattern = /(?:from\s*|import\s*)["'](\.{1,2}\/[^"']+)["']/gu;

  while (pending.length > 0) {
    const pathname = pending.pop();
    if (visited.has(pathname)) continue;
    visited.add(pathname);
    const descriptor = resolveWebAsset(pathname);
    assert.ok(descriptor, `missing static route for ${pathname}`);
    const source = await fs.readFile(
      new URL(`../src/${descriptor.source}/${descriptor.file}`, import.meta.url),
      'utf8',
    );
    for (const match of source.matchAll(importPattern)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(pathname), match[1]));
      assert.ok(resolveWebAsset(dependency), `${pathname} imports unavailable ${dependency}`);
      pending.push(dependency);
    }
  }
});

test('web asset responses include the application security boundary', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-web-static-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>HND</title>');

  const server = http.createServer(async (req, res) => {
    try {
      const descriptor = resolveWebAsset('/');
      await sendWebAsset(req, res, root, descriptor);
    } catch (error) {
      res.writeHead(error.statusCode || 500, error.statusCode === 405 ? { Allow: 'GET, HEAD' } : {});
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await response.text(), /HND/);

  const wrongMethod = await fetch(url, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);

  if (process.platform !== 'win32') {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
    await fs.writeFile(outside, 'SECRET');
    await fs.rm(path.join(root, 'index.html'));
    await fs.symlink(outside, path.join(root, 'index.html'));
    const blocked = await fetch(url);
    assert.equal(blocked.status, 404);
    await fs.rm(outside);
  }
});
