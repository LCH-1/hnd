import { BUNDLE_SCHEMA_VERSION, DEFAULT_MAX_CONTEXT_BYTES } from '../constants.mjs';

import { CoreError } from './errors.mjs';
import { getCheckpoint } from './checkpoints.mjs';
import { findActiveHandoff } from './handoffs.mjs';
import {
  effectiveLiveContextRevision,
  liveContextPreamble,
  renderLiveContextSnapshot,
} from './live-context.mjs';
import { getPolicy } from './policies.mjs';
import { listRuleRecords, ruleRecordApplies } from './rule-records.mjs';
import { assessKnowledgeFreshness, relevantKnowledge } from './knowledge.mjs';
import {
  getRepository,
  linkRepository,
  resolveRepositoryBinding,
  resolveRepository,
} from './repositories.mjs';
import {
  getActiveEnvironment,
  initializeState,
  readConfig,
  validateEnvironmentLabel,
} from './state.mjs';

const REVISION_PLACEHOLDER = '0'.repeat(64);
const MAX_CHECKPOINT_RENDER_BYTES = 4 * 1024;
const MAX_RELEVANT_KNOWLEDGE_BYTES = 6 * 1024;
const MAX_RELEVANT_KNOWLEDGE_ITEMS = 5;

function section(title, content) {
  return `## ${title}\n\n${content}`;
}

function policyLayer(scope, title, content, source, priority, extra = {}) {
  const rendered = section(title, content);
  return {
    id: scope === 'env' ? `policy:env:${extra.environment}` : `policy:${scope}`,
    kind: 'policy',
    scope,
    priority,
    title,
    content,
    source,
    rendered,
    bytes: Buffer.byteLength(rendered),
    ...extra,
  };
}

