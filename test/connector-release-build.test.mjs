import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildConnectorRelease } from '../scripts/build-connector-release.mjs';
import { VERSION as RUNTIME_VERSION } from '../src/constants.mjs';
import {
  canonicalJson,
  CONNECTOR_RELEASE_KEY_ID,
  MAX_CONNECTOR_BUNDLE_BYTES,
  validateConnectorBundle,
  validateConnectorManifest,
} from '../src/update/manifest.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-connector-release-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function signingKeys(directory, prefix = 'release') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePath = path.join(directory, `${prefix}-private.pem`);
  const publicPath = path.join(directory, `${prefix}-public.pem`);
  await fs.writeFile(
    privatePath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    publicPath,
    publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o644 },
  );
  return { privatePath, publicPath, publicKey };
}

async function buildWithTestKey(output, keys, sequence = 42) {
  let stdout = '';
  const result = await buildConnectorRelease([
    '--sequence', String(sequence),
    '--private-key', keys.privatePath,
    '--public-key', keys.publicPath,
    '--key-id', CONNECTOR_RELEASE_KEY_ID,
    '--min-launcher-version', '0.1.1',
    '--output', output,
  ], {
    env: {},
    stdout: { write: (chunk) => { stdout += String(chunk); } },
    allowTestPublicKeyOverride: true,
  });
  return { ...result, stdout };
}

test('connector release build is deterministic, signed, canonical, and client-only', async (t) => {
  const root = await temporaryDirectory(t);
  const keys = await signingKeys(root);
  const firstOutput = path.join(root, 'first');
  const secondOutput = path.join(root, 'second');
  const first = await buildWithTestKey(firstOutput, keys);
  const second = await buildWithTestKey(secondOutput, keys);

  const firstManifestBytes = await fs.readFile(path.join(firstOutput, 'manifest.json'));
  const secondManifestBytes = await fs.readFile(path.join(secondOutput, 'manifest.json'));
  assert.deepEqual(firstManifestBytes, secondManifestBytes);
  const manifest = JSON.parse(firstManifestBytes.toString('utf8'));
  assert.equal(firstManifestBytes.toString('utf8'), canonicalJson(manifest));
  assert.equal(manifest.sequence, 42);
  assert.equal(manifest.version, RUNTIME_VERSION);
  assert.equal(manifest.keyId, CONNECTOR_RELEASE_KEY_ID);
  assert.equal(manifest.bundle.path, `/v1/connector/releases/${manifest.bundle.sha256}.hndb`);
  assert.match(first.stdout, new RegExp(manifest.bundle.sha256, 'u'));
  assert.doesNotMatch(first.stdout, /PRIVATE KEY|BEGIN PRIVATE|signing-key/u);

  const verifiedManifest = validateConnectorManifest(manifest, {
    launcherVersion: '0.1.1',
    publicKey: keys.publicKey,
    keyId: CONNECTOR_RELEASE_KEY_ID,
  });
  const firstBundle = await fs.readFile(path.join(firstOutput, `${manifest.bundle.sha256}.hndb`));
  const secondBundle = await fs.readFile(path.join(secondOutput, `${manifest.bundle.sha256}.hndb`));
  assert.deepEqual(firstBundle, secondBundle);
  assert.ok(firstBundle.byteLength <= MAX_CONNECTOR_BUNDLE_BYTES);
  const parsedBundle = JSON.parse(firstBundle.toString('utf8'));
  assert.equal(firstBundle.toString('utf8'), canonicalJson(parsedBundle));
  const verifiedBundle = validateConnectorBundle(firstBundle, verifiedManifest);

  const reviewedFiles = (await fs.readFile(
    path.join(projectRoot, 'assets', 'connector-runtime-files.txt'),
    'utf8',
  )).trim().split('\n');
  assert.deepEqual(parsedBundle.files.map((file) => file.path), reviewedFiles);
  assert.deepEqual(verifiedBundle.files.map((file) => file.path), reviewedFiles);
  assert.ok(parsedBundle.files.every((file) => file.mode === 0o644));
  assert.equal(parsedBundle.entrypoint, 'src/cli.mjs');
  assert.equal(parsedBundle.files.some((file) => file.path.startsWith('src/server/')), false);
  assert.equal(parsedBundle.files.some((file) => file.path.startsWith('src/web/')), false);
  assert.equal(parsedBundle.files.some((file) => file.path.startsWith('src/browser/')), false);
  assert.equal(parsedBundle.files.some((file) => [
    'src/sync/server.mjs',
    'src/sync/store.mjs',
    'bin/hnd.mjs',
  ].includes(file.path)), false);

  const inventory = (await fs.readdir(firstOutput)).sort();
  assert.deepEqual(inventory, [`${manifest.bundle.sha256}.hndb`, 'manifest.json'].sort());
});

test('connector release build rejects mismatched keys and unrecognized output', async (t) => {
  const root = await temporaryDirectory(t);
  const first = await signingKeys(root, 'first');
  const second = await signingKeys(root, 'second');
  const output = path.join(root, 'output');

  await assert.rejects(
    buildConnectorRelease([
      '--sequence', '1',
      '--private-key', first.privatePath,
      '--public-key', second.publicPath,
      '--output', output,
    ], { env: {}, allowTestPublicKeyOverride: true, stdout: { write() {} } }),
    /private and public keys do not match/u,
  );

  await fs.mkdir(output);
  await fs.writeFile(path.join(output, 'keep.txt'), 'user data\n');
  await assert.rejects(
    buildWithTestKey(output, first, 1),
    /Refusing to replace an unrecognized output directory/u,
  );
  assert.equal(await fs.readFile(path.join(output, 'keep.txt'), 'utf8'), 'user data\n');
});

test('production build refuses a public key other than the launcher-pinned key', async (t) => {
  const root = await temporaryDirectory(t);
  const keys = await signingKeys(root);
  await assert.rejects(
    buildConnectorRelease([
      '--sequence', '1',
      '--private-key', keys.privatePath,
      '--public-key', keys.publicPath,
      '--output', path.join(root, 'output'),
    ], { env: {}, stdout: { write() {} } }),
    /does not match the pinned launcher key/u,
  );
});

test('connector release Docker image includes only the prebuilt public artifact', async () => {
  const [dockerfile, dockerignore, compose] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'Dockerfile'), 'utf8'),
    fs.readFile(path.join(projectRoot, '.dockerignore'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'docker-compose.yml'), 'utf8'),
  ]);
  assert.match(dockerfile, /COPY --chown=node:node dist\/connector-release \.\/dist\/connector-release/u);
  assert.match(dockerfile, /HND_SERVER_CONNECTOR_DIR=\/app\/dist\/connector-release/u);
  assert.doesNotMatch(dockerfile, /private[_-]?key|signing-key|\.pem/u);
  assert.match(dockerignore, /!dist\/connector-release\/manifest\.json/u);
  assert.match(dockerignore, /!dist\/connector-release\/\*\.hndb/u);
  assert.doesNotMatch(dockerignore, /!dist\/connector-release\/\*\*/u);
  assert.match(compose, /HND_SERVER_CONNECTOR_DIR: \/app\/dist\/connector-release/u);
  assert.doesNotMatch(compose, /PRIVATE_KEY|private[_-]?key|signing-key/u);
});
