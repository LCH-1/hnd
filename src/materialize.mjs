import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { applyOperations } from './fs-operations.mjs';

const execFileAsync = promisify(execFile);

export const CURSOR_RULE_RELATIVE_PATH = '.cursor/rules/50-hnd.mdc';
export const CURSOR_RULE_OWNERSHIP_MARKER = '<!-- hnd-managed-cursor-rule: v1 -->';
export const EXCLUDE_PATTERN = `/${CURSOR_RULE_RELATIVE_PATH}`;

const CURSOR_RULE_PREFIX = `---
description: hnd effective policy and active work handoff
alwaysApply: true
---

${CURSOR_RULE_OWNERSHIP_MARKER}

`;
const EXCLUDE_BEGIN_PREFIX = '# >>> hnd managed cursor fallback v1; previous-file=';
const EXCLUDE_MIDDLE = '; previous-eol=';
const EXCLUDE_BEGIN_SUFFIX = ' >>>';
const EXCLUDE_END = '# <<< hnd managed cursor fallback v1 <<<';
const MAX_EXCLUDE_BYTES = 1024 * 1024;

export class MaterializeError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = 'MaterializeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function conflict(message, details) {
  throw new MaterializeError('MATERIALIZE_CONFLICT', message, details);
}

async function runGit(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new MaterializeError('GIT_UNAVAILABLE', 'git executable was not found', undefined, {
        cause: error,
      });
    }
    throw new MaterializeError(
      'MATERIALIZE_NOT_GIT',
      `Cannot materialize a Cursor rule outside a Git worktree: ${path.resolve(cwd)}`,
      { cwd: path.resolve(cwd), args, stderr: error.stderr?.trim() || undefined },
      { cause: error },
    );
  }
}

async function readRegularFile(filePath, { optional = false, maxBytes } = {}) {
  let metadata;
  try {
    metadata = await fs.lstat(filePath);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return { content: undefined, mode: undefined };
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    conflict(`Refusing to manage a non-regular path: ${filePath}`, { path: filePath });
  }
  if (maxBytes !== undefined && metadata.size > maxBytes) {
    conflict(`Refusing to modify an unexpectedly large file: ${filePath}`, {
      path: filePath,
      bytes: metadata.size,
      maxBytes,
    });
  }
  return {
    content: await fs.readFile(filePath, 'utf8'),
    mode: metadata.mode & 0o777,
  };
}

async function assertManagedDirectoryChain(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      conflict(`Refusing to materialize through a non-directory or symbolic link: ${current}`, {
        path: current,
      });
    }
  }
}

async function assertCursorRuleUntracked(root) {
  const tracked = await runGit(root, [
    'ls-files',
    '--stage',
    '--',
    CURSOR_RULE_RELATIVE_PATH,
  ]);
  if (tracked !== '') {
    conflict(
      `Refusing to place private context in a Git-tracked path: ${path.join(root, ...CURSOR_RULE_RELATIVE_PATH.split('/'))}`,
      { root, path: CURSOR_RULE_RELATIVE_PATH },
    );
  }
}