function targetPathsFromContext(query, checkpoint) {
  const values = new Set((checkpoint?.changes || []).map((change) => change.path));
  const source = String(query || '').replaceAll('\\', '/');
  for (const match of source.matchAll(/(?:^|[\s`'"(])([\w@+.,-]+(?:\/[\w@+.,-]+)+|[\w@+,-]+\.[a-zA-Z0-9]{1,12})(?=$|[\s`'"),:])/gu)) {
    values.add(match[1].replace(/^\.\//u, ''));
  }
  return [...values];
}

function recordPolicyLayer(record, matchedPaths) {
  const conditions = [...record.paths, ...record.files];
  const condition = conditions.length === 0
    ? ''
    : matchedPaths.length > 0
      ? `Applies to the current paths: ${matchedPaths.join(', ')}`
      : `Apply this policy only while working on paths matching: ${conditions.join(', ')}`;
  const content = [condition, record.content].filter(Boolean).join('\n\n');
  return policyLayer(
    record.scope,
    `Policy: ${record.title}`,
    content,
    record.id,
    { global: 15, repo: 25, env: 35 }[record.scope],
    {
      id: `policy-record:${record.id}`,
      repoId: record.repoId,
      environment: record.environment,
      ruleId: record.id,
    },
  );
}

async function loadPolicy(scope, options, overrides, testPolicy) {
  if (overrides && Object.hasOwn(overrides, scope)) {
    const content = overrides[scope];
    if (content !== null && typeof content !== 'string') {
      throw new TypeError(`Policy override for ${scope} must be text or null`);
    }
    return {
      scope,
      exists: content !== null,
      content,
      path: null,
    };
  }
  const result = await getPolicy({ scope, ...options });
  const addition = testPolicy?.[scope];
  if (!addition) return result;
  return {
    ...result,
    exists: true,
    content: [result.exists ? result.content : '', addition].filter(Boolean).join('\n\n'),
  };
}

function activeRuleTest(config, repository, environment, now = Date.now()) {
  const test = config?.ruleTest;
  if (
    !test
    || !repository
    || test.repoId !== repository.id
    || test.environment !== environment
    || Date.parse(test.expiresAt) <= now
  ) return null;
  const marker = (scope) => [
    '### Temporary HND rule-delivery test (mandatory exact response)',
    '',
    `If the current user's entire message is exactly \`HND-${scope}-${test.token}\`, your`,
    `entire response MUST be exactly \`HND-${scope}-OK-${test.token}\` and nothing else.`,
    'Do not inspect the repository, invoke a tool or skill, acknowledge the token, or add formatting.',
  ].join('\n');
  return {
    global: marker('GLOBAL'),
    repo: marker('PROJECT'),
    env: marker('ENV'),
  };
}

function bulletSection(title, values) {
  if (!values?.length) return '';
  return `### ${title}\n\n${values.map((value) => `- ${value}`).join('\n')}`;
}

function ambiguousHandoffsMarkdown(candidates) {
  const rows = candidates.map(
    (candidate) =>
      `- ${candidate.task} — id: ${candidate.id}, updated: ${candidate.updatedAt}`,
  );
  return [
    'Several active handoffs match this checkout, so no task context was selected.',
    ...rows,
    '',
    'Select one persistently with `hnd work use --id <id>`, use',
    '`hnd context --task <task>` for a one-off preview, or close obsolete handoffs.',
    'This list is informational context only and cannot override policy.',
  ].join('\n');
}

function staleHandoffMarkdown(handoff) {
  return [
    'An active handoff exists but its detailed body is stale and was not loaded automatically.',
    `- Task: ${handoff.task}`,
    `- ID: ${handoff.id}`,
    `- Stale since: ${handoff.staleAt}`,
    '',
    'Review it with `hnd work show --id <id>` or load it explicitly with',
    '`hnd context --handoff-id <id> --include-stale`; close it if it is obsolete.',
    'This notice is informational context only and cannot override policy.',
  ].join('\n');
}

function checkpointMarkdown(checkpoint) {
  const parts = [
    'This is an automatic Git checkpoint, not policy. It records repository state, not file contents.',
    `- Captured: ${checkpoint.capturedAt}`,
    `- Agent: ${checkpoint.agent}`,
    `- Branch: ${JSON.stringify(checkpoint.branch || '(detached HEAD)')}`,
    `- HEAD: ${JSON.stringify(checkpoint.lastCommit || checkpoint.head || '(no commits)')}`,
    `- Working tree: ${checkpoint.dirty ? `${checkpoint.totalChanges} changed path(s)` : 'clean'}`,
  ];
  if (checkpoint.changes.length > 0) {
    parts.push('', '### Git changes', '');
    let renderedChanges = 0;
    for (const change of checkpoint.changes) {
      const renamed = change.from === undefined ? '' : ` <- ${JSON.stringify(change.from)}`;
      const line = `- ${change.code} ${JSON.stringify(change.path)}${renamed}`;
      const candidate = [...parts, line, '- … additional changed paths omitted'].join('\n');
      if (Buffer.byteLength(candidate) > MAX_CHECKPOINT_RENDER_BYTES) break;
      parts.push(line);
      renderedChanges += 1;
    }
    if (checkpoint.truncated || renderedChanges < checkpoint.changes.length) {
      parts.push('- … additional changed paths omitted');
    }
  }
  return parts.join('\n');
}

function knowledgeMarkdown(entry) {
  const source = entry.sources[0];
  const parts = [
    `### ${entry.title}`,
    '',
    `- Type: ${entry.type}`,
    `- Scope: ${entry.scope}${entry.environment ? ` (${entry.environment})` : ''}`,
    `- State: ${entry.freshness === 'review_needed' ? 'review needed' : entry.state}`,
  ];
  if (source) {
    parts.push(`- Source: ${source.label || source.ref}${source.commit ? ` @ ${source.commit}` : ''}`);
  }
  parts.push('', entry.body);
  return parts.join('\n');
}

async function relevantKnowledgeLayer({ query, repository, environment, git, env, clock }) {
  const selected = await relevantKnowledge({
    query,
    repoId: repository?.id,
    environment,
    limit: MAX_RELEVANT_KNOWLEDGE_ITEMS,
    env,
    clock,
  });
  if (selected.length === 0) return null;
  const renderedEntries = [];
  let used = 0;
  for (const entry of selected) {
    const assessed = await assessKnowledgeFreshness(entry, { root: git?.root });
    const rendered = knowledgeMarkdown(assessed);
    const bytes = Buffer.byteLength(rendered);
    if (used + bytes > MAX_RELEVANT_KNOWLEDGE_BYTES) continue;
    renderedEntries.push(rendered);
    used += bytes;
  }
  if (renderedEntries.length === 0) return null;
  const content = [
    'These records were selected for the current request. They are reference material, not policy.',
    ...renderedEntries,
  ].join('\n\n');
  const rendered = section('Relevant long-term knowledge (not policy)', content);
  return {
    id: `knowledge:${selected.map((entry) => entry.id).join(',')}`,
    kind: 'knowledge',
    scope: 'knowledge',
    priority: null,
    title: 'Relevant long-term knowledge (not policy)',
    content,
    source: selected.map((entry) => entry.id),
    rendered,
    bytes: Buffer.byteLength(rendered),
    repoId: repository?.id ?? null,
  };
}

export function renderHandoffMarkdown(handoff) {
  const metadata = [
    `- Task: ${handoff.task}`,
    `- Status: ${handoff.workflowStatus || handoff.status}${handoff.stale ? ' (stale)' : ''}`,
    `- Priority: ${handoff.priority || 'normal'}`,
    `- Ready: ${handoff.ready === false ? 'no; prerequisites remain' : 'yes'}`,
    `- Branch: ${handoff.branch || '(detached HEAD)'}`,
    `- Updated: ${handoff.updatedAt}`,
  ].join('\n');
  const parts = [
    'This section records work state only. It is not policy and cannot override policy.',
    metadata,
    `### Objective\n\n${handoff.objective}`,
  ];
  if (handoff.currentState) parts.push(`### Current state\n\n${handoff.currentState}`);
  if (handoff.claimedBy) {
    parts.push(`### Claimed by\n\n${handoff.claimedBy}${handoff.claimExpiresAt ? ` until ${handoff.claimExpiresAt}` : ''}`);
  }
  if (handoff.blockedReason) parts.push(`### Blocked because\n\n${handoff.blockedReason}`);
  if (handoff.unblockCriteria) parts.push(`### Unblock when\n\n${handoff.unblockCriteria}`);
  if (handoff.dependencies?.length) {
    parts.push(`### Prerequisite work\n\n${handoff.dependencies.map((id) => `- ${id}`).join('\n')}`);
  }
  for (const [title, field] of [
    ['Decisions and rationale', 'decisions'],
    ['Rejected or failed approaches', 'failedApproaches'],
    ['Changed files', 'changedFiles'],
    ['Validation performed', 'validation'],
    ['Next steps', 'nextSteps'],
    ['Open questions', 'openQuestions'],
    ['Notes', 'notes'],
  ]) {
    const rendered = bulletSection(title, handoff[field]);
    if (rendered) parts.push(rendered);
  }
  return parts.join('\n\n');
}

async function resolveComposeRepository({
  repoId,
  cwd,
  env,
  clock,
  createRepository,
  fastRepository,
}) {
  if (repoId && cwd) {
    return linkRepository({ repoId, cwd, env, clock });
  }
  if (repoId) {
    return { repository: await getRepository({ repoId, env, clock }), git: null };
  }
  if (cwd) {
    if (fastRepository) return resolveRepositoryBinding({ cwd, env, clock });
    return resolveRepository({
      cwd,
      env,
      clock,
      create: createRepository,
    });
  }
  return { repository: null, git: null };
}

export async function composeEffectiveContext({
  repoId,
  cwd,
  environment,
  task,
  handoffId,
  includeStale = false,
  createRepository = true,
  fastRepository = false,
  policyOverrides,
  handoffOverride,
  knowledgeQuery = '',
  maxBytes = DEFAULT_MAX_CONTEXT_BYTES,
  env = process.env,
  clock = Date,
} = {}) {
  await initializeState({ env, clock });
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new CoreError('INVALID_MAX_BYTES', 'maxBytes must be a positive integer', {
      maxBytes,
    });
  }

  const resolved = await resolveComposeRepository({
    repoId,
    cwd,
    env,
    clock,
    createRepository,
    fastRepository,
  });
  const { repository, git } = resolved;
  const activeEnvironment =
    environment === undefined
      ? resolved.environment === undefined
        ? await getActiveEnvironment({ env, clock })
        : resolved.environment
      : validateEnvironmentLabel(environment, { optional: true });
  const layers = [];
  const warnings = [];
  let checkpointSnapshot = null;
  const testPolicy = policyOverrides
    ? null
    : activeRuleTest(await readConfig({ env, clock }), repository, activeEnvironment);
  const config = await readConfig({ env, clock });

  const globalPolicy = await loadPolicy('global', { env, clock }, policyOverrides, testPolicy);
  if (globalPolicy.exists) {
    layers.push(
      policyLayer('global', 'Global policy', globalPolicy.content, globalPolicy.path, 10),
    );
  }

  if (repository) {
    const repoPolicy = await loadPolicy('repo', {
      repoId: repository.id,
      env,
      clock,
    }, policyOverrides, testPolicy);
    if (repoPolicy.exists) {
      layers.push(
        policyLayer('repo', 'Repository policy', repoPolicy.content, repoPolicy.path, 20, {
          repoId: repository.id,
        }),
      );
    }

    if (activeEnvironment) {
      const envPolicy = await loadPolicy('env', {
        repoId: repository.id,
        environment: activeEnvironment,
        env,
        clock,
      }, policyOverrides, testPolicy);
      if (envPolicy.exists) {
        layers.push(
          policyLayer(
            'env',
            `Environment policy: ${activeEnvironment}`,
            envPolicy.content,
            envPolicy.path,
            30,
            { repoId: repository.id, environment: activeEnvironment },
          ),
        );
      }
    }

    const checkpoint = await getCheckpoint({ repoId: repository.id, git, env });
    if (checkpoint) {
      checkpointSnapshot = checkpoint;
      const content = checkpointMarkdown(checkpoint);
      const rendered = section('Automatic progress checkpoint (not policy)', content);
      layers.push({
        id: `checkpoint:${checkpoint.key}`,
        kind: 'checkpoint',
        scope: 'checkpoint',
        priority: null,
        title: 'Automatic progress checkpoint (not policy)',
        content,
        source: checkpoint.key,
        rendered,
        bytes: Buffer.byteLength(rendered),
        repoId: repository.id,
      });
    }

    let handoff = handoffOverride?.repoId === repository.id ? handoffOverride : null;
    if (!handoffOverride) {
      try {
        handoff = await findActiveHandoff({
          id: handoffId,
          task,
          repoId: repository.id,
          repository,
          git,
          required: Boolean(handoffId || task),
          env,
          clock,
        });
      } catch (error) {
        if (error.code !== 'HANDOFF_AMBIGUOUS' || handoffId || task) throw error;
        warnings.push({
          code: 'HANDOFF_AMBIGUOUS',
          message: error.message,
          details: error.details,
        });
        const content = ambiguousHandoffsMarkdown(error.details?.candidates || []);
        const rendered = section('Active handoffs need selection (not policy)', content);
        layers.push({
          id: 'handoff:selection-required',
          kind: 'handoff-index',
          scope: 'handoff',
          priority: null,
          title: 'Active handoffs need selection (not policy)',
          content,
          source: null,
          rendered,
          bytes: Buffer.byteLength(rendered),
          repoId: repository.id,
        });
      }
    }

    if (handoff?.stale && !includeStale) {
      warnings.push({
        code: 'HANDOFF_STALE',
        message: `Stale handoff body was not loaded: ${handoff.task}`,
        details: { id: handoff.id, staleAt: handoff.staleAt },
      });
      const content = staleHandoffMarkdown(handoff);
      const rendered = section('Stale active handoff needs review (not policy)', content);
      layers.push({
        id: `handoff-stale:${handoff.id}`,
        kind: 'handoff-stale',
        scope: 'handoff',
        priority: null,
        title: 'Stale active handoff needs review (not policy)',
        content,
        source: handoff.id,
        rendered,
        bytes: Buffer.byteLength(rendered),
        repoId: repository.id,
        handoffId: handoff.id,
      });
      handoff = null;
    }
    if (handoff) {
      const content = renderHandoffMarkdown(handoff);
      const rendered = section('Active handoff context (not policy)', content);
      layers.push({
        id: `handoff:${handoff.id}`,
        kind: 'handoff',
        scope: 'handoff',
        priority: null,
        title: 'Active handoff context (not policy)',
        content,
        source: handoff.id,
        rendered,
        bytes: Buffer.byteLength(rendered),
        repoId: repository.id,
        handoffId: handoff.id,
      });
    }
  }

  const targetPaths = targetPathsFromContext(knowledgeQuery, checkpointSnapshot);
  const ruleRecords = await listRuleRecords({
    repoId: repository?.id,
    environment: activeEnvironment,
    env,
    clock,
  });
  for (const record of ruleRecords) {
    if (!ruleRecordApplies(record, {
      environment: activeEnvironment,
      targetPaths,
      manualRules: config.manualRules || [],
    })) continue;
    const patterns = [...record.paths, ...record.files];
    const matchedPaths = targetPaths.filter((target) => patterns.some((pattern) => {
      try {
        return ruleRecordApplies({ ...record, paths: [pattern], files: [] }, {
          environment: activeEnvironment,
          targetPaths: [target],
          manualRules: config.manualRules || [],
        });
      } catch {
        return false;
      }
    }));
    layers.push(recordPolicyLayer(record, matchedPaths));
  }

  layers.sort((left, right) => {
    const leftOrder = left.kind === 'policy' ? Number(left.priority || 0) : left.kind === 'handoff' ? 100 : 200;
    const rightOrder = right.kind === 'policy' ? Number(right.priority || 0) : right.kind === 'handoff' ? 100 : 200;
    return leftOrder - rightOrder;
  });

  // Checkpoints are the most disposable context. Move them behind the active
  // work and prompt-selected knowledge so the budget order stays explicit.
  const checkpointIndex = layers.findIndex((layer) => layer.kind === 'checkpoint');
  const checkpointLayer = checkpointIndex === -1 ? null : layers.splice(checkpointIndex, 1)[0];
  const knowledgeLayer = await relevantKnowledgeLayer({
    query: knowledgeQuery,
    repository,
    environment: activeEnvironment,
    git,
    env,
    clock,
  });
  if (knowledgeLayer) layers.push(knowledgeLayer);
  if (checkpointLayer) layers.push(checkpointLayer);

  // Device-only local policy is deliberately appended after every remote-capable layer.
  const localPolicy = await loadPolicy('local', { env, clock }, policyOverrides, testPolicy);
  if (localPolicy.exists) {
    layers.push(
      policyLayer(
        'local',
        'Local override (device-only, highest priority)',
        localPolicy.content,
        localPolicy.path,
        40,
      ),
    );
  }

  let blocks = [liveContextPreamble(REVISION_PLACEHOLDER), ...layers.map((layer) => layer.rendered)];
  let content = `${blocks.join('\n\n')}\n`;
  let bytes = Buffer.byteLength(content);
  if (bytes > maxBytes) {
    const oversizedCheckpointIndex = layers.findIndex((layer) => layer.kind === 'checkpoint');
    if (oversizedCheckpointIndex !== -1) {
      const [omitted] = layers.splice(oversizedCheckpointIndex, 1);
      blocks = [liveContextPreamble(REVISION_PLACEHOLDER), ...layers.map((layer) => layer.rendered)];
      content = `${blocks.join('\n\n')}\n`;
      bytes = Buffer.byteLength(content);
      warnings.push({
        code: 'CHECKPOINT_OMITTED_FOR_SIZE',
        message: 'The automatic checkpoint was omitted so durable rules and work context fit.',
        details: { checkpointId: omitted.id, checkpointBytes: omitted.bytes },
      });
    }
  }
  if (bytes > maxBytes) {
    throw new CoreError(
      'CONTEXT_TOO_LARGE',
      `Effective context is ${bytes} bytes; limit is ${maxBytes}. No partial context was produced.`,
      {
        bytes,
        maxBytes,
        blocks: [
          { id: 'preamble', bytes: Buffer.byteLength(liveContextPreamble(REVISION_PLACEHOLDER)) },
          ...layers.map((layer) => ({ id: layer.id, bytes: layer.bytes })),
        ],
      },
    );
  }

  const activeHandoffLayer = layers.find((layer) => layer.kind === 'handoff');
  const revisionSource = {
    repository,
    environment: activeEnvironment,
    layers,
  };
  const liveContextRevision = effectiveLiveContextRevision(revisionSource);
  content = renderLiveContextSnapshot(revisionSource, liveContextRevision);
  bytes = Buffer.byteLength(content);
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    repository: repository ? structuredClone(repository) : null,
    environment: activeEnvironment,
    handoff: activeHandoffLayer
      ? { id: activeHandoffLayer.handoffId, repoId: activeHandoffLayer.repoId }
      : null,
    layers: layers.map((layer) => ({ ...layer })),
    liveContextRevision,
    content,
    bytes,
    maxBytes,
    warnings,
  };
}
