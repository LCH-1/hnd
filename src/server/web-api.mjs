import {
  AccountStoreError,
} from './account-store.mjs';
import { isIP } from 'node:net';
import {
  clearWebSessionCookie,
  serializeWebSessionCookie,
  sessionTokenFromCookieHeader,
} from './web-auth.mjs';
import {
  AuthenticationError,
  ManagedVaultKeyError,
  PreconditionFailedError,
  PreconditionRequiredError,
  VaultResetError,
} from '../sync/store.mjs';
import { createHash } from 'node:crypto';

const DEFAULT_JSON_LIMIT = 64 * 1024;
const API_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

class WebApiError extends Error {
  constructor(statusCode, code, message, headers = {}) {
    super(message);
    this.name = 'WebApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }
}

function header(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) throw new WebApiError(400, 'invalid_header', `Multiple ${name} headers are not allowed.`);
  return value;
}

function send(res, statusCode, body = null, headers = {}) {
  const normalized = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const responseHeaders = { ...API_HEADERS, ...headers };
  if (normalized) responseHeaders['Content-Length'] = String(normalized.byteLength);
  res.writeHead(statusCode, responseHeaders);
  res.end(normalized);
}

function sendJson(res, statusCode, value, headers = {}) {
  send(res, statusCode, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

async function readBytes(req, maxBytes) {
  const declared = header(req, 'content-length');
  if (declared !== undefined) {
    if (!/^\d+$/.test(declared)) throw new WebApiError(400, 'invalid_length', 'Invalid Content-Length.');
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes)) throw new WebApiError(400, 'invalid_length', 'Invalid Content-Length.');
    if (bytes > maxBytes) {
      req.resume();
      throw new WebApiError(413, 'request_too_large', 'Request body is too large.');
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      received += chunk.byteLength;
      if (received > maxBytes) tooLarge = true;
      else if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new WebApiError(413, 'request_too_large', 'Request body is too large.'));
      else resolve(Buffer.concat(chunks, received));
    });
    req.on('aborted', () => reject(new WebApiError(400, 'aborted', 'Request body was aborted.')));
    req.on('error', reject);
  });
}

async function readJson(req, maxBytes = DEFAULT_JSON_LIMIT) {
  const mediaType = String(header(req, 'content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new WebApiError(415, 'unsupported_media_type', 'JSON requests must use application/json.');
  }
  const bytes = await readBytes(req, maxBytes);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new WebApiError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebApiError(400, 'invalid_json', 'Request body must be a JSON object.');
  }
  return value;
}

function decodeBase64url(value, maxBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new WebApiError(400, 'invalid_snapshot', 'Encrypted snapshot encoding is invalid.');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes || bytes.toString('base64url') !== value) {
    throw new WebApiError(400, 'invalid_snapshot', 'Encrypted snapshot encoding is invalid.');
  }
  if (bytes.byteLength < 33 || !bytes.subarray(0, 5).equals(Buffer.from('484e444501', 'hex'))) {
    throw new WebApiError(400, 'invalid_snapshot', 'Unsupported encrypted snapshot envelope.');
  }
  return bytes;
}

function decodeVaultKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new WebApiError(400, 'invalid_vault_key', 'Vault key encoding is invalid.');
  }
  const key = Buffer.from(value, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== value) {
    key.fill(0);
    throw new WebApiError(400, 'invalid_vault_key', 'Vault key encoding is invalid.');
  }
  return key;
}

function formatConnectionCode(invitationToken, secret) {
  const match = /^hndi_([A-Za-z0-9_-]{43})$/.exec(String(invitationToken));
  if (!match || !Buffer.isBuffer(secret) || secret.byteLength !== 32) {
    throw new Error('Invalid server-generated connection secret');
  }
  const secretPart = secret.toString('base64url');
  const digest = createHash('sha256').update(`${match[1]}.${secretPart}`).digest();
  try {
    const checksum = digest.toString('base64url').slice(0, 12);
    return `hndj_${match[1]}.${secretPart}.${checksum}`;
  } finally {
    digest.fill(0);
  }
}

function assertOnlyFields(value, allowed) {
  const accepted = new Set(allowed);
  const unexpected = Object.keys(value).find((field) => !accepted.has(field));
  if (unexpected) {
    throw new WebApiError(400, 'invalid_request', `Unexpected request field: ${unexpected}`);
  }
}

