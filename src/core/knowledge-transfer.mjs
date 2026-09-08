import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertNoSensitive, redactSensitiveText } from './privacy.mjs';

const TRANSFER_VERSION = 1;

function yamlText(value) {
  return JSON.stringify(String(value ?? ''));
}

export function exportKnowledge(entries, { format = 'json', project = null, allowSensitive = false } = {}) {
  assertNoSensitive(entries, { allowSensitive });
  const exportedAt = new Date().toISOString();
  if (format === 'json') {
    return `${JSON.stringify({
      schema: 'hnd-knowledge',
      version: TRANSFER_VERSION,
      exportedAt,
      project,
      entries,
    }, null, 2)}\n`;
  }
  if (format === 'okf') {
    return `${JSON.stringify({
      format: 'okf',
      version: TRANSFER_VERSION,
      generator: 'hnd',
      exportedAt,
      records: entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        content: entry.body,
        kind: entry.type,
        status: entry.state,
        scope: entry.scope,
        projectId: entry.repoId,
        environment: entry.environment,
        tags: entry.tags,
        pinned: entry.pinned,
        sources: entry.sources,
        relations: entry.relationships,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })),
    }, null, 2)}\n`;
  }
  if (format !== 'markdown') throw new Error('Format must be json, markdown, or okf');
  const parts = [
    '# HND knowledge export',
    '',
    `Exported: ${exportedAt}`,
    project ? `Project: ${project}` : null,
  ].filter(Boolean);
  for (const entry of entries) {
    // Measure normalized JavaScript string units, matching the Markdown
    // importer after LF/CRLF normalization. Old readers ignore this field.
    const body = entry.body.replace(/\r\n/gu, '\n');
    parts.push(
      '',
      '---',
      `id: ${yamlText(entry.id)}`,
      `title: ${yamlText(entry.title)}`,
      `type: ${yamlText(entry.type)}`,
      `state: ${yamlText(entry.state)}`,
      `scope: ${yamlText(entry.scope)}`,
      `projectId: ${yamlText(entry.repoId || '')}`,
      `environment: ${yamlText(entry.environment || '')}`,
      `pinned: ${entry.pinned ? 'true' : 'false'}`,
      `tags: ${JSON.stringify(entry.tags)}`,
      `bodyLength: ${body.length}`,
      '---',
      '',
      `## ${entry.title.replace(/[\r\n\u2028\u2029]+/gu, ' ')}`,
      '',
      body,
    );
  }
  return `${parts.join('\n')}\n`;
}

function candidateType(text) {
  const value = text.toLocaleLowerCase('und');
  if (/실패|failed|did not work|안 됨|오류/u.test(value)) return 'failure';
  if (/주의|경고|caution|warning/u.test(value)) return 'caution';
  if (/결정|decided|decision/u.test(value)) return 'decision';
  if (/해결|fixed|solution|원인/u.test(value)) return 'solution';
  if (/runbook|절차|운영/u.test(value)) return 'runbook';
  if (/architecture|설계|구조/u.test(value)) return 'architecture';
  if (/^\s*(?:\$|npm |git |docker |hnd )/mu.test(text)) return 'command';
  return 'note';
}

