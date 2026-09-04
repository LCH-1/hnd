import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { UsageError } from './args.mjs';

export const DEFAULT_MAX_TEXT_INPUT_BYTES = 1024 * 1024;

function validateMaxBytes(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new UsageError('Text input byte limit must be a positive safe integer.');
  }
}

function assertWithinLimit(value, maxBytes, label) {
  const bytes = Buffer.byteLength(value);
  if (bytes > maxBytes) {
    throw new UsageError(`${label} exceeds the ${maxBytes} byte limit.`);
  }
  return value;
}

async function readTextStream(stream, { maxBytes, label }) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const chunkBytes = typeof chunk === 'string'
      ? Buffer.byteLength(chunk)
      : (ArrayBuffer.isView(chunk) || chunk instanceof ArrayBuffer)
        ? chunk.byteLength
        : null;
    if (chunkBytes === null) {
      throw new UsageError(`${label} produced an unsupported data chunk.`);
    }
    if (chunkBytes > maxBytes - bytes) {
      throw new UsageError(`${label} exceeds the ${maxBytes} byte limit.`);
    }
    const buffer = typeof chunk === 'string'
      ? Buffer.from(chunk)
      : chunk instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(chunk))
        : Buffer.from(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    bytes += chunkBytes;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readStdin(
  stream = process.stdin,
  { maxBytes = DEFAULT_MAX_TEXT_INPUT_BYTES } = {},
) {
  validateMaxBytes(maxBytes);
  return readTextStream(stream, { maxBytes, label: 'Standard input' });
}

export async function readTextInput(options, {
  required = true,
  stream = process.stdin,
  maxBytes = DEFAULT_MAX_TEXT_INPUT_BYTES,
} = {}) {
  validateMaxBytes(maxBytes);
  const sources = [
    options.text !== undefined ? 'text' : null,
    options.file !== undefined ? 'file' : null,
    options.stdin === true ? 'stdin' : null,
  ].filter(Boolean);
  if (sources.length > 1) {
    throw new UsageError('Use only one of --text, --file, or --stdin.');
  }
  if (sources.length === 0) {
    if (!required) return undefined;
    throw new UsageError('Provide content with --text, --file, or --stdin.');
  }
  if (sources[0] === 'text') {
    if (options.text === true || Array.isArray(options.text)) {
      throw new UsageError('--text requires one value.');
    }
    return assertWithinLimit(String(options.text), maxBytes, 'Text input');
  }
  if (sources[0] === 'file') {
    if (options.file === true || Array.isArray(options.file)) {
      throw new UsageError('--file requires one path.');
    }
    const filePath = path.resolve(String(options.file));
    return readTextStream(createReadStream(filePath), {
      maxBytes,
      label: `Input file ${filePath}`,
    });
  }
  return readStdin(stream, { maxBytes });
}

export async function editText(initial, {
  env = process.env,
  suffix = '.md',
  label = 'hnd-edit',
  maxBytes = DEFAULT_MAX_TEXT_INPUT_BYTES,
} = {}) {
  validateMaxBytes(maxBytes);
  const command = env.VISUAL || env.EDITOR;
  if (!command) {
    throw new UsageError('Set $VISUAL or $EDITOR before using edit.');
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  const filePath = path.join(directory, `content${suffix}`);
  try {
    const initialText = assertWithinLimit(String(initial ?? ''), maxBytes, 'Editor input');
    await fs.writeFile(filePath, initialText, { encoding: 'utf8', mode: 0o600 });
    const [executable, ...args] = splitCommand(command);
    const result = spawnSync(executable, [...args, filePath], { stdio: 'inherit', env });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Editor exited with status ${result.status}.`);
    }
    return await readTextStream(createReadStream(filePath), {
      maxBytes,
      label: 'Edited text',
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// Supports the common "editor --flag" form without invoking a shell.
function splitCommand(value) {
  const parts = String(value).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const unquoted = parts.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  });
  if (unquoted.length === 0) throw new UsageError('The editor command is empty.');
  return unquoted;
}
