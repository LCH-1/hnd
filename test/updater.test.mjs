import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MANAGED_SKILL_MARKER } from '../src/adapters/common.mjs';
import { withAdapterMutationLock } from '../src/adapters/mutation-lock.mjs';
import { VERSION as RUNTIME_VERSION } from '../src/constants.mjs';
import { launcherMain, scheduleAutomaticUpdate } from '../src/launcher.mjs';
import { LAUNCHER_VERSION } from '../src/launcher-version.mjs';
import { agentPaths, statePaths } from '../src/paths.mjs';
import {
  applyConnectorUpdate,
  checkConnectorUpdate,
  rollbackConnectorUpdate,
} from '../src/update/client.mjs';
import {
  installConnectorBundle,
  smokeConnectorRuntime,
} from '../src/update/install.mjs';
import {
  refreshManagedSkills,
  refreshManagedSkillsAfterUpdate,
} from '../src/update/integration.mjs';
import {
  CONNECTOR_RELEASE_KEY_ID,
  canonicalJson,
  sha256Hex,
  validateConnectorBundle,
  validateConnectorManifest,
  versionAtLeast,
} from '../src/update/manifest.mjs';
import {
  readRuntimePointer,
  readUpdateState,
  runtimeDirectory,
  runtimePaths,
  runtimeReady,
} from '../src/update/state.mjs';

function releaseKeyPair() {
  return generateKeyPairSync('ed25519');
}

function fileDescriptor(filePath, contents, mode = 0o644) {
  const content = Buffer.from(contents);
  return {
    path: filePath,
    mode,
    size: content.byteLength,
    sha256: sha256Hex(content),
    content: content.toString('base64'),
  };
}

function encodeBundle(value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  const digest = sha256Hex(bytes);
  return {
    bytes,
    descriptor: {
      path: `/v1/connector/releases/${digest}.hndb`,
      bytes: bytes.byteLength,
      sha256: digest,
    },
  };
}

function connectorBundle({
  version = '1.0.0',
  source = 'export async function main() {}\n',
  files,
} = {}) {
  const value = {
    schemaVersion: 1,
    version,
    entrypoint: 'src/cli.mjs',
    files: files ?? [fileDescriptor('src/cli.mjs', source)],
  };
  return { value, ...encodeBundle(value) };
}

function signedManifest(bundle, privateKey, {
  sequence = 1,
  version = '1.0.0',
  minLauncherVersion = '0.1.0',
} = {}) {
  const unsigned = {
    schemaVersion: 1,
    channel: 'stable',
    sequence,
    version,
    minLauncherVersion,
    bundle: bundle.descriptor,
    keyId: CONNECTOR_RELEASE_KEY_ID,
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonicalJson(unsigned), 'utf8'),
      privateKey,
    ).toString('base64url'),
  };
}

function releaseFixture(keyPair, options = {}) {
  const version = options.version ?? '1.0.0';
  const bundle = connectorBundle({
    version,
    source: options.source,
    files: options.files,
  });
  return {
    bundle,
    manifest: signedManifest(bundle, keyPair.privateKey, {
      sequence: options.sequence ?? 1,
      version,
      minLauncherVersion: options.minLauncherVersion ?? '0.1.0',
    }),
  };
}

async function temporaryEnvironment(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-updater-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'state');
  const userHome = path.join(root, 'user');
  await fs.mkdir(userHome, { recursive: true });
  return {
    root,
    env: {
      ...process.env,
      HND_HOME: home,
      HND_USER_HOME: userHome,
      HND_DISABLE_AUTO_UPDATE: '1',
    },
  };
}

