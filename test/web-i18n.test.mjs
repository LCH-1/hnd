import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => 'en',
    setItem: () => {},
  },
});

const i18n = await import('../src/web/i18n.js');

function visibleKoreanStrings(source) {
  const text = [...source.matchAll(/>([^<>]*[가-힣][^<>]*)</gu)]
    .map((match) => match[1].replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  const attributes = [...source.matchAll(/(?:placeholder|aria-label|title)="([^"]*[가-힣][^"]*)"/gu)]
    .map((match) => match[1].replace(/\s+/gu, ' ').trim());
  return [...new Set([...text, ...attributes])];
}

test('browser language normalization accepts common aliases', () => {
  assert.equal(i18n.normalizePreference('kr'), 'ko');
  assert.equal(i18n.normalizePreference('ko-KR'), 'ko');
  assert.equal(i18n.normalizePreference('en-US'), 'en');
  assert.equal(i18n.normalizePreference('auto'), 'auto');
  assert.equal(i18n.normalizePreference('fr'), null);
});

test('every visible Korean shell string has an English translation', async () => {
  for (const file of ['index.html', 'setup.html', 'app.html']) {
    const source = await fs.readFile(new URL(`../src/web/${file}`, import.meta.url), 'utf8');
    const missing = visibleKoreanStrings(source)
      .filter((value) => value !== '한국어')
      .filter((value) => i18n.t(value) === value);
    assert.deepEqual(missing, [], file);
  }
});
