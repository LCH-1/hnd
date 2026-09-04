import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyOperations } from '../src/fs-operations.mjs';
import { agentPaths } from '../src/paths.mjs';
import {
  AdapterConfigError,
  AdapterConflictError,
  HND_HOOK_STATUS,
  buildAdapterOperations,
  createHookCommands,
  doctorAdapters,
  formatClaudeHookOutput,
  formatCodexHookOutput,
  formatCursorHookOutput,
  inspectAdapters,
  planInstall,
  planUninstall,
  previewAdapters,
  renderHookOutput,
} from '../src/adapters/index.mjs';
import {
  createCodexCheckpointHook,
  createCodexHook,
  createCodexPromptHook,
} from '../src/adapters/codex.mjs';

const SKILL = `---
name: hnd-handoff
description: Test handoff skill.
---

<!-- hnd-managed-skill: hnd-handoff -->

# Test
`;

async function makeHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-adapters-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return {
    home,
    env: { HND_USER_HOME: home, HND_HOME: path.join(home, '.hnd') },
    paths: agentPaths({ HND_USER_HOME: home }),
  };
}

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function options(env, overrides = {}) {
  return {
    env,
    binPath: '/opt/hnd package/bin/hnd.mjs',
    execPath: '/opt/node runtime/bin/node',
    skillContent: SKILL,
    ...overrides,
  };
}

function nestedHandlers(config, eventName) {
  return config.hooks[eventName].flatMap((group) => group.hooks);
}

test('hook commands quote executable and bin paths and provide a Windows command', () => {
  const posix = createHookCommands('claude', {
    execPath: "/opt/node's runtime/node",
    binPath: '/opt/hnd tools/bin/hnd.mjs',
    platform: 'linux',
  });
  assert.equal(
    posix.host,
    `'/opt/node'"'"'s runtime/node' '/opt/hnd tools/bin/hnd.mjs' 'hook' 'claude'`,
  );

  const windows = createHookCommands('codex', {
    execPath: String.raw`C:\Program Files\nodejs\node.exe`,
    binPath: String.raw`C:\Users\Ada Lovelace\hnd\bin\hnd.mjs`,
    platform: 'win32',
  });
  assert.equal(
    windows.windows,
    String.raw`node "C:\Users\Ada Lovelace\hnd\bin\hnd.mjs" "hook" "codex"`,
  );
  assert.equal(windows.host, windows.windows);
});

