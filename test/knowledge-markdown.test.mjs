import assert from 'node:assert/strict';
import test from 'node:test';

import { exportKnowledge, importKnowledgeFile, sessionCandidate } from '../src/core/knowledge-transfer.mjs';

function entry(title, body) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title,
    body,
    type: 'note',
    state: 'current',
    scope: 'global',
    repoId: null,
    environment: null,
    pinned: false,
    tags: ['example'],
  };
}

function legacyExport(entries) {
  return exportKnowledge(entries, { format: 'markdown' })
    .replace(/^bodyLength: \d+\n/gmu, '')
    .replace(/^title: .*\n/gmu, '');
}

test('legacy Markdown exports retain horizontal rules and complete front matter examples inside variable-length fences', () => {
  const example = legacyExport([entry('Nested example', 'Nested body')]).trim();
  const entries = [
    entry('Legacy first', `Before\n---\nAfter\n\n\`\`\`\`markdown\n\`\`\`\n${example}\n\`\`\`\n\`\`\`\`\n\n~~~md\n${example}\n~~~`),
    entry('Legacy second', 'Second body\n\n---\nkind: example\n---\n\nRetained'),
  ];
  for (const source of [legacyExport(entries), legacyExport(entries).replaceAll('\n', '\r\n')]) {
    const imported = importKnowledgeFile('legacy.md', source);
    assert.equal(imported.length, 2);
    assert.deepEqual(imported.map((value) => value.body), entries.map((value) => value.body));
  }
});

test('length-framed Markdown exports retain nested exports and unclosed fences across LF and CRLF', () => {
  const nested = exportKnowledge([entry('Nested export', 'Nested body')], { format: 'markdown' });
  const entries = [
    entry('First', `한글 😀\n\n${nested}\n\n\`\`\`md\nUnclosed code fence`),
    entry('Second', 'Second 😀 body\n---\nStill second'),
  ];
  const exported = exportKnowledge(entries, { format: 'markdown' });
  assert.match(exported, /bodyLength: \d+/u);
  for (const source of [exported, exported.replaceAll('\n', '\r\n')]) {
    const imported = importKnowledgeFile('export.md', source);
    assert.equal(imported.length, 2);
    assert.deepEqual(imported.map((value) => value.body), entries.map((value) => value.body));
  }
});

test('Markdown metadata preserves multiline titles while display headings stay on one line', () => {
  const entries = [
    entry('Title with "quotes"\n---\nSecond line 😀', 'First body'),
    entry('Windows title\r\nAnother line\rCarriage return\u2028Unicode separator', 'Second body'),
  ];
  const exported = exportKnowledge(entries, { format: 'markdown' });
  for (const source of [exported, exported.replaceAll('\n', '\r\n')]) {
    const imported = importKnowledgeFile('multiline.md', source);
    assert.equal(imported.length, 2);
    assert.deepEqual(imported.map((value) => value.title), entries.map((value) => value.title));
    assert.deepEqual(imported.map((value) => value.body), entries.map((value) => value.body));
  }
  assert.deepEqual(exported.match(/^## .*/gmu), [
    '## Title with "quotes" --- Second line 😀',
    '## Windows title Another line Carriage return Unicode separator',
  ]);
});

test('Markdown title metadata must be text rather than silently replacing a damaged title', () => {
  const exported = exportKnowledge([entry('Original title', 'Body')], { format: 'markdown' });
  const damaged = exported.replace('title: "Original title"\n', 'title: 42\n');
  assert.notEqual(damaged, exported);
  assert.throws(() => importKnowledgeFile('damaged-title.md', damaged), /title/u);
});

test('invalid Markdown body lengths reject the complete import instead of returning truncated records', () => {
  const exported = exportKnowledge([entry('First', 'First body'), entry('Second', 'Second body')], { format: 'markdown' });
  for (const length of ['"invalid"', '-1', '0', '1.5', '9999999999999999999', '12']) {
    const damaged = exported.replace('bodyLength: 11\n', `bodyLength: ${length}\n`);
    assert.notEqual(damaged, exported);
    assert.throws(() => importKnowledgeFile('damaged.md', damaged), /bodyLength/u);
  }
});

test('session imports collect conversation envelopes only and preserve the requested source reference', () => {
  const rows = [
    { type: 'session_meta', payload: { text: 'PRIVATE METADATA' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex assistant conclusion' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'system', content: [{ type: 'text', text: 'PRIVATE SYSTEM PROMPT' }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'PRIVATE TOOL RESULT' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Codex user request' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Codex assistant conclusion' } },
    { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'PRIVATE INTERNAL REASONING' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Claude assistant conclusion' }, { type: 'tool_use', input: { text: 'PRIVATE TOOL ARGUMENTS' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'PRIVATE CLAUDE TOOL RESULT' }] }, { type: 'text', text: 'Claude user request' }] } },
    { role: 'tool', content: 'PRIVATE GENERIC TOOL RESULT' },
    { type: 'system', message: 'PRIVATE SYSTEM EVENT' },
  ];
  const candidate = sessionCandidate('/private/transcript.jsonl', rows.map((row) => JSON.stringify(row)).join('\n'), {
    sourceRef: 'sessions/transcript.jsonl',
  });
  assert.equal(candidate.sources[0].ref, 'sessions/transcript.jsonl');
  assert.equal(candidate.body, 'Codex assistant conclusion\n\nCodex user request\n\nClaude assistant conclusion\n\nClaude user request');
  assert.doesNotMatch(candidate.body, /PRIVATE/u);
  assert.equal(candidate.approval, 'pending');
});
