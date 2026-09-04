#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  canonicalJson,
  CONNECTOR_BUNDLE_SCHEMA_VERSION,
  CONNECTOR_CHANNEL,
  CONNECTOR_MANIFEST_SCHEMA_VERSION,
  CONNECTOR_RELEASE_KEY_ID,
  MAX_CONNECTOR_BUNDLE_BYTES,
  MAX_CONNECTOR_FILE_BYTES,
  MAX_CONNECTOR_FILES,
  validateConnectorBundle,
} from '../src/update/manifest.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const defaultFileList = path.join(projectRoot, 'assets', 'connector-runtime-files.txt');
const defaultPublicKey = path.join(projectRoot, 'assets', 'release-public-key.pem');
const defaultOutput = path.join(projectRoot, 'dist', 'connector-release');
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_KEY_BYTES = 16 * 1024;

function usage() {
  return [
    'Usage:',
    '  node scripts/build-connector-release.mjs --sequence N --private-key PATH',
    '      [--public-key PATH] [--key-id hnd-release-2026-01]',
    '      [--min-launcher-version VERSION] [--output DIRECTORY]',
    '',
    'Environment equivalents:',
    '  HND_RELEASE_SEQUENCE, HND_RELEASE_PRIVATE_KEY_FILE,',
    '  HND_RELEASE_PUBLIC_KEY_FILE, HND_RELEASE_KEY_ID,',
    '  HND_RELEASE_MIN_LAUNCHER_VERSION, HND_RELEASE_OUTPUT',
    '',
  ].join('\n');
}

function parseArguments(argv, env) {
  const parsed = {
    sequence: env.HND_RELEASE_SEQUENCE,
    privateKey: env.HND_RELEASE_PRIVATE_KEY_FILE,
    publicKey: env.HND_RELEASE_PUBLIC_KEY_FILE || defaultPublicKey,
    keyId: env.HND_RELEASE_KEY_ID || CONNECTOR_RELEASE_KEY_ID,
    minLauncherVersion: env.HND_RELEASE_MIN_LAUNCHER_VERSION,
    output: env.HND_RELEASE_OUTPUT || defaultOutput,
    help: false,
  };
  const options = new Map([
    ['--sequence', 'sequence'],
    ['--private-key', 'privateKey'],
    ['--public-key', 'publicKey'],
    ['--key-id', 'keyId'],
    ['--min-launcher-version', 'minLauncherVersion'],
    ['--output', 'output'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    const name = options.get(argument);
    if (!name) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    parsed[name] = value;
    index += 1;
  }
  if (parsed.help) return parsed;
  if (!/^\d+$/.test(String(parsed.sequence || ''))) {
    throw new Error('--sequence must be a positive integer');
  }
  parsed.sequence = Number(parsed.sequence);
  if (!Number.isSafeInteger(parsed.sequence) || parsed.sequence < 1) {
    throw new Error('--sequence must be a positive safe integer');
  }
  if (!parsed.privateKey) throw new Error('--private-key is required');
  if (parsed.keyId !== CONNECTOR_RELEASE_KEY_ID) {
    throw new Error(`--key-id must be ${CONNECTOR_RELEASE_KEY_ID}`);
  }
  parsed.privateKey = path.resolve(parsed.privateKey);
  parsed.publicKey = path.resolve(parsed.publicKey);
  parsed.output = path.resolve(parsed.output);
  return parsed;
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readRegularFile(filePath, maximumBytes, { privateFile = false } = {}) {
  const metadata = await fs.lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new Error(`Expected a regular file no larger than ${maximumBytes} bytes: ${filePath}`);
  }
  if (privateFile && process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('The connector release private key must not be accessible by group or other users');
  }
  const value = await fs.readFile(filePath);
  if (value.byteLength > maximumBytes) throw new Error(`File is too large: ${filePath}`);
  return value;
}

async function assertPrivateKeyOutsideProject(filePath) {
  const canonicalProject = await fs.realpath(projectRoot);
  const canonicalKey = await fs.realpath(filePath);
  if (isInside(canonicalProject, canonicalKey)) {
    throw new Error('The connector release private key must be stored outside the project directory');
  }
}

function validateReleaseVersion(value, label) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new Error(`${label} must be a semantic version such as 1.2.3`);
  }
  return value;
}

function safeRuntimePath(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 240
    || value.includes('\\')
    || value.includes('\0')
    || path.posix.isAbsolute(value)
  ) return false;
  const segments = value.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) return false;
  const allowed = value === 'LICENSE'
    || value === 'assets/hnd-handoff/SKILL.md'
    || /^src\/[A-Za-z0-9._/-]+\.mjs$/.test(value);
  if (!allowed) return false;
  return !value.startsWith('src/server/')
    && !value.startsWith('src/web/')
    && !value.startsWith('src/browser/')
    && ![
      'src/sync/index.mjs',
      'src/sync/server.mjs',
      'src/sync/store.mjs',
    ].includes(value);
}

