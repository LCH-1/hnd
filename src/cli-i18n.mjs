import fs from 'node:fs/promises';

import { statePaths } from './paths.mjs';
import { updateConfig } from './core/state.mjs';

const LANGUAGE_ALIASES = Object.freeze({
  auto: 'auto',
  ko: 'ko',
  kr: 'ko',
  'ko-kr': 'ko',
  korean: 'ko',
  en: 'en',
  'en-us': 'en',
  'en-gb': 'en',
  english: 'en',
});

let activeLanguage = 'en';

export function normalizeLanguage(value, { allowAuto = true } = {}) {
  const normalized = LANGUAGE_ALIASES[String(value ?? '').trim().toLowerCase()] ?? null;
  if (!normalized || (!allowAuto && normalized === 'auto')) return null;
  return normalized;
}

export function detectOsLanguage(env = process.env) {
  const candidates = [
    env.LC_ALL,
    env.LC_MESSAGES,
    env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale,
  ];
  return candidates.some((value) => /^ko(?:[_-]|$)/i.test(String(value ?? ''))) ? 'ko' : 'en';
}

export async function languageState(env = process.env) {
  let preference = 'auto';
  try {
    const value = JSON.parse(await fs.readFile(statePaths(env).config, 'utf8'));
    preference = normalizeLanguage(value?.language) ?? 'auto';
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error?.code) && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  return {
    preference,
    language: preference === 'auto' ? detectOsLanguage(env) : preference,
    source: preference === 'auto' ? 'os' : 'setting',
  };
}

export async function useCliLanguage(env = process.env) {
  const state = await languageState(env);
  activeLanguage = state.language;
  return state;
}

export function cliLanguage() {
  return activeLanguage;
}

export async function saveLanguagePreference(preference, env = process.env) {
  const normalized = normalizeLanguage(preference);
  if (!normalized) {
    const error = new Error('Language must be auto, ko, or en.');
    error.code = 'INVALID_LANGUAGE';
    throw error;
  }
  await updateConfig({ language: normalized }, { env });
  return useCliLanguage(env);
}

const EN = Object.freeze({
  '도움말 주제를 찾을 수 없습니다': 'Help topic not found',
  '사용 가능': 'Available',
  '저장소': 'Repository',
  '환경': 'Environment',
  '선택 안 됨': 'not selected',
  '진행 자동 저장': 'Automatic progress',
  '자동 동기화': 'Automatic sync',
  '켜짐': 'on',
  '꺼짐': 'off',
  'PC를 연결한 뒤 시작': 'starts after this PC is connected',
  'HND 계정 연결': 'HND account',
  '완료': 'connected',
  '안 됨': 'not connected',
  '진행 중 작업': 'Active work',
  '다음 단계': 'Next step',
  '언어 설정': 'Language preference',
  '현재 언어': 'Current language',
  '자동 (OS 언어)': 'automatic (OS language)',
  '설정': 'setting',
  '언어 설정을 자동으로 변경했습니다.': 'Language now follows the OS.',
  '언어를 한국어로 변경했습니다.': 'Language changed to Korean.',
  '언어를 영어로 변경했습니다.': 'Language changed to English.',
});

export function ct(korean) {
  return activeLanguage === 'ko' ? korean : (EN[korean] ?? korean);
}