async function writeJson(file, value, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

async function configureRemote(env, baseUrl = 'https://updates.example.test') {
  const paths = statePaths(env);
  await writeJson(paths.remotes, { schemaVersion: 1, baseUrl });
  await fs.mkdir(paths.secrets, { recursive: true, mode: 0o700 });
  const deviceToken = `hndd_${'D'.repeat(43)}`;
  await fs.writeFile(path.join(paths.secrets, 'device.token'), `${deviceToken}\n`, {
    mode: 0o600,
  });
  return { baseUrl: new URL(baseUrl).href, deviceToken };
}

async function writePublicKey(root, publicKey) {
  const file = path.join(root, 'release-public-key.pem');
  await fs.writeFile(file, publicKey.export({ type: 'spki', format: 'pem' }), {
    mode: 0o644,
  });
  return file;
}

function byteResponse(bytes, status = 200, headers = {}) {
  const body = Buffer.from(bytes);
  return new Response(body, {
    status,
    headers: {
      'Content-Length': String(body.byteLength),
      ...headers,
    },
  });
}

function outputStream() {
  const chunks = [];
  return {
    write(value) {
      chunks.push(String(value));
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
}

test('update help describes the command-triggered short background check accurately', async (t) => {
  const { env } = await temporaryEnvironment(t);
  env.LANG = 'ko_KR.UTF-8';
  const stdout = outputStream();
  const stderr = outputStream();
  await launcherMain(['update', 'help'], { env, stdout, stderr });
  const help = stdout.text();
  assert.match(help, /hnd 명령을 실행할 때 마지막 확인 시도 후 6시간/u);
  assert.match(help, /짧은 백그라운드 확인을 시작/u);
  assert.match(help, /계속 실행되는 업데이트 프로그램은 없습니다/u);
  assert.doesNotMatch(help, /평소에는 6시간마다/u);
  assert.equal(stderr.text(), '');
});

test('automatic update spawn errors never escape into the foreground command', async (t) => {
  const { env } = await temporaryEnvironment(t);
  env.HND_DISABLE_AUTO_UPDATE = '0';
  await configureRemote(env);
  const child = new EventEmitter();
  let unrefCalled = false;
  child.unref = () => {
    unrefCalled = true;
  };

  const scheduled = await scheduleAutomaticUpdate(env, {
    execPath: path.join(env.HND_USER_HOME, 'missing-node'),
    spawnImpl: () => child,
  });

  assert.equal(scheduled, true);
  assert.equal(unrefCalled, true);
  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('spawn failed'), {
    code: 'ENOENT',
  })));
});

test('update status separates the npm launcher, local runtime, and server runtime', async (t) => {
  const { env } = await temporaryEnvironment(t);
  env.LANG = 'ko_KR.UTF-8';
  const stdout = outputStream();
  const stderr = outputStream();
  await launcherMain(['update', 'status'], { env, stdout, stderr });
  const status = stdout.text();
  assert.match(status, /npm 런처: \d+\.\d+\.\d+/u);
  assert.match(status, /로컬 런타임: \d+\.\d+\.\d+ · npm 내장/u);
  assert.match(status, /서버 제공 런타임: PC 연결 후 확인 가능/u);
  assert.match(status, /업데이트 상태: 중앙 서버에 PC 연결 필요/u);
  assert.equal(stderr.text(), '');

  const jsonOut = outputStream();
  await launcherMain(['update', 'status', '--json'], { env, stdout: jsonOut, stderr });
  const json = JSON.parse(jsonOut.text());
  assert.equal(json.launcherVersion, LAUNCHER_VERSION);
  assert.equal(json.clientRelease.version, RUNTIME_VERSION);
  assert.notEqual(json.launcherVersion, json.clientRelease.version);
  assert.equal(json.clientRelease.builtIn, true);
  assert.equal(json.serverRelease, null);
});

test('connector manifests verify Ed25519 signatures and reject tampering, rollback, and old launchers', () => {
  const keys = releaseKeyPair();
  const release = releaseFixture(keys, {
    sequence: 7,
    version: '2.3.4',
    minLauncherVersion: '0.4.0',
  });
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const validated = validateConnectorManifest(release.manifest, {
    launcherVersion: '0.4.0',
    publicKey,
    highestSequence: 7,
  });
  assert.equal(validated.version, '2.3.4');
  assert.equal(Object.isFrozen(validated), true);

  assert.throws(
    () => validateConnectorManifest(
      { ...release.manifest, version: '2.3.5' },
      { launcherVersion: '0.4.0', publicKey, highestSequence: 7 },
    ),
    /signature verification failed/,
  );
  assert.throws(
    () => validateConnectorManifest(release.manifest, {
      launcherVersion: '0.4.0',
      publicKey,
      highestSequence: 8,
    }),
    /older than a previously trusted release/,
  );
  assert.throws(
    () => validateConnectorManifest(release.manifest, {
      launcherVersion: '0.3.9',
      publicKey,
      highestSequence: 0,
    }),
    /requires launcher 0\.4\.0 or newer/,
  );
  const otherKeys = releaseKeyPair();
  assert.throws(
    () => validateConnectorManifest(release.manifest, {
      launcherVersion: '0.4.0',
      publicKey: otherKeys.publicKey,
    }),
    /signature verification failed/,
  );
  assert.equal(versionAtLeast('0.4.0', '0.4.0'), true);
  assert.equal(versionAtLeast('0.4.1', '0.4.0'), true);
  assert.equal(versionAtLeast('0.4.0-beta.1', '0.4.0'), false);
});

