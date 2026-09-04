import os from 'node:os';
import path from 'node:path';

export function userHome(env = process.env) {
  if (env.HND_USER_HOME && !path.isAbsolute(env.HND_USER_HOME)) {
    throw new Error('HND_USER_HOME must be an absolute path.');
  }
  return path.resolve(env.HND_USER_HOME || os.homedir());
}

export function hndHome(env = process.env) {
  if (env.HND_HOME && !path.isAbsolute(env.HND_HOME)) {
    throw new Error('HND_HOME must be an absolute path.');
  }
  return path.resolve(env.HND_HOME || path.join(userHome(env), '.hnd'));
}

export function statePaths(env = process.env) {
  const home = hndHome(env);
  return Object.freeze({
    home,
    config: path.join(home, 'config.json'),
    globalPolicy: path.join(home, 'policies', 'global.md'),
    localOverride: path.join(home, 'local-override.md'),
    repositories: path.join(home, 'repositories'),
    repoIndex: path.join(home, 'repositories.json'),
    bindings: path.join(home, 'bindings.json'),
    handoffSelections: path.join(home, 'handoff-selections.json'),
    knowledge: path.join(home, 'knowledge'),
    rules: path.join(home, 'rules'),
    ledger: path.join(home, 'managed.json'),
    blobs: path.join(home, 'blobs'),
    secrets: path.join(home, 'secrets'),
    remotes: path.join(home, 'remotes.json'),
    cache: path.join(home, 'cache'),
    locks: path.join(home, 'locks'),
    runtime: path.join(home, 'runtime'),
    runtimeReleases: path.join(home, 'runtime', 'releases'),
    runtimeCurrent: path.join(home, 'runtime', 'current.json'),
    runtimePrevious: path.join(home, 'runtime', 'previous.json'),
    runtimeUpdateState: path.join(home, 'runtime', 'update-state.json'),
    runtimeUpdateLock: path.join(home, 'locks', 'connector-update.lock'),
  });
}

export function agentPaths(env = process.env) {
  const home = userHome(env);
  return Object.freeze({
    claude: {
      settings: path.join(home, '.claude', 'settings.json'),
      skill: path.join(home, '.claude', 'skills', 'hnd-handoff', 'SKILL.md'),
    },
    codex: {
      hooks: path.join(home, '.codex', 'hooks.json'),
      config: path.join(home, '.codex', 'config.toml'),
      skill: path.join(home, '.codex', 'skills', 'hnd-handoff', 'SKILL.md'),
    },
    cursor: {
      hooks: path.join(home, '.cursor', 'hooks.json'),
      skill: path.join(home, '.cursor', 'skills', 'hnd-handoff', 'SKILL.md'),
    },
    sharedSkill: path.join(home, '.agents', 'skills', 'hnd-handoff', 'SKILL.md'),
  });
}

export function repositoryPaths(repoId, env = process.env) {
  if (!/^[a-f0-9-]{36}$/i.test(repoId)) {
    throw new Error(`Invalid repository id: ${repoId}`);
  }
  const root = path.join(statePaths(env).repositories, repoId);
  return Object.freeze({
    root,
    metadata: path.join(root, 'repository.json'),
    policy: path.join(root, 'policy.md'),
    environments: path.join(root, 'environments'),
    handoffs: path.join(root, 'handoffs'),
    archive: path.join(root, 'archive'),
    checkpoints: path.join(root, 'checkpoints'),
    rules: path.join(root, 'rules'),
  });
}

export function normalizeFsPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32'
    ? resolved.replaceAll('\\', '/').toLowerCase()
    : resolved;
}
