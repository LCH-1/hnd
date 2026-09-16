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
  '매 턴마다': 'Every turn',
  '파일이 바뀐 턴만': 'Only turns that changed files',
  '세션이 끝날 때만': 'Only when the session ends',
  '오래 걸린 턴만': 'Only long turns',
  '초 이상': 's or longer',
  '발송 조건': 'Sends on',
  '예시': 'Example',
  '알림을 보낼 서비스를 고르세요.': 'Choose where notifications should go.',
  '번호 또는 이름': 'Number or name',
  '웹훅 URL': 'Webhook URL',
  '등록된 알림 채널이 없습니다.': 'No notification channels are configured.',
  '알림 채널을 추가했습니다.': 'Notification channel added.',
  '알림 채널을 수정했습니다.': 'Notification channel updated.',
  '알림 채널을 삭제했습니다.': 'Notification channel removed.',
  '알림 연결 테스트': 'Notification test',
  '이 메시지가 보이면 알림 설정이 끝난 것입니다.': 'If you can read this, notifications are set up.',
  '전송 성공': 'Delivered',
  '전송 실패': 'Not delivered',
  '프로젝트 등록 완료': 'Project registered',
  '이미 등록된 프로젝트입니다.': 'This project is already registered.',
  '프로젝트 연결 완료': 'Project linked',
  '환경 변경': 'Change environment',
  '환경 선택을 해제했습니다.': 'Environment selection cleared.',
  '선택된 환경이 없습니다.': 'No environment selected.',
  'Cursor 룰이 최신 상태입니다.': 'Cursor rules are up to date.',
  '보낼 변경 사항이 없습니다.': 'No changes to upload.',
  '받을 변경 사항이 없습니다.': 'No changes to download.',
  '서버에 저장했습니다.': 'Saved to the server.',
  '서버의 변경 사항을 적용했습니다.': 'Changes from the server applied.',
  '로컬과 서버의 변경 사항을 병합했습니다.': 'Local and server changes merged.',
  '미리보기: 파일은 변경하지 않습니다.': 'Preview: files will not be changed.',
  '미리보기: 변경 사항 없음.': 'Preview: no changes needed.',
  '공통 설정은 이미 완료되어 있습니다.': 'Shared settings are already configured.',
  '이미 설정되어 있습니다.': 'Already configured.',
  '제거할 설정이 없습니다.': 'No settings to remove.',
  '설정 완료.': 'Setup complete.',
  '공통 설정 완료.': 'Shared setup complete.',
  '설정 제거 완료.': 'Settings removed.',
  '변경 없음': 'No changes',
  '저장 예정': 'Would save',
  '삭제 예정': 'Would remove',
  '저장': 'Saved',
  '삭제': 'Removed',
  'Cursor 룰 설정 생략: 등록되지 않은 프로젝트입니다.': 'Cursor rules skipped: project not registered.',
  'Cursor 룰 설정 생략: Git 프로젝트 경로가 아닙니다.': 'Cursor rules skipped: not in a Git project.',
  '설정: hnd init 실행 후 hnd setup': 'Setup: run hnd init, then hnd setup',
  '설정: Git 프로젝트 경로에서 hnd init 실행 후 hnd setup': 'Setup: run hnd init in a Git project, then hnd setup',
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
