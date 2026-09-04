import { createHash } from 'node:crypto';

export function createStrongEtag(contents) {
  const digest = createHash('sha256').update(contents).digest('hex');
  return `"${digest}"`;
}

export function parseEntityTags(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Invalid empty ETag condition');
  }
  const trimmed = value.trim();
  if (trimmed === '*') return Object.freeze({ wildcard: true, tags: [] });

  const tags = trimmed.split(',').map((part) => {
    const candidate = part.trim();
    const match = /^(W\/)?"([!#-~\x80-\xff]*)"$/.exec(candidate);
    if (!match) throw new Error('Invalid ETag condition');
    return Object.freeze({ weak: Boolean(match[1]), value: `"${match[2]}"` });
  });
  if (tags.length === 0) throw new Error('Invalid ETag condition');
  return Object.freeze({ wildcard: false, tags });
}

export function strongEtagMatches(condition, currentEtag, exists = true) {
  const parsed = typeof condition === 'string' ? parseEntityTags(condition) : condition;
  if (parsed.wildcard) return exists;
  return parsed.tags.some((tag) => !tag.weak && tag.value === currentEtag);
}

export function weakEtagMatches(condition, currentEtag, exists = true) {
  const parsed = typeof condition === 'string' ? parseEntityTags(condition) : condition;
  if (parsed.wildcard) return exists;
  return parsed.tags.some((tag) => tag.value === currentEtag);
}