test('connector bundles reject traversal, case-fold duplicates, and inner or outer integrity mismatches', () => {
  const valid = connectorBundle();
  const manifest = { version: '1.0.0', bundle: valid.descriptor };
  const decoded = validateConnectorBundle(valid.bytes, manifest);
  assert.equal(decoded.entrypoint, 'src/cli.mjs');

  for (const unsafePath of [
    '../escape.mjs',
    'src/../escape.mjs',
    'src\\escape.mjs',
    '/src/escape.mjs',
  ]) {
    const unsafe = connectorBundle({
      files: [
        fileDescriptor('src/cli.mjs', 'export function main() {}\n'),
        fileDescriptor(unsafePath, 'unsafe\n'),
      ],
    });
    assert.throws(
      () => validateConnectorBundle(unsafe.bytes, {
        version: '1.0.0',
        bundle: unsafe.descriptor,
      }),
      /Unsafe connector bundle path/,
    );
  }

  const duplicate = connectorBundle({
    files: [
      fileDescriptor('src/cli.mjs', 'export function main() {}\n'),
      fileDescriptor('src/CLI.mjs', 'export function main() {}\n'),
    ],
  });
  assert.throws(
    () => validateConnectorBundle(duplicate.bytes, {
      version: '1.0.0',
      bundle: duplicate.descriptor,
    }),
    /Duplicate connector bundle path/,
  );

  for (const field of ['size', 'sha256']) {
    const changed = structuredClone(valid.value);
    changed.files[0][field] = field === 'size'
      ? changed.files[0].size + 1
      : '0'.repeat(64);
    const encoded = encodeBundle(changed);
    assert.throws(
      () => validateConnectorBundle(encoded.bytes, {
        version: '1.0.0',
        bundle: encoded.descriptor,
      }),
      /Connector file integrity check failed/,
    );
  }

  assert.throws(
    () => validateConnectorBundle(valid.bytes, {
      version: '1.0.0',
      bundle: { ...valid.descriptor, bytes: valid.descriptor.bytes + 1 },
    }),
    /bundle size does not match/,
  );
  assert.throws(
    () => validateConnectorBundle(valid.bytes, {
      version: '1.0.0',
      bundle: { ...valid.descriptor, sha256: '0'.repeat(64) },
    }),
    /bundle digest does not match/,
  );
});

test('bundle installation publishes atomically and leaves the active runtime unchanged after smoke failure', async (t) => {
  const { env } = await temporaryEnvironment(t);
  const keys = releaseKeyPair();
  const first = releaseFixture(keys, { sequence: 1, version: '1.0.0' });
  let smokeDirectory;
  const installed = await installConnectorBundle(first.manifest, first.bundle.bytes, {
    env,
    smoke: async (directory) => {
      smokeDirectory = directory;
      assert.match(await fs.readFile(path.join(directory, 'src', 'cli.mjs'), 'utf8'), /main/);
      await assert.rejects(fs.lstat(path.join(directory, '.complete')), { code: 'ENOENT' });
    },
  });
  assert.equal(installed.installed, true);
  assert.equal(installed.reused, false);
  assert.match(path.basename(smokeDirectory), /^\.staging-/);
  assert.deepEqual(await readRuntimePointer('current', env), installed.pointer);
  assert.equal(await runtimeReady(installed.pointer, env), true);
  assert.equal(
    (await fs.stat(path.join(installed.directory, 'src', 'cli.mjs'))).mode & 0o777,
    0o644,
  );

  const second = releaseFixture(keys, { sequence: 2, version: '1.1.0' });
  await assert.rejects(
    installConnectorBundle(second.manifest, second.bundle.bytes, {
      env,
      smoke: async () => {
        throw new Error('deliberate smoke failure');
      },
    }),
    /deliberate smoke failure/,
  );
  assert.deepEqual(await readRuntimePointer('current', env), installed.pointer);
  await assert.rejects(fs.lstat(runtimeDirectory({
    schemaVersion: 1,
    sequence: second.manifest.sequence,
    version: second.manifest.version,
    sha256: second.manifest.bundle.sha256,
  }, env)), { code: 'ENOENT' });
  const runtimeEntries = await fs.readdir(runtimePaths(env).root);
  assert.equal(runtimeEntries.some((entry) => entry.startsWith('.staging-')), false);
});

