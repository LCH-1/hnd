import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function captureStream() {
  let value = '';
  return {
    write(chunk) {
      value += String(chunk);
      return true;
    },
    value: () => value,
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test('CLI delivers the local-first policy and cross-agent handoff workflow', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-cli-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'checkout');
  const userHome = path.join(root, 'user');
  const stateHome = path.join(root, 'state');
  await fs.mkdir(repository, { recursive: true });
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.email', 'hnd-test@example.invalid');
  git(repository, 'config', 'user.name', 'hnd test');
  await fs.writeFile(path.join(repository, 'README.md'), '# fixture\n');
  git(repository, 'add', 'README.md');
  git(repository, 'commit', '-m', 'initial');

  const env = {
    ...process.env,
    HND_HOME: stateHome,
    HND_USER_HOME: userHome,
  };
  const run = async (args, input = '', envOverrides = {}) => {
    const stdout = captureStream();
    const stderr = captureStream();
    await main(args, {
      env: { ...env, ...envOverrides },
      cwd: repository,
      stdin: Readable.from([input]),
      stdout,
      stderr,
    });
    return { stdout: stdout.value(), stderr: stderr.value() };
  };

  await run(['init', '--env', 'laptop']);
  await run(['policy', 'set', 'global', '--text', 'GLOBAL-CHECK: explain risky changes']);
  await run(['policy', 'set', 'repo', '--text', 'REPO-CHECK: run repository tests']);
  await run(['policy', 'set', 'env', '--text', 'ENV-CHECK: never deploy from this laptop']);
  await run(['policy', 'set', 'local', '--text', 'LOCAL-GUARD: never reveal credentials']);
  const started = await run([
    'handoff', 'start', 'auth-refresh',
    '--goal', 'Safely replace refresh token rotation',
  ]);
  assert.match(started.stdout, /Started auth-refresh/);
  await run([
    'handoff', 'save', 'auth-refresh',
    '--current', 'Implementation is ready; rollback coverage remains',
    '--decision', 'Use a five-minute overlap to avoid racing clients',
    '--rejected', 'A trigger obscured service failure handling',
    '--changed-file', 'src/auth/rotate.mjs',
    '--check', 'unit tests passed',
    '--next', 'Add rollback integration coverage',
  ]);
  const secondary = JSON.parse((await run([
    'handoff', 'start', 'docs-pass', '--goal', 'Document the rollout', '--json',
  ])).stdout);
  assert.match((await run(['context'])).stdout, /Document the rollout/);
  await run(['handoff', 'select', 'auth-refresh']);
  assert.match((await run(['context'])).stdout, /refresh token rotation/);
  await run(['handoff', 'close', '--id', secondary.id]);
  const archived = JSON.parse((await run(['handoff', 'show', '--id', secondary.id, '--json'])).stdout);
  assert.equal(archived.status, 'closed');

  const composed = (await run(['context'])).stdout;
  for (const marker of ['GLOBAL-CHECK', 'REPO-CHECK', 'ENV-CHECK', 'auth-refresh', 'LOCAL-GUARD']) {
    assert.match(composed, new RegExp(marker));
  }
  assert.ok(composed.indexOf('GLOBAL-CHECK') < composed.indexOf('REPO-CHECK'));
  assert.ok(composed.indexOf('REPO-CHECK') < composed.indexOf('ENV-CHECK'));
  assert.ok(composed.indexOf('ENV-CHECK') < composed.indexOf('auth-refresh'));
  assert.ok(composed.indexOf('auth-refresh') < composed.indexOf('LOCAL-GUARD'));

  const claudeSettings = path.join(userHome, '.claude', 'settings.json');
  const codexHooks = path.join(userHome, '.codex', 'hooks.json');
  const cursorHooks = path.join(userHome, '.cursor', 'hooks.json');
  const userConfigs = {
    [claudeSettings]: { permissions: { deny: ['WebFetch'] } },
    [codexHooks]: {
      description: 'user hooks',
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'user-stop' }] }] },
    },
    [cursorHooks]: {
      version: 1,
      hooks: { afterFileEdit: [{ command: 'user-after-edit' }] },
    },
  };
  for (const [filePath, value] of Object.entries(userConfigs)) await writeJson(filePath, value);
  const beforeDryRun = await Promise.all(
    Object.keys(userConfigs).map((filePath) => fs.readFile(filePath, 'utf8')),
  );
  const preview = await run(['setup', '--agents', 'all', '--dry-run', '--json']);
  assert.ok(JSON.parse(preview.stdout).operations.every((item) => item.changed));
  const afterDryRun = await Promise.all(
    Object.keys(userConfigs).map((filePath) => fs.readFile(filePath, 'utf8')),
  );
  assert.deepEqual(afterDryRun, beforeDryRun);

  const installed = await run(['setup', '--agents', 'all']);
  assert.match(installed.stdout, /approve the changed HND hooks in \/hooks/u);
  const claude = JSON.parse(await fs.readFile(claudeSettings, 'utf8'));
  const codex = JSON.parse(await fs.readFile(codexHooks, 'utf8'));
  const cursor = JSON.parse(await fs.readFile(cursorHooks, 'utf8'));
  assert.deepEqual(claude.permissions, userConfigs[claudeSettings].permissions);
  assert.deepEqual(codex.hooks.Stop[0], userConfigs[codexHooks].hooks.Stop[0]);
  assert.equal(codex.hooks.Stop.length, 2);
  assert.equal(codex.hooks.SessionEnd.length, 1);
  assert.deepEqual(cursor.hooks.afterFileEdit, userConfigs[cursorHooks].hooks.afterFileEdit);
  assert.match(claude.hooks.SessionStart.at(-1).hooks[0].command, /--state-home/);
  assert.match(claude.hooks.SessionStart.at(-1).hooks[0].command, new RegExp(stateHome.replaceAll('\\', '\\\\')));

  let cursorSessionEnv = {};
  for (const agent of ['claude', 'codex', 'cursor']) {
    const result = await run(
      ['hook', agent],
      JSON.stringify({ cwd: repository, session_id: `live-${agent}` }),
    );
    const wire = JSON.parse(result.stdout);
    const injected = agent === 'cursor'
      ? wire.additional_context
      : wire.hookSpecificOutput.additionalContext;
    assert.match(injected, /GLOBAL-CHECK/);
    assert.match(injected, /auth-refresh/);
    assert.match(injected, /LOCAL-GUARD/);
    if (agent === 'cursor') cursorSessionEnv = wire.env;
  }

  // Simulate a rule arriving from another device without running a local CLI
  // mutation (which would refresh Cursor's materialized fallback immediately).
  await fs.writeFile(
    path.join(stateHome, 'policies', 'global.md'),
    'GLOBAL-CHECK-UPDATED: apply the new rule in this live session\n',
  );
  for (const agent of ['claude', 'codex', 'cursor']) {
    const payload = agent === 'cursor'
      ? { cwd: repository, prompt: 'continue in this session' }
      : { cwd: repository, session_id: `live-${agent}`, prompt: 'continue in this session' };
    const result = await run(
      ['hook', agent, 'prompt'],
      JSON.stringify(payload),
      agent === 'cursor' ? cursorSessionEnv : {},
    );
    const wire = JSON.parse(result.stdout);
    if (agent === 'cursor') {
      assert.deepEqual(wire, { continue: true });
      assert.match(
        await fs.readFile(path.join(repository, '.cursor', 'rules', '50-hnd.mdc'), 'utf8'),
        /GLOBAL-CHECK-UPDATED/u,
      );
      assert.match(
        await fs.readFile(path.join(repository, '.cursor', 'rules', '50-hnd.mdc'), 'utf8'),
        /auth-refresh/u,
      );
    } else {
      assert.equal(wire.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      assert.match(wire.hookSpecificOutput.additionalContext, /GLOBAL-CHECK-UPDATED/u);
      assert.match(wire.hookSpecificOutput.additionalContext, /REPO-CHECK|ENV-CHECK|LOCAL-GUARD/u);
      assert.match(wire.hookSpecificOutput.additionalContext, /auth-refresh/u);
    }
    const repeated = await run(
      ['hook', agent, 'prompt'],
      JSON.stringify(payload),
      agent === 'cursor' ? cursorSessionEnv : {},
    );
    assert.deepEqual(
      JSON.parse(repeated.stdout),
      agent === 'cursor' ? { continue: true } : {},
    );
  }

  await run([
    'handoff', 'save', 'auth-refresh',
    '--current', 'Live handoff update reached every running agent',
    '--next', 'Continue without reopening the session',
  ]);
  for (const agent of ['claude', 'codex', 'cursor']) {
    const payload = agent === 'cursor'
      ? { cwd: repository, prompt: 'read the updated handoff' }
      : { cwd: repository, session_id: `live-${agent}`, prompt: 'read the updated handoff' };
    const result = await run(
      ['hook', agent, 'prompt'],
      JSON.stringify(payload),
      agent === 'cursor' ? cursorSessionEnv : {},
    );
    const wire = JSON.parse(result.stdout);
    if (agent === 'cursor') {
      assert.deepEqual(wire, { continue: true });
      assert.match(
        await fs.readFile(path.join(repository, '.cursor', 'rules', '50-hnd.mdc'), 'utf8'),
        /Live handoff update reached every running agent/u,
      );
    } else {
      assert.match(
        wire.hookSpecificOutput.additionalContext,
        /Live handoff update reached every running agent/u,
      );
      assert.match(wire.hookSpecificOutput.additionalContext, /GLOBAL-CHECK-UPDATED/u);
    }
  }

  await fs.writeFile(path.join(repository, 'live-progress.txt'), 'checkpoint refresh\n');
  await run(
    ['hook', 'cursor', 'stop'],
    JSON.stringify({ cwd: repository, session_id: 'live-cursor' }),
    cursorSessionEnv,
  );
  for (const agent of ['claude', 'codex', 'cursor']) {
    const payload = agent === 'cursor'
      ? { cwd: repository, prompt: 'read the updated checkpoint' }
      : { cwd: repository, session_id: `live-${agent}`, prompt: 'read the updated checkpoint' };
    const result = await run(
      ['hook', agent, 'prompt'],
      JSON.stringify(payload),
      agent === 'cursor' ? cursorSessionEnv : {},
    );
    const wire = JSON.parse(result.stdout);
    if (agent === 'cursor') {
      assert.deepEqual(wire, { continue: true });
      assert.match(
        await fs.readFile(path.join(repository, '.cursor', 'rules', '50-hnd.mdc'), 'utf8'),
        /live-progress\.txt/u,
      );
    } else {
      assert.match(wire.hookSpecificOutput.additionalContext, /live-progress\.txt/u);
      assert.match(wire.hookSpecificOutput.additionalContext, /Automatic progress checkpoint/u);
    }
  }

  const exactPreview = JSON.parse((await run(['preview', '--agent', 'all', '--json'])).stdout);
  assert.equal(exactPreview.targets.length, 3);
  for (const target of exactPreview.targets) {
    assert.equal(target.bytes, Buffer.byteLength(target.content));
  }
  assert.match(exactPreview.targets.find((item) => item.agent === 'cursor').content, /^---\n/);
  assert.equal(
    JSON.parse(exactPreview.targets.find((item) => item.agent === 'claude').content)
      .hookSpecificOutput.hookEventName,
    'SessionStart',
  );

  const selectionsPath = path.join(stateHome, 'handoff-selections.json');
  const validSelections = await fs.readFile(selectionsPath, 'utf8');
  await fs.writeFile(selectionsPath, '{broken');
  const failedOpen = await run(['hook', 'claude'], JSON.stringify({ cwd: repository }));
  assert.equal(JSON.parse(failedOpen.stdout).hookSpecificOutput.additionalContext, '');
  assert.match(failedOpen.stderr, /context unavailable.+hnd doctor/i);
  await fs.writeFile(selectionsPath, validSelections);

  const diagnosis = JSON.parse((await run(['doctor', '--json'])).stdout);
  assert.equal(diagnosis.ok, true);
  assert.ok(diagnosis.adapters.every((adapter) => adapter.ok));

  await run(['uninstall', '--agents', 'all']);
  const uninstalledClaude = JSON.parse(await fs.readFile(claudeSettings, 'utf8'));
  const uninstalledCodex = JSON.parse(await fs.readFile(codexHooks, 'utf8'));
  const uninstalledCursor = JSON.parse(await fs.readFile(cursorHooks, 'utf8'));
  assert.deepEqual(uninstalledClaude.permissions, userConfigs[claudeSettings].permissions);
  assert.deepEqual(uninstalledCodex.hooks.Stop, userConfigs[codexHooks].hooks.Stop);
  assert.deepEqual(uninstalledCursor.hooks.afterFileEdit, userConfigs[cursorHooks].hooks.afterFileEdit);
});

test('the outer lifecycle boundary fails open instead of exiting nonzero', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  await main(['--state-home', 'relative', 'hook', 'codex', 'stop'], {
    stdout,
    stderr,
  });
  assert.equal(stdout.value(), '');
  assert.match(stderr.value(), /hnd hook: codex\/stop failed open/u);
  assert.match(stderr.value(), /--state-home must be an absolute path/u);
});