test('Codex uses host-safe Windows fallback commands and practical lifecycle timeouts', () => {
  const commands = createHookCommands('codex', {
    execPath: String.raw`C:\Program Files\nodejs\node.exe`,
    binPath: String.raw`C:\Users\Ada Lovelace\AppData\Roaming\npm\node_modules\@lch-1\hnd\bin\hnd.mjs`,
    platform: 'win32',
  });
  const start = createCodexHook(commands);
  const prompt = createCodexPromptHook(commands);
  const stop = createCodexCheckpointHook(commands, 'stop');
  const end = createCodexCheckpointHook(commands, 'end');

  for (const handler of [start, prompt, stop, end]) {
    assert.equal(handler.command, handler.commandWindows);
    assert.match(handler.command, /^node "/u);
  }
  assert.equal(start.timeout, 10);
  assert.equal(prompt.timeout, 5);
  assert.equal(stop.timeout, 10);
  assert.equal(end.timeout, 3);
});

test('install plans merge all three hook schemas while preserving user configuration', async (t) => {
  const fixture = await makeHome(t);
  const userClaudeHandler = {
    type: 'command',
    command: 'user-claude-hook',
    timeout: 17,
    custom: { keep: true },
  };
  const userCodexGroup = {
    matcher: 'resume',
    customGroupField: 'keep',
    hooks: [{ type: 'command', command: 'user-codex-hook', timeout: 9 }],
  };
  const userCursorHandler = {
    command: 'user-cursor-hook',
    custom: ['keep', 1],
  };
  const claudeBefore = {
    permissions: { deny: ['Read(.env)'] },
    unknownTopLevel: { nested: true },
    hooks: {
      Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'notify-user' }] }],
      SessionStart: [{ matcher: 'compact', hooks: [userClaudeHandler] }],
    },
  };
  const codexBefore = {
    description: 'user hooks',
    unknownTopLevel: [1, 2, 3],
    hooks: {
      SessionStart: [userCodexGroup],
      Stop: [{ hooks: [{ type: 'command', command: 'user-stop' }] }],
    },
  };
  const cursorBefore = {
    version: 1,
    unknownTopLevel: 'keep',
    hooks: {
      sessionStart: [userCursorHandler],
      afterFileEdit: [{ command: 'format-user-files' }],
    },
  };

  const claudeText = `${JSON.stringify(claudeBefore, null, 4).replaceAll('\n', '\r\n')}\r\n`;
  await Promise.all([
    write(fixture.paths.claude.settings, claudeText),
    write(fixture.paths.codex.hooks, `${JSON.stringify(codexBefore, null, 2)}\n`),
    write(fixture.paths.cursor.hooks, `${JSON.stringify(cursorBefore, null, 2)}\n`),
  ]);

  const operations = await planInstall(options(fixture.env));
  assert.equal(operations.length, 6);
  assert.equal(operations.filter((operation) => operation.component === 'hook').length, 3);
  assert.equal(operations.filter((operation) => operation.component === 'skill').length, 3);
  await applyOperations(operations);

  const [claude, codex, cursor] = await Promise.all([
    readJson(fixture.paths.claude.settings),
    readJson(fixture.paths.codex.hooks),
    readJson(fixture.paths.cursor.hooks),
  ]);
  assert.deepEqual(claude.permissions, claudeBefore.permissions);
  assert.deepEqual(claude.unknownTopLevel, claudeBefore.unknownTopLevel);
  assert.deepEqual(claude.hooks.Notification, claudeBefore.hooks.Notification);
  assert.deepEqual(claude.hooks.SessionStart[0], claudeBefore.hooks.SessionStart[0]);
  assert.equal(
    nestedHandlers(claude, 'SessionStart').filter(
      (handler) => handler.statusMessage === HND_HOOK_STATUS,
    ).length,
    1,
  );
  assert.match(
    nestedHandlers(claude, 'UserPromptSubmit')[0].command,
    /'hook' 'claude' 'prompt'$/,
  );

  assert.equal(codex.description, codexBefore.description);
  assert.deepEqual(codex.unknownTopLevel, codexBefore.unknownTopLevel);
  assert.deepEqual(codex.hooks.Stop[0], codexBefore.hooks.Stop[0]);
  assert.equal(codex.hooks.Stop.length, 2);
  assert.match(codex.hooks.Stop[1].hooks[0].command, /'hook' 'codex' 'stop'$/);
  assert.equal(codex.hooks.SessionEnd.length, 1);
  assert.match(codex.hooks.SessionEnd[0].hooks[0].command, /'hook' 'codex' 'end'$/);
  assert.deepEqual(codex.hooks.SessionStart[0], userCodexGroup);
  const codexManaged = nestedHandlers(codex, 'SessionStart').filter(
    (handler) => handler.statusMessage === HND_HOOK_STATUS,
  );
  assert.equal(codexManaged.length, 1);
  assert.equal(codex.hooks.SessionStart.at(-1).hooks[0], codexManaged[0]);
  assert.match(codexManaged[0].command, /'hook' 'codex'$/);
  assert.match(codexManaged[0].commandWindows, /"hook" "codex"$/);
  assert.equal(codexManaged[0].additionalContextLimit, 0);
  assert.equal(codex.hooks.SessionStart.at(-1).matcher, 'startup|resume|clear|compact');
  assert.match(
    nestedHandlers(codex, 'UserPromptSubmit')[0].command,
    /'hook' 'codex' 'prompt'$/,
  );
  assert.equal(nestedHandlers(codex, 'UserPromptSubmit')[0].additionalContextLimit, 0);

  assert.equal(cursor.version, 1);
  assert.equal(cursor.unknownTopLevel, cursorBefore.unknownTopLevel);
  assert.deepEqual(cursor.hooks.afterFileEdit, cursorBefore.hooks.afterFileEdit);
  assert.deepEqual(cursor.hooks.sessionStart[0], userCursorHandler);
  assert.equal(cursor.hooks.sessionStart.length, 2);
  assert.match(cursor.hooks.beforeSubmitPrompt[0].command, /'hook' 'cursor' 'prompt'$/);
  assert.match(cursor.hooks.stop[0].command, /'hook' 'cursor' 'stop'$/);
  assert.match(cursor.hooks.sessionEnd[0].command, /'hook' 'cursor' 'end'$/);

  assert.match(claude.hooks.Stop[0].hooks[0].command, /'hook' 'claude' 'stop'$/);
  assert.match(claude.hooks.PreCompact[0].hooks[0].command, /'hook' 'claude' 'precompact'$/);
  assert.match(claude.hooks.SessionEnd[0].hooks[0].command, /'hook' 'claude' 'end'$/);

  const formattedClaude = await fs.readFile(fixture.paths.claude.settings, 'utf8');
  assert.ok(formattedClaude.endsWith('\r\n'));
  assert.equal(formattedClaude.replaceAll('\r\n', '').includes('\n'), false);
  assert.match(formattedClaude, /\r\n {4}"permissions"/);

  for (const agent of ['claude', 'codex', 'cursor']) {
    assert.equal(await fs.readFile(fixture.paths[agent].skill, 'utf8'), SKILL);
  }
});