test('runtime readiness rechecks the completion marker and every installed file hash', async (t) => {
  const { env } = await temporaryEnvironment(t);
  const keys = releaseKeyPair();
  const release = releaseFixture(keys);
  const installed = await installConnectorBundle(release.manifest, release.bundle.bytes, {
    env,
    smoke: async () => {},
  });
  const entrypoint = path.join(installed.directory, 'src', 'cli.mjs');
  const original = await fs.readFile(entrypoint);
  assert.equal(await runtimeReady(installed.pointer, env), true);

  await fs.writeFile(entrypoint, Buffer.concat([original, Buffer.from('// changed\n')]));
  assert.equal(await runtimeReady(installed.pointer, env), false);
  await fs.writeFile(entrypoint, original);
  assert.equal(await runtimeReady(installed.pointer, env), true);

  await fs.writeFile(path.join(installed.directory, '.complete'), '{"schemaVersion":1}\n');
  assert.equal(await runtimeReady(installed.pointer, env), false);
});

test('runtime refresh updates only existing managed skills and never installs or takes over files', async (t) => {
  const { env } = await temporaryEnvironment(t);
  const keys = releaseKeyPair();
  const desired = `${MANAGED_SKILL_MARKER}\n# Updated runtime skill\n`;
  const release = releaseFixture(keys, {
    files: [
      fileDescriptor('src/cli.mjs', 'export async function main() {}\n'),
      fileDescriptor('assets/hnd-handoff/SKILL.md', desired),
    ],
  });
  const installed = await installConnectorBundle(release.manifest, release.bundle.bytes, {
    env,
    smoke: async () => {},
  });
  assert.equal(await runtimeReady(installed.pointer, env), true);

  const paths = agentPaths(env);
  const oldManaged = `${MANAGED_SKILL_MARKER}\n# Old managed skill\n`;
  const unmanaged = '# User-owned skill\n';
  await fs.mkdir(path.dirname(paths.claude.skill), { recursive: true });
  await fs.mkdir(path.dirname(paths.cursor.skill), { recursive: true });
  await fs.writeFile(paths.claude.skill, oldManaged, { mode: 0o600 });
  await fs.writeFile(paths.cursor.skill, unmanaged, { mode: 0o600 });

  const updated = await refreshManagedSkills(installed.directory, env);
  assert.deepEqual(updated, [{ agent: 'claude', path: paths.claude.skill }]);
  assert.equal(await fs.readFile(paths.claude.skill, 'utf8'), desired);
  await assert.rejects(fs.lstat(paths.codex.skill), { code: 'ENOENT' });
  assert.equal(await fs.readFile(paths.cursor.skill, 'utf8'), unmanaged);
  assert.deepEqual(await refreshManagedSkills(installed.directory, env), []);
});

test('a delayed older updater cannot replace skills from the active runtime', async (t) => {
  const { env } = await temporaryEnvironment(t);
  const keys = releaseKeyPair();
  const oldSkill = `${MANAGED_SKILL_MARKER}\n# Runtime v1 skill\n`;
  const newSkill = `${MANAGED_SKILL_MARKER}\n# Runtime v2 skill\n`;
  const oldRelease = releaseFixture(keys, {
    sequence: 1,
    version: '1.0.0',
    files: [
      fileDescriptor('src/cli.mjs', 'export async function main() {}\n'),
      fileDescriptor('assets/hnd-handoff/SKILL.md', oldSkill),
    ],
  });
  const newRelease = releaseFixture(keys, {
    sequence: 2,
    version: '2.0.0',
    files: [
      fileDescriptor('src/cli.mjs', 'export async function main() {}\n'),
      fileDescriptor('assets/hnd-handoff/SKILL.md', newSkill),
    ],
  });
  const oldInstalled = await installConnectorBundle(
    oldRelease.manifest,
    oldRelease.bundle.bytes,
    { env, smoke: async () => {} },
  );
  const skillPath = agentPaths(env).claude.skill;
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, `${MANAGED_SKILL_MARKER}\n# Initial skill\n`);
  const newInstalled = await installConnectorBundle(
    newRelease.manifest,
    newRelease.bundle.bytes,
    { env, smoke: async () => {} },
  );

  assert.deepEqual(await refreshManagedSkills(newInstalled.directory, env), [{
    agent: 'claude',
    path: skillPath,
  }]);
  assert.equal(await fs.readFile(skillPath, 'utf8'), newSkill);
  assert.deepEqual(await refreshManagedSkills(oldInstalled.directory, env), []);
  assert.equal(await fs.readFile(skillPath, 'utf8'), newSkill);
});

