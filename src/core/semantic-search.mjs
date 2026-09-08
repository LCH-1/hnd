import path from 'node:path';
import { createHash } from 'node:crypto';

import { statePaths } from '../paths.mjs';
import { CoreError } from './errors.mjs';
import { readJson, withFileLock, writeJsonAtomic } from './fs.mjs';
import { scanSensitive } from './privacy.mjs';

const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1, enabled: false, model: 'embeddinggemma',
  endpoint: 'http://127.0.0.1:11434', timeoutMs: 1500,
});
const MAX_ENTRIES = 256;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSIONS = 4096;

function configPath(env) {
  return path.join(statePaths(env).cache, 'semantic-search-config.json');
}

function normalizeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !Object.keys(DEFAULT_CONFIG).includes(key))) {
    throw new CoreError('INVALID_SEMANTIC_CONFIG', 'Invalid semantic search configuration');
  }
  const config = { ...DEFAULT_CONFIG, ...value };
  if (config.schemaVersion !== 1 || typeof config.enabled !== 'boolean'
    || typeof config.endpoint !== 'string'
    || typeof config.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,119}$/.test(config.model)
    || /(?:[-:]cloud)(?:$|[:/])/i.test(config.model)
    || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 50 || config.timeoutMs > 10_000) {
    throw new CoreError('INVALID_SEMANTIC_CONFIG', 'Use a local embedding model and a timeout from 50 to 10000 ms');
  }
  let endpoint;
  try { endpoint = new URL(config.endpoint); } catch {
    throw new CoreError('INVALID_SEMANTIC_CONFIG', 'Embedding endpoint must be a loopback HTTP origin');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new CoreError('INVALID_SEMANTIC_CONFIG', 'Embedding endpoint must be a loopback HTTP origin without credentials');
  }
  // Do not delegate the localhost trust boundary to configurable DNS.
  if (endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1';
  return Object.freeze({ ...config, endpoint: endpoint.origin });
}

export async function getSemanticSearchConfig({ env = process.env } = {}) {
  const saved = await readJson(configPath(env), { optional: true });
  return normalizeConfig(saved ?? DEFAULT_CONFIG);
}

export async function configureSemanticSearch({ env = process.env, ...patch } = {}) {
  return withFileLock(path.join(statePaths(env).locks, 'semantic-search-config.lock'), async () => {
    const previous = await getSemanticSearchConfig({ env });
    const next = normalizeConfig({ ...previous, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) });
    await writeJsonAtomic(configPath(env), next);
    return next;
  });
}

export function semanticContentDigest(entry) {
  return createHash('sha256').update(JSON.stringify([entry.title, entry.body, entry.tags])).digest('hex');
}

function vector(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_DIMENSIONS
    || !value.every((part) => typeof part === 'number' && Number.isFinite(part) && Math.abs(part) <= 1e10)) {
    throw new CoreError('SEMANTIC_RESPONSE_INVALID', 'Embedding response contains an invalid vector');
  }
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new CoreError('SEMANTIC_RESPONSE_INVALID', 'Embedding vector must have a finite nonzero norm');
  }
  return value.map((part) => part / norm);
}

async function responseJson(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new CoreError('SEMANTIC_PROVIDER_UNAVAILABLE', 'Local embedding provider is unavailable');
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CoreError('SEMANTIC_RESPONSE_INVALID', 'Embedding response is too large');
  }
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      throw new CoreError('SEMANTIC_RESPONSE_INVALID', 'Embedding response is too large');
    }
    parts.push(Buffer.from(part));
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch {
    throw new CoreError('SEMANTIC_RESPONSE_INVALID', 'Embedding response must be JSON');
  }
}