test('setup is idempotent and consolidates duplicate managed entries without touching user entries', async (t) => {
  const fixture = await makeHome(t);
  const setupOptions = options(fixture.env, { agents: ['codex'] });
  await applyOperations(await planInstall(setupOptions));
  assert.deepEqual(await planInstall(setupOptions), []);

  const config = await readJson(fixture.paths.codex.hooks);
  const managedGroup = structuredClone(config.hooks.SessionStart[0]);
  const userGroup = {
    matcher: 'startup',
    hooks: [{ type: 'command', command: 'do-not-touch', metadata: { bytes: 'same' } }],
  };
  config.hooks.SessionStart.unshift(userGroup, structuredClone(managedGroup));
  await write(fixture.paths.codex.hooks, `${JSON.stringify(config, null, 2)}\n`);

  const operations = await planInstall(setupOptions);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].component, 'hook');
  await applyOperations(operations);
  const consolidated = await readJson(fixture.paths.codex.hooks);
  assert.deepEqual(consolidated.hooks.SessionStart[0], userGroup);
  assert.equal(
    nestedHandlers(consolidated, 'SessionStart').filter(
      (handler) => handler.statusMessage === HND_HOOK_STATUS,
    ).length,
    1,
  );
  assert.deepEqual(await planInstall(setupOptions), []);
});

test('setup migrates standalone launcher hooks and uninstall removes the npm hooks', async (t) => {
  const fixture = await makeHome(t);
  const oldOptions = options(fixture.env, {
    binPath: '/home/ada/.local/share/hnd/launcher.mjs',
  });
  await applyOperations(await planInstall(oldOptions));

  const movedOptions = options(fixture.env, {
    execPath: '/new/node installation/bin/node',
    binPath: '/new/hnd installation/bin/hnd.mjs',
  });
  const migration = await planInstall(movedOptions);
  assert.equal(migration.filter((operation) => operation.component === 'hook').length, 3);
  assert.equal(migration.filter((operation) => operation.component === 'skill').length, 0);
  await applyOperations(migration);

  for (const agent of ['claude', 'codex', 'cursor']) {
    const config = await readJson(
      agent === 'claude' ? fixture.paths.claude.settings : fixture.paths[agent].hooks,
    );
    const handlers = agent === 'cursor'
      ? config.hooks.sessionStart
      : nestedHandlers(config, 'SessionStart');
    assert.equal(handlers.length, 1);
    assert.match(handlers[0].command, /new\/hnd installation/);
    assert.doesNotMatch(handlers[0].command, /launcher\.mjs/);
  }

  await applyOperations(await planUninstall(movedOptions));
  assert.deepEqual(await readJson(fixture.paths.claude.settings), {});
  assert.deepEqual(await readJson(fixture.paths.codex.hooks), {});
  assert.deepEqual(await readJson(fixture.paths.cursor.hooks), { version: 1 });
});

test('uninstall preserves pre-existing minimal agent configuration files', async (t) => {
  const fixture = await makeHome(t);
  const setupOptions = options(fixture.env);
  const originals = {
    claude: '{}\n',
    codex: '{}',
    cursor: '{"version":1}',
  };
  await Promise.all([
    write(fixture.paths.claude.settings, originals.claude),
    write(fixture.paths.codex.hooks, originals.codex),
    write(fixture.paths.cursor.hooks, originals.cursor),
  ]);

  await applyOperations(await planInstall(setupOptions));
  await applyOperations(await planUninstall(setupOptions));

  assert.equal(await fs.readFile(fixture.paths.claude.settings, 'utf8'), originals.claude);
  assert.equal(await fs.readFile(fixture.paths.codex.hooks, 'utf8'), originals.codex);
  assert.equal(await fs.readFile(fixture.paths.cursor.hooks, 'utf8'), originals.cursor);
});