test('runtime refresh cannot recreate a managed skill removed by concurrent uninstall', async (t) => {
  const { env } = await temporaryEnvironment(t);
  const keys = releaseKeyPair();
  const desired = `${MANAGED_SKILL_MARKER}\n# Updated runtime skill\n`;
  const release = releaseFixture(keys, {
    files: [
      fileDescriptor('src/cli.mjs', 'export async function main() {}\n'),
      fileDescriptor('assets/hnd-handoff/SKILL.md', desired),
    ],
  });
  const installed = await installConnectorBundle(release.manifest, release.bundle.bytes, {
    env,
    smoke: async () => {},
  });
  const skillPath = agentPaths(env).claude.skill;
  const oldManaged = `${MANAGED_SKILL_MARKER}\n# Old managed skill\n`;
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, oldManaged, { mode: 0o600 });

  let refresh;
  await withAdapterMutationLock(env, async () => {
    refresh = refreshManagedSkills(installed.directory, env);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await fs.readFile(skillPath, 'utf8'), oldManaged);
    await fs.rm(skillPath);
  });

  assert.deepEqual(await refresh, []);
  await assert.rejects(fs.lstat(skillPath), { code: 'ENOENT' });
});

test('runtime refresh refuses a managed-skill symlink without following or replacing it', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows symlink creation requires environment-specific privileges');
    return;
  }
  const { root, env } = await temporaryEnvironment(t);
  const keys = releaseKeyPair();
  const desired = `${MANAGED_SKILL_MARKER}\n# Updated runtime skill\n`;
  const release = releaseFixture(keys, {
    files: [
      fileDescriptor('src/cli.mjs', 'export async function main() {}\n'),
      fileDescriptor('assets/hnd-handoff/SKILL.md', desired),
    ],
  });
  const installed = await installConnectorBundle(release.manifest, release.bundle.bytes, {
    env,
    smoke: async () => {},
  });
  const paths = agentPaths(env);
  const outside = path.join(root, 'outside-skill.md');
  const outsideContents = `${MANAGED_SKILL_MARKER}\n# Outside user file\n`;
  await fs.writeFile(outside, outsideContents);
  await fs.mkdir(path.dirname(paths.claude.skill), { recursive: true });
  await fs.symlink(outside, paths.claude.skill);

  await assert.rejects(
    refreshManagedSkills(installed.directory, env),
    /regular file|symbolic link|unsafe/i,
  );
  assert.equal((await fs.lstat(paths.claude.skill)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(outside, 'utf8'), outsideContents);
});

