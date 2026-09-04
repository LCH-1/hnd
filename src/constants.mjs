export const APP_NAME = 'hnd';
// Version of the client runtime distributed by the central HND server. It is
// intentionally independent from the npm launcher package version.
export const VERSION = '1.2.0';
export const STATE_SCHEMA_VERSION = 1;
export const BUNDLE_SCHEMA_VERSION = 1;
export const DEFAULT_ENVIRONMENT = 'default';
export const DEFAULT_STALE_HOURS = 72;
export const DEFAULT_MAX_CONTEXT_BYTES = 32 * 1024;

export const POLICY_SCOPES = Object.freeze(['global', 'repo', 'env', 'local']);
export const AGENTS = Object.freeze(['claude', 'codex', 'cursor']);

export const MANAGED = Object.freeze({
  id: 'hnd',
  description: 'Managed by hnd. Edit through the hnd CLI.',
});