test('uninstall removes only exact hnd hooks and managed skills', async (t) => {
  const fixture = await makeHome(t);
  const setupOptions = options(fixture.env);
  const userHooks = {
    claude: { type: 'command', command: 'keep-claude' },
    codex: { type: 'command', command: 'keep-codex' },
    cursor: { command: 'keep-cursor' },
  };
  await write(fixture.paths.claude.settings, `${JSON.stringify({
    theme: 'dark',
    hooks: { SessionStart: [{ matcher: '', hooks: [userHooks.claude] }] },
  }, null, 2)}\n`);
  await write(fixture.paths.codex.hooks, `${JSON.stringify({
    description: 'mine',
    hooks: { SessionStart: [{ hooks: [userHooks.codex] }] },
  }, null, 2)}\n`);
  await write(fixture.paths.cursor.hooks, `${JSON.stringify({
    version: 1,
    color: 'blue',
    hooks: { sessionStart: [userHooks.cursor] },
  }, null, 2)}\n`);
  await applyOperations(await planInstall(setupOptions));

  const uninstall = await planUninstall(setupOptions);
  assert.equal(uninstall.length, 6);
  await applyOperations(uninstall);
  const [claude, codex, cursor] = await Promise.all([
    readJson(fixture.paths.claude.settings),
    readJson(fixture.paths.codex.hooks),
    readJson(fixture.paths.cursor.hooks),
  ]);
  assert.equal(claude.theme, 'dark');
  assert.deepEqual(nestedHandlers(claude, 'SessionStart'), [userHooks.claude]);
  assert.equal(codex.description, 'mine');
  assert.deepEqual(nestedHandlers(codex, 'SessionStart'), [userHooks.codex]);
  assert.equal(cursor.color, 'blue');
  assert.deepEqual(cursor.hooks.sessionStart, [userHooks.cursor]);
  for (const agent of ['claude', 'codex', 'cursor']) {
    await assert.rejects(fs.stat(fixture.paths[agent].skill), { code: 'ENOENT' });
  }
  assert.deepEqual(await planUninstall(setupOptions), []);
});

test('preview returns exact before/after bytes without writing', async (t) => {
  const fixture = await makeHome(t);
  const previews = await previewAdapters(options(fixture.env, { agents: 'claude' }));
  assert.equal(previews.length, 2);
  const hook = previews.find((preview) => preview.component === 'hook');
  assert.equal(hook.before, null);
  assert.match(hook.after, /"SessionStart"/);
  assert.match(hook.after, /hnd\.mjs/);
  await assert.rejects(fs.stat(fixture.paths.claude.settings), { code: 'ENOENT' });
  await assert.rejects(fs.stat(fixture.paths.claude.skill), { code: 'ENOENT' });
});

test('CLI facade exposes operation, inspection, and hook-rendering contracts', async (t) => {
  const fixture = await makeHome(t);
  const setupOptions = options(fixture.env, { agents: ['cursor'] });
  const operations = await buildAdapterOperations({ ...setupOptions, action: 'install' });
  assert.equal(operations.length, 2);
  let inspection = await inspectAdapters(setupOptions);
  assert.equal(inspection.length, 1);
  assert.equal(inspection[0].agent, 'cursor');
  assert.equal(inspection[0].ok, false);
  await applyOperations(operations);
  inspection = await inspectAdapters(setupOptions);
  assert.equal(inspection[0].ok, true);
  assert.deepEqual(JSON.parse(renderHookOutput('cursor', 'context')), {
    additional_context: 'context',
  });
  assert.equal(
    (await buildAdapterOperations({ ...setupOptions, action: 'uninstall' })).length,
    2,
  );
});