test('runtime refresh requires an intact completion marker and real hash-verified skill file', async (t) => {
  const { root, env } = await temporaryEnvironment(t);
  const keys = releaseKeyPair();
  const desired = `${MANAGED_SKILL_MARKER}\n# Signed runtime skill\n`;
  const release = releaseFixture(keys, {
    files: [
      fileDescriptor('src/cli.mjs', 'export async function main() {}\n'),
      fileDescriptor('assets/hnd-handoff/SKILL.md', desired),
    ],
  });
  const installed = await installConnectorBundle(release.manifest, release.bundle.bytes, {
    env,
    smoke: async () => {},
  });
  const paths = agentPaths(env);
  const oldManaged = `${MANAGED_SKILL_MARKER}\n# Old managed skill\n`;
  await fs.mkdir(path.dirname(paths.claude.skill), { recursive: true });
  await fs.writeFile(paths.claude.skill, oldManaged, { mode: 0o600 });

  const markerPath = path.join(installed.directory, '.complete');
  const marker = await fs.readFile(markerPath);
  await fs.writeFile(markerPath, '{"schemaVersion":1}\n');
  assert.equal(await runtimeReady(installed.pointer, env), false);
  await assert.rejects(
    refreshManagedSkills(installed.directory, env),
    /runtime|completion|verified|integrity/i,
  );
  assert.equal(await fs.readFile(paths.claude.skill, 'utf8'), oldManaged);

  await fs.writeFile(markerPath, marker);
  const source = path.join(installed.directory, 'assets', 'hnd-handoff', 'SKILL.md');
  await fs.writeFile(source, `${MANAGED_SKILL_MARKER}\n# Locally tampered skill\n`);
  assert.equal(await runtimeReady(installed.pointer, env), false);
  await assert.rejects(
    refreshManagedSkills(installed.directory, env),
    /runtime|completion|verified|integrity/i,
  );
  assert.equal(await fs.readFile(paths.claude.skill, 'utf8'), oldManaged);

  await fs.writeFile(source, desired);
  assert.equal(await runtimeReady(installed.pointer, env), true);
  const copiedRuntime = path.join(root, 'copied-runtime');
  await fs.cp(installed.directory, copiedRuntime, { recursive: true });
  await assert.rejects(
    refreshManagedSkills(copiedRuntime, env),
    /does not match its verified release/,
  );
  assert.equal(await fs.readFile(paths.claude.skill, 'utf8'), oldManaged);

  if (process.platform !== 'win32') {
    const outside = path.join(root, 'untrusted-runtime-skill.md');
    await fs.writeFile(outside, desired);
    await fs.unlink(source);
    await fs.symlink(outside, source);
    assert.equal(await runtimeReady(installed.pointer, env), false);
    await assert.rejects(
      refreshManagedSkills(installed.directory, env),
      /runtime|completion|verified|integrity/i,
    );
    assert.equal(await fs.readFile(paths.claude.skill, 'utf8'), oldManaged);
  }
});

test('a no-change apply retries managed skill refresh for the active runtime', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows symlink creation requires environment-specific privileges');
    return;
  }
  const { root, env } = await temporaryEnvironment(t);
  const remote = await configureRemote(env);
  const keys = releaseKeyPair();
  const publicKeyPath = await writePublicKey(root, keys.publicKey);
  const desired = `${MANAGED_SKILL_MARKER}\n# Current runtime skill\n`;
  const release = releaseFixture(keys, {
    files: [
      fileDescriptor('src/cli.mjs', 'export async function main() {}\n'),
      fileDescriptor('assets/hnd-handoff/SKILL.md', desired),
    ],
  });
  const fetchImpl = async (target, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${remote.deviceToken}`);
    const url = new URL(target);
    if (url.pathname === '/v1/connector/manifest') {
      return byteResponse(Buffer.from(JSON.stringify(release.manifest), 'utf8'));
    }
    if (url.pathname === release.manifest.bundle.path) return byteResponse(release.bundle.bytes);
    return byteResponse(Buffer.from('not found'), 404);
  };
  const updateOptions = {
    env,
    launcherVersion: '0.1.1',
    publicKeyPath,
    fetchImpl,
    smoke: async () => {},
  };
  const first = await applyConnectorUpdate(updateOptions);
  assert.equal(first.installed, true);

  const skillPath = agentPaths(env).claude.skill;
  const outside = path.join(root, 'linked-managed-skill.md');
  await fs.writeFile(outside, `${MANAGED_SKILL_MARKER}\n# Linked skill\n`);
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.symlink(outside, skillPath);
  await assert.rejects(
    refreshManagedSkillsAfterUpdate(first, env),
    /regular file|symbolic link|unsafe/i,
  );

  await fs.unlink(skillPath);
  await fs.writeFile(skillPath, `${MANAGED_SKILL_MARKER}\n# Stale skill\n`);
  const second = await applyConnectorUpdate(updateOptions);
  assert.equal(second.installed, false);
  assert.equal(second.current.sha256, first.pointer.sha256);
  assert.equal(second.directory, undefined);
  assert.deepEqual(await refreshManagedSkillsAfterUpdate(second, env), [{
    agent: 'claude',
    path: skillPath,
  }]);
  assert.equal(await fs.readFile(skillPath, 'utf8'), desired);
});

