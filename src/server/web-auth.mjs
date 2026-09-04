import { timingSafeEqual } from 'node:crypto';

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { parseCookie, stringifySetCookie } from 'cookie';

import {
  AccountStoreError,
  DEFAULT_SESSION_ABSOLUTE_TTL_MS,
  generateWebAuthnUserId,
} from './account-store.mjs';

export const WEB_SESSION_COOKIE_NAME = '__Host-hnd_session';
export const DEFAULT_RECENT_AUTHENTICATION_MS = 5 * 60 * 1000;

const DEFAULT_WEBAUTHN = Object.freeze({
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
});

function authError(code, message, statusCode = 401) {
  return new AccountStoreError(code, message, { statusCode });
}

function normalizeRelyingParty(originValue, rpIdValue) {
  let origin;
  try {
    origin = new URL(originValue);
  } catch {
    throw new Error('WebAuthn origin must be an absolute URL');
  }
  const localDevelopment = origin.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(origin.hostname);
  if (
    (origin.protocol !== 'https:' && !localDevelopment)
    || origin.username
    || origin.password
    || origin.search
    || origin.hash
    || (origin.pathname !== '/' && origin.pathname !== '')
  ) {
    throw new Error('WebAuthn origin must be an HTTPS origin without credentials, path, query, or fragment');
  }
  const rpId = String(rpIdValue ?? '').toLowerCase();
  if (!rpId || rpId !== origin.hostname.toLowerCase() || rpId.endsWith('.')) {
    throw new Error('WebAuthn RP ID must exactly match the configured origin hostname');
  }
  return Object.freeze({ origin: origin.origin, rpId });
}

function base64urlEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (!/^[A-Za-z0-9_-]+$/.test(left) || !/^[A-Za-z0-9_-]+$/.test(right)) return false;
  const leftBytes = Buffer.from(left, 'base64url');
  const rightBytes = Buffer.from(right, 'base64url');
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function validCredentialResponse(response) {
  return Boolean(
    response
    && typeof response === 'object'
    && typeof response.id === 'string'
    && response.response
    && typeof response.response === 'object',
  );
}

function passkeyFromRegistration(registrationInfo, label) {
  const credential = registrationInfo?.credential;
  if (!credential) throw authError('registration_failed', 'Passkey registration failed.');
  return Object.freeze({
    id: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports ?? [],
    deviceType: registrationInfo.credentialDeviceType,
    backedUp: registrationInfo.credentialBackedUp,
    label,
  });
}

function webSessionResult(created, recoveryStatus) {
  return Object.freeze({
    authenticated: true,
    sessionToken: created.sessionToken,
    csrfToken: created.csrfToken,
    session: created.session,
    user: created.user,
    memberships: created.memberships,
    activeTenantId: created.session.activeTenantId,
    requiresPasskey: created.session.recoveryRequired,
    recoveryCodesConfigured: recoveryStatus.configured,
    recoveryCodesConfirmed: recoveryStatus.confirmed,
  });
}

export function serializeWebSessionCookie(sessionToken, options = {}) {
  const maxAge = options.maxAgeSeconds ?? Math.floor(DEFAULT_SESSION_ABSOLUTE_TTL_MS / 1000);
  if (!Number.isSafeInteger(maxAge) || maxAge < 1) throw new Error('Session cookie Max-Age must be positive');
  return stringifySetCookie({
    name: WEB_SESSION_COOKIE_NAME,
    value: sessionToken,
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge,
  });
}

export function clearWebSessionCookie() {
  return stringifySetCookie({
    name: WEB_SESSION_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    expires: new Date(0),
    maxAge: 0,
  });
}

export function sessionTokenFromCookieHeader(header) {
  if (typeof header !== 'string' || header.length > 8192) return null;
  const occurrences = header.split(';').reduce((count, pair) => {
    const separator = pair.indexOf('=');
    if (separator === -1) return count;
    return pair.slice(0, separator).trim() === WEB_SESSION_COOKIE_NAME ? count + 1 : count;
  }, 0);
  if (occurrences !== 1) return null;
  try {
    return parseCookie(header)[WEB_SESSION_COOKIE_NAME] ?? null;
  } catch {
    return null;
  }
}

