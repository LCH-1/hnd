import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { addKnowledge, removeKnowledge, searchKnowledge, searchKnowledgeDetailed, updateKnowledge } from '../src/core/knowledge.mjs';
import { configureSemanticSearch, getSemanticSearchConfig } from '../src/core/semantic-search.mjs';
import { captureSyncSnapshot } from '../src/sync/capture.mjs';

async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-semantic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HND_HOME: path.join(root, 'state'), HND_USER_HOME: root };
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    requests.push({ path: request.url, method: request.method, headers: request.headers, body });
    if (handler && await handler(body, response)) return;
    const embeddings = body.input.map((text) => /로그인|인증|자격/.test(text) ? [1, 0, 0] : [0, 1, 0]);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: body.model, embeddings }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return { env, endpoint, requests };
}

test('semantic search is opt-in and uses real vector cosine ranking for Korean paraphrases', async (t) => {
  const { env, endpoint, requests } = await fixture(t);
  const desired = await addKnowledge({ env, title: '인증 갱신 전략', body: '접속 자격이 만료되면 토큰을 재발급한다.' });
  await addKnowledge({ env, title: '백업 주기', body: '자료를 외장 디스크에 보관한다.' });
  const query = '로그인이 끊어지면 어떻게 복원해?';
  assert.deepEqual(await searchKnowledge({ env, query }), []);
  const disabled = await searchKnowledgeDetailed({ env, query, mode: 'semantic' });
  assert.equal(disabled.fallback, true);
  assert.equal(disabled.reason, 'disabled');
  assert.equal(requests.length, 0);
  await configureSemanticSearch({ env, enabled: true, endpoint, model: 'test-embedding' });
  const result = await searchKnowledgeDetailed({ env, query, mode: 'semantic' });
  assert.equal(result.mode, 'semantic');
  assert.equal(result.fallback, false);
  assert.deepEqual(result.items.map((item) => item.id), [desired.id]);
  assert.equal(result.items[0].score, 1);
  assert.ok(requests.every((item) => item.path === '/api/embed' && item.method === 'POST'
    && item.headers.authorization === undefined && item.body.truncate === false));
  const hybrid = await searchKnowledgeDetailed({ env, query: '백업', mode: 'hybrid' });
  assert.equal(hybrid.items[0].title, '백업 주기');
  assert.equal(hybrid.mode, 'hybrid');
});

test('vector cache refreshes content and model changes and never returns deleted records', async (t) => {
  const { env, endpoint, requests } = await fixture(t);
  const clock = () => new Date('2026-09-07T00:00:00Z');
  const note = await addKnowledge({ env, clock, title: '인증', body: 'first version' });
  await configureSemanticSearch({ env, enabled: true, endpoint, model: 'embedding-one' });
  const options = { env, query: '로그인 복원', mode: 'semantic' };
  await searchKnowledgeDetailed(options);
  const firstCount = requests.length;
  await searchKnowledgeDetailed(options);
  assert.equal(requests.length, firstCount + 1, 'unchanged documents reuse embeddings; only query is embedded');
  await updateKnowledge({ env, clock, id: note.id, body: 'second version' });
  await searchKnowledgeDetailed(options);
  assert.ok(requests.at(-1).body.input[0].includes('second version'));
  await configureSemanticSearch({ env, model: 'embedding-two' });
  await searchKnowledgeDetailed(options);
  assert.ok(requests.slice(-2).every((item) => item.body.model === 'embedding-two'));
  await removeKnowledge({ env, id: note.id });
  const deleted = await searchKnowledgeDetailed(options);
  assert.deepEqual(deleted.items, []);
  const snapshot = await captureSyncSnapshot(env.HND_HOME);
  assert.ok(snapshot.files.every((file) => !file.path.includes('vector') && !file.path.includes('semantic-search')));
});

test('embedding network work does not hold knowledge locks and rechecks concurrent deletion', async (t) => {
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const { env, endpoint } = await fixture(t, async (body) => {
    if (body.input[0] === '로그인') { entered(); await gate; }
    return false;
  });
  const note = await addKnowledge({ env, title: '인증', body: 'credentials' });
  await configureSemanticSearch({ env, enabled: true, endpoint });
  const pending = searchKnowledgeDetailed({ env, query: '로그인', mode: 'semantic' });
  await started;
  await removeKnowledge({ env, id: note.id });
  release();
  assert.deepEqual((await pending).items, []);
});

