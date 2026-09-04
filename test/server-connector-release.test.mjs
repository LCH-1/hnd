import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildConnectorRelease } from '../scripts/build-connector-release.mjs';
import {
  BUNDLE_CONTENT_TYPE,
  MANIFEST_CONTENT_TYPE,
} from '../src/server/connector-release.mjs';
import { createSyncServer, serverMain } from '../src/sync/server.mjs';
import { CONNECTOR_RELEASE_KEY_ID } from '../src/update/manifest.mjs';
import { applyConnectorUpdate } from '../src/update/client.mjs';
import { readRuntimePointer, runtimeReady } from '../src/update/state.mjs';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-server-release-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function releaseFixture(t, root) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePath = path.join(root, 'private.pem');
  const publicPath = path.join(root, 'public.pem');
  const output = path.join(root, 'release');
  await fs.writeFile(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await fs.writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  const built = await buildConnectorRelease([
    '--sequence', '7',
    '--private-key', privatePath,
    '--public-key', publicPath,
    '--key-id', CONNECTOR_RELEASE_KEY_ID,
    '--output', output,
  ], {
    env: {},
    stdout: { write() {} },
    allowTestPublicKeyOverride: true,
  });
  return { directory: output, manifest: built.manifest, publicPath };
}

async function enrolledServer(t, root, connectorDirectory) {
  const server = await createSyncServer({
    dataDirectory: path.join(root, 'data'),
    connectorDirectory,
  });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const enrollment = await server.createEnrollmentKey('release-tenant');
  const response = await fetch(`${address.url}/v1/enroll`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${enrollment.enrollmentKey}`,
      'X-Hnd-Device-Name': 'release-test',
    },
  });
  assert.equal(response.status, 201);
  const enrolled = await response.json();
  return { server, address, token: enrolled.deviceToken, device: enrolled.device };
}

function authenticated(token, options = {}) {
  return {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    redirect: 'error',
  };
}

test('authenticated devices can GET and HEAD the exact connector release', async (t) => {
  const root = await temporaryDirectory(t);
  const release = await releaseFixture(t, root);
  const { address, token, device } = await enrolledServer(t, root, release.directory);
  const manifestUrl = `${address.url}/v1/connector/manifest`;

  const unauthorized = await fetch(manifestUrl, { redirect: 'error' });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer');

  const manifestResponse = await fetch(manifestUrl, authenticated(token));
  assert.equal(manifestResponse.status, 200);
  assert.equal(manifestResponse.headers.get('content-type'), MANIFEST_CONTENT_TYPE);
  assert.equal(manifestResponse.headers.get('cache-control'), 'private, no-store');
  assert.match(manifestResponse.headers.get('etag'), /^"[a-f0-9]{64}"$/u);
  const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
  assert.equal(Number(manifestResponse.headers.get('content-length')), manifestBytes.byteLength);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.deepEqual(manifest, release.manifest);

  const manifestHead = await fetch(manifestUrl, authenticated(token, { method: 'HEAD' }));
  assert.equal(manifestHead.status, 200);
  assert.equal(manifestHead.headers.get('content-length'), String(manifestBytes.byteLength));
  assert.equal((await manifestHead.arrayBuffer()).byteLength, 0);

  const bundleUrl = `${address.url}${manifest.bundle.path}`;
  const bundleResponse = await fetch(bundleUrl, authenticated(token));
  assert.equal(bundleResponse.status, 200);
  assert.equal(bundleResponse.headers.get('content-type'), BUNDLE_CONTENT_TYPE);
  assert.equal(bundleResponse.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(bundleResponse.headers.get('etag'), `"${manifest.bundle.sha256}"`);
  const bundle = Buffer.from(await bundleResponse.arrayBuffer());
  assert.equal(bundle.byteLength, manifest.bundle.bytes);
  assert.equal(createHash('sha256').update(bundle).digest('hex'), manifest.bundle.sha256);

  const bundleHead = await fetch(bundleUrl, authenticated(token, { method: 'HEAD' }));
  assert.equal(bundleHead.status, 200);
  assert.equal(bundleHead.headers.get('content-length'), String(bundle.byteLength));
  assert.equal((await bundleHead.arrayBuffer()).byteLength, 0);

  for (const [url, method] of [
    [manifestUrl, 'POST'],
    [bundleUrl, 'PUT'],
  ]) {
    const response = await fetch(url, authenticated(token, { method }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }

  for (const url of [
    `${manifestUrl}?channel=stable`,
    `${bundleUrl}?download=1`,
  ]) {
    const response = await fetch(url, authenticated(token));
    assert.equal(response.status, 400);
  }

  for (const pathname of [
    `/v1/connector/releases/${'0'.repeat(64)}.hndb`,
    `/v1/connector/releases/${manifest.bundle.sha256.toUpperCase()}.hndb`,
    `${manifest.bundle.path}/extra`,
  ]) {
    const response = await fetch(`${address.url}${pathname}`, authenticated(token));
    assert.equal(response.status, 404);
  }

  const revoked = await fetch(
    `${address.url}/v1/devices/${device.id}/revoke`,
    authenticated(token, { method: 'POST' }),
  );
  assert.equal(revoked.status, 204);
  assert.equal((await fetch(manifestUrl, authenticated(token))).status, 401);
});

test('connector routes return 404 when no release directory is available', async (t) => {
  const root = await temporaryDirectory(t);
  const { address, token } = await enrolledServer(t, root, path.join(root, 'missing-release'));
  for (const method of ['GET', 'HEAD', 'POST']) {
    const response = await fetch(
      `${address.url}/v1/connector/manifest`,
      authenticated(token, { method }),
    );
    assert.equal(response.status, 404);
  }
});

test('the updater installs a release from the real authenticated server routes', async (t) => {
  const root = await temporaryDirectory(t);
  const release = await releaseFixture(t, root);
  const { address, token, device } = await enrolledServer(t, root, release.directory);
  const clientHome = path.join(root, 'client-home');
  const secrets = path.join(clientHome, 'secrets');
  await fs.mkdir(secrets, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(clientHome, 'remotes.json'), `${JSON.stringify({
    schemaVersion: 1,
    baseUrl: address.url,
    device,
  })}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(secrets, 'device.token'), `${token}\n`, { mode: 0o600 });
  const env = {
    HND_HOME: clientHome,
    HND_USER_HOME: path.join(root, 'user-home'),
  };

  const result = await applyConnectorUpdate({
    env,
    launcherVersion: release.manifest.minLauncherVersion,
    publicKeyPath: release.publicPath,
    timeoutMs: 5_000,
  });
  assert.equal(result.installed, true);
  assert.equal(result.pointer.sequence, release.manifest.sequence);
  assert.equal(result.pointer.sha256, release.manifest.bundle.sha256);
  const current = await readRuntimePointer('current', env);
  assert.deepEqual(current, result.pointer);
  assert.equal(await runtimeReady(current, env), true);
});

