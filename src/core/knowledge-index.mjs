import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { statePaths } from '../paths.mjs';

function indexFingerprint(entries) {
  return createHash('sha256')
    // A fixed test clock, a restored snapshot, or a coarse filesystem clock can
    // legitimately change searchable text without changing updatedAt. The
    // index is derived state, so fingerprint the indexed values themselves.
    .update(JSON.stringify(entries.map((entry) => [
      entry.id,
      entry.updatedAt,
      entry.title,
      entry.body,
      entry.tags,
    ])))
    .digest('hex');
}

function ftsTerms(query, match) {
  const terms = String(query || '')
    .normalize('NFKC')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 32)
    .map((term) => `"${term.replaceAll('"', '""')}"*`);
  return terms.join(match === 'any' ? ' OR ' : ' AND ');
}

function openIndex(env) {
  const file = path.join(statePaths(env).cache, 'knowledge-fts.sqlite');
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      id UNINDEXED,
      title,
      body,
      tags,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  return database;
}

function rebuildIfNeeded(database, entries) {
  const fingerprint = indexFingerprint(entries);
  const current = database.prepare(
    "SELECT value FROM index_meta WHERE key = 'fingerprint'",
  ).get()?.value;
  if (current === fingerprint) return;

  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM knowledge_fts');
    const insert = database.prepare(
      'INSERT INTO knowledge_fts (id, title, body, tags) VALUES (?, ?, ?, ?)',
    );
    for (const entry of entries) {
      insert.run(entry.id, entry.title, entry.body, entry.tags.join(' '));
    }
    database.prepare(`
      INSERT INTO index_meta (key, value) VALUES ('fingerprint', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(fingerprint);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Search the derived local FTS5 index. The JSON knowledge files remain the
 * source of truth; the index is rebuilt after sync or any local mutation.
 */
export function searchKnowledgeIndex({
  entries, query, env = process.env, limit = 100, match = 'all',
} = {}) {
  if (!['all', 'any'].includes(match)) throw new TypeError('match must be all or any');
  const expression = ftsTerms(query, match);
  if (!expression) return [];
  const database = openIndex(env);
  try {
    rebuildIfNeeded(database, entries);
    return database.prepare(`
      SELECT id, bm25(knowledge_fts, 0.0, 8.0, 1.0, 4.0) AS rank
      FROM knowledge_fts
      WHERE knowledge_fts MATCH ?
      ORDER BY rank ASC
      LIMIT ?
    `).all(expression, Math.max(1, Math.min(Number(limit) || 100, 500)));
  } finally {
    database.close();
  }
}