test('the real runtime smoke check imports a valid module and rejects a broken module', async (t) => {
  const { root } = await temporaryEnvironment(t);
  const good = path.join(root, 'good-runtime');
  const bad = path.join(root, 'bad-runtime');
  const missingMain = path.join(root, 'missing-main-runtime');
  await fs.mkdir(path.join(good, 'src'), { recursive: true });
  await fs.mkdir(path.join(bad, 'src'), { recursive: true });
  await fs.mkdir(path.join(missingMain, 'src'), { recursive: true });
  await fs.writeFile(path.join(good, 'src', 'cli.mjs'), 'export async function main() {}\n');
  await fs.writeFile(path.join(bad, 'src', 'cli.mjs'), 'export const = broken syntax\n');
  await fs.writeFile(path.join(missingMain, 'src', 'cli.mjs'), 'export const value = 1;\n');
  await smokeConnectorRuntime(good);
  await assert.rejects(smokeConnectorRuntime(bad), /smoke test failed/);
  await assert.rejects(smokeConnectorRuntime(missingMain), /smoke test failed/);
});

test('authenticated update integration installs, survives fetch failure, and quarantines an explicit rollback', async (t) => {
  const { root, env } = await temporaryEnvironment(t);
  const remote = await configureRemote(env);
  const keys = releaseKeyPair();
  const publicKeyPath = await writePublicKey(root, keys.publicKey);
  const first = releaseFixture(keys, { sequence: 1, version: '1.0.0' });
  const second = releaseFixture(keys, { sequence: 2, version: '1.1.0' });
  let active = first;
  const requests = [];
  const fetchImpl = async (target, options) => {
    const url = new URL(target);
    requests.push({ url: url.href, authorization: options.headers.Authorization });
    if (url.pathname === '/v1/connector/manifest') {
      return byteResponse(Buffer.from(JSON.stringify(active.manifest), 'utf8'));
    }
    if (url.pathname === active.manifest.bundle.path) {
      return byteResponse(active.bundle.bytes);
    }
    return byteResponse(Buffer.from('not found'), 404);
  };
  const updateOptions = {
    env,
    launcherVersion: '0.1.1',
    publicKeyPath,
    fetchImpl,
    smoke: async () => {},
  };

  const installedFirst = await applyConnectorUpdate(updateOptions);
  assert.equal(installedFirst.installed, true);
  assert.equal(installedFirst.pointer.sequence, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests.every((request) => (
    request.authorization === `Bearer ${remote.deviceToken}`
  )), true);

  active = second;
  const installedSecond = await applyConnectorUpdate(updateOptions);
  assert.equal(installedSecond.pointer.sequence, 2);
  assert.equal((await readRuntimePointer('previous', env)).sequence, 1);
  const stateAfterInstall = await readUpdateState(env);
  assert.deepEqual(Object.keys(stateAfterInstall.origins), [remote.baseUrl]);
  assert.equal(stateAfterInstall.origins[remote.baseUrl].highestSequence, 2);

  const equivocated = releaseFixture(keys, { sequence: 2, version: '1.1.1' });
  active = equivocated;
  await assert.rejects(
    checkConnectorUpdate(updateOptions),
    /reused a trusted release sequence with different bytes/,
  );
  active = second;

  const beforeFailure = await readRuntimePointer('current', env);
  await assert.rejects(
    applyConnectorUpdate({
      ...updateOptions,
      fetchImpl: async () => byteResponse(Buffer.from('unavailable'), 503),
    }),
    /HTTP 503/,
  );
  assert.deepEqual(await readRuntimePointer('current', env), beforeFailure);

  const rolledBack = await rollbackConnectorUpdate(env);
  assert.equal(rolledBack.current.sequence, 1);
  assert.equal(rolledBack.rolledBack.sequence, 2);
  const stateAfterRollback = await readUpdateState(env);
  assert.deepEqual(stateAfterRollback.origins[remote.baseUrl].quarantine, [2]);

  const checked = await checkConnectorUpdate(updateOptions);
  assert.equal(checked.manifest.sequence, 2);
  assert.equal(checked.quarantined, true);
  assert.equal(checked.available, false);

  active = first;
  await assert.rejects(
    checkConnectorUpdate(updateOptions),
    /older than a previously trusted release/,
  );
});

test('update downloads bound chunked responses even without Content-Length', async (t) => {
  const { root, env } = await temporaryEnvironment(t);
  const remote = await configureRemote(env);
  const keys = releaseKeyPair();
  const publicKeyPath = await writePublicKey(root, keys.publicKey);
  let authorization;
  await assert.rejects(
    checkConnectorUpdate({
      env,
      launcherVersion: '0.1.1',
      publicKeyPath,
      fetchImpl: async (_target, options) => {
        authorization = options.headers.Authorization;
        return new Response(Buffer.alloc(40 * 1024, 1), { status: 200 });
      },
    }),
    /response size is invalid/,
  );
  assert.equal(authorization, `Bearer ${remote.deviceToken}`);
});