async function embed(config, input, signal) {
  if (input.some((text) => typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > MAX_INPUT_BYTES)) {
    throw new CoreError('SEMANTIC_INPUT_TOO_LARGE', 'Embedding inputs must be bounded text');
  }
  // Official Ollama /api/embed accepts an input array and returns embeddings.
  // Never install/pull a model, send an API key, or follow an HTTP redirect.
  const response = await fetch(`${config.endpoint}/api/embed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model, input, truncate: false }),
    signal, redirect: 'error',
  });
  const body = await responseJson(response);
  if (!Array.isArray(body?.embeddings) || body.embeddings.length !== input.length) {
    throw new CoreError('SEMANTIC_RESPONSE_INVALID', 'Embedding response count does not match input');
  }
  const vectors = body.embeddings.map(vector);
  if (!vectors.every((item) => item.length === vectors[0].length)) {
    throw new CoreError('SEMANTIC_RESPONSE_INVALID', 'Embedding vector dimensions disagree');
  }
  return vectors;
}

function fallbackReason(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  if (error?.code === 'STATE_BUSY') return 'busy';
  if (error?.code === 'SEMANTIC_INPUT_TOO_LARGE') return 'input_too_large';
  if (error?.code === 'SEMANTIC_RESPONSE_INVALID') return 'invalid_response';
  if (error?.code === 'INVALID_SEMANTIC_CONFIG') return 'invalid_config';
  return 'provider_unavailable';
}

export async function searchSemanticIndex({ entries, query, env = process.env, limit = 100 } = {}) {
  if (!Array.isArray(entries) || typeof query !== 'string' || !query.trim()
    || query.includes('\0') || Buffer.byteLength(query) > MAX_INPUT_BYTES
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new CoreError('INVALID_KNOWLEDGE', 'Invalid semantic search query or limit');
  }
  // Loopback is still a separate process with its own logging/backend policy.
  // Explicit sensitive storage never authorizes forwarding a credential query.
  if (scanSensitive(query).length) {
    return { items: [], fallback: true, reason: 'sensitive_query' };
  }
  try {
    const config = await getSemanticSearchConfig({ env });
    if (!config.enabled) return { items: [], fallback: true, reason: 'disabled' };
    if (entries.length > MAX_ENTRIES) return { items: [], fallback: true, reason: 'index_capacity' };
    if (!entries.length) return { items: [], fallback: false, reason: null };
    return await withFileLock(path.join(statePaths(env).locks, 'semantic-search.lock'), async () => {
      const file = path.join(statePaths(env).cache, 'knowledge-vectors.json');
      const signature = createHash('sha256').update(JSON.stringify([config.endpoint, config.model])).digest('hex');
      let previous;
      try { previous = await readJson(file, { optional: true }); } catch { previous = null; }
      const saved = previous?.schemaVersion === 1 && previous.signature === signature
        && previous.entries && typeof previous.entries === 'object' ? previous.entries : {};
      const signal = AbortSignal.timeout(config.timeoutMs);
      const [queryVector] = await embed(config, [query], signal);
      const next = {};
      const missing = [];
      for (const entry of entries) {
        const digest = semanticContentDigest(entry);
        const cached = saved[entry.id];
        let cachedVector;
        if (cached?.digest === digest) {
          try { cachedVector = vector(cached.vector); } catch { cachedVector = null; }
        }
        if (cachedVector?.length === queryVector.length) next[entry.id] = { digest, vector: cachedVector };
        else missing.push(entry);
      }
      for (let offset = 0; offset < missing.length; offset += 16) {
        const batch = missing.slice(offset, offset + 16);
        const vectors = await embed(config, batch.map((entry) => `${entry.title}\n${entry.tags.join(' ')}\n${entry.body}`), signal);
        for (let index = 0; index < batch.length; index += 1) {
          if (vectors[index].length !== queryVector.length) {
            throw new CoreError('SEMANTIC_RESPONSE_INVALID', 'Document and query vector dimensions disagree');
          }
          next[batch[index].id] = { digest: semanticContentDigest(batch[index]), vector: vectors[index] };
        }
      }
      // Only the live candidate set is persisted; removed/excluded records
      // cannot be returned merely because an old embedding exists.
      await writeJsonAtomic(file, { schemaVersion: 1, signature, entries: next });
      const items = entries.map((entry) => ({
        id: entry.id,
        score: next[entry.id].vector.reduce((sum, part, index) => sum + part * queryVector[index], 0),
      })).filter((item) => item.score > 0.15)
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, limit);
      return { items, fallback: false, reason: null };
    }, { timeoutMs: 250, staleMs: 30_000 });
  } catch (error) {
    return { items: [], fallback: true, reason: fallbackReason(error) };
  }
}
