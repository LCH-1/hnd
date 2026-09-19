import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createCore } from '../src/core/index.mjs';
import { materializeCursor, dematerializeCursor } from '../src/materialize.mjs';
import { statePaths } from '../src/paths.mjs';

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-workspace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  await fs.mkdir(path.join(cwd, 'src', 'nested'), { recursive: true });
  const env = { ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: path.join(root, 'user') };
  return { root, cwd, env, core: createCore({ cwd, env }) };
}

test('plain folders retain identity and environment in subdirectories and after git init', async (t) => {
  const { root, cwd, env, core } = await fixture(t);
  await assert.rejects(core.repo.resolve({ create: false }), { code: 'REPOSITORY_NOT_REGISTERED' });
  const first = await core.repo.init({ environment: 'dev' });
  assert.equal(first.git.available, false);
  assert.equal(first.git.unavailableReason, 'NOT_GIT_REPOSITORY');
  assert.equal(first.git.branch, null);
  assert.deepEqual(first.repository.remoteAliases, []);
  const nested = createCore({ cwd: path.join(cwd, 'src', 'nested'), env });
  assert.equal((await nested.repo.init({ environment: 'prod' })).repository.id, first.repository.id);
  assert.equal(await nested.env.get(), 'dev');
  await nested.env.set('test');
  assert.equal(await core.env.get(), 'test');
  await core.policy.set({ scope: 'repo', content: 'FOLDER RULE' });
  assert.match((await nested.compose({ fastRepository: true })).content, /FOLDER RULE/);
  const sibling = path.join(root, 'project-sibling');
  await fs.mkdir(sibling);
  assert.notEqual((await createCore({ cwd: sibling, env }).repo.init()).repository.id, first.repository.id);
  const alias = path.join(root, 'alias');
  await fs.symlink(cwd, alias, 'dir');
  assert.equal((await createCore({ cwd: alias, env }).repo.resolve()).repository.id, first.repository.id);
  assert.equal((await core.auto.capture()).reason, 'NOT_GIT_REPOSITORY');
  assert.equal(await core.auto.show(), null);

  await execFileAsync('git', ['-C', cwd, 'init', '-b', 'main']);
  const upgraded = await nested.repo.resolve();
  assert.equal(upgraded.repository.id, first.repository.id);
  assert.equal(upgraded.git.available, true);
  assert.equal(upgraded.git.branch, 'main');
  assert.equal(await nested.env.get(), 'test');
  assert.match((await nested.compose()).content, /FOLDER RULE/);
  assert.equal((await core.auto.capture()).changed, true);
});

test('nested Git boundaries do not inherit a plain parent workspace', async (t) => {
  const { cwd, env, core } = await fixture(t);
  const parent = await core.repo.init();
  await core.policy.set({ scope: 'repo', content: 'PARENT PRIVATE RULE' });
  const childPath = path.join(cwd, 'src');
  await execFileAsync('git', ['-C', childPath, 'init', '-b', 'main']);
  const child = createCore({ cwd: path.join(childPath, 'nested'), env });
  assert.notEqual((await child.repo.init()).repository.id, parent.repository.id);
  assert.doesNotMatch((await child.compose()).content, /PARENT PRIVATE RULE/);
});

test('plain folders can be linked explicitly and unlinked from subdirectories', async (t) => {
  const { root, cwd, env, core } = await fixture(t);
  const first = await core.repo.init();
  const secondPath = path.join(root, 'copy');
  await fs.mkdir(path.join(secondPath, 'src'), { recursive: true });
  const second = createCore({ cwd: secondPath, env });
  await assert.rejects(second.repo.link({ repoId: first.repository.id }), { code: 'REPOSITORY_LINK_UNRELATED' });
  await second.repo.link({ repoId: first.repository.id, force: true });
  assert.equal((await second.repo.resolve()).repository.id, first.repository.id);
  const unlinked = await createCore({ cwd: path.join(secondPath, 'src'), env }).repo.unlink();
  assert.equal(unlinked.root, secondPath);
  assert.equal(unlinked.removed, true);
  assert.equal((await core.repo.resolve()).repository.id, first.repository.id);
  const missing = createCore({ cwd: path.join(cwd, 'missing'), env });
  await assert.rejects(missing.repo.init(), { code: 'PATH_UNAVAILABLE' });
  const file = path.join(cwd, 'file.txt');
  await fs.writeFile(file, 'file');
  await assert.rejects(createCore({ cwd: file, env }).repo.init(), { code: 'PATH_UNAVAILABLE' });
});

