import { createHash, verify } from 'node:crypto';

export const CONNECTOR_MANIFEST_SCHEMA_VERSION = 1;
export const CONNECTOR_BUNDLE_SCHEMA_VERSION = 1;
export const CONNECTOR_CHANNEL = 'stable';
export const CONNECTOR_RELEASE_KEY_ID = 'hnd-release-2026-01';
export const MAX_CONNECTOR_BUNDLE_BYTES = 8 * 1024 * 1024;
export const MAX_CONNECTOR_FILES = 128;
export const MAX_CONNECTOR_FILE_BYTES = 4 * 1024 * 1024;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Canonical JSON only accepts safe integers');
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (!plainObject(value)) throw new TypeError('Canonical JSON only accepts plain JSON values');
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
  ).join(',')}}`;
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseVersion(value, label) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function versionAtLeast(actual, minimum) {
  const actualVersion = parseVersion(actual, 'Launcher version');
  const minimumVersion = parseVersion(minimum, 'Minimum launcher version');
  const [leftCore, leftPrerelease] = actualVersion.split('-', 2);
  const [rightCore, rightPrerelease] = minimumVersion.split('-', 2);
  const left = leftCore.split('.').map(Number);
  const right = rightCore.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  if (!leftPrerelease) return true;
  if (!rightPrerelease) return false;
  const leftParts = leftPrerelease.split('.');
  const rightParts = rightPrerelease.split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] === undefined) return false;
    if (rightParts[index] === undefined) return true;
    if (leftParts[index] === rightParts[index]) continue;
    const leftNumeric = /^\d+$/.test(leftParts[index]);
    const rightNumeric = /^\d+$/.test(rightParts[index]);
    if (leftNumeric && rightNumeric) return Number(leftParts[index]) > Number(rightParts[index]);
    if (leftNumeric !== rightNumeric) return !leftNumeric;
    return leftParts[index] > rightParts[index];
  }
  return true;
}

function unsignedManifest(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    channel: manifest.channel,
    sequence: manifest.sequence,
    version: manifest.version,
    minLauncherVersion: manifest.minLauncherVersion,
    bundle: manifest.bundle,
    keyId: manifest.keyId,
  };
}

export function validateConnectorManifest(value, {
  launcherVersion,
  publicKey,
  keyId = CONNECTOR_RELEASE_KEY_ID,
  highestSequence = 0,
} = {}) {
  if (!exactKeys(value, [
    'schemaVersion', 'channel', 'sequence', 'version', 'minLauncherVersion',
    'bundle', 'keyId', 'signature',
  ])) throw new Error('Connector manifest has unexpected fields');
  if (value.schemaVersion !== CONNECTOR_MANIFEST_SCHEMA_VERSION) {
    throw new Error('Unsupported connector manifest version');
  }
  if (value.channel !== CONNECTOR_CHANNEL) throw new Error('Unsupported connector release channel');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error('Connector release sequence is invalid');
  }
  if (value.sequence < highestSequence) throw new Error('Connector release is older than a previously trusted release');
  parseVersion(value.version, 'Connector version');
  parseVersion(value.minLauncherVersion, 'Minimum launcher version');
  if (launcherVersion && !versionAtLeast(launcherVersion, value.minLauncherVersion)) {
    throw new Error(`Connector ${value.version} requires launcher ${value.minLauncherVersion} or newer`);
  }
  if (value.keyId !== keyId) throw new Error('Connector release signing key is not trusted');
  if (!exactKeys(value.bundle, ['path', 'bytes', 'sha256'])) {
    throw new Error('Connector bundle descriptor is invalid');
  }
  if (!/^\/v1\/connector\/releases\/[a-f0-9]{64}\.hndb$/.test(value.bundle.path)) {
    throw new Error('Connector bundle path is invalid');
  }
  if (!Number.isSafeInteger(value.bundle.bytes)
    || value.bundle.bytes < 1
    || value.bundle.bytes > MAX_CONNECTOR_BUNDLE_BYTES) {
    throw new Error('Connector bundle size is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(value.bundle.sha256)
    || !value.bundle.path.endsWith(`/${value.bundle.sha256}.hndb`)) {
    throw new Error('Connector bundle digest is invalid');
  }
  if (typeof value.signature !== 'string'
    || !/^[A-Za-z0-9_-]{86}$/.test(value.signature)) {
    throw new Error('Connector manifest signature is invalid');
  }
  if (!publicKey) throw new Error('Connector release public key is unavailable');
  let signature;
  try {
    signature = Buffer.from(value.signature, 'base64url');
  } catch {
    throw new Error('Connector manifest signature is invalid');
  }
  if (signature.byteLength !== 64 || signature.toString('base64url') !== value.signature) {
    throw new Error('Connector manifest signature is invalid');
  }
  const verified = verify(
    null,
    Buffer.from(canonicalJson(unsignedManifest(value)), 'utf8'),
    publicKey,
    signature,
  );
  if (!verified) throw new Error('Connector manifest signature verification failed');
  return Object.freeze(structuredClone(value));
}

function safeBundlePath(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 240
    || value.includes('\\')
    || value.includes('\0')
    || value.startsWith('/')
  ) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..')
    && (
      value === 'assets/hnd-handoff/SKILL.md'
      || value === 'LICENSE'
      || /^src\/[A-Za-z0-9._/-]+\.mjs$/.test(value)
    );
}

export function validateConnectorBundle(bytes, manifest) {
  const source = Buffer.from(bytes);
  if (source.byteLength !== manifest.bundle.bytes) throw new Error('Connector bundle size does not match its manifest');
  if (sha256Hex(source) !== manifest.bundle.sha256) throw new Error('Connector bundle digest does not match its manifest');
  let value;
  try {
    value = JSON.parse(source.toString('utf8'));
  } catch {
    throw new Error('Connector bundle is not valid JSON');
  }
  if (!exactKeys(value, ['schemaVersion', 'version', 'entrypoint', 'files'])) {
    throw new Error('Connector bundle has unexpected fields');
  }
  if (value.schemaVersion !== CONNECTOR_BUNDLE_SCHEMA_VERSION
    || value.version !== manifest.version
    || value.entrypoint !== 'src/cli.mjs'
    || !Array.isArray(value.files)
    || value.files.length < 1
    || value.files.length > MAX_CONNECTOR_FILES) {
    throw new Error('Connector bundle metadata is invalid');
  }
  const seen = new Set();
  let totalBytes = 0;
  const files = value.files.map((file) => {
    if (!exactKeys(file, ['path', 'mode', 'size', 'sha256', 'content'])) {
      throw new Error('Connector bundle file descriptor is invalid');
    }
    if (!safeBundlePath(file.path)) throw new Error(`Unsafe connector bundle path: ${String(file.path)}`);
    const folded = file.path.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw new Error(`Duplicate connector bundle path: ${file.path}`);
    seen.add(folded);
    if (![0o600, 0o644, 0o700, 0o755].includes(file.mode)) {
      throw new Error(`Invalid connector file mode: ${file.path}`);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_CONNECTOR_FILE_BYTES) {
      throw new Error(`Invalid connector file size: ${file.path}`);
    }
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`Invalid connector file digest: ${file.path}`);
    }
    if (typeof file.content !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) {
      throw new Error(`Invalid connector file encoding: ${file.path}`);
    }
    const content = Buffer.from(file.content, 'base64');
    if (content.byteLength !== file.size || sha256Hex(content) !== file.sha256) {
      throw new Error(`Connector file integrity check failed: ${file.path}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_CONNECTOR_BUNDLE_BYTES) throw new Error('Connector bundle expands beyond its size limit');
    return Object.freeze({
      path: file.path,
      mode: file.mode,
      size: file.size,
      sha256: file.sha256,
      content,
    });
  });
  if (!seen.has(value.entrypoint.toLowerCase())) throw new Error('Connector bundle entrypoint is missing');
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    version: value.version,
    entrypoint: value.entrypoint,
    files: Object.freeze(files),
  });
}