test('provider timeout, invalid vectors, and oversized responses produce explicit FTS fallback', async (t) => {
  for (const failure of ['timeout', 'invalid_response', 'oversized']) {
    await t.test(failure, async (t) => {
      const { env, endpoint } = await fixture(t, async (body, response) => {
        if (failure === 'timeout') return true;
        if (failure === 'oversized') {
          response.writeHead(200, { 'content-length': 3 * 1024 * 1024 });
          response.end('{}');
        } else response.end(JSON.stringify({ embeddings: [[0, 0]] }));
        return true;
      });
      const note = await addKnowledge({ env, title: 'backup', body: 'restore procedure' });
      await configureSemanticSearch({ env, enabled: true, endpoint, timeoutMs: 50 });
      const result = await searchKnowledgeDetailed({ env, query: 'backup', mode: 'semantic' });
      assert.equal(result.mode, 'keyword');
      assert.equal(result.fallback, true);
      assert.equal(result.reason, failure === 'timeout' ? 'timeout' : 'invalid_response');
      assert.deepEqual(result.items.map((item) => item.id), [note.id]);
    });
  }
});

test('configuration rejects external origins, credentials, paths, cloud models, and invalid bounds', async (t) => {
  const { env } = await fixture(t);
  for (const patch of [
    { endpoint: 'https://example.com' }, { endpoint: 'http://user:secret@127.0.0.1:11434' },
    { endpoint: 'http://127.0.0.1:11434/proxy' }, { endpoint: 'http://127.0.0.1:11434?token=secret' },
    { model: 'model:cloud' }, { timeoutMs: 0 }, { enabled: 'yes' },
  ]) {
    await assert.rejects(configureSemanticSearch({ env, ...patch }), { code: 'INVALID_SEMANTIC_CONFIG' });
  }
  assert.equal((await getSemanticSearchConfig({ env })).enabled, false);
  await assert.rejects(searchKnowledgeDetailed({ env, query: 'query', mode: 'semantic', limit: -1 }), { code: 'INVALID_KNOWLEDGE' });
});

test('legacy sensitive records are excluded from keyword and semantic provider inputs', async (t) => {
  const { env, endpoint, requests } = await fixture(t);
  const token = `ghp_${'a'.repeat(30)}`;
  await assert.rejects(addKnowledge({ env, title: 'credentials', body: token }), { code: 'SENSITIVE_CONTENT' });
  await addKnowledge({ env, title: 'credentials', body: token, allowSensitive: true });
  assert.deepEqual(await searchKnowledge({ env, query: 'credentials' }), []);
  await configureSemanticSearch({ env, enabled: true, endpoint });
  assert.deepEqual((await searchKnowledgeDetailed({ env, query: 'credentials', mode: 'semantic' })).items, []);
  assert.equal(requests.length, 0);
});

test('credential-bearing queries never reach the local provider or result diagnostics', async (t) => {
  const { env, endpoint, requests } = await fixture(t);
  await addKnowledge({ env, title: 'login recovery', body: 'Rotate credentials through the account settings.' });
  await configureSemanticSearch({ env, enabled: true, endpoint });
  for (const mode of ['semantic', 'hybrid']) {
    const syntheticToken = `ghp_${'SyntheticOnly'.repeat(3)}`;
    const query = `login ${syntheticToken}`;
    const result = await searchKnowledgeDetailed({ env, query, mode });
    assert.equal(result.requestedMode, mode);
    assert.equal(result.mode, 'keyword');
    assert.equal(result.fallback, true);
    assert.equal(result.reason, 'sensitive_query');
    assert.deepEqual(result.items, await searchKnowledge({ env, query }));
    assert.equal(JSON.stringify(result).includes(syntheticToken), false);
    assert.equal(JSON.stringify(result).includes(query), false);
  }
  assert.deepEqual(requests, [], 'no HTTP request or provider request-log entry may contain the query');
});
