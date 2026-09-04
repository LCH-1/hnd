import path from 'node:path';
import { createHash } from 'node:crypto';

const TRANSFER_VERSION = 1;

function yamlText(value) {
  return JSON.stringify(String(value ?? ''));
}

export function exportKnowledge(entries, { format = 'json', project = null } = {}) {
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
    parts.push(
      '',
      '---',
      `id: ${yamlText(entry.id)}`,
      `type: ${yamlText(entry.type)}`,
      `state: ${yamlText(entry.state)}`,
      `scope: ${yamlText(entry.scope)}`,
      `projectId: ${yamlText(entry.repoId || '')}`,
      `environment: ${yamlText(entry.environment || '')}`,
      `pinned: ${entry.pinned ? 'true' : 'false'}`,
      `tags: ${JSON.stringify(entry.tags)}`,
      '---',
      '',
      `## ${entry.title}`,
      '',
      entry.body,
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
  for (const key of ['text', 'content', 'message', 'prompt', 'last_assistant_message']) {
    if (Object.hasOwn(value, key)) collectText(value[key], output);
  }
}

export function sessionCandidate(file, content, { scope = 'repo' } = {}) {
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
    ...documentCandidate(file, body, { scope }),
    title: `세션 검토 후보 · ${path.basename(file)}`,
    tags: ['session-import'],
    sources: [{ kind: 'session', ref: file, label: path.basename(file) }],
  };
}

export function automaticSessionCandidate(payload, { agent, sessionId } = {}) {
  const body = [
    payload?.last_assistant_message,
    payload?.lastAssistantMessage,
    payload?.assistant_message,
  ].find((value) => typeof value === 'string' && value.trim());
  if (!body || body.trim().length < 80) return null;
  return {
    title: candidateTitle(body, '세션에서 찾은 지식 후보'),
    body: body.trim().slice(0, 48_000),
    tags: ['session-suggestion'],
    scope: 'repo',
    type: candidateType(body),
    state: 'review_needed',
    approval: 'pending',
    sources: [{ kind: 'session', ref: sessionId || 'unknown', label: agent || null }],
    agent,
  };
}

export function importKnowledgeFile(file, content, { scope, sourceRef = file } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(content || ''));
  } catch {
    const source = String(content || '');
    if (source.startsWith('# HND knowledge export')) {
      const chunks = source.split(/\n---\n/u);
      const entries = [];
      for (let index = 1; index + 1 < chunks.length; index += 2) {
        const metadata = Object.fromEntries(chunks[index].split(/\r?\n/u).map((line) => {
          const separator = line.indexOf(':');
          if (separator === -1) return [line, ''];
          const key = line.slice(0, separator).trim();
          const raw = line.slice(separator + 1).trim();
          try { return [key, JSON.parse(raw)]; } catch { return [key, raw]; }
        }));
        const bodyChunk = chunks[index + 1].trim();
        const heading = bodyChunk.match(/^##\s+(.+)\n/u);
        entries.push({
          title: heading?.[1] || path.basename(file),
          body: heading ? bodyChunk.slice(heading[0].length).trim() : bodyChunk,
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