export class WebAuthService {
  constructor(options) {
    if (!options?.store) throw new Error('WebAuthService requires an AccountStore');
    this.store = options.store;
    const relyingParty = normalizeRelyingParty(options.origin, options.rpId);
    this.origin = relyingParty.origin;
    this.rpId = relyingParty.rpId;
    this.rpName = String(options.rpName ?? 'HND').trim();
    if (!this.rpName || this.rpName.length > 100) throw new Error('Invalid WebAuthn RP name');
    this.signupMode = options.signupMode ?? 'open';
    this.clock = options.clock ?? (() => Date.now());
    this.recentAuthenticationMs = options.recentAuthenticationMs
      ?? DEFAULT_RECENT_AUTHENTICATION_MS;
    if (!Number.isSafeInteger(this.recentAuthenticationMs) || this.recentAuthenticationMs < 1_000) {
      throw new Error('Recent-authentication window must be at least one second');
    }
    this.webauthn = Object.freeze({ ...DEFAULT_WEBAUTHN, ...(options.webauthn ?? {}) });
    for (const operation of Object.keys(DEFAULT_WEBAUTHN)) {
      if (typeof this.webauthn[operation] !== 'function') {
        throw new Error(`WebAuthn implementation is missing ${operation}`);
      }
    }
  }

  publicSignupStatus() {
    return this.store.signupStatus(this.signupMode);
  }

