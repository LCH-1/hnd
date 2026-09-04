import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  open,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalJson,
  CONNECTOR_CHANNEL,
  CONNECTOR_MANIFEST_SCHEMA_VERSION,
  CONNECTOR_RELEASE_KEY_ID,
  MAX_CONNECTOR_BUNDLE_BYTES,
  validateConnectorBundle,
} from '../update/manifest.mjs';

const MAX_CONNECTOR_MANIFEST_BYTES = 32 * 1024;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

const MANIFEST_CONTENT_TYPE = 'application/vnd.hnd.connector-manifest+json';
const BUNDLE_CONTENT_TYPE = 'application/vnd.hnd.connector-bundle+json';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validateServedManifest(value) {
  if (!hasExactKeys(value, [
    'schemaVersion',
    'channel',
    'sequence',
    'version',
    'minLauncherVersion',
    'bundle',
    'keyId',
    'signature',
  ])) {
    throw new Error('Connector release manifest has unexpected fields');
  }
  if (
    value.schemaVersion !== CONNECTOR_MANIFEST_SCHEMA_VERSION
    || value.channel !== CONNECTOR_CHANNEL
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || typeof value.version !== 'string'
    || !VERSION_PATTERN.test(value.version)
    || typeof value.minLauncherVersion !== 'string'
    || !VERSION_PATTERN.test(value.minLauncherVersion)
    || value.keyId !== CONNECTOR_RELEASE_KEY_ID
    || typeof value.signature !== 'string'
    || !SIGNATURE_PATTERN.test(value.signature)
    || Buffer.from(value.signature, 'base64url').byteLength !== 64
    || Buffer.from(value.signature, 'base64url').toString('base64url') !== value.signature
  ) {
    throw new Error('Connector release manifest metadata is invalid');
  }
  if (!hasExactKeys(value.bundle, ['path', 'bytes', 'sha256'])) {
    throw new Error('Connector release bundle descriptor is invalid');
  }
  if (
    !Number.isSafeInteger(value.bundle.bytes)
    || value.bundle.bytes < 1
    || value.bundle.bytes > MAX_CONNECTOR_BUNDLE_BYTES
    || typeof value.bundle.sha256 !== 'string'
    || !DIGEST_PATTERN.test(value.bundle.sha256)
    || value.bundle.path !== `/v1/connector/releases/${value.bundle.sha256}.hndb`
  ) {
    throw new Error('Connector release bundle descriptor is invalid');
  }
  return value;
}

async function readManagedFile(root, canonicalRoot, filename, maximumBytes) {
  const filePath = path.join(root, filename);
  let handle;
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
      throw new Error(`Connector release file is unsafe or too large: ${filename}`);
    }
    const canonicalFile = await realpath(filePath);
    if (canonicalFile !== path.join(canonicalRoot, filename)) {
      throw new Error(`Connector release file escapes its directory: ${filename}`);
    }
    const noFollow = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW || 0);
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.size > maximumBytes
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
    ) {
      throw new Error(`Connector release file changed while opening: ${filename}`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maximumBytes) {
      throw new Error(`Connector release file is too large: ${filename}`);
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}

function parseCanonicalJson(bytes, label) {
  let value;
  const source = bytes.toString('utf8');
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (canonicalJson(value) !== source) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
}

function releaseAsset(body, contentType, cacheControl, etag) {
  return Object.freeze({
    body,
    headers: Object.freeze({
      'Cache-Control': cacheControl,
      'Content-Length': String(body.byteLength),
      'Content-Type': contentType,
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    }),
  });
}

export class ConnectorReleaseStore {
  constructor({ manifest, manifestBytes, bundleBytes }) {
    this.manifest = Object.freeze(structuredClone(manifest));
    this.digest = manifest.bundle.sha256;
    this.manifestAsset = releaseAsset(
      manifestBytes,
      MANIFEST_CONTENT_TYPE,
      'private, no-store',
      `"${sha256(manifestBytes)}"`,
    );
    this.bundleAsset = releaseAsset(
      bundleBytes,
      BUNDLE_CONTENT_TYPE,
      'private, max-age=31536000, immutable',
      `"${this.digest}"`,
    );
  }

  asset(pathname) {
    if (pathname === '/v1/connector/manifest') return this.manifestAsset;
    if (pathname === `/v1/connector/releases/${this.digest}.hndb`) return this.bundleAsset;
    return null;
  }
}

export async function loadConnectorRelease(directory) {
  if (directory === undefined || directory === null || directory === false || directory === '') {
    return null;
  }
  const root = path.resolve(directory);
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Connector release directory must be a real directory');
  }
  const canonicalRoot = await realpath(root);
  const manifestBytes = await readManagedFile(
    root,
    canonicalRoot,
    'manifest.json',
    MAX_CONNECTOR_MANIFEST_BYTES,
  );
  const manifest = validateServedManifest(parseCanonicalJson(
    manifestBytes,
    'Connector release manifest',
  ));
  const bundleFilename = `${manifest.bundle.sha256}.hndb`;
  const bundleBytes = await readManagedFile(
    root,
    canonicalRoot,
    bundleFilename,
    MAX_CONNECTOR_BUNDLE_BYTES,
  );
  if (
    bundleBytes.byteLength !== manifest.bundle.bytes
    || sha256(bundleBytes) !== manifest.bundle.sha256
  ) {
    throw new Error('Connector release bundle does not match its manifest');
  }
  const bundleValue = parseCanonicalJson(bundleBytes, 'Connector release bundle');
  validateConnectorBundle(bundleBytes, manifest);
  if (bundleValue.version !== manifest.version) {
    throw new Error('Connector release versions do not match');
  }
  return new ConnectorReleaseStore({ manifest, manifestBytes, bundleBytes });
}

export function sendConnectorReleaseAsset(req, res, asset) {
  if (!asset) throw new TypeError('Connector release asset is required');
  res.writeHead(200, asset.headers);
  res.end(req.method === 'HEAD' ? undefined : asset.body);
}

export {
  BUNDLE_CONTENT_TYPE,
  MANIFEST_CONTENT_TYPE,
  MAX_CONNECTOR_MANIFEST_BYTES,
};
