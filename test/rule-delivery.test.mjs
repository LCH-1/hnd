import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CURSOR_LIVE_CONTEXT_SESSION_ENV,
  effectiveLiveContextRevision,
  liveContextSessionKey,
  recordLiveContextDelivery,
  renderLiveContextSnapshot,
} from '../src/core/live-context.mjs';

function composition(policy = 'RULE-A', checkpoint = 'CHECKPOINT-A') {
  return {
    repository: { id: '11111111-1111-4111-8111-111111111111' },
    environment: 'prod',
    layers: [
      {
        kind: 'policy',
        scope: 'global',
        content: policy,
        rendered: `## Global policy\n\n${policy}`,
      },
      {
        kind: 'checkpoint',
        scope: 'checkpoint',
        content: checkpoint,
        rendered: `## Checkpoint\n\n${checkpoint}`,
      },
    ],
  };
}

test('live context hashes every effective layer and emits one complete snapshot per revision', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-live-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { HND_HOME: path.join(root, '.hnd'), HND_USER_HOME: root };
  const payload = { session_id: 'session-a' };

  const initial = composition();
  const start = await recordLiveContextDelivery({
    agent: 'codex', payload, composition: initial, env, force: true,
  });
  assert.equal(start.changed, true);
  assert.match(start.content, /hnd live context/u);
  assert.match(start.content, /Live context revision: `[a-f0-9]{64}`/u);
  assert.match(start.content, /replaces earlier HND snapshots/u);
  assert.match(start.content, /active, mandatory instruction/u);
  assert.match(start.content, /do not inspect files, invoke tools or\s+skills/u);
  assert.match(start.content, /RULE-A/u);
  assert.match(start.content, /CHECKPOINT-A/u);

  const unchanged = await recordLiveContextDelivery({
    agent: 'codex', payload, composition: composition('RULE-A', 'CHECKPOINT-A'), env,
  });
  assert.equal(unchanged.changed, false);
  assert.equal(
    effectiveLiveContextRevision(initial),
    effectiveLiveContextRevision(composition('RULE-A', 'CHECKPOINT-A')),
  );

  const resumed = await recordLiveContextDelivery({
    agent: 'codex',
    payload,
    composition: composition('RULE-A', 'CHECKPOINT-A'),
    env,
    force: true,
  });
  assert.equal(resumed.changed, true);
  assert.equal(resumed.revision, unchanged.revision);
  assert.match(resumed.content, /RULE-A/u);
  assert.match(resumed.content, /CHECKPOINT-A/u);

  const checkpointChanged = await recordLiveContextDelivery({
    agent: 'codex', payload, composition: composition('RULE-A', 'CHECKPOINT-B'), env,
  });
  assert.equal(checkpointChanged.changed, true);
  assert.match(checkpointChanged.content, /RULE-A/u);
  assert.match(checkpointChanged.content, /CHECKPOINT-B/u);
  assert.doesNotMatch(checkpointChanged.content, /CHECKPOINT-A/u);

  const policyChanged = await recordLiveContextDelivery({
    agent: 'codex', payload, composition: composition('RULE-B', 'CHECKPOINT-B'), env,
  });
  assert.equal(policyChanged.changed, true);
  assert.match(policyChanged.content, /RULE-B/u);
  assert.match(policyChanged.content, /CHECKPOINT-B/u);
  assert.doesNotMatch(policyChanged.content, /RULE-A/u);

  const nextSession = await recordLiveContextDelivery({
    agent: 'codex', payload: { session_id: 'session-b' }, composition: composition('RULE-B'), env,
  });
  assert.equal(nextSession.changed, true);
});

test('empty snapshots revoke earlier HND state and Cursor carries its live session key', async () => {
  const empty = {
    repository: { id: '11111111-1111-4111-8111-111111111111' },
    environment: 'prod',
    layers: [],
  };
  assert.match(renderLiveContextSnapshot(empty), /hnd live context/u);
  assert.doesNotMatch(renderLiveContextSnapshot(empty), /RULE-|CHECKPOINT-/u);

  const key = liveContextSessionKey('cursor', { session_id: 'cursor-session' }, {});
  assert.match(key, /^[a-f0-9]{64}$/u);
  assert.equal(
    liveContextSessionKey('cursor', {}, { [CURSOR_LIVE_CONTEXT_SESSION_ENV]: key }),
    key,
  );
});
