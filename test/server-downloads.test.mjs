import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSyncServer, serverMain } from '../src/sync/server.mjs';

test('standalone installer and archive routes stay retired', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-retired-downloads-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = await createSyncServer({ dataDirectory: path.join(root, 'data') });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  context.after(() => server.close());

  for (const pathname of [
    '/install.sh',
    '/install.ps1',
    '/downloads/hnd-connector.tar.gz',
    '/downloads/hnd-connector.sha256',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(`${address.url}${pathname}`, { method });
      assert.equal(response.status, 404, `${method} ${pathname}`);
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
      if (method === 'GET') {
        assert.deepEqual(await response.json(), { error: 'Not found' });
      } else {
        assert.equal((await response.arrayBuffer()).byteLength, 0);
      }
    }
  }
});

test('server CLI no longer accepts or documents a public installer directory', async () => {
  await assert.rejects(
    serverMain(['--public-dir', '/tmp/hnd-public'], { env: {} }),
    /Unknown option: --public-dir/u,
  );

  let help = '';
  await serverMain(['--help'], {
    env: {},
    stdout: { write: (chunk) => { help += String(chunk); } },
  });
  assert.doesNotMatch(help, /public-dir/u);
});