test('doctor reports installed, missing, outdated, conflicts, and invalid JSON', async (t) => {
  const fixture = await makeHome(t);
  const setupOptions = options(fixture.env, { agents: ['claude'] });
  let report = await doctorAdapters(setupOptions);
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.map((check) => check.status), ['missing', 'missing']);

  await applyOperations(await planInstall(setupOptions));
  report = await doctorAdapters(setupOptions);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((check) => check.status), ['ok', 'ok']);

  await write(fixture.paths.claude.skill, `${SKILL}\nlocally changed\n`);
  report = await doctorAdapters(setupOptions);
  assert.equal(report.checks.find((check) => check.component === 'skill').status, 'outdated');

  await write(fixture.paths.claude.settings, '{ invalid json');
  report = await doctorAdapters(setupOptions);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.component === 'hook').status, 'invalid');
  await assert.rejects(planInstall(setupOptions), AdapterConfigError);
  assert.equal(await fs.readFile(fixture.paths.claude.settings, 'utf8'), '{ invalid json');
});

test('an unmanaged skill collision is never overwritten or removed', async (t) => {
  const fixture = await makeHome(t);
  const setupOptions = options(fixture.env, { agents: 'cursor' });
  await write(fixture.paths.cursor.skill, '---\nname: hnd-handoff\n---\nuser content\n');
  await assert.rejects(planInstall(setupOptions), AdapterConflictError);
  assert.equal(
    await fs.readFile(fixture.paths.cursor.skill, 'utf8'),
    '---\nname: hnd-handoff\n---\nuser content\n',
  );
  assert.deepEqual(await planUninstall(setupOptions), []);
});

test('adapter setup refuses symlinked configuration and skill targets', {
  skip: process.platform === 'win32',
}, async (t) => {
  const fixture = await makeHome(t);
  const configTarget = path.join(fixture.home, 'user-claude-settings.json');
  const configContent = '{}\n';
  await write(configTarget, configContent);
  await fs.mkdir(path.dirname(fixture.paths.claude.settings), { recursive: true });
  await fs.symlink(configTarget, fixture.paths.claude.settings);

  await assert.rejects(
    planInstall(options(fixture.env, { agents: 'claude' })),
    (error) => (
      error instanceof AdapterConflictError
      && error.path === fixture.paths.claude.settings
      && /symbolic link/u.test(error.message)
    ),
  );
  await assert.rejects(
    planUninstall(options(fixture.env, { agents: 'claude' })),
    (error) => (
      error instanceof AdapterConflictError
      && error.path === fixture.paths.claude.settings
      && /symbolic link/u.test(error.message)
    ),
  );
  assert.equal((await fs.lstat(fixture.paths.claude.settings)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(configTarget, 'utf8'), configContent);

  const skillTarget = path.join(fixture.home, 'user-cursor-skill.md');
  await write(skillTarget, SKILL);
  await fs.mkdir(path.dirname(fixture.paths.cursor.skill), { recursive: true });
  await fs.symlink(skillTarget, fixture.paths.cursor.skill);

  await assert.rejects(
    planInstall(options(fixture.env, { agents: 'cursor' })),
    (error) => (
      error instanceof AdapterConflictError
      && error.path === fixture.paths.cursor.skill
      && /symbolic link/u.test(error.message)
    ),
  );
  assert.equal((await fs.lstat(fixture.paths.cursor.skill)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(skillTarget, 'utf8'), SKILL);
});

test('hook output uses each agent vendor schema and safely escapes context', () => {
  const context = 'line one\n"quoted" </script>';
  assert.deepEqual(JSON.parse(formatClaudeHookOutput(context)), {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  });
  assert.deepEqual(JSON.parse(formatCodexHookOutput(context)), {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  });
  assert.deepEqual(JSON.parse(formatCursorHookOutput(context)), {
    additional_context: context,
  });
  assert.ok(formatClaudeHookOutput(context).endsWith('\n'));
  assert.ok(formatCodexHookOutput(context).endsWith('\n'));
  assert.ok(formatCursorHookOutput(context).endsWith('\n'));
});

test('Cursor refuses an unsupported schema version without modifying the file', async (t) => {
  const fixture = await makeHome(t);
  const current = '{"version":2,"hooks":{}}\n';
  await write(fixture.paths.cursor.hooks, current);
  await assert.rejects(
    planInstall(options(fixture.env, { agents: 'cursor' })),
    AdapterConfigError,
  );
  assert.equal(await fs.readFile(fixture.paths.cursor.hooks, 'utf8'), current);
});