function publicSessionResult(value) {
  const { sessionToken, ...safe } = value;
  const activeTenantId = safe.activeTenantId ?? safe.session?.activeTenantId;
  const role = safe.memberships?.find(
    (membership) => membership.tenantId === activeTenantId,
  )?.role;
  const requiresPasskey = Boolean(safe.requiresPasskey ?? safe.session?.recoveryRequired);
  return {
    ...safe,
    user: safe.user && role ? { ...safe.user, role } : safe.user,
    requiresPasskey,
    ...(requiresPasskey ? {
      onboarding: { complete: false, step: 2, recovery: true },
    } : {}),
  };
}

function roleFor(authenticated) {
  return authenticated.memberships.find(
    (membership) => membership.tenantId === authenticated.session.activeTenantId,
  )?.role ?? 'member';
}

class BoundedRateLimiter {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.entries = new Map();
  }

  check(key, limit, windowMs) {
    const now = this.clock();
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + windowMs };
    entry.count += 1;
    this.entries.set(key, entry);
    if (this.entries.size > 4096) {
      for (const [candidate, value] of this.entries) {
        if (value.resetAt <= now || this.entries.size > 3072) this.entries.delete(candidate);
      }
    }
    if (entry.count > limit) {
      throw new WebApiError(429, 'rate_limited', 'Too many requests. Try again later.', {
        'Retry-After': String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))),
      });
    }
  }
}

function isPrivateOrLoopbackAddress(value) {
  const address = String(value ?? '').toLowerCase();
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(ipv4) === 4) {
    const [first, second] = ipv4.split('.').map(Number);
    return first === 10
      || first === 127
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  return isIP(address) === 6 && (/^f[cd]/.test(address) || /^fe[89ab]/.test(address));
}

function rateLimitAddress(req, trustProxy) {
  const peer = req.socket.remoteAddress || 'unknown';
  if (!trustProxy || !isPrivateOrLoopbackAddress(peer)) return peer;
  const realIp = header(req, 'x-real-ip');
  if (realIp === undefined) return peer;
  const candidate = realIp.trim();
  if (candidate.length > 64 || isIP(candidate) === 0) {
    throw new WebApiError(400, 'invalid_header', 'Invalid x-real-ip header.');
  }
  return candidate;
}

export class WebApiRouter {
  constructor(options) {
    if (!options?.auth || !options?.accounts || !options?.control || !options?.snapshots) {
      throw new Error('WebApiRouter requires auth, accounts, control, and snapshots');
    }
    this.auth = options.auth;
    this.accounts = options.accounts;
    this.control = options.control;
    this.snapshots = options.snapshots;
    this.origin = new URL(options.origin).origin;
    this.maxBlobBytes = options.maxBlobBytes;
    this.onError = options.onError ?? (() => {});
    this.rateLimiter = new BoundedRateLimiter(options.clock);
    this.trustProxy = options.trustProxy === true;
  }