test('server refuses altered or symlinked connector release artifacts', async (t) => {
  const root = await temporaryDirectory(t);
  const release = await releaseFixture(t, root);
  const bundlePath = path.join(release.directory, `${release.manifest.bundle.sha256}.hndb`);
  const original = await fs.readFile(bundlePath);
  const altered = Buffer.from(original);
  altered[altered.length - 1] ^= 1;
  await fs.writeFile(bundlePath, altered);
  await assert.rejects(
    createSyncServer({ dataDirectory: path.join(root, 'altered-data'), connectorDirectory: release.directory }),
    /does not match its manifest|not valid JSON|not canonical JSON/u,
  );

  await fs.writeFile(bundlePath, original);
  if (process.platform !== 'win32') {
    const link = path.join(root, 'release-link');
    await fs.symlink(release.directory, link);
    await assert.rejects(
      createSyncServer({ dataDirectory: path.join(root, 'link-data'), connectorDirectory: link }),
      /must be a real directory/u,
    );
  }
});

test('server CLI accepts and documents the connector release directory', async () => {
  let help = '';
  await serverMain(['--help'], {
    env: {},
    stdout: { write: (chunk) => { help += String(chunk); } },
  });
  assert.match(help, /--connector-dir PATH/u);
  await assert.rejects(
    serverMain(['--connector-dir'], { env: {} }),
    /--connector-dir requires a value/u,
  );
});
