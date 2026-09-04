import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { UsageError } from '../src/args.mjs';
import {
  DEFAULT_MAX_TEXT_INPUT_BYTES,
  editText,
  readStdin,
  readTextInput,
} from '../src/input.mjs';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-input-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('readStdin enforces its byte limit incrementally and closes the iterator', async () => {
  let chunksRequested = 0;
  let iteratorClosed = false;
  async function* chunks() {
    try {
      chunksRequested += 1;
      yield Buffer.from('1234');
      chunksRequested += 1;
      yield Buffer.from('5678');
      chunksRequested += 1;
      yield Buffer.alloc(1024);
    } finally {
      iteratorClosed = true;
    }
  }

  await assert.rejects(
    readStdin(chunks(), { maxBytes: 5 }),
    (error) => error instanceof UsageError
      && /Standard input exceeds the 5 byte limit/.test(error.message),
  );
  assert.equal(chunksRequested, 2);
  assert.equal(iteratorClosed, true);
});

test('readTextInput counts UTF-8 bytes for inline text', async () => {
  assert.equal(
    await readTextInput({ text: 'éé' }, { maxBytes: 4 }),
    'éé',
  );
  await assert.rejects(
    readTextInput({ text: 'éé' }, { maxBytes: 3 }),
    (error) => error instanceof UsageError
      && /Text input exceeds the 3 byte limit/.test(error.message),
  );
});

test('readTextInput streams files with the same byte limit', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'policy.md');
  await fs.writeFile(filePath, '123456');

  assert.equal(
    await readTextInput({ file: filePath }, { maxBytes: 6 }),
    '123456',
  );
  await assert.rejects(
    readTextInput({ file: filePath }, { maxBytes: 5 }),
    (error) => error instanceof UsageError
      && /Input file .* exceeds the 5 byte limit/.test(error.message),
  );
});

test('default text limit rejects oversized stdin while preserving normal policy-sized input', async () => {
  const policy = '# Rules\n' + 'x'.repeat(32 * 1024);
  assert.equal(
    await readStdin(Readable.from([policy])),
    policy,
  );
  await assert.rejects(
    readStdin(Readable.from([Buffer.alloc(DEFAULT_MAX_TEXT_INPUT_BYTES + 1)])),
    (error) => error instanceof UsageError
      && error.message.includes(`${DEFAULT_MAX_TEXT_INPUT_BYTES} byte limit`),
  );
});

test('invalid limits fail before reading input', async () => {
  for (const maxBytes of [0, -1, Number.POSITIVE_INFINITY, 1.5]) {
    await assert.rejects(
      readStdin(Readable.from(['ignored']), { maxBytes }),
      (error) => error instanceof UsageError
        && /positive safe integer/.test(error.message),
    );
  }
});

test('unsupported stream chunks are rejected without treating numbers as buffer sizes', async () => {
  async function* invalidChunks() {
    yield 2 ** 31;
  }
  await assert.rejects(
    readStdin(invalidChunks()),
    (error) => error instanceof UsageError
      && /unsupported data chunk/.test(error.message),
  );
});

test('editText bounds content written by the editor', async (t) => {
  const directory = await temporaryDirectory(t);
  const editorPath = path.join(directory, 'oversized-editor.mjs');
  await fs.writeFile(
    editorPath,
    "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], 'x'.repeat(65));\n",
  );

  await assert.rejects(
    editText('initial', {
      env: { ...process.env, EDITOR: `"${process.execPath}" "${editorPath}"` },
      maxBytes: 64,
    }),
    (error) => error instanceof UsageError
      && /Edited text exceeds the 64 byte limit/.test(error.message),
  );
});