  #requireOrigin(req) {
    if (header(req, 'origin') !== this.origin) {
      throw new WebApiError(403, 'invalid_origin', 'Request origin is not allowed.');
    }
  }

  #rate(req, bucket, limit, windowMs) {
    const address = rateLimitAddress(req, this.trustProxy);
    this.rateLimiter.check(`${bucket}:${address}`, limit, windowMs);
  }

  #sessionToken(req) {
    const token = sessionTokenFromCookieHeader(header(req, 'cookie'));
    if (!token) throw new WebApiError(401, 'unauthorized', 'Login is required.');
    return token;
  }

  #authenticate(req, { csrf = false, allowRecovery = false } = {}) {
    const sessionToken = this.#sessionToken(req);
    let result;
    if (!csrf) {
      result = {
        sessionToken,
        authenticated: this.auth.session(sessionToken, { rotateCsrf: false }),
      };
    } else {
      this.#requireOrigin(req);
      const csrfToken = header(req, 'x-hnd-csrf');
      result = {
        sessionToken,
        csrfToken,
        authenticated: this.auth.verifyCsrf(sessionToken, csrfToken),
      };
    }
    if (result.authenticated.session.recoveryRequired && !allowRecovery) {
      throw new WebApiError(
        403,
        'recovery_passkey_required',
        'Register a new passkey to finish account recovery.',
      );
    }
    return result;
  }

  #unauthenticatedState() {
    const status = this.auth.publicSignupStatus();
    const needsOwnerSetup = this.accounts.userCount() === 0;
    return {
      authenticated: false,
      needsOwnerSetup,
      server: { needsOwnerSetup },
      signup: {
        allowed: status.allowed,
        requiresCode: status.requiresCode,
        mode: status.codeKind === 'bootstrap' ? 'bootstrap' : status.effectiveMode,
        firstUser: needsOwnerSetup,
      },
    };
  }

  #setLogin(res, value) {
    sendJson(res, 200, publicSessionResult(value), {
      'Set-Cookie': serializeWebSessionCookie(value.sessionToken),
      'X-Hnd-CSRF': value.csrfToken,
    });
  }

  async handle(req, res, url) {
    if (!url.pathname.startsWith('/api/web/')) return false;
    try {
      await this.#route(req, res, url);
    } catch (error) {
      this.#error(res, error);
    }
    return true;
  }

  async #route(req, res, url) {
    const { pathname } = url;

    if ((pathname === '/api/web/bootstrap' || pathname === '/api/web/auth/session') && req.method === 'GET') {
      const sessionToken = sessionTokenFromCookieHeader(header(req, 'cookie'));
      if (!sessionToken) {
        sendJson(res, 200, this.#unauthenticatedState());
        return;
      }
      try {
        const authenticated = this.auth.session(sessionToken);
        sendJson(res, 200, publicSessionResult(authenticated), {
          'X-Hnd-CSRF': authenticated.csrfToken,
        });
      } catch (error) {
        if (!(error instanceof AccountStoreError) || error.statusCode !== 401) throw error;
        sendJson(res, 200, this.#unauthenticatedState(), { 'Set-Cookie': clearWebSessionCookie() });
      }
      return;
    }

    if (pathname === '/api/web/auth/login/options' && req.method === 'POST') {
      this.#requireOrigin(req);
      this.#rate(req, 'login-options', 30, 60_000);
      await readJson(req);
      sendJson(res, 200, await this.auth.authenticationOptions());
      return;
    }
    if (pathname === '/api/web/auth/login/verify' && req.method === 'POST') {
      this.#requireOrigin(req);
      this.#rate(req, 'login-verify', 30, 60_000);
      this.#setLogin(res, await this.auth.verifyAuthentication(await readJson(req)));
      return;
    }
    if (pathname === '/api/web/auth/register/options' && req.method === 'POST') {
      this.#requireOrigin(req);
      this.#rate(req, 'register-options', 20, 60 * 60_000);
      sendJson(res, 200, await this.auth.registrationOptions(await readJson(req)));
      return;
    }
    if (pathname === '/api/web/auth/register/verify' && req.method === 'POST') {
      this.#requireOrigin(req);
      this.#rate(req, 'register-verify', 20, 60 * 60_000);
      this.#setLogin(res, await this.auth.verifyRegistration(await readJson(req)));
      return;
    }
    if (pathname === '/api/web/auth/reauth/options' && req.method === 'POST') {
      const { sessionToken, csrfToken } = this.#authenticate(req, { csrf: true });
      this.#rate(req, 'reauth-options', 20, 15 * 60_000);
      await readJson(req);
      sendJson(res, 200, await this.auth.reauthenticationOptions({ sessionToken, csrfToken }));
      return;
    }
    if (pathname === '/api/web/auth/reauth/verify' && req.method === 'POST') {
      const { sessionToken, csrfToken } = this.#authenticate(req, { csrf: true });
      this.#rate(req, 'reauth-verify', 20, 15 * 60_000);
      const body = await readJson(req);
      const authenticated = await this.auth.verifyReauthentication({
        ...body,
        sessionToken,
        csrfToken,
      });
      sendJson(res, 200, { reauthenticated: true, session: authenticated.session });
      return;
    }
    if (pathname === '/api/web/auth/logout' && req.method === 'POST') {
      const { sessionToken, csrfToken } = this.#authenticate(req, {
        csrf: true,
        allowRecovery: true,
      });
      await readJson(req);
      this.auth.logout(sessionToken, csrfToken);
      sendJson(res, 200, { loggedOut: true }, { 'Set-Cookie': clearWebSessionCookie() });
      return;
    }

    if (pathname === '/api/web/recovery/codes' && req.method === 'POST') {
      const { sessionToken, csrfToken } = this.#authenticate(req, { csrf: true });
      const body = await readJson(req);
      sendJson(res, 201, this.auth.createRecoveryCodes({
        sessionToken,
        csrfToken,
        count: body.count,
      }));
      return;
    }
    if (pathname === '/api/web/recovery/confirm' && req.method === 'POST') {
      const { sessionToken, csrfToken } = this.#authenticate(req, { csrf: true });
      sendJson(res, 200, this.auth.confirmRecoveryCodes({
        ...await readJson(req),
        sessionToken,
        csrfToken,
      }));
      return;
    }
    if (pathname === '/api/web/recovery/use' && req.method === 'POST') {
      this.#requireOrigin(req);
      this.#rate(req, 'recovery-use', 10, 15 * 60_000);
      this.#setLogin(res, this.auth.useRecoveryCode(await readJson(req)));
      return;
    }

    if (pathname === '/api/web/vault/status' && req.method === 'GET') {
      const { authenticated } = this.#authenticate(req);
      const tenantId = authenticated.session.activeTenantId;
      const current = await this.snapshots.get(tenantId);
      sendJson(res, 200, {
        initialized: Boolean(current),
        etag: current?.etag ?? null,
        keyManaged: await this.snapshots.managedVaultKeyStatus(tenantId),
      });
      return;
    }
    if (pathname === '/api/web/vault/initialize' && req.method === 'POST') {
      const { authenticated } = this.#authenticate(req, { csrf: true });
      const body = await readJson(req, Math.ceil(this.maxBlobBytes * 1.4) + 4096);
      if (body.version !== 1 || body.algorithm !== 'AES-256-GCM') {
        throw new WebApiError(400, 'invalid_snapshot', 'Unsupported browser vault format.');
      }
      const blob = decodeBase64url(body.snapshot, this.maxBlobBytes);
      const stored = await this.snapshots.putConditional(
        authenticated.session.activeTenantId,
        blob,
        { ifNoneMatch: '*' },
      );
      sendJson(res, 201, { initialized: true, etag: stored.etag, revisionId: stored.revisionId }, {
        ETag: stored.etag,
      });
      return;
    }
    if (pathname === '/api/web/vault/snapshot' && req.method === 'GET') {
      const { authenticated } = this.#authenticate(req);
      const current = await this.snapshots.get(authenticated.session.activeTenantId);
      if (!current) throw new WebApiError(404, 'snapshot_not_found', 'Encrypted snapshot not found.');
      sendJson(res, 200, { snapshot: current.blob.toString('base64url'), etag: current.etag }, {
        ETag: current.etag,
      });
      return;
    }
    if (pathname === '/api/web/vault/snapshot' && req.method === 'PUT') {
      const { authenticated } = this.#authenticate(req, { csrf: true });
      const body = await readJson(req, Math.ceil(this.maxBlobBytes * 1.4) + 4096);
      const blob = decodeBase64url(body.snapshot ?? body.blob, this.maxBlobBytes);
      const stored = await this.snapshots.putConditional(
        authenticated.session.activeTenantId,
        blob,
        {
          ifMatch: header(req, 'if-match'),
          ifNoneMatch: header(req, 'if-none-match'),
          requireManagedKey: true,
        },
      );
      sendJson(res, stored.created ? 201 : 200, {
        saved: true,
        etag: stored.etag,
        revisionId: stored.revisionId,
      }, { ETag: stored.etag });
      return;
    }
    if (pathname === '/api/web/vault/key/adopt' && req.method === 'POST') {
      const { sessionToken, authenticated } = this.#authenticate(req, { csrf: true });
      if (roleFor(authenticated) !== 'owner') {
        throw new WebApiError(
          403,
          'forbidden',
          'Only the workspace owner may adopt its legacy vault key.',
        );
      }
      this.auth.requireRecentAuthentication(sessionToken);
      this.#rate(req, 'vault-key-adopt', 5, 60 * 60_000);
      const body = await readJson(req, 4096);
      assertOnlyFields(body, ['vaultKey']);
      const vaultKey = decodeVaultKey(body.vaultKey);
      try {
        const adopted = await this.snapshots.adoptManagedVaultKey(
          authenticated.session.activeTenantId,
          vaultKey,
        );
        sendJson(res, adopted.created ? 201 : 200, adopted);
      } finally {
        vaultKey.fill(0);
      }
      return;
    }
    if (pathname === '/api/web/vault/key/unlock' && req.method === 'POST') {
      const { sessionToken, authenticated } = this.#authenticate(req, { csrf: true });
      this.auth.requireRecentAuthentication(sessionToken);
      this.#rate(req, 'vault-key-unlock', 20, 60 * 60_000);
      const body = await readJson(req, 4096);
      assertOnlyFields(body, []);
      const vaultKey = await this.snapshots.unlockManagedVaultKey(
        authenticated.session.activeTenantId,
      );
      try {
        sendJson(res, 200, { vaultKey: vaultKey.toString('base64url') });
      } finally {
        vaultKey.fill(0);
      }
      return;
    }
    if (pathname === '/api/web/vault/reset' && req.method === 'POST') {
      const { sessionToken, authenticated } = this.#authenticate(req, { csrf: true });
      if (roleFor(authenticated) !== 'owner') {
        throw new WebApiError(403, 'forbidden', 'Only the workspace owner may reset its vault.');
      }
      this.auth.requireRecentAuthentication(sessionToken);
      this.#rate(req, 'vault-reset', 5, 60 * 60_000);
      const body = await readJson(req, Math.ceil(this.maxBlobBytes * 1.4) + 4096);
      assertOnlyFields(body, ['version', 'algorithm', 'snapshot', 'confirmation']);
      if (body.version !== 1 || body.algorithm !== 'AES-256-GCM') {
        throw new WebApiError(400, 'invalid_snapshot', 'Unsupported browser vault format.');
      }
      if (body.confirmation !== 'RESET_VAULT') {
        throw new WebApiError(
          400,
          'invalid_confirmation',
          'Vault reset confirmation must be exactly RESET_VAULT.',
        );
      }
      const blob = decodeBase64url(body.snapshot, this.maxBlobBytes);
      const stored = await this.snapshots.resetVault(
        authenticated.session.activeTenantId,
        blob,
        {
          ifMatch: header(req, 'if-match'),
          requireUnmanagedKey: true,
        },
      );
      sendJson(res, 200, {
        reset: true,
        etag: stored.etag,
        revisionId: stored.revisionId,
      }, { ETag: stored.etag });
      return;
    }
    if (pathname === '/api/web/vault/pair/finish' && req.method === 'POST') {
      const { sessionToken, authenticated } = this.#authenticate(req, { csrf: true });
      this.auth.requireRecentAuthentication(sessionToken);
      const body = await readJson(req);
      const result = await this.control.consumeVaultInvitation(
        body.invitationToken,
        authenticated.session.activeTenantId,
      );
      try {
        sendJson(res, 200, { wrappedVaultKey: result.wrappedVaultKey.toString('base64url') });
      } finally {
        result.wrappedVaultKey.fill(0);
      }
      return;
    }

    if (pathname === '/api/web/connections' && req.method === 'POST') {
      const { sessionToken, authenticated } = this.#authenticate(req, { csrf: true });
      this.auth.requireRecentAuthentication(sessionToken);
      this.#rate(req, 'account-connection', 20, 60 * 60_000);
      const body = await readJson(req, 4096);
      assertOnlyFields(body, ['ttlSeconds']);
      const ttlSeconds = body.ttlSeconds ?? 900;
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 604800) {
        throw new WebApiError(
          400,
          'invalid_ttl',
          'Connection lifetime must be 60-604800 seconds.',
        );
      }
      const tenantId = authenticated.session.activeTenantId;
      const issued = await this.snapshots.createManagedDeviceInvitation(
        tenantId,
        { ttlMs: ttlSeconds * 1000 },
      );
      try {
        sendJson(res, 201, {
          connectionCode: formatConnectionCode(issued.invitationToken, issued.connectionSecret),
          connectionId: issued.invitationId,
          expiresAt: issued.expiresAt,
        });
      } finally {
        issued.connectionSecret.fill(0);
      }
      return;
    }

    if (pathname === '/api/web/device-invitations' && req.method === 'POST') {
      req.resume();
      sendJson(res, 410, {
        error: 'device_delegation_retired',
        message: 'Create a connection from your signed-in HND account instead.',
        connect: '/api/web/connections',
      });
      return;
    }

    if (pathname === '/api/web/enrollments' && req.method === 'POST') {
      const { sessionToken, authenticated } = this.#authenticate(req, { csrf: true });
      this.auth.requireRecentAuthentication(sessionToken);
      const body = await readJson(req);
      const seconds = body.ttlSeconds ?? 900;
      if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 604800) {
        throw new WebApiError(400, 'invalid_ttl', 'Enrollment lifetime must be 60-604800 seconds.');
      }
      const issued = await this.control.createEnrollmentKey(
        authenticated.session.activeTenantId,
        { ttlMs: seconds * 1000 },
      );
      sendJson(res, 201, issued);
      return;
    }
    const enrollmentMatch = /^\/api\/web\/enrollments\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(pathname);
    if (enrollmentMatch && req.method === 'GET') {
      const { authenticated } = this.#authenticate(req);
      const status = await this.control.enrollmentStatus(
        authenticated.session.activeTenantId,
        enrollmentMatch[1],
      );
      if (!status) throw new WebApiError(404, 'enrollment_not_found', 'Enrollment not found.');
      sendJson(res, 200, status);
      return;
    }

    if (pathname === '/api/web/account/invites' && req.method === 'GET') {
      const { authenticated } = this.#authenticate(req);
      sendJson(res, 200, {
        invites: this.accounts.listAccountInvites({
          actorUserId: authenticated.user.id,
          tenantId: authenticated.session.activeTenantId,
        }),
      });
      return;
    }
    if (pathname === '/api/web/account/invites' && req.method === 'POST') {
      const { sessionToken, authenticated } = this.#authenticate(req, { csrf: true });
      this.auth.requireRecentAuthentication(sessionToken);
      this.#rate(req, 'account-invite', 20, 60 * 60_000);
      const body = await readJson(req);
      const ttlSeconds = body.ttlSeconds ?? 24 * 60 * 60;
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 7 * 24 * 60 * 60) {
        throw new WebApiError(400, 'invalid_ttl', 'Invitation lifetime must be 60-604800 seconds.');
      }
      if (body.role !== undefined && !['owner', 'admin', 'member'].includes(body.role)) {
        throw new WebApiError(400, 'invalid_role', 'Invitation role must be owner, admin, or member.');
      }
      sendJson(res, 201, this.accounts.createAccountInvite({
        actorUserId: authenticated.user.id,
        tenantId: authenticated.session.activeTenantId,
        role: body.role ?? 'member',
        ttlMs: ttlSeconds * 1000,
      }));
      return;
    }
    if (pathname === '/api/web/account/members' && req.method === 'GET') {
      const { authenticated } = this.#authenticate(req);
      sendJson(res, 200, {
        members: this.accounts.listTenantMembers({
          actorUserId: authenticated.user.id,
          tenantId: authenticated.session.activeTenantId,
        }),
      });
      return;
    }

    if (pathname === '/api/web/overview' && req.method === 'GET') {
      const { authenticated } = this.#authenticate(req);
      const tenantId = authenticated.session.activeTenantId;
      const [devices, revisions] = await Promise.all([
        this.control.listDevices(tenantId),
        this.snapshots.listRevisions(tenantId),
      ]);
      sendJson(res, 200, {
        devices,
        revisions,
        deviceCount: devices.filter((device) => !device.revokedAt).length,
        revisionCount: revisions.length,
        lastSavedAt: revisions.find((revision) => revision.current)?.createdAt ?? null,
        recentDevices: devices.slice(-5).reverse(),
        recentRevisions: revisions.slice(0, 5),
      });
      return;
    }
    if (pathname === '/api/web/devices' && req.method === 'GET') {
      const { authenticated } = this.#authenticate(req);
      sendJson(res, 200, { devices: await this.control.listDevices(authenticated.session.activeTenantId) });
      return;
    }
    const renameMatch = /^\/api\/web\/devices\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(pathname);
    if (renameMatch && req.method === 'PATCH') {
      const { authenticated } = this.#authenticate(req, { csrf: true });
      if (!['owner', 'admin'].includes(roleFor(authenticated))) {
        throw new WebApiError(403, 'forbidden', 'Only a workspace owner or administrator may rename devices.');
      }
      const body = await readJson(req, 4096);
      assertOnlyFields(body, ['name']);
      if (
        typeof body.name !== 'string'
        || body.name.trim().length === 0
        || body.name.trim().length > 100
        || /[\u0000-\u001f\u007f]/.test(body.name)
      ) {
        throw new WebApiError(400, 'invalid_device_name', 'Device name must contain 1-100 visible characters.');
      }
      const device = await this.control.renameDevice(
        authenticated.session.activeTenantId,
        renameMatch[1],
        body.name,
      );
      if (!device) throw new WebApiError(404, 'device_not_found', 'Active device not found.');
      sendJson(res, 200, { device });
      return;
    }
    const revokeMatch = /^\/api\/web\/devices\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/revoke$/.exec(pathname);
    if (revokeMatch && req.method === 'POST') {
      const { sessionToken, authenticated } = this.#authenticate(req, { csrf: true });
      if (!['owner', 'admin'].includes(roleFor(authenticated))) {
        throw new WebApiError(403, 'forbidden', 'Only a workspace owner or administrator may revoke devices.');
      }
      this.auth.requireRecentAuthentication(sessionToken);
      await readJson(req);
      const revoked = await this.control.revokeDevice(authenticated.session.activeTenantId, revokeMatch[1]);
      if (!revoked) throw new WebApiError(404, 'device_not_found', 'Device not found.');
      sendJson(res, 200, { revoked: true });
      return;
    }
    if (pathname === '/api/web/revisions' && req.method === 'GET') {
      const { authenticated } = this.#authenticate(req);
      sendJson(res, 200, { revisions: await this.snapshots.listRevisions(authenticated.session.activeTenantId) });
      return;
    }
    if (pathname === '/api/web/security/passkeys' && req.method === 'GET') {
      const { authenticated } = this.#authenticate(req);
      const passkeys = this.accounts.listPasskeys(authenticated.user.id).map(({ publicKey, ...passkey }) => passkey);
      sendJson(res, 200, { passkeys });
      return;
    }
    if (pathname === '/api/web/security/passkeys/options' && req.method === 'POST') {
      const { sessionToken, csrfToken } = this.#authenticate(req, {
        csrf: true,
        allowRecovery: true,
      });
      this.#rate(req, 'passkey-add-options', 20, 60 * 60_000);
      const body = await readJson(req);
      sendJson(res, 200, await this.auth.passkeyRegistrationOptions({
        ...body,
        sessionToken,
        csrfToken,
      }));
      return;
    }
    if (pathname === '/api/web/security/passkeys/verify' && req.method === 'POST') {
      const { sessionToken, csrfToken } = this.#authenticate(req, {
        csrf: true,
        allowRecovery: true,
      });
      this.#rate(req, 'passkey-add-verify', 20, 60 * 60_000);
      const result = await this.auth.verifyPasskeyRegistration({
        ...await readJson(req),
        sessionToken,
        csrfToken,
      });
      const { publicKey, ...passkey } = result.passkey;
      sendJson(res, 201, { ...result, passkey });
      return;
    }
    const passkeyMatch = /^\/api\/web\/security\/passkeys\/([A-Za-z0-9_-]{1,1024})$/.exec(pathname);
    if (passkeyMatch && req.method === 'DELETE') {
      const { sessionToken, authenticated } = this.#authenticate(req, { csrf: true });
      this.auth.requireRecentAuthentication(sessionToken);
      sendJson(res, 200, this.accounts.revokePasskey(authenticated.user.id, passkeyMatch[1]));
      return;
    }
    if (pathname === '/api/web/security/sessions' && req.method === 'GET') {
      const { authenticated } = this.#authenticate(req);
      sendJson(res, 200, {
        sessions: this.accounts.listWebSessions(
          authenticated.user.id,
          authenticated.session.id,
        ),
      });
      return;
    }
    const webSessionMatch = /^\/api\/web\/security\/sessions\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
    if (webSessionMatch && req.method === 'DELETE') {
      const { sessionToken, authenticated } = this.#authenticate(req, { csrf: true });
      this.auth.requireRecentAuthentication(sessionToken);
      sendJson(res, 200, this.accounts.revokeWebSession(
        authenticated.user.id,
        webSessionMatch[1],
        authenticated.session.id,
      ));
      return;
    }
    if (pathname === '/api/web/settings' && req.method === 'GET') {
      const { authenticated } = this.#authenticate(req);
      sendJson(res, 200, {
        user: authenticated.user,
        role: roleFor(authenticated),
        serverOwner: this.accounts.isServerOwner(authenticated.user.id),
        signup: this.auth.publicSignupStatus(),
        signupMode: this.auth.signupMode,
        revisionRetention: this.snapshots.maxRevisionsPerTenant,
      });
      return;
    }
    if (pathname === '/api/web/settings' && req.method === 'PUT') {
      const { sessionToken, authenticated } = this.#authenticate(req, { csrf: true });
      const body = await readJson(req);
      const updatesServerSettings = body.signupMode !== undefined
        || body.revisionRetention !== undefined;
      if (updatesServerSettings) {
        if (
          body.signupMode !== undefined
          && !['first-user', 'invite', 'open', 'disabled', 'closed'].includes(body.signupMode)
        ) {
          throw new WebApiError(400, 'invalid_signup_mode', 'Unsupported signup mode.');
        }
        this.auth.requireRecentAuthentication(sessionToken);
        if (!this.accounts.isServerOwner(authenticated.user.id)) {
          throw new WebApiError(403, 'forbidden', 'Server owner access is required.');
        }
      }
      let user = authenticated.user;
      if (body.displayName !== undefined) {
        user = this.accounts.updateDisplayName(authenticated.user.id, body.displayName);
      }
      if (body.language !== undefined) {
        user = this.accounts.updateLanguage(authenticated.user.id, body.language);
      }
      let settings = {
        signupMode: this.auth.signupMode,
        revisionRetention: this.snapshots.maxRevisionsPerTenant,
      };
      if (updatesServerSettings) {
        settings = this.accounts.updateServerSettings(
          authenticated.user.id,
          authenticated.session.activeTenantId,
          {
            signupMode: body.signupMode,
            revisionRetention: body.revisionRetention,
            defaults: settings,
          },
        );
        this.auth.signupMode = settings.signupMode;
        this.snapshots.maxRevisionsPerTenant = settings.revisionRetention;
      }
      sendJson(res, 200, { user, ...settings });
      return;
    }

    throw new WebApiError(404, 'not_found', 'Not found.');
  }

  #error(res, error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof WebApiError) {
      sendJson(res, error.statusCode, { error: error.code, message: error.message }, error.headers);
      return;
    }
    if (error instanceof AccountStoreError) {
      sendJson(res, error.statusCode, { error: error.code, message: error.message });
      return;
    }
    if (error instanceof AuthenticationError) {
      sendJson(res, 401, { error: 'unauthorized', message: error.message });
      return;
    }
    if (error instanceof PreconditionRequiredError) {
      sendJson(res, 428, { error: 'precondition_required', message: error.message }, error.currentEtag ? { ETag: error.currentEtag } : {});
      return;
    }
    if (error instanceof PreconditionFailedError) {
      sendJson(res, 412, { error: 'precondition_failed', message: error.message }, error.currentEtag ? { ETag: error.currentEtag } : {});
      return;
    }
    if (error instanceof VaultResetError) {
      sendJson(res, error.statusCode, {
        error: error.code,
        message: error.message,
        ...(error.activeDeviceCount > 0 ? { activeDeviceCount: error.activeDeviceCount } : {}),
      }, error.currentEtag ? { ETag: error.currentEtag } : {});
      return;
    }
    if (error instanceof ManagedVaultKeyError) {
      sendJson(res, error.statusCode, { error: error.code, message: error.message });
      return;
    }
    if (error instanceof RangeError) {
      sendJson(res, 413, { error: 'request_too_large', message: error.message });
      return;
    }
    if (error?.message?.startsWith('Invalid ')) {
      sendJson(res, 400, { error: 'invalid_request', message: error.message });
      return;
    }
    this.onError(error);
    sendJson(res, 500, { error: 'internal_server_error', message: 'Internal server error.' });
  }
}

export { WebApiError };