function newlineFor(source) {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function markerLine(previousFile, previousEol) {
  return `${EXCLUDE_BEGIN_PREFIX}${previousFile ? '1' : '0'}${EXCLUDE_MIDDLE}${previousEol ? '1' : '0'}${EXCLUDE_BEGIN_SUFFIX}`;
}

function excludeBlock(eol, previousFile, previousEol) {
  return [markerLine(previousFile, previousEol), EXCLUDE_PATTERN, EXCLUDE_END, ''].join(eol);
}

function allIndexes(source, needle) {
  const indexes = [];
  let offset = 0;
  while (offset <= source.length) {
    const index = source.indexOf(needle, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + needle.length;
  }
  return indexes;
}

/**
 * Finds the exact hnd-owned block. Any partial, duplicated, or edited marker
 * fails closed so an uninstall can never guess which user bytes to remove.
 */
export function inspectExcludeBlock(source) {
  if (typeof source !== 'string') throw new TypeError('exclude source must be text');
  const beginIndexes = allIndexes(source, EXCLUDE_BEGIN_PREFIX);
  const endIndexes = allIndexes(source, EXCLUDE_END);
  if (beginIndexes.length === 0 && endIndexes.length === 0) return null;
  if (beginIndexes.length !== 1 || endIndexes.length !== 1) {
    conflict('The hnd block in .git/info/exclude is duplicated or incomplete.');
  }

  const start = beginIndexes[0];
  if (start > 0 && source[start - 1] !== '\n') {
    conflict('The hnd block in .git/info/exclude does not begin on its own line.');
  }
  const lineEnd = source.indexOf('\n', start);
  if (lineEnd === -1) conflict('The hnd block in .git/info/exclude is incomplete.');
  const rawBegin = source.slice(start, lineEnd).replace(/\r$/, '');
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `^${escape(EXCLUDE_BEGIN_PREFIX)}([01])${escape(EXCLUDE_MIDDLE)}([01])${escape(EXCLUDE_BEGIN_SUFFIX)}$`,
  ).exec(rawBegin);
  if (!match) conflict('The hnd block in .git/info/exclude has an invalid ownership marker.');

  const eol = source.slice(lineEnd - 1, lineEnd + 1) === '\r\n' ? '\r\n' : '\n';
  const previousFile = match[1] === '1';
  const previousEol = match[2] === '1';
  const expected = excludeBlock(eol, previousFile, previousEol);
  if (source.slice(start, start + expected.length) !== expected) {
    conflict('The hnd block in .git/info/exclude was edited; refusing to replace user bytes.');
  }
  return { start, end: start + expected.length, previousFile, previousEol, eol };
}

export function installExcludeBlock(source, { previousFile = true } = {}) {
  if (typeof source !== 'string') throw new TypeError('exclude source must be text');
  if (inspectExcludeBlock(source)) return source;
  const eol = newlineFor(source);
  const previousEol = source.length === 0 || source.endsWith('\n');
  const separator = source.length > 0 && !previousEol ? eol : '';
  return `${source}${separator}${excludeBlock(eol, previousFile, previousEol)}`;
}

export function removeExcludeBlock(source) {
  if (typeof source !== 'string') throw new TypeError('exclude source must be text');
  const block = inspectExcludeBlock(source);
  if (!block) return source;
  let prefix = source.slice(0, block.start);
  const suffix = source.slice(block.end);
  if (!block.previousEol && suffix.length === 0) {
    if (!prefix.endsWith(block.eol)) {
      conflict('The hnd block cannot restore the original .git/info/exclude ending.');
    }
    prefix = prefix.slice(0, -block.eol.length);
  }
  return `${prefix}${suffix}`;
}

export function renderCursorRule(content) {
  if (typeof content !== 'string') throw new TypeError('Cursor context must be text');
  if (content.includes('\0')) {
    throw new MaterializeError('INVALID_MATERIALIZED_CONTEXT', 'Cursor context cannot contain NUL bytes');
  }
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  return `${CURSOR_RULE_PREFIX}${normalized}`;
}

export function isManagedCursorRule(content) {
  return typeof content === 'string' && content.startsWith(CURSOR_RULE_PREFIX);
}

export async function resolveCursorMaterializationPaths(cwd = process.cwd()) {
  const requested = path.resolve(cwd);
  const rootSource = await runGit(requested, ['rev-parse', '--show-toplevel']);
  const root = await fs.realpath(rootSource);
  const commonSource = await runGit(root, ['rev-parse', '--git-common-dir']);
  const commonDirectory = await fs.realpath(path.resolve(root, commonSource));
  const infoDirectory = path.join(commonDirectory, 'info');
  await assertCursorRuleUntracked(root);
  await assertManagedDirectoryChain(root, ['.cursor', 'rules']);
  await assertManagedDirectoryChain(commonDirectory, ['info']);
  return Object.freeze({
    root,
    rule: path.join(root, ...CURSOR_RULE_RELATIVE_PATH.split('/')),
    exclude: path.join(infoDirectory, 'exclude'),
  });
}

function writeOperation({ filePath, content, previous, mode, component, reason }) {
  return {
    kind: 'write',
    path: filePath,
    content,
    previous,
    mode: mode ?? 0o600,
    agent: 'cursor',
    component,
    reason,
  };
}

function removeOperation({ filePath, previous, component, reason }) {
  return {
    kind: 'remove',
    path: filePath,
    previous,
    agent: 'cursor',
    component,
    reason,
  };
}

export async function planCursorMaterialization({ cwd = process.cwd(), content } = {}) {
  const paths = await resolveCursorMaterializationPaths(cwd);
  const [rule, exclude] = await Promise.all([
    readRegularFile(paths.rule, { optional: true }),
    readRegularFile(paths.exclude, { optional: true, maxBytes: MAX_EXCLUDE_BYTES }),
  ]);
  if (rule.content !== undefined && !isManagedCursorRule(rule.content)) {
    const markerPresent = rule.content.includes(CURSOR_RULE_OWNERSHIP_MARKER);
    conflict(
      markerPresent
        ? `The managed Cursor rule has an invalid header: ${paths.rule}`
        : `An unmanaged Cursor rule already exists: ${paths.rule}`,
      { path: paths.rule },
    );
  }

  const operations = [];
  const nextExclude = installExcludeBlock(exclude.content ?? '', {
    previousFile: exclude.content !== undefined,
  });
  if (nextExclude !== exclude.content) {
    operations.push(writeOperation({
      filePath: paths.exclude,
      content: nextExclude,
      previous: exclude.content,
      mode: exclude.mode ?? 0o600,
      component: 'cursor-exclude',
      reason: `Exclude ${CURSOR_RULE_RELATIVE_PATH} without changing tracked repository files.`,
    }));
  }

  const nextRule = renderCursorRule(content);
  if (nextRule !== rule.content) {
    operations.push(writeOperation({
      filePath: paths.rule,
      content: nextRule,
      previous: rule.content,
      mode: rule.mode ?? 0o600,
      component: 'cursor-rule',
      reason: 'Materialize the effective hnd context as one always-applied Cursor rule.',
    }));
  }
  return Object.freeze({ paths, operations: Object.freeze(operations) });
}

export async function planCursorDematerialization({ cwd = process.cwd() } = {}) {
  const paths = await resolveCursorMaterializationPaths(cwd);
  const [rule, exclude] = await Promise.all([
    readRegularFile(paths.rule, { optional: true }),
    readRegularFile(paths.exclude, { optional: true, maxBytes: MAX_EXCLUDE_BYTES }),
  ]);
  if (
    rule.content !== undefined
    && rule.content.includes(CURSOR_RULE_OWNERSHIP_MARKER)
    && !isManagedCursorRule(rule.content)
  ) {
    conflict(`The managed Cursor rule has an invalid header: ${paths.rule}`, {
      path: paths.rule,
    });
  }

  const operations = [];
  if (isManagedCursorRule(rule.content)) {
    operations.push(removeOperation({
      filePath: paths.rule,
      previous: rule.content,
      component: 'cursor-rule',
      reason: 'Remove the hnd-owned Cursor fallback rule.',
    }));
  }
  if (exclude.content !== undefined) {
    const block = inspectExcludeBlock(exclude.content);
    const nextExclude = removeExcludeBlock(exclude.content);
    if (nextExclude !== exclude.content) {
      operations.push(
        nextExclude === '' && block?.previousFile === false
          ? removeOperation({
              filePath: paths.exclude,
              previous: exclude.content,
              component: 'cursor-exclude',
              reason: 'Remove the hnd-created empty exclude file.',
            })
          : writeOperation({
              filePath: paths.exclude,
              content: nextExclude,
              previous: exclude.content,
              mode: exclude.mode,
              component: 'cursor-exclude',
              reason: 'Remove only the hnd-owned ignore marker block.',
            }),
      );
    }
  }
  return Object.freeze({ paths, operations: Object.freeze(operations) });
}

export async function materializeCursor(options = {}) {
  const planned = await planCursorMaterialization(options);
  const results = await applyOperations(planned.operations, { dryRun: options.dryRun === true });
  return Object.freeze({ ...planned, results: Object.freeze(results) });
}

export async function dematerializeCursor(options = {}) {
  const planned = await planCursorDematerialization(options);
  const results = await applyOperations(planned.operations, { dryRun: options.dryRun === true });
  return Object.freeze({ ...planned, results: Object.freeze(results) });
}