function candidateTitle(text, fallback) {
  const first = String(text || '').split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  if (!first) return fallback;
  return [...first.replace(/^#+\s*/u, '')].slice(0, 120).join('');
}

export function documentCandidate(file, content, { scope = 'repo', sourceRef = file } = {}) {
  const body = String(content || '').trim();
  return {
    title: candidateTitle(body, path.basename(file)),
    body,
    tags: ['imported', path.basename(file)],
    scope,
    type: candidateType(body),
    state: 'review_needed',
    approval: 'pending',
    sources: [{
      kind: 'file',
      ref: sourceRef,
      label: path.basename(file),
      hash: createHash('sha256').update(String(content || '')).digest('hex'),
    }],
  };
}

function collectText(value, output) {
  if (typeof value === 'string') {
    if (value.trim()) output.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.type === 'response_item') {
    if (value.payload?.type === 'message' && ['user', 'assistant'].includes(value.payload.role)) {
      collectText(value.payload.content, output);
    }
    return;
  }
  if (value.type === 'event_msg') {
    if (['user_message', 'agent_message'].includes(value.payload?.type)) {
      collectText(value.payload.message, output);
    }
    return;
  }
  // Do not recursively mine arbitrary envelopes or tool-result blocks. The
  // supported generic forms are conversation messages and their text blocks.
  if (Object.hasOwn(value, 'payload')) return;
  if (value.role && !['user', 'assistant'].includes(value.role)) return;
  if (value.type && !['user', 'assistant', 'message', 'text', 'input_text', 'output_text'].includes(value.type)) return;
  for (const key of ['text', 'content', 'message', 'prompt', 'last_assistant_message']) {
    if (Object.hasOwn(value, key)) collectText(value[key], output);
  }
}

export function sessionCandidate(file, content, { scope = 'repo', sourceRef = file } = {}) {
  const pieces = [];
  for (const line of String(content || '').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      collectText(JSON.parse(line), pieces);
    } catch {
      pieces.push(line.trim());
    }
  }
  const body = [...new Set(pieces)].slice(-12).join('\n\n').slice(0, 48_000);
  return {
    ...documentCandidate(file, body, { scope, sourceRef }),
    title: `세션 검토 후보 · ${path.basename(file)}`,
    tags: ['session-import'],
    sources: [{ kind: 'session', ref: sourceRef, label: path.basename(file) }],
  };
}

export function automaticSessionCandidate(payload, { agent, sessionId, sessionKey } = {}) {
  const original = [
    payload?.last_assistant_message,
    payload?.lastAssistantMessage,
    payload?.assistant_message,
  ].find((value) => typeof value === 'string' && value.trim());
  if (!original || original.trim().length < 80) return null;
  const body = redactSensitiveText(original).text;
  return {
    title: candidateTitle(body, '세션에서 찾은 지식 후보'),
    body: body.trim().slice(0, 48_000),
    tags: ['session-suggestion'],
    scope: 'repo',
    type: candidateType(body),
    state: 'review_needed',
    approval: 'pending',
    sources: [{
      kind: 'session',
      ref: sessionKey ? `hnd-session:${sessionKey}` : redactSensitiveText(sessionId || 'unknown').text,
      label: agent || null,
    }],
    agent,
  };
}

function markdownExportHeader(source, offset) {
  const match = source.slice(offset).match(/^---\n((?:[a-zA-Z][a-zA-Z0-9_]*:[^\n]*\n)+)---\n\n## ([^\n]+)\n(?:\n|$)/u);
  if (!match) return null;
  const metadata = Object.fromEntries(match[1].trimEnd().split('\n').map((value) => {
    const separator = value.indexOf(':');
    const key = value.slice(0, separator).trim();
    const raw = value.slice(separator + 1).trim();
    try { return [key, JSON.parse(raw)]; } catch { return [key, raw]; }
  }));
  if (!['id', 'type', 'state', 'scope', 'projectId', 'environment', 'pinned', 'tags']
    .every((key) => Object.hasOwn(metadata, key))) return null;
  if (Object.hasOwn(metadata, 'title') && typeof metadata.title !== 'string') {
    throw new Error('Invalid HND Markdown title metadata; title must be text.');
  }
  return { metadata, title: metadata.title ?? match[2], start: offset, bodyStart: offset + match[0].length };
}

function markdownExportRecords(content) {
  const source = content.replace(/\r\n/gu, '\n');
  const headers = [];
  let offset = 0;
  let fence = null;
  while (offset < source.length) {
    const lineEnd = source.indexOf('\n', offset);
    const line = source.slice(offset, lineEnd === -1 ? source.length : lineEnd);
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence.character
        && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker) {
      if (marker[1][0] !== '`' || !marker[2].includes('`')) {
        fence = { character: marker[1][0], length: marker[1].length };
      }
    } else if (line === '---') {
      // A horizontal rule alone is not a record boundary. Match the actual
      // HND front matter plus heading, and ignore examples in fenced code.
      const header = markdownExportHeader(source, offset);
      if (header) {
        if (Object.hasOwn(header.metadata, 'bodyLength')) {
          const length = header.metadata.bodyLength;
          if (!Number.isSafeInteger(length) || length < 0 || length > source.length - header.bodyStart) {
            throw new Error('Invalid HND Markdown bodyLength; the knowledge export may be damaged.');
          }
          header.bodyEnd = header.bodyStart + length;
          const suffix = source.slice(header.bodyEnd);
          const nextOffset = header.bodyEnd + (suffix.match(/^[\t \n]*/u)?.[0].length ?? 0);
          if (!suffix.startsWith('\n') || (nextOffset !== source.length && !markdownExportHeader(source, nextOffset))) {
            throw new Error('HND Markdown bodyLength does not match the record boundary; export again after editing.');
          }
          headers.push(header);
          // Never interpret body text, including nested exports and unclosed
          // code fences, as metadata when the export supplied its exact span.
          offset = header.bodyEnd;
          continue;
        }
        headers.push(header);
      }
    }
    offset += line.length + 1;
  }
  return headers.map((header, index) => ({
    ...header,
    body: source.slice(header.bodyStart, header.bodyEnd ?? headers[index + 1]?.start ?? source.length).trim(),
  }));
}

export function importKnowledgeFile(file, content, { scope, sourceRef = file } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(content || ''));
  } catch {
    const source = String(content || '');
    if (source.startsWith('# HND knowledge export')) {
      const entries = [];
      for (const { metadata, title, body } of markdownExportRecords(source)) {
        entries.push({
          title,
          body,
          tags: Array.isArray(metadata.tags) ? metadata.tags : [],
          scope: scope || metadata.scope || 'global',
          repoId: scope ? undefined : metadata.projectId || undefined,
          environment: scope ? undefined : metadata.environment || undefined,
          type: metadata.type || 'note',
          state: 'review_needed',
          pinned: metadata.pinned === true || metadata.pinned === 'true',
          sources: [{ kind: 'import', ref: sourceRef, label: path.basename(file) }],
          relationships: [],
          approval: 'pending',
        });
      }
      if (entries.length > 0) return entries;
    }
    return [documentCandidate(file, content, { scope: scope || 'repo', sourceRef })];
  }
  const sourceEntries = parsed?.schema === 'hnd-knowledge' && Array.isArray(parsed.entries)
    ? parsed.entries
    : parsed?.format === 'okf' && Array.isArray(parsed.records)
      ? parsed.records.map((record) => ({
          title: record.title,
          body: record.content,
          type: record.kind,
          state: record.status,
          scope: record.scope,
          repoId: record.projectId,
          environment: record.environment,
          tags: record.tags,
          pinned: record.pinned,
          sources: record.sources,
          relationships: record.relations,
        }))
      : null;
  if (!sourceEntries) return [documentCandidate(file, content, { scope: scope || 'repo', sourceRef })];
  return sourceEntries.map((entry) => ({
    title: String(entry.title || path.basename(file)).slice(0, 200),
    body: String(entry.body || ''),
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    scope: scope || entry.scope || 'global',
    repoId: scope ? undefined : entry.repoId,
    environment: scope ? undefined : entry.environment,
    type: entry.type || 'note',
    state: 'review_needed',
    pinned: entry.pinned === true,
    sources: Array.isArray(entry.sources) ? entry.sources : [],
    relationships: Array.isArray(entry.relationships) ? entry.relationships : [],
    approval: 'pending',
  }));
}
