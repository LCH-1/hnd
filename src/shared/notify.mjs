// Shared, dependency-free contract for the browser, the CLI, and the hook path.
// Webhook URLs live inside the end-to-end encrypted snapshot, so this module is
// also the single place that decides which destinations are allowed at all.

export const NOTIFY_PROVIDERS = Object.freeze(['slack', 'discord']);
export const NOTIFY_TRIGGERS = Object.freeze(['always', 'long-turn', 'changed-files', 'session-end']);
export const NOTIFY_MAX_CHANNELS = 5;
export const NOTIFY_DEFAULT_TRIGGER = 'long-turn';
export const NOTIFY_DEFAULT_THRESHOLD_SECONDS = 60;
export const NOTIFY_MIN_THRESHOLD_SECONDS = 5;
export const NOTIFY_MAX_THRESHOLD_SECONDS = 86_400;
export const NOTIFY_MAX_LABEL_LENGTH = 60;
export const NOTIFY_DEFAULTS = Object.freeze({ channels: Object.freeze([]) });

// Slack rejects browser origins outright and Discord caps a message at 2000
// characters, so the tighter budget is the one that has to hold.
const BODY_LIMITS = Object.freeze({ slack: 2_800, discord: 1_800 });
const WEBHOOK_HOSTS = Object.freeze({
  slack: Object.freeze(['hooks.slack.com']),
  discord: Object.freeze(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']),
});
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function providerLabel(provider) {
  return provider === 'slack' ? 'Slack' : provider === 'discord' ? 'Discord' : provider;
}

/**
 * Accepts only the documented webhook shape for each provider. An arbitrary
 * https URL would turn a synced settings file into a request forwarder, so the
 * host allowlist is a hard requirement rather than a convenience check.
 */
export function webhookUrlProblem(provider, value) {
  if (!NOTIFY_PROVIDERS.includes(provider)) return 'unknown_provider';
  if (typeof value !== 'string' || !value.trim()) return 'missing';
  if (value.length > 512) return 'too_long';
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return 'malformed';
  }
  if (url.protocol !== 'https:') return 'not_https';
  if (url.username || url.password || url.search || url.hash) return 'malformed';
  if (!WEBHOOK_HOSTS[provider].includes(url.hostname)) return 'wrong_host';
  if (provider === 'slack' && !/^\/services\/[A-Za-z0-9/_-]{10,}$/.test(url.pathname)) return 'wrong_path';
  if (provider === 'discord' && !/^\/api\/(?:v\d{1,2}\/)?webhooks\/\d{5,}\/[\w-]{10,}$/.test(url.pathname)) {
    return 'wrong_path';
  }
  return null;
}

export function validWebhookUrl(provider, value) {
  return webhookUrlProblem(provider, value) === null;
}

/** Never let a webhook secret reach a log, a list view, or a work record. */
export function maskWebhookUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    return '********';
  }
  const tail = url.pathname.slice(-4);
  return `${url.origin}/…${tail}`;
}

export function validNotifyChannel(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set(['id', 'provider', 'label', 'webhookUrl', 'enabled', 'trigger', 'thresholdSeconds']);
  if (!Object.keys(value).every((key) => allowed.has(key))) return false;
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) return false;
  if (!NOTIFY_PROVIDERS.includes(value.provider)) return false;
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > NOTIFY_MAX_LABEL_LENGTH) return false;
  if (!validWebhookUrl(value.provider, value.webhookUrl)) return false;
  if (typeof value.enabled !== 'boolean') return false;
  if (!NOTIFY_TRIGGERS.includes(value.trigger)) return false;
  return Number.isSafeInteger(value.thresholdSeconds)
    && value.thresholdSeconds >= NOTIFY_MIN_THRESHOLD_SECONDS
    && value.thresholdSeconds <= NOTIFY_MAX_THRESHOLD_SECONDS;
}

export function validNotifySettings(value) {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!Object.keys(value).every((key) => key === 'channels')) return false;
  if (!Array.isArray(value.channels)) return false;
  if (value.channels.length > NOTIFY_MAX_CHANNELS) return false;
  if (!value.channels.every((channel) => validNotifyChannel(channel))) return false;
  return new Set(value.channels.map((channel) => channel.id)).size === value.channels.length;
}

export function effectiveNotifySettings(value) {
  return { channels: validNotifySettings(value) && value ? value.channels.map((channel) => ({ ...channel })) : [] };
}

/** The list view and every CLI/JSON output go through this, never the raw record. */
export function redactNotifyChannel(channel) {
  const { webhookUrl, ...rest } = channel;
  return { ...rest, webhook: maskWebhookUrl(webhookUrl) };
}

export function redactNotifySettings(value) {
  return { channels: effectiveNotifySettings(value).channels.map((channel) => redactNotifyChannel(channel)) };
}

