import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { WORK_SESSION_ENV, workSessionKey } from '../core/work-session.mjs';

// Claude sources this host-provided file before subsequent Bash commands.
// Append only a validated digest; never place payload IDs or shell commands
// from the transcript into an executable environment file.
export async function connectClaudeSessionEnvironment({ sessionKey, env = process.env } = {}) {
  const target = env.CLAUDE_ENV_FILE;
  if (!target || !sessionKey) return false;
  if (!path.isAbsolute(target)) throw new TypeError('CLAUDE_ENV_FILE must be an absolute path.');
  const key = workSessionKey({ sessionKey, env: {} });
  const line = `export ${WORK_SESSION_ENV}='${key}'`;
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) throw new TypeError('CLAUDE_ENV_FILE must not be a symlink.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const handle = await fs.open(target, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024
      || (process.getuid && stat.uid !== process.getuid())
      || (process.platform !== 'win32' && (stat.mode & 0o022))) {
      throw new TypeError('CLAUDE_ENV_FILE must be a private, regular environment file.');
    }
    const content = await handle.readFile('utf8');
    // A later resume/fork may need a different binding. Comparing the last
    // assignment preserves that transition while keeping repeated hooks quiet.
    const assignments = content.split(/\r?\n/).filter((value) => value.startsWith(`export ${WORK_SESSION_ENV}=`));
    if (assignments.at(-1) !== line) await handle.writeFile(`\n${line}\n`);
    return true;
  } finally {
    await handle.close();
  }
}
