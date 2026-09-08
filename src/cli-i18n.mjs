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
  '미리보기: 파일을 변경하지 않았습니다.': 'Preview: no files were changed.',
  '사용자 공통 설정은 이미 완료되어 변경할 내용이 없습니다.': 'Shared user setup is already complete. No changes needed.',
  '설정이 이미 완료되어 변경할 내용이 없습니다.': 'Setup is already complete. No changes needed.',
  '제거할 HND 관리 설정이 없습니다.': 'No HND-managed settings found. Nothing to uninstall.',
  '다음 파일에 HND 설정을 적용할 예정입니다.': 'HND settings would be applied to the following files.',
  '다음 파일에서 HND 설정을 제거할 예정입니다.': 'HND settings would be removed from the following files.',
  'HND 설정을 적용했습니다.': 'HND setup completed.',
  'HND 설정을 제거했습니다. 다른 사용자 설정은 보존했습니다.': 'HND settings removed. Other user settings were preserved.',
  '프로젝트 전용 — 현재 Git 저장소': 'Project only — current Git repository',
  '사용자 공통 — 이 PC의 같은 사용자로 실행하는 모든 프로젝트': 'Shared user settings — all projects run by this user on this PC',
  '변경 없음': 'No changes',
  '저장 예정': 'Would save',
  '삭제 예정': 'Would remove',
  '저장': 'Saved',
  '삭제': 'Removed',
  'Cursor 룰은 프로젝트마다 설정하고, 훅·스킬은 사용자 공통 설정을 공유합니다. 같은 내용의 파일은 다시 저장하지 않습니다.': 'Cursor rules are project-specific; hooks and skills are shared user settings. Identical files are not written again.',
  '훅·스킬은 사용자 공통 설정입니다. 같은 내용의 파일은 다시 저장하지 않습니다.': 'Hooks and skills are shared user settings. Identical files are not written again.',
  '프로젝트 전용 Cursor 룰은 건너뛰었습니다. 현재 Git 저장소가 HND에 등록되지 않았습니다.': 'Project-specific Cursor rules were skipped: this Git repository is not registered with HND.',
  '프로젝트 전용 Cursor 룰은 건너뛰었습니다. 현재 경로가 Git 저장소가 아닙니다.': 'Project-specific Cursor rules were skipped: the current path is not a Git repository.',
  '다음 단계: hnd init으로 현재 프로젝트를 등록한 뒤 hnd setup을 실행하세요.': 'Next: register this project with hnd init, then run hnd setup.',
  '다음 단계: Git 프로젝트 경로에서 hnd init을 실행한 뒤 hnd setup을 실행하세요.': 'Next: run hnd init in a Git project, then run hnd setup.',
  '설정 확인': 'Check setup',
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