  async registrationOptions(input) {
    const pending = this.store.prepareSignup({
      mode: this.signupMode,
      username: input?.username,
      displayName: input?.displayName,
      code: input?.code,
    });
    const webauthnUserId = generateWebAuthnUserId();
    const options = await this.webauthn.generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpId,
      userID: webauthnUserId,
      userName: pending.username,
      userDisplayName: pending.displayName,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      excludeCredentials: [],
    });
    const flow = this.store.createWebAuthnFlow({
      type: 'signup',
      challenge: options.challenge,
      inviteId: pending.inviteId,
      signupPolicy: pending.signupPolicy,
      pendingUsername: pending.username,
      pendingDisplayName: pending.displayName,
      pendingWebauthnUserId: webauthnUserId,
      pendingTenantId: pending.tenantId,
      pendingRole: pending.role,
    });
    return Object.freeze({ flowId: flow.flowId, expiresAt: flow.expiresAt, options });
  }

  async verifyRegistration(input) {
    const flow = this.store.consumeWebAuthnFlow(input?.flowId, 'signup');
    if (!validCredentialResponse(input?.response)) {
      throw authError('registration_failed', 'Passkey registration failed.');
    }
    let verification;
    try {
      verification = await this.webauthn.verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: flow.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw authError('registration_failed', 'Passkey registration failed.');
    }
    if (!verification?.verified || !verification.registrationInfo) {
      throw authError('registration_failed', 'Passkey registration failed.');
    }
    const created = this.store.completeSignup(
      flow,
      passkeyFromRegistration(verification.registrationInfo, input.label),
    );
    const session = this.store.createSession(created.user.id, {
      activeTenantId: created.membership.tenantId,
    });
    return webSessionResult(session, this.store.recoveryCodeStatus(created.user.id));
  }

  async authenticationOptions() {
    const options = await this.webauthn.generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: [],
      userVerification: 'required',
    });
    const flow = this.store.createWebAuthnFlow({
      type: 'login',
      challenge: options.challenge,
    });
    return Object.freeze({ flowId: flow.flowId, expiresAt: flow.expiresAt, options });
  }

  async verifyAuthentication(input) {
    const flow = this.store.consumeWebAuthnFlow(input?.flowId, 'login');
    if (!validCredentialResponse(input?.response)) {
      throw authError('authentication_failed', 'Passkey authentication failed.');
    }
    const passkey = this.store.getPasskey(input.response.id);
    if (!passkey) throw authError('authentication_failed', 'Passkey authentication failed.');
    const user = this.store.getUser(passkey.userId);
    const userHandle = input.response.response.userHandle;
    if (!user || !base64urlEqual(userHandle, user.webauthnUserId)) {
      throw authError('authentication_failed', 'Passkey authentication failed.');
    }
    let verification;
    try {
      verification = await this.webauthn.verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: flow.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: passkey.counter,
          transports: passkey.transports,
        },
        requireUserVerification: true,
      });
    } catch {
      throw authError('authentication_failed', 'Passkey authentication failed.');
    }
    if (!verification?.verified || !verification.authenticationInfo) {
      throw authError('authentication_failed', 'Passkey authentication failed.');
    }
    const authenticated = this.store.completePasskeyAuthentication(
      passkey.id,
      passkey.counter,
      verification.authenticationInfo,
    );
    const session = this.store.createSession(authenticated.userId);
    return webSessionResult(
      session,
      this.store.recoveryCodeStatus(authenticated.userId),
    );
  }

  session(sessionToken, options = {}) {
    if (options.rotateCsrf === false) {
      const authenticated = this.store.authenticateSession(sessionToken);
      const recoveryStatus = this.store.recoveryCodeStatus(authenticated.user.id);
      return Object.freeze({
        authenticated: true,
        ...authenticated,
        activeTenantId: authenticated.session.activeTenantId,
        recoveryCodesConfigured: recoveryStatus.configured,
        recoveryCodesConfirmed: recoveryStatus.confirmed,
      });
    }
    const authenticated = this.store.rotateCsrf(sessionToken);
    const recoveryStatus = this.store.recoveryCodeStatus(authenticated.user.id);
    return Object.freeze({
      authenticated: true,
      ...authenticated,
      activeTenantId: authenticated.session.activeTenantId,
      recoveryCodesConfigured: recoveryStatus.configured,
      recoveryCodesConfirmed: recoveryStatus.confirmed,
    });
  }

  verifyCsrf(sessionToken, csrfToken) {
    return this.store.verifyCsrf(sessionToken, csrfToken);
  }

  requireRecentAuthentication(sessionToken, options = {}) {
    const authenticated = this.store.authenticateSession(sessionToken);
    const maximumAgeMs = options.maximumAgeMs ?? this.recentAuthenticationMs;
    if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 1_000) {
      throw new Error('Recent-authentication maximum age must be at least one second');
    }
    const reauthenticatedAt = Date.parse(authenticated.session.reauthenticatedAt);
    if (
      authenticated.session.recoveryRequired
      || !Number.isFinite(reauthenticatedAt)
      || this.clock() - reauthenticatedAt > maximumAgeMs
    ) {
      throw authError('reauthentication_required', 'Passkey reauthentication is required.', 401);
    }
    return authenticated;
  }

  async reauthenticationOptions(input) {
    const authenticated = this.store.verifyCsrf(input?.sessionToken, input?.csrfToken);
    if (authenticated.session.recoveryRequired) {
      throw authError('recovery_passkey_required', 'Register a new passkey to finish account recovery.', 403);
    }
    const passkeys = this.store.listPasskeys(authenticated.user.id);
    if (passkeys.length === 0) throw authError('authentication_failed', 'Passkey authentication failed.');
    const options = await this.webauthn.generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports,
      })),
      userVerification: 'required',
    });
    const flow = this.store.createWebAuthnFlow({
      type: 'reauthenticate',
      userId: authenticated.user.id,
      sessionId: authenticated.session.id,
      challenge: options.challenge,
    });
    return Object.freeze({ flowId: flow.flowId, expiresAt: flow.expiresAt, options });
  }

  async verifyReauthentication(input) {
    const session = this.store.verifyCsrf(input?.sessionToken, input?.csrfToken);
    if (session.session.recoveryRequired) {
      throw authError('recovery_passkey_required', 'Register a new passkey to finish account recovery.', 403);
    }
    const flow = this.store.consumeWebAuthnFlow(input?.flowId, 'reauthenticate');
    if (
      flow.userId !== session.user.id
      || flow.sessionId !== session.session.id
      || !validCredentialResponse(input?.response)
    ) {
      throw authError('authentication_failed', 'Passkey authentication failed.');
    }
    const passkey = this.store.getPasskey(input.response.id);
    if (!passkey || passkey.userId !== session.user.id) {
      throw authError('authentication_failed', 'Passkey authentication failed.');
    }
    const userHandle = input.response.response.userHandle;
    if (userHandle !== undefined && userHandle !== null
      && !base64urlEqual(userHandle, session.user.webauthnUserId)) {
      throw authError('authentication_failed', 'Passkey authentication failed.');
    }
    let verification;
    try {
      verification = await this.webauthn.verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: flow.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: passkey.counter,
          transports: passkey.transports,
        },
        requireUserVerification: true,
      });
    } catch {
      throw authError('authentication_failed', 'Passkey authentication failed.');
    }
    if (!verification?.verified || !verification.authenticationInfo) {
      throw authError('authentication_failed', 'Passkey authentication failed.');
    }
    this.store.completePasskeyAuthentication(
      passkey.id,
      passkey.counter,
      verification.authenticationInfo,
    );
    return this.store.markSessionReauthenticated(input.sessionToken);
  }

  async passkeyRegistrationOptions(input) {
    const authenticated = this.store.verifyCsrf(input?.sessionToken, input?.csrfToken);
    if (!authenticated.session.recoveryRequired) {
      this.requireRecentAuthentication(input.sessionToken);
    }
    const passkeys = this.store.listPasskeys(authenticated.user.id);
    const options = await this.webauthn.generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpId,
      userID: Buffer.from(authenticated.user.webauthnUserId, 'base64url'),
      userName: authenticated.user.username,
      userDisplayName: authenticated.user.displayName,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      excludeCredentials: passkeys.map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports,
      })),
    });
    const flow = this.store.createPasskeyRegistrationFlow({
      sessionToken: input.sessionToken,
      userId: authenticated.user.id,
      challenge: options.challenge,
      label: input?.label ?? input?.name,
    });
    return Object.freeze({ ...flow, options, recovery: authenticated.session.recoveryRequired });
  }

  async verifyPasskeyRegistration(input) {
    const authenticated = this.store.verifyCsrf(input?.sessionToken, input?.csrfToken);
    if (!authenticated.session.recoveryRequired) {
      this.requireRecentAuthentication(input.sessionToken);
    }
    const flow = this.store.consumePasskeyRegistrationFlow(input?.flowId, {
      sessionToken: input?.sessionToken,
    });
    if (flow.userId !== authenticated.user.id || !validCredentialResponse(input?.response)) {
      throw authError('registration_failed', 'Passkey registration failed.');
    }
    let verification;
    try {
      verification = await this.webauthn.verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: flow.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw authError('registration_failed', 'Passkey registration failed.');
    }
    if (!verification?.verified || !verification.registrationInfo) {
      throw authError('registration_failed', 'Passkey registration failed.');
    }
    const passkey = this.store.addPasskey(
      authenticated.user.id,
      passkeyFromRegistration(verification.registrationInfo, flow.label),
    );
    const session = authenticated.session.recoveryRequired
      ? this.store.finishRecoverySession(input.sessionToken)
      : this.store.authenticateSession(input.sessionToken, { touch: false });
    return Object.freeze({
      registered: true,
      recovered: authenticated.session.recoveryRequired,
      requiresPasskey: false,
      passkey,
      session: session.session,
    });
  }

  createRecoveryCodes(input) {
    const authenticated = this.store.verifyCsrf(input?.sessionToken, input?.csrfToken);
    this.requireRecentAuthentication(input.sessionToken);
    return this.store.createRecoveryCodes(authenticated.user.id, { count: input?.count });
  }

  confirmRecoveryCodes(input) {
    const authenticated = this.store.verifyCsrf(input?.sessionToken, input?.csrfToken);
    this.requireRecentAuthentication(input.sessionToken);
    return this.store.confirmRecoveryCodes(
      authenticated.user.id,
      input?.confirmationId,
    );
  }

  useRecoveryCode(input) {
    const recovered = this.store.consumeRecoveryCode(input?.code);
    const session = this.store.createSession(recovered.user.id, {
      activeTenantId: recovered.memberships[0]?.tenantId,
      recoveryRequired: true,
    });
    return webSessionResult(
      session,
      this.store.recoveryCodeStatus(recovered.user.id),
    );
  }

  logout(sessionToken, csrfToken) {
    this.store.verifyCsrf(sessionToken, csrfToken);
    this.store.revokeSession(sessionToken);
    return Object.freeze({ loggedOut: true });
  }
}
