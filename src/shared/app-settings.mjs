// Shared, dependency-free contract for the browser and installed connector.
import { NOTIFY_DEFAULTS, effectiveNotifySettings, validNotifySettings } from './notify.mjs';

export const APP_SETTINGS_PATH = 'app-settings.json';
export const APP_SETTINGS_DEFAULTS = Object.freeze({
  workRecording: 'manual',
  autoSave: true,
  knowledgeSuggestions: false,
  notify: NOTIFY_DEFAULTS,
});

export function validAppSettings(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === 1
    && Object.keys(value).every((key) => key === 'schemaVersion' || Object.hasOwn(APP_SETTINGS_DEFAULTS, key))
    && (value.workRecording === undefined || ['manual', 'automatic'].includes(value.workRecording))
    && (value.autoSave === undefined || typeof value.autoSave === 'boolean')
    && (value.knowledgeSuggestions === undefined || typeof value.knowledgeSuggestions === 'boolean')
    && validNotifySettings(value.notify);
}

export function effectiveAppSettings(value = {}, localConfig = {}) {
  return {
    ...APP_SETTINGS_DEFAULTS,
    autoSave: localConfig.autoSave !== false,
    knowledgeSuggestions: localConfig.knowledgeSuggestions === true,
    ...value,
    // Frozen defaults must never be handed out as a live reference, and a
    // partially written channel list must never reach the sender.
    notify: effectiveNotifySettings(value.notify),
    schemaVersion: 1,
  };
}

export function workRecordingInstructions(mode) {
  if (mode !== 'automatic') return '';
  return [
    'Work recording is enabled for this workspace. This policy authorizes concise work summaries, not extra implementation scope.',
    'On a concrete implementation, investigation or review request, run hnd work list before making changes. Questions and casual conversation alone do not create work.',
    'Reuse this session\'s selected task only if it matches the request. Never inherit another session\'s selection or take over its claimed task.',
    'For a new task: hnd work new "SHORT TITLE" --goal "REQUEST SUMMARY", then hnd work claim. If work overlaps another session, coordinate before editing shared files.',
    'After meaningful progress and before ending the turn, use hnd work save --current "SUMMARY" --next "NEXT STEP"; include --decision, --rejected and --validation when relevant. Check hnd work save --help for supported flags.',
    'Record only concise task facts, decisions, changed paths and validation outcomes. Never copy raw prompts, transcripts, credentials, personal data or excluded file contents into work records.',
    'Respect project/session privacy settings and user requests not to record. Do not automatically close work or mark it complete without the user\'s instruction.',
    'If HND is unavailable, briefly report that recording failed and continue the authorized task; do not retry indefinitely.',
  ].join('\n');
}