test('launcher uses a cached previous runtime offline, rolls back a broken import, and forwards the permanent bin path', async (t) => {
  const { env } = await temporaryEnvironment(t);
  await configureRemote(env, 'https://offline.example.test');
  const keys = releaseKeyPair();
  const source = [
    'export async function main(argv, options) {',
    '  options.stdout.write(`${JSON.stringify({ source: "cached", argv, binPath: options.binPath })}\\n`);',
    '  return "cached-result";',
    '}',
    '',
  ].join('\n');
  const good = releaseFixture(keys, { sequence: 1, version: '1.0.0', source });
  const broken = releaseFixture(keys, {
    sequence: 2,
    version: '1.1.0',
    source: 'throw new Error("broken runtime import");\nexport async function main() {}\n',
  });
  await installConnectorBundle(good.manifest, good.bundle.bytes, {
    env,
    smoke: async () => {},
  });
  await installConnectorBundle(broken.manifest, broken.bundle.bytes, {
    env,
    smoke: async () => {},
  });

  const stdout = outputStream();
  const stderr = outputStream();
  const permanentBinPath = path.join(path.parse(env.HND_HOME).root, 'permanent', 'hnd.mjs');
  const result = await launcherMain(['hook-probe'], {
    env,
    cwd: env.HND_USER_HOME,
    stdin: null,
    stdout,
    stderr,
    binPath: permanentBinPath,
  });
  assert.equal(result, 'cached-result');
  assert.deepEqual(JSON.parse(stdout.text()), {
    source: 'cached',
    argv: ['hook-probe'],
    binPath: permanentBinPath,
  });
  assert.equal(stderr.text(), '');
  assert.equal((await readRuntimePointer('current', env)).sequence, 1);
  assert.equal((await readRuntimePointer('previous', env)).sequence, 2);
  const updateState = await readUpdateState(env);
  assert.deepEqual(
    updateState.origins[new URL('https://offline.example.test').href].quarantine,
    [2],
  );
});

test('launcher rolls back a hash-invalid current runtime only once', async (t) => {
  const { env } = await temporaryEnvironment(t);
  await configureRemote(env, 'https://integrity.example.test');
  const keys = releaseKeyPair();
  const previous = releaseFixture(keys, {
    sequence: 1,
    version: '1.0.0',
    source: 'export async function main(_argv, options) { options.stdout.write("previous\\n"); }\n',
  });
  const current = releaseFixture(keys, {
    sequence: 2,
    version: '1.1.0',
    source: 'export async function main(_argv, options) { options.stdout.write("current\\n"); }\n',
  });
  await installConnectorBundle(previous.manifest, previous.bundle.bytes, {
    env,
    smoke: async () => {},
  });
  const installedCurrent = await installConnectorBundle(current.manifest, current.bundle.bytes, {
    env,
    smoke: async () => {},
  });
  await fs.appendFile(path.join(installedCurrent.directory, 'src', 'cli.mjs'), '// corrupt\n');
  assert.equal(await runtimeReady(installedCurrent.pointer, env), false);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stdout = outputStream();
    await launcherMain(['integrity-probe'], {
      env,
      cwd: env.HND_USER_HOME,
      stdin: null,
      stdout,
      stderr: outputStream(),
    });
    assert.equal(stdout.text(), 'previous\n');
    assert.equal((await readRuntimePointer('current', env)).sequence, 1);
    assert.equal((await readRuntimePointer('previous', env)).sequence, 2);
  }
  const updateState = await readUpdateState(env);
  assert.deepEqual(
    updateState.origins[new URL('https://integrity.example.test').href].quarantine,
    [2],
  );
});

test('launcher falls back to the packaged CLI when no cached runtime is usable', async (t) => {
  const { env } = await temporaryEnvironment(t);
  const stdout = outputStream();
  const stderr = outputStream();
  await launcherMain(['--version'], {
    env,
    cwd: env.HND_USER_HOME,
    stdin: null,
    stdout,
    stderr,
  });
  assert.match(stdout.text(), /^\d+\.\d+\.\d+\n$/);
  assert.equal(stderr.text(), '');
});