async function assertSourceFile(relativePath) {
  if (!safeRuntimePath(relativePath)) {
    throw new Error(`Unsafe connector runtime allowlist entry: ${relativePath}`);
  }
  const segments = relativePath.split('/');
  let current = projectRoot;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = await fs.lstat(current);
    const final = index === segments.length - 1;
    if (
      metadata.isSymbolicLink()
      || (final ? !metadata.isFile() : !metadata.isDirectory())
      || (final && metadata.size > MAX_CONNECTOR_FILE_BYTES)
    ) {
      throw new Error(`Connector runtime source path is unsafe: ${relativePath}`);
    }
  }
  return current;
}

async function runtimeSources() {
  const listMetadata = await fs.lstat(defaultFileList);
  if (!listMetadata.isFile() || listMetadata.isSymbolicLink()) {
    throw new Error('Connector runtime allowlist is missing or unsafe');
  }
  const source = await fs.readFile(defaultFileList, 'utf8');
  const entries = source.split(/\r?\n/u).filter(Boolean);
  if (
    entries.length < 1
    || entries.length > MAX_CONNECTOR_FILES
    || new Set(entries).size !== entries.length
  ) {
    throw new Error('Connector runtime allowlist is empty or contains duplicates');
  }
  const sorted = [...entries].sort();
  if (entries.some((entry, index) => entry !== sorted[index])) {
    throw new Error('Connector runtime allowlist must be sorted');
  }
  const result = new Map();
  for (const relativePath of entries) {
    const absolutePath = await assertSourceFile(relativePath);
    result.set(relativePath, await fs.readFile(absolutePath));
  }
  return result;
}

async function smokeRuntime(sources) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-release-smoke-'));
  try {
    for (const [relativePath, contents] of sources) {
      const target = path.join(staging, ...relativePath.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, contents, { flag: 'wx', mode: 0o644 });
    }
    const entrypoint = path.join(staging, 'src', 'cli.mjs');
    const loaded = await import(`${pathToFileURL(entrypoint).href}?release-build-smoke=1`);
    if (typeof loaded.main !== 'function') {
      throw new Error('Connector runtime entrypoint does not export main');
    }
  } catch (cause) {
    throw new Error(`Connector runtime smoke test failed: ${cause.message}`, { cause });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

function assertClientModuleClosure(sources) {
  const pending = ['src/cli.mjs'];
  const visited = new Set();
  const relativeModule = /(["'])(\.{1,2}\/[^"'\n]+\.mjs)\1/gu;
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    const contents = sources.get(current);
    if (!contents) throw new Error(`Connector runtime is missing imported module: ${current}`);
    visited.add(current);
    const source = contents.toString('utf8');
    for (const match of source.matchAll(relativeModule)) {
      const prefix = source.slice(Math.max(0, match.index - 512), match.index);
      if (!/(?:\bfrom|\bimport|\bimport\s*\()\s*$/u.test(prefix)) continue;
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(current), match[2]));
      if (!safeRuntimePath(dependency) || !sources.has(dependency)) {
        throw new Error(`Connector runtime import escapes its reviewed allowlist: ${current} -> ${match[2]}`);
      }
      pending.push(dependency);
    }
  }
  const extraModules = [...sources.keys()].filter(
    (file) => file.endsWith('.mjs') && !visited.has(file),
  );
  if (extraModules.length > 0) {
    throw new Error(`Connector runtime contains unreachable modules: ${extraModules.join(', ')}`);
  }
}

function buildBundle(version, sources) {
  const files = [...sources.entries()].map(([filePath, contents]) => ({
    path: filePath,
    mode: 0o644,
    size: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
    content: contents.toString('base64'),
  }));
  return {
    schemaVersion: CONNECTOR_BUNDLE_SCHEMA_VERSION,
    version,
    entrypoint: 'src/cli.mjs',
    files,
  };
}

async function loadSigningKeys(options, { allowTestPublicKeyOverride = false } = {}) {
  await assertPrivateKeyOutsideProject(options.privateKey);
  const [privateBytes, publicBytes, pinnedPublicBytes] = await Promise.all([
    readRegularFile(options.privateKey, MAX_KEY_BYTES, { privateFile: true }),
    readRegularFile(options.publicKey, MAX_KEY_BYTES),
    allowTestPublicKeyOverride ? null : readRegularFile(defaultPublicKey, MAX_KEY_BYTES),
  ]);
  let privateKey;
  let publicKey;
  try {
    privateKey = createPrivateKey(privateBytes);
    publicKey = createPublicKey(publicBytes);
  } catch {
    throw new Error('Connector release signing key is invalid');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Connector releases require Ed25519 keys');
  }
  if (!allowTestPublicKeyOverride) {
    let pinnedPublicKey;
    try {
      pinnedPublicKey = createPublicKey(pinnedPublicBytes);
    } catch {
      throw new Error('Pinned connector release public key is invalid');
    }
    const pinned = pinnedPublicKey.export({ type: 'spki', format: 'der' });
    const supplied = publicKey.export({ type: 'spki', format: 'der' });
    if (!Buffer.from(pinned).equals(Buffer.from(supplied))) {
      throw new Error('Connector release public key does not match the pinned launcher key');
    }
  }
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const supplied = publicKey.export({ type: 'spki', format: 'der' });
  if (!Buffer.from(derived).equals(Buffer.from(supplied))) {
    throw new Error('Connector release private and public keys do not match');
  }
  return { privateKey, publicKey };
}

async function validateExistingOutput(output) {
  let metadata;
  try {
    metadata = await fs.lstat(output);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Connector release output must be a real directory');
  }
  const entries = await fs.readdir(output, { withFileTypes: true });
  if (entries.length === 0 && output !== defaultOutput) {
    throw new Error(`Refusing to replace an unrecognized output directory: ${output}`);
  }
  for (const entry of entries) {
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || (entry.name !== 'manifest.json' && !/^[a-f0-9]{64}\.hndb$/.test(entry.name))
    ) {
      throw new Error(`Refusing to replace an unrecognized output directory: ${output}`);
    }
  }
  return true;
}