test('Cursor folder rules are ignored by future Git and uninstall restores user bytes', async (t) => {
  const { cwd, env, core } = await fixture(t);
  await core.repo.init();
  const ignore = path.join(cwd, '.gitignore');
  const original = 'node_modules/\r\n# user text without final newline';
  await fs.writeFile(ignore, original);
  const nested = path.join(cwd, 'src', 'nested');
  const result = await materializeCursor({ cwd: nested, env, content: 'PRIVATE RULE' });
  assert.equal(result.paths.root, cwd);
  assert.equal(result.paths.exclude, ignore);
  assert.equal((await materializeCursor({ cwd: nested, env, content: 'PRIVATE RULE' })).operations.length, 0);
  await execFileAsync('git', ['-C', cwd, 'init', '-b', 'main']);
  const ignored = await execFileAsync('git', ['-C', cwd, 'check-ignore', '.cursor/rules/50-hnd.mdc']);
  assert.equal(ignored.stdout.trim(), '.cursor/rules/50-hnd.mdc');
  await materializeCursor({ cwd: nested, env, content: 'UPDATED RULE' });
  await dematerializeCursor({ cwd: nested, env });
  assert.equal(await fs.readFile(ignore, 'utf8'), original);
  await assert.rejects(fs.access(result.paths.rule), { code: 'ENOENT' });
});

