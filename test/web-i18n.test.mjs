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
  assert.equal(
    i18n.t('로그아웃 상태를 안전하게 반영하지 못했습니다. 페이지를 새로고침해 다시 시도해 주세요.'),
    'The signed-out state could not be applied safely. Reload the page and try again.',
  );
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

test('language selection works when browser storage access is denied', async () => {
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('storage denied', 'SecurityError');
      },
    });
    const isolated = await import(`../src/web/i18n.js?storage-denied=${Date.now()}`);
    assert.deepEqual(isolated.setLanguagePreference('ko'), {
      preference: 'ko',
      language: 'ko',
    });
  } finally {
    if (storageDescriptor === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  }
});
