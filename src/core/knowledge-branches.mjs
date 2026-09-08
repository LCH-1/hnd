import { createHash } from 'node:crypto';

import { CoreError } from './errors.mjs';
import { isUuid } from './state.mjs';

export const EXPERIMENT_SOURCE_PREFIX = 'hnd:experiment:v1:';

export function isKnowledgeExperiment(entry) {
  return (entry.sources ?? []).some((source) => source.kind === 'import'
    && typeof source.ref === 'string' && source.ref.startsWith(EXPERIMENT_SOURCE_PREFIX));
}

export function knowledgeExperimentMetadata(entry) {
  const markers = (entry.sources ?? []).filter((source) => source.kind === 'import'
    && typeof source.ref === 'string' && source.ref.startsWith(EXPERIMENT_SOURCE_PREFIX));
  if (!markers.length) return null;
  let metadata;
  try {
    if (markers.length !== 1) throw new Error('Duplicate marker');
    const encoded = markers[0].ref.slice(EXPERIMENT_SOURCE_PREFIX.length);
    if (!/^[a-zA-Z0-9_-]+$/.test(encoded)) throw new Error('Invalid encoding');
    metadata = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new CoreError('INVALID_KNOWLEDGE_EXPERIMENT', 'Experimental knowledge metadata is invalid');
  }
  if (!metadata || Object.keys(metadata).some((key) => !['workId', 'name', 'baseId', 'baseDigest'].includes(key))
    || !isUuid(metadata.workId) || typeof metadata.name !== 'string' || !metadata.name.trim()
    || [...metadata.name].length > 80 || /[\0\r\n]/.test(metadata.name)
    || (metadata.baseId !== null && !isUuid(metadata.baseId))
    || (metadata.baseDigest !== null && !/^[a-f0-9]{64}$/.test(metadata.baseDigest))
    || (metadata.baseId === null) !== (metadata.baseDigest === null)) {
    throw new CoreError('INVALID_KNOWLEDGE_EXPERIMENT', 'Experimental knowledge metadata is invalid');
  }
  return metadata;
}

export function experimentSource(metadata) {
  const source = {
    kind: 'import',
    ref: `${EXPERIMENT_SOURCE_PREFIX}${Buffer.from(JSON.stringify(metadata)).toString('base64url')}`,
    label: `HND experiment: ${metadata.name}`, hash: null, commit: null,
  };
  knowledgeExperimentMetadata({ sources: [source] });
  return source;
}

export function knowledgeRevision(entry) {
  return createHash('sha256').update(JSON.stringify([
    entry.id, entry.title, entry.body, entry.tags, entry.scope, entry.repoId,
    entry.environment, entry.type, entry.state, entry.pinned, entry.sources,
    entry.relationships, entry.approval,
  ])).digest('hex');
}

export function adoptedKnowledgeId(experimentId) {
  const digest = createHash('sha256').update(`hnd-adopt\0${experimentId}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