/**
 * A stop hook fires at the end of every turn, so an unconditional channel would
 * bury the user. `event.phase` is the hook phase, `elapsedSeconds` is null when
 * the turn start was never recorded, and `changed` reports whether the
 * checkpoint saw new git changes.
 */
export function shouldNotify(channel, event = {}) {
  if (!channel?.enabled) return false;
  const phase = event.phase === 'end' ? 'end' : 'stop';
  if (channel.trigger === 'session-end') return phase === 'end';
  if (phase !== 'stop') return false;
  if (channel.trigger === 'always') return true;
  if (channel.trigger === 'changed-files') return event.changed === true;
  // A turn without a recorded start is reported rather than silently dropped:
  // a missed notification is worse than an extra one.
  return typeof event.elapsedSeconds !== 'number' || event.elapsedSeconds >= channel.thresholdSeconds;
}

export function formatDuration(seconds, language = 'en') {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (language === 'ko') return minutes ? `${minutes}분 ${rest}초` : `${rest}초`;
  return minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

function summaryLines(event, language) {
  const ko = language === 'ko';
  const lines = [];
  const scope = [event.repository, event.branch && `(${event.branch})`].filter(Boolean).join(' ');
  lines.push(`${ko ? '✅ 작업 완료' : '✅ Turn complete'}${scope ? ` · ${scope}` : ''}`);
  const facts = [
    event.agentLabel,
    formatDuration(event.elapsedSeconds, language),
    typeof event.changedCount === 'number' && event.changedCount > 0
      ? (ko ? `변경 ${event.changedCount}개` : `${event.changedCount} changed`)
      : '',
  ].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '));
  if (event.title) lines.push(`*${event.title}*`);
  if (event.currentState) lines.push(`${ko ? '지금' : 'Now'}: ${event.currentState}`);
  if (event.nextStep) lines.push(`${ko ? '다음' : 'Next'}: ${event.nextStep}`);
  return lines;
}

export function renderNotifyText(event = {}, { language = 'en', provider = 'slack' } = {}) {
  const limit = BODY_LIMITS[provider] ?? BODY_LIMITS.discord;
  const text = summaryLines(event, language).join('\n');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function buildNotifyRequest(channel, event = {}, { language = 'en' } = {}) {
  const text = renderNotifyText(event, { language, provider: channel.provider });
  return {
    url: channel.webhookUrl,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(channel.provider === 'slack' ? { text } : { content: text }),
    text,
  };
}

/**
 * Setup steps rendered verbatim by both `hnd notify guide` and the web panel so
 * the two surfaces can never drift apart.
 */
export function providerGuide(provider, language = 'en') {
  const ko = language === 'ko';
  if (provider === 'slack') {
    return {
      provider,
      title: ko ? 'Slack 수신 웹훅 만들기' : 'Create a Slack incoming webhook',
      steps: ko ? [
        'https://api.slack.com/apps 에서 Create New App → From scratch를 선택합니다.',
        '앱 이름을 정하고 알림을 받을 워크스페이스를 고릅니다.',
        '왼쪽 메뉴에서 Incoming Webhooks를 열고 Activate Incoming Webhooks를 켭니다.',
        'Add New Webhook to Workspace를 누르고 알림을 받을 채널을 선택합니다.',
        '만들어진 https://hooks.slack.com/services/... 주소를 복사합니다.',
      ] : [
        'Open https://api.slack.com/apps and choose Create New App → From scratch.',
        'Name the app and pick the workspace that should receive notifications.',
        'Open Incoming Webhooks in the sidebar and turn on Activate Incoming Webhooks.',
        'Select Add New Webhook to Workspace and choose the destination channel.',
        'Copy the generated https://hooks.slack.com/services/... URL.',
      ],
      // Deliberately not shaped like a real token. A realistic placeholder trips
      // GitHub push protection, and teaching the repository to allow that
      // pattern would stop it from catching a genuine webhook later.
      example: 'https://hooks.slack.com/services/YOUR-TEAM-ID/YOUR-CHANNEL-ID/YOUR-TOKEN',
    };
  }
  return {
    provider: 'discord',
    title: ko ? 'Discord 웹훅 만들기' : 'Create a Discord webhook',
    steps: ko ? [
      '알림을 받을 채널의 톱니바퀴(채널 편집) 아이콘을 누릅니다.',
      '연동 → 웹훅 → 새 웹훅을 차례로 선택합니다.',
      '이름과 채널을 확인한 뒤 웹훅 URL 복사를 누릅니다.',
      '복사한 https://discord.com/api/webhooks/... 주소를 사용합니다.',
    ] : [
      'Open the destination channel and select the gear (Edit Channel) icon.',
      'Go to Integrations → Webhooks → New Webhook.',
      'Confirm the name and channel, then select Copy Webhook URL.',
      'Use the copied https://discord.com/api/webhooks/... URL.',
    ],
    example: 'https://discord.com/api/webhooks/000000000000000000/YOUR-WEBHOOK-TOKEN',
  };
}