async function writeSyncedFile(filePath, contents) {
  let handle;
  try {
    handle = await fs.open(filePath, 'wx', 0o644);
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function writeBuildOutput(output, manifestBytes, bundleDigest, bundleBytes) {
  const parent = path.dirname(output);
  const basename = path.basename(output);
  if (
    !basename
    || basename === '.'
    || basename === '..'
    || output === path.parse(output).root
    || output === path.resolve(projectRoot)
    || output === path.resolve(os.homedir())
  ) {
    throw new Error('Connector release output path is unsafe');
  }
  await fs.mkdir(parent, { recursive: true });
  const existed = await validateExistingOutput(output);
  const staging = await fs.mkdtemp(path.join(parent, `.${basename}.stage-`));
  let backup = null;
  try {
    await writeSyncedFile(path.join(staging, `${bundleDigest}.hndb`), bundleBytes);
    await writeSyncedFile(path.join(staging, 'manifest.json'), manifestBytes);
    await syncDirectory(staging);
    if (existed) {
      backup = path.join(parent, `.${basename}.previous-${process.pid}-${Date.now()}`);
      await fs.rename(output, backup);
    }
    try {
      await fs.rename(staging, output);
    } catch (error) {
      if (backup) await fs.rename(backup, output).catch(() => {});
      throw error;
    }
    await syncDirectory(parent);
    if (backup) await fs.rm(backup, { recursive: true });
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export async function buildConnectorRelease(argv = process.argv.slice(2), {
  env = process.env,
  stdout = process.stdout,
  allowTestPublicKeyOverride = false,
} = {}) {
  const options = parseArguments(argv, env);
  if (options.help) {
    stdout.write(usage());
    return null;
  }
  const packageMetadata = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const packageVersion = validateReleaseVersion(packageMetadata.version, 'Package version');
  options.minLauncherVersion = validateReleaseVersion(
    options.minLauncherVersion || packageVersion,
    'Minimum launcher version',
  );
  const { VERSION: connectorVersion } = await import('../src/constants.mjs');
  const version = validateReleaseVersion(connectorVersion, 'Connector runtime version');

  const [sources, keys] = await Promise.all([
    runtimeSources(),
    loadSigningKeys(options, { allowTestPublicKeyOverride }),
  ]);
  assertClientModuleClosure(sources);
  await smokeRuntime(sources);
  const bundle = buildBundle(version, sources);
  const bundleBytes = Buffer.from(canonicalJson(bundle), 'utf8');
  if (bundleBytes.byteLength > MAX_CONNECTOR_BUNDLE_BYTES) {
    throw new Error(`Connector bundle exceeds ${MAX_CONNECTOR_BUNDLE_BYTES} byte limit`);
  }
  const bundleDigest = createHash('sha256').update(bundleBytes).digest('hex');
  const unsignedManifest = {
    schemaVersion: CONNECTOR_MANIFEST_SCHEMA_VERSION,
    channel: CONNECTOR_CHANNEL,
    sequence: options.sequence,
    version,
    minLauncherVersion: options.minLauncherVersion,
    bundle: {
      path: `/v1/connector/releases/${bundleDigest}.hndb`,
      bytes: bundleBytes.byteLength,
      sha256: bundleDigest,
    },
    keyId: options.keyId,
  };
  const signedBytes = Buffer.from(canonicalJson(unsignedManifest), 'utf8');
  const signature = sign(null, signedBytes, keys.privateKey);
  if (!verify(null, signedBytes, keys.publicKey, signature)) {
    throw new Error('Connector release signature self-check failed');
  }
  const manifest = { ...unsignedManifest, signature: signature.toString('base64url') };
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
  validateConnectorBundle(bundleBytes, manifest);
  await writeBuildOutput(options.output, manifestBytes, bundleDigest, bundleBytes);
  stdout.write(`connector release: ${version} sequence ${options.sequence}\n`);
  stdout.write(`bundle: ${bundleDigest} (${bundleBytes.byteLength} bytes)\n`);
  stdout.write(`output: ${options.output}\n`);
  return Object.freeze({ manifest, output: options.output });
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  buildConnectorRelease().catch((error) => {
    process.stderr.write(`build-connector-release: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