test('CLI, hooks, work, knowledge, and snapshots run with no Git executable', async (t) => {
  const { root, cwd, env, core } = await fixture(t);
  const gitPath = path.join(root, 'git-project');
  await fs.mkdir(path.join(gitPath, 'nested'), { recursive: true });
  await execFileAsync('git', ['-C', gitPath, 'init', '-b', 'main']);
  const gitCore = createCore({ cwd: gitPath, env });
  const existing = await gitCore.repo.init();
  await gitCore.auto.capture();
  const noGitPath = path.join(root, 'empty-bin');
  await fs.mkdir(noGitPath);
  const imports = {
    cli: new URL('../src/cli.mjs', import.meta.url).href,
    core: new URL('../src/core/index.mjs', import.meta.url).href,
    snapshot: new URL('../src/sync/capture.mjs', import.meta.url).href,
    materialize: new URL('../src/materialize.mjs', import.meta.url).href,
  };
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    import { Readable } from 'node:stream';
    import { main } from ${JSON.stringify(imports.cli)};
    import { createCore } from ${JSON.stringify(imports.core)};
    import { captureSnapshot } from ${JSON.stringify(imports.snapshot)};
    import { materializeCursor } from ${JSON.stringify(imports.materialize)};
    await assert.rejects(promisify(execFile)('git', ['--version']), { code: 'ENOENT' });
    const cwd = process.cwd();
    async function run(args, payload, directory = cwd) {
      let stdout = '';
      let stderr = '';
      await main(args, {
        cwd: directory,
        stdin: Readable.from(payload ? [JSON.stringify(payload)] : []),
        stdout: { write: (chunk) => { stdout += chunk; return true; } },
        stderr: { write: (chunk) => { stderr += chunk; return true; } },
      });
      assert.equal(stderr, '', args.join(' ') + ': ' + stderr);
      return stdout;
    }
    const initialized = JSON.parse(await run(['init', '--json']));
    assert.equal(initialized.git.available, false);
    assert.equal(initialized.git.unavailableReason, 'GIT_UNAVAILABLE');
    await run(['setup']);
    await run(['rule', 'set', 'repo', '--text', 'NO GIT RULE']);
    await run(['env', 'set', 'dev']);
    const work = JSON.parse(await run(['work', 'new', 'folder-task', '--goal', 'Remember folder work', '--json']));
    await run(['work', 'claim']);
    await run(['work', 'save', '--current', 'Saved without Git', '--next', 'Continue folder work']);
    assert.equal(JSON.parse(await run(['work', 'show', '--json'])).id, work.id);
    const nested = path.join(cwd, 'src', 'nested');
    assert.equal(JSON.parse(await run(['work', 'show', '--json'], null, nested)).id, work.id);
    const core = createCore({ cwd });
    const knowledge = await core.knowledge.add({ scope: 'repo', title: 'Folder knowledge', body: 'Folder decisions' });
    assert.ok((await core.knowledge.list({ scope: 'repo' })).some((entry) => entry.id === knowledge.id));
    assert.match(await run(['context'], null, nested), /NO GIT RULE/);
    const status = JSON.parse(await run(['status', '--json'], null, nested));
    assert.equal(status.repository.repository.id, initialized.repository.id);
    assert.equal(status.environment, 'dev');
    assert.equal(status.checkpoint, null);
    assert.equal((await core.auto.capture()).reason, 'GIT_UNAVAILABLE');
    for (const agent of ['codex', 'claude', 'cursor']) {
      const payload = { cwd: nested, session_id: agent + '-no-git' };
      assert.match(await run(['hook', agent, 'start'], payload), /NO GIT RULE/);
      await run(['hook', agent, 'prompt'], payload);
      await run(['hook', agent, 'stop'], payload);
      await run(['hook', agent, 'end'], payload);
    }
    assert.match(await fs.readFile(path.join(cwd, '.cursor/rules/50-hnd.mdc'), 'utf8'), /NO GIT RULE/);
    const snapshot = await captureSnapshot(process.env.HND_HOME);
    assert.ok(snapshot.files.some((file) => file.path.includes('/handoffs/')));
    assert.ok(snapshot.files.some((file) => file.path.includes('/knowledge/') || file.path.startsWith('knowledge/')));
    assert.ok(snapshot.files.every((file) => file.path !== 'bindings.json'));

    // Losing Git must retain an existing project's binding and hide stale checkpoints.
    const gitPath = ${JSON.stringify(gitPath)};
    const existing = createCore({ cwd: path.join(gitPath, 'nested') });
    const resolved = await existing.repo.init();
    assert.equal(resolved.repository.id, ${JSON.stringify(existing.repository.id)});
    assert.equal(resolved.git.root, gitPath);
    assert.equal(await existing.auto.show(), null);
    assert.equal((await existing.auto.capture()).reason, 'GIT_UNAVAILABLE');
    await run(['rule', 'set', 'repo', '--text', 'EXISTING REPO RULE'], null, gitPath);
    await run(['init'], null, gitPath);
    await run(['setup'], null, gitPath);
    await assert.rejects(materializeCursor({ cwd: gitPath, content: 'PRIVATE' }), { code: 'GIT_UNAVAILABLE' });
    await assert.rejects(fs.access(path.join(gitPath, '.cursor/rules/50-hnd.mdc')), { code: 'ENOENT' });

    // A .git file is also a boundary when Git is unavailable.
    const nestedRepo = path.join(cwd, 'vendor');
    await fs.mkdir(path.join(nestedRepo, 'src'), { recursive: true });
    await fs.writeFile(path.join(nestedRepo, '.git'), 'gitdir: elsewhere');
    const isolated = createCore({ cwd: path.join(nestedRepo, 'src') });
    const child = await isolated.repo.init();
    assert.notEqual(child.repository.id, initialized.repository.id);
    assert.equal(child.git.root, nestedRepo);
    assert.doesNotMatch((await isolated.compose()).content, /NO GIT RULE/);

    const fresh = path.join(path.dirname(cwd), 'hook-only');
    await fs.mkdir(fresh);
    await run(['hook', 'codex', 'start'], { cwd: fresh, session_id: 'new-folder' }, fresh);
    assert.equal(JSON.parse(await run(['status', '--json'], null, fresh)).environment, 'default');
    await run(['uninstall']);
    await assert.rejects(fs.access(path.join(cwd, '.gitignore')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(cwd, '.cursor/rules/50-hnd.mdc')), { code: 'ENOENT' });
    console.log('git-free workflow passed');
  `;
  const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', source], {
    cwd,
    env: { ...env, PATH: noGitPath },
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  assert.match(result.stdout, /git-free workflow passed/);
  assert.equal((await core.repo.list()).length, 4);
  assert.ok((await fs.readFile(statePaths(env).bindings, 'utf8')).includes(cwd));
});
