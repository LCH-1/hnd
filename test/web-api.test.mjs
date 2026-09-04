import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  decryptBytes,
  encryptBytes,
  encryptSnapshot,
  generateVaultKey,
} from '../src/sync/crypto.mjs';
import { createSyncServer } from '../src/sync/server.mjs';
import { parseDeviceInvite } from '../src/remote-cli.mjs';
import { DEFAULT_SERVER_MASTER_KEY_FILENAME } from '../src/sync/store.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hnd-web-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let sequence = 0;
  const webauthn = {
    async generateRegistrationOptions(options) {
      sequence += 1;
      return {
        challenge: `registration_challenge_${sequence}`,
        rp: { id: options.rpID, name: options.rpName },
        user: {
          id: Buffer.from(options.userID).toString('base64url'),
          name: options.userName,
          displayName: options.userDisplayName,
        },
        authenticatorSelection: options.authenticatorSelection,
      };
    },
    async verifyRegistrationResponse(options) {
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: options.response.id,
            publicKey: new Uint8Array([1, 2, 3, 4]),
            counter: 0,
            transports: ['internal'],
          },
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
        },
      };
    },
    async generateAuthenticationOptions(options) {
      sequence += 1;
      return {
        challenge: `authentication_challenge_${sequence}`,
        rpId: options.rpID,
        allowCredentials: options.allowCredentials,
        userVerification: options.userVerification,
      };
    },
    async verifyAuthenticationResponse(options) {
      return {
        verified: true,
        authenticationInfo: {
          newCounter: options.credential.counter + 1,
          credentialBackedUp: true,
        },
      };
    },
  };
  const server = await createSyncServer({
    dataDirectory: path.join(root, 'data'),
    publicOrigin: 'http://localhost',
    rpId: 'localhost',
    webauthn,
    maxBlobBytes: 64 * 1024,
    clock: options.clock,
    signupMode: options.signupMode,
    trustProxy: options.trustProxy ?? true,
  });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  return { root, server, url: address.url };
}

async function jsonRequest(url, pathname, options = {}) {
  const response = await fetch(`${url}${pathname}`, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  });
  const body = await response.json();
  return { response, body };
}

function mutationHeaders(values = {}) {
  return {
    Origin: 'http://localhost',
    'Content-Type': 'application/json',
    ...values,
  };
}

async function registerOwner(server, url, credentialId = 'owner_credential') {
  const registration = await jsonRequest(url, '/api/web/auth/register/options', {
    method: 'POST',
    headers: mutationHeaders(),
    body: { username: 'owner', displayName: 'Owner' },
  });
  assert.equal(registration.response.status, 200);
  const verified = await jsonRequest(url, '/api/web/auth/register/verify', {
    method: 'POST',
    headers: mutationHeaders(),
    body: {
      flowId: registration.body.flowId,
      response: { id: credentialId, response: { clientDataJSON: 'test' } },
    },
  });
  assert.equal(verified.response.status, 200);
  return {
    body: verified.body,
    cookie: verified.response.headers.get('set-cookie').split(';', 1)[0],
    csrf: verified.response.headers.get('x-hnd-csrf'),
  };
}

async function registerInvitedUser(url, owner, { username, role }) {
  const invitation = await jsonRequest(url, '/api/web/account/invites', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { role, ttlSeconds: 3600 },
  });
  assert.equal(invitation.response.status, 201);
  const registration = await jsonRequest(url, '/api/web/auth/register/options', {
    method: 'POST',
    headers: mutationHeaders(),
    body: { username, displayName: username, code: invitation.body.code },
  });
  assert.equal(registration.response.status, 200);
  const verified = await jsonRequest(url, '/api/web/auth/register/verify', {
    method: 'POST',
    headers: mutationHeaders(),
    body: {
      flowId: registration.body.flowId,
      response: { id: `${username}_credential`, response: { clientDataJSON: 'test' } },
    },
  });
  assert.equal(verified.response.status, 200);
  return {
    body: verified.body,
    cookie: verified.response.headers.get('set-cookie').split(';', 1)[0],
    csrf: verified.response.headers.get('x-hnd-csrf'),
  };
}

test('web API defaults to open registration without an invitation', async (t) => {
  const { url } = await fixture(t);
  const initial = await jsonRequest(url, '/api/web/auth/session');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.signup.mode, 'open');
  assert.equal(initial.body.signup.allowed, true);
  assert.equal(initial.body.signup.requiresCode, false);
});

test('web API drives first-owner setup, hashed session recovery, vault, and PC enrollment', async (t) => {
  const { root, server, url } = await fixture(t, { signupMode: 'first-user' });
  const initial = await jsonRequest(url, '/api/web/auth/session');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.authenticated, false);
  assert.equal(initial.body.needsOwnerSetup, true);
  assert.equal(initial.body.signup.mode, 'first-user');
  assert.equal(initial.body.signup.requiresCode, false);

  const registration = await jsonRequest(url, '/api/web/auth/register/options', {
    method: 'POST',
    headers: mutationHeaders(),
    body: { username: 'owner', displayName: 'Owner' },
  });
  assert.equal(registration.response.status, 200);
  assert.match(registration.body.flowId, /^hndf_/);
  assert.equal(registration.body.options.authenticatorSelection.userVerification, 'required');

  const verified = await jsonRequest(url, '/api/web/auth/register/verify', {
    method: 'POST',
    headers: mutationHeaders(),
    body: {
      flowId: registration.body.flowId,
      response: { id: 'owner_credential', response: { clientDataJSON: 'test' } },
    },
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.authenticated, true);
  assert.equal('sessionToken' in verified.body, false);
  const cookie = verified.response.headers.get('set-cookie').split(';', 1)[0];
  assert.match(cookie, /^__Host-hnd_session=hnds_/);
  let csrf = verified.response.headers.get('x-hnd-csrf');
  assert.match(csrf, /^hndc_/);

  const session = await jsonRequest(url, '/api/web/auth/session', {
    headers: { Cookie: cookie },
  });
  assert.equal(session.body.user.username, 'owner');
  assert.equal(session.body.recoveryCodesConfigured, false);
  csrf = session.response.headers.get('x-hnd-csrf');

  const recovery = await jsonRequest(url, '/api/web/recovery/codes', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: cookie, 'X-Hnd-CSRF': csrf }),
    body: { count: 4 },
  });
  assert.equal(recovery.response.status, 201);
  assert.equal(recovery.body.codes.length, 4);
  assert.match(recovery.body.codes[0], /^hndr_/);
  const configuredSession = await jsonRequest(url, '/api/web/auth/session', {
    headers: { Cookie: cookie },
  });
  assert.equal(configuredSession.body.recoveryCodesConfigured, true);
  assert.equal(configuredSession.body.recoveryCodesConfirmed, false);
  csrf = configuredSession.response.headers.get('x-hnd-csrf');
  const confirmedRecovery = await jsonRequest(url, '/api/web/recovery/confirm', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: cookie, 'X-Hnd-CSRF': csrf }),
    body: { confirmationId: recovery.body.confirmationId },
  });
  assert.equal(confirmedRecovery.response.status, 200);
  assert.equal(confirmedRecovery.body.confirmed, true);
  const confirmedSession = await jsonRequest(url, '/api/web/auth/session', {
    headers: { Cookie: cookie },
  });
  assert.equal(confirmedSession.body.recoveryCodesConfirmed, true);
  csrf = confirmedSession.response.headers.get('x-hnd-csrf');

  const vaultKey = generateVaultKey();
  const encrypted = encryptSnapshot({ schemaVersion: 1, files: [] }, vaultKey);
  const initialized = await jsonRequest(url, '/api/web/vault/initialize', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: cookie, 'X-Hnd-CSRF': csrf }),
    body: {
      version: 1,
      algorithm: 'AES-256-GCM',
      browserStorage: 'indexeddb-wrapped',
      snapshot: encrypted.toString('base64url'),
    },
  });
  assert.equal(initialized.response.status, 201);
  assert.match(initialized.body.etag, /^"[a-f0-9]{64}"$/);

  const snapshot = await jsonRequest(url, '/api/web/vault/snapshot', {
    headers: { Cookie: cookie },
  });
  assert.equal(snapshot.body.snapshot, encrypted.toString('base64url'));

  const adopted = await jsonRequest(url, '/api/web/vault/key/adopt', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: cookie, 'X-Hnd-CSRF': csrf }),
    body: { vaultKey: vaultKey.toString('base64url') },
  });
  assert.equal(adopted.response.status, 201);
  assert.equal(adopted.body.keyManaged, true);

  const connection = await jsonRequest(url, '/api/web/connections', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: cookie, 'X-Hnd-CSRF': csrf }),
    body: { ttlSeconds: 900 },
  });
  assert.equal(connection.response.status, 201);
  assert.match(connection.body.connectionCode, /^hndj_/);
  assert.match(connection.body.connectionId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  const parsedConnection = parseDeviceInvite(connection.body.connectionCode);
  const databaseBytes = await fs.readFile(path.join(root, 'data', 'hnd.sqlite'));
  assert.equal(databaseBytes.includes(vaultKey), false);
  assert.equal(databaseBytes.includes(parsedConnection.secret), false);
  assert.equal(
    databaseBytes.includes(Buffer.from(parsedConnection.invitationToken, 'utf8')),
    false,
  );

  const joinedFromBrowser = await jsonRequest(url, '/v1/join', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${parsedConnection.invitationToken}`,
      'X-Hnd-Device-Name': 'browser-invited-pc',
    },
  });
  assert.equal(joinedFromBrowser.response.status, 201);
  assert.equal(joinedFromBrowser.body.device.name, 'browser-invited-pc');
  assert.equal(joinedFromBrowser.body.device.tenantId, verified.body.activeTenantId);
  assert.deepEqual(
    decryptBytes(Buffer.from(joinedFromBrowser.body.wrappedVaultKey, 'base64'), parsedConnection.secret),
    vaultKey,
  );
  const replayedBrowserInvitation = await jsonRequest(url, '/v1/join', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${parsedConnection.invitationToken}`,
      'X-Hnd-Device-Name': 'replay',
    },
  });
  assert.equal(replayedBrowserInvitation.response.status, 401);

  const issued = await jsonRequest(url, '/api/web/enrollments', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: cookie, 'X-Hnd-CSRF': csrf }),
    body: { name: 'laptop', ttlSeconds: 900 },
  });
  assert.equal(issued.response.status, 201);
  assert.match(issued.body.enrollmentKey, /^hnde_/);
  const enrolled = await jsonRequest(url, '/v1/enroll', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${issued.body.enrollmentKey}`,
      'X-Hnd-Device-Name': 'laptop',
    },
  });
  assert.equal(enrolled.response.status, 201);

  const enrollmentStatus = await jsonRequest(url, `/api/web/enrollments/${issued.body.enrollmentId}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(enrollmentStatus.body.consumed, true);
  assert.equal(enrollmentStatus.body.device.name, 'laptop');

  const overview = await jsonRequest(url, '/api/web/overview', { headers: { Cookie: cookie } });
  assert.equal(overview.body.deviceCount, 2);
  assert.equal(overview.body.revisionCount, 1);

  const recovered = await jsonRequest(url, '/api/web/recovery/use', {
    method: 'POST',
    headers: mutationHeaders(),
    body: { code: recovery.body.codes[0] },
  });
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.body.user.username, 'owner');
  assert.equal(recovered.body.requiresPasskey, true);
  assert.equal(recovered.body.onboarding.recovery, true);
  assert.equal(recovered.body.recoveryCodesConfirmed, false);
  const recoveredCookie = recovered.response.headers.get('set-cookie').split(';', 1)[0];
  const recoveredCsrf = recovered.response.headers.get('x-hnd-csrf');
  assert.notEqual(recoveredCookie, cookie);

  const blockedVault = await jsonRequest(url, '/api/web/vault/status', {
    headers: { Cookie: recoveredCookie },
  });
  assert.equal(blockedVault.response.status, 403);
  assert.equal(blockedVault.body.error, 'recovery_passkey_required');

  const recoveryPasskey = await jsonRequest(url, '/api/web/security/passkeys/options', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: recoveredCookie, 'X-Hnd-CSRF': recoveredCsrf }),
    body: { name: 'Recovered key' },
  });
  assert.equal(recoveryPasskey.response.status, 200);
  assert.equal(recoveryPasskey.body.recovery, true);
  const recoveryVerified = await jsonRequest(url, '/api/web/security/passkeys/verify', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: recoveredCookie, 'X-Hnd-CSRF': recoveredCsrf }),
    body: {
      flowId: recoveryPasskey.body.flowId,
      response: { id: 'recovered_credential', response: { clientDataJSON: 'test' } },
    },
  });
  assert.equal(recoveryVerified.response.status, 201);
  assert.equal(recoveryVerified.body.recovered, true);
  assert.equal(recoveryVerified.body.requiresPasskey, false);
  assert.equal('publicKey' in recoveryVerified.body.passkey, false);

  const unlockedVault = await jsonRequest(url, '/api/web/vault/status', {
    headers: { Cookie: recoveredCookie },
  });
  assert.equal(unlockedVault.response.status, 200);
  assert.equal(unlockedVault.body.initialized, true);

  const oldSession = await jsonRequest(url, '/api/web/auth/session', { headers: { Cookie: cookie } });
  assert.equal(oldSession.body.authenticated, false);
});

test('web mutations require exact Origin and CSRF while public session state remains readable', async (t) => {
  const { server, url } = await fixture(t);
  const bootstrap = await server.createBootstrapCode();
  const wrongOrigin = await jsonRequest(url, '/api/web/auth/register/options', {
    method: 'POST',
    headers: mutationHeaders({ Origin: 'https://evil.example' }),
    body: { username: 'owner', displayName: 'Owner', code: bootstrap.code },
  });
  assert.equal(wrongOrigin.response.status, 403);
  assert.equal(wrongOrigin.body.error, 'invalid_origin');

  const missingJsonType = await jsonRequest(url, '/api/web/auth/login/options', {
    method: 'POST',
    headers: { Origin: 'http://localhost' },
    body: {},
  });
  assert.equal(missingJsonType.response.status, 415);

  const loginOptions = await jsonRequest(url, '/api/web/auth/login/options', {
    method: 'POST',
    headers: mutationHeaders(),
    body: {},
  });
  assert.equal(loginOptions.response.status, 200);
  assert.match(loginOptions.body.flowId, /^hndf_/);
});

test('legacy device-delegated invitation issuance is retired with account connection guidance', async (t) => {
  const { url } = await fixture(t);
  for (const pathname of ['/api/web/device-invitations', '/v1/invitations']) {
    const retired = await jsonRequest(url, pathname, {
      method: 'POST',
      headers: mutationHeaders(),
      body: {},
    });
    assert.equal(retired.response.status, 410);
    assert.equal(retired.body.error, 'device_delegation_retired');
    assert.equal(retired.body.connect, '/api/web/connections');
  }
});

test('account-managed vault keys enforce custody boundaries and gate browser snapshot writes', async (t) => {
  const { url } = await fixture(t);
  const owner = await registerOwner(null, url);
  const vaultKey = generateVaultKey();
  const initialEnvelope = encryptSnapshot({ schemaVersion: 1, files: [] }, vaultKey);
  const initialized = await jsonRequest(url, '/api/web/vault/initialize', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: {
      version: 1,
      algorithm: 'AES-256-GCM',
      snapshot: initialEnvelope.toString('base64url'),
    },
  });
  assert.equal(initialized.response.status, 201);

  const legacyStatus = await jsonRequest(url, '/api/web/vault/status', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(legacyStatus.body.keyManaged, false);
  const unavailable = await jsonRequest(url, '/api/web/vault/key/unlock', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: {},
  });
  assert.equal(unavailable.response.status, 409);
  assert.equal(unavailable.body.error, 'legacy_vault_key_unavailable');

  const blockedWrite = await jsonRequest(url, '/api/web/vault/snapshot', {
    method: 'PUT',
    headers: mutationHeaders({
      Cookie: owner.cookie,
      'X-Hnd-CSRF': owner.csrf,
      'If-Match': initialized.body.etag,
    }),
    body: { snapshot: initialEnvelope.toString('base64url') },
  });
  assert.equal(blockedWrite.response.status, 409);
  assert.equal(blockedWrite.body.error, 'legacy_vault_key_unavailable');

  const wrongOrigin = await jsonRequest(url, '/api/web/vault/key/adopt', {
    method: 'POST',
    headers: mutationHeaders({
      Origin: 'https://evil.example',
      Cookie: owner.cookie,
      'X-Hnd-CSRF': owner.csrf,
    }),
    body: { vaultKey: vaultKey.toString('base64url') },
  });
  assert.equal(wrongOrigin.response.status, 403);
  assert.equal(wrongOrigin.body.error, 'invalid_origin');
  const missingCsrf = await jsonRequest(url, '/api/web/vault/key/adopt', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie }),
    body: { vaultKey: vaultKey.toString('base64url') },
  });
  assert.equal(missingCsrf.response.status, 403);
  const unexpected = await jsonRequest(url, '/api/web/vault/key/adopt', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { vaultKey: vaultKey.toString('base64url'), rawKey: 'forbidden' },
  });
  assert.equal(unexpected.response.status, 400);
  assert.equal(unexpected.body.error, 'invalid_request');
  const wrongKey = await jsonRequest(url, '/api/web/vault/key/adopt', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { vaultKey: generateVaultKey().toString('base64url') },
  });
  assert.equal(wrongKey.response.status, 400);
  assert.equal(wrongKey.body.error, 'invalid_vault_key');

  const member = await registerInvitedUser(url, owner, {
    username: 'managed_key_member',
    role: 'member',
  });
  const memberAdopt = await jsonRequest(url, '/api/web/vault/key/adopt', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: member.cookie, 'X-Hnd-CSRF': member.csrf }),
    body: { vaultKey: vaultKey.toString('base64url') },
  });
  assert.equal(memberAdopt.response.status, 403);

  const adopted = await jsonRequest(url, '/api/web/vault/key/adopt', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { vaultKey: vaultKey.toString('base64url') },
  });
  assert.equal(adopted.response.status, 201);
  assert.deepEqual(adopted.body, { created: true, keyManaged: true });
  const adoptedAgain = await jsonRequest(url, '/api/web/vault/key/adopt', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { vaultKey: vaultKey.toString('base64url') },
  });
  assert.equal(adoptedAgain.response.status, 200);
  assert.equal(adoptedAgain.body.created, false);

  const managedStatus = await jsonRequest(url, '/api/web/vault/status', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(managedStatus.body.keyManaged, true);
  const unlockWrongOrigin = await jsonRequest(url, '/api/web/vault/key/unlock', {
    method: 'POST',
    headers: mutationHeaders({
      Origin: 'https://evil.example',
      Cookie: member.cookie,
      'X-Hnd-CSRF': member.csrf,
    }),
    body: {},
  });
  assert.equal(unlockWrongOrigin.response.status, 403);
  assert.equal(unlockWrongOrigin.body.error, 'invalid_origin');
  const unlockMissingCsrf = await jsonRequest(url, '/api/web/vault/key/unlock', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: member.cookie }),
    body: {},
  });
  assert.equal(unlockMissingCsrf.response.status, 403);
  const memberUnlock = await jsonRequest(url, '/api/web/vault/key/unlock', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: member.cookie, 'X-Hnd-CSRF': member.csrf }),
    body: {},
  });
  assert.equal(memberUnlock.response.status, 200);
  assert.equal(memberUnlock.body.vaultKey, vaultKey.toString('base64url'));

  const invalidConnection = await jsonRequest(url, '/api/web/connections', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: member.cookie, 'X-Hnd-CSRF': member.csrf }),
    body: { ttlSeconds: 59 },
  });
  assert.equal(invalidConnection.response.status, 400);
  assert.equal(invalidConnection.body.error, 'invalid_ttl');
  const connectionMissingCsrf = await jsonRequest(url, '/api/web/connections', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: member.cookie }),
    body: { ttlSeconds: 900 },
  });
  assert.equal(connectionMissingCsrf.response.status, 403);
  const memberConnection = await jsonRequest(url, '/api/web/connections', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: member.cookie, 'X-Hnd-CSRF': member.csrf }),
    body: { ttlSeconds: 900 },
  });
  assert.equal(memberConnection.response.status, 201);
  const parsed = parseDeviceInvite(memberConnection.body.connectionCode);
  const joined = await jsonRequest(url, '/v1/join', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${parsed.invitationToken}`,
      'X-Hnd-Device-Name': 'member-account-pc',
    },
  });
  assert.equal(joined.response.status, 201);
  const joinedKey = decryptBytes(
    Buffer.from(joined.body.wrappedVaultKey, 'base64'),
    parsed.secret,
    { maxBytes: 32 },
  );
  assert.deepEqual(joinedKey, vaultKey);
  joinedKey.fill(0);
  parsed.secret.fill(0);
  vaultKey.fill(0);
});

test('vault-key adoption is rate limited before expensive decryption work', async (t) => {
  const { url } = await fixture(t);
  const owner = await registerOwner(null, url);
  const vaultKey = generateVaultKey();
  const initialized = await jsonRequest(url, '/api/web/vault/initialize', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: {
      version: 1,
      algorithm: 'AES-256-GCM',
      snapshot: encryptSnapshot({ schemaVersion: 1, files: [] }, vaultKey).toString('base64url'),
    },
  });
  assert.equal(initialized.response.status, 201);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rejected = await jsonRequest(url, '/api/web/vault/key/adopt', {
      method: 'POST',
      headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
      body: { vaultKey: generateVaultKey().toString('base64url') },
    });
    assert.equal(rejected.response.status, 400);
  }
  const limited = await jsonRequest(url, '/api/web/vault/key/adopt', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { vaultKey: vaultKey.toString('base64url') },
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  vaultKey.fill(0);
});

test('runtime master-key loss degrades health and closes every account-key API without data loss', async (t) => {
  const { root, url } = await fixture(t);
  const owner = await registerOwner(null, url);
  const vaultKey = generateVaultKey();
  const initialEnvelope = encryptSnapshot({ schemaVersion: 1, files: [] }, vaultKey);
  const initialized = await jsonRequest(url, '/api/web/vault/initialize', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: {
      version: 1,
      algorithm: 'AES-256-GCM',
      snapshot: initialEnvelope.toString('base64url'),
    },
  });
  assert.equal(initialized.response.status, 201);
  const adopted = await jsonRequest(url, '/api/web/vault/key/adopt', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { vaultKey: vaultKey.toString('base64url') },
  });
  assert.equal(adopted.response.status, 201);

  const masterKeyPath = path.join(root, 'data', DEFAULT_SERVER_MASTER_KEY_FILENAME);
  const originalMasterKey = await fs.readFile(masterKeyPath);
  await fs.rm(masterKeyPath);

  const health = await jsonRequest(url, '/healthz');
  assert.equal(health.response.status, 503);
  assert.deepEqual(health.body, {
    ok: false,
    status: 'degraded',
    component: 'server-vault-key',
  });
  const status = await jsonRequest(url, '/api/web/vault/status', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(status.response.status, 503);
  assert.equal(status.body.error, 'vault_key_service_unavailable');

  for (const [pathname, body] of [
    ['/api/web/vault/key/unlock', {}],
    ['/api/web/vault/key/adopt', { vaultKey: vaultKey.toString('base64url') }],
    ['/api/web/connections', { ttlSeconds: 900 }],
  ]) {
    const unavailable = await jsonRequest(url, pathname, {
      method: 'POST',
      headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
      body,
    });
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.error, 'vault_key_service_unavailable');
  }

  const blockedWrite = await jsonRequest(url, '/api/web/vault/snapshot', {
    method: 'PUT',
    headers: mutationHeaders({
      Cookie: owner.cookie,
      'X-Hnd-CSRF': owner.csrf,
      'If-Match': initialized.body.etag,
    }),
    body: {
      snapshot: encryptSnapshot({ schemaVersion: 1, files: [] }, vaultKey).toString('base64url'),
    },
  });
  assert.equal(blockedWrite.response.status, 503);
  assert.equal(blockedWrite.body.error, 'vault_key_service_unavailable');
  const unchanged = await jsonRequest(url, '/api/web/vault/snapshot', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(unchanged.response.status, 200);
  assert.equal(unchanged.body.etag, initialized.body.etag);
  assert.equal(unchanged.body.snapshot, initialEnvelope.toString('base64url'));

  await fs.writeFile(masterKeyPath, originalMasterKey, { mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(masterKeyPath, 0o600);
  const recovered = await jsonRequest(url, '/healthz');
  assert.equal(recovered.response.status, 200);
  assert.deepEqual(recovered.body, { ok: true });
  const recoveredStatus = await jsonRequest(url, '/api/web/vault/status', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(recoveredStatus.response.status, 200);
  assert.equal(recoveredStatus.body.keyManaged, true);

  originalMasterKey.fill(0);
  vaultKey.fill(0);
});

test('vault reset requires owner reauthentication and replaces only an owner vault', async (t) => {
  const { root, url } = await fixture(t);
  const owner = await registerOwner(null, url);
  const vaultKey = generateVaultKey();
  const initialEnvelope = encryptSnapshot(
    { schemaVersion: 1, files: [] },
    vaultKey,
  );
  const initialized = await jsonRequest(url, '/api/web/vault/initialize', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: {
      version: 1,
      algorithm: 'AES-256-GCM',
      snapshot: initialEnvelope.toString('base64url'),
    },
  });
  assert.equal(initialized.response.status, 201);

  const member = await registerInvitedUser(url, owner, {
    username: 'reset_member',
    role: 'member',
  });
  const admin = await registerInvitedUser(url, owner, {
    username: 'reset_admin',
    role: 'admin',
  });
  const resetEnvelope = encryptSnapshot({ schemaVersion: 1, files: [] }, generateVaultKey());
  const validBody = {
    version: 1,
    algorithm: 'AES-256-GCM',
    snapshot: resetEnvelope.toString('base64url'),
    confirmation: 'RESET_VAULT',
  };

  const unauthenticated = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({ 'If-Match': initialized.body.etag }),
    body: validBody,
  });
  assert.equal(unauthenticated.response.status, 401);

  const wrongOrigin = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({
      Cookie: owner.cookie,
      'X-Hnd-CSRF': owner.csrf,
      'If-Match': initialized.body.etag,
      Origin: 'https://evil.example',
    }),
    body: validBody,
  });
  assert.equal(wrongOrigin.response.status, 403);
  assert.equal(wrongOrigin.body.error, 'invalid_origin');

  const missingCsrf = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'If-Match': initialized.body.etag }),
    body: validBody,
  });
  assert.equal(missingCsrf.response.status, 403);

  for (const account of [member, admin]) {
    const forbidden = await jsonRequest(url, '/api/web/vault/reset', {
      method: 'POST',
      headers: mutationHeaders({
        Cookie: account.cookie,
        'X-Hnd-CSRF': account.csrf,
        'If-Match': initialized.body.etag,
      }),
      body: validBody,
    });
    assert.equal(forbidden.response.status, 403);
    assert.equal(forbidden.body.error, 'forbidden');
  }

  const rawVaultKey = generateVaultKey().toString('base64url');
  const rawSecretAttempt = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({
      Cookie: owner.cookie,
      'X-Hnd-CSRF': owner.csrf,
      'If-Match': initialized.body.etag,
    }),
    body: { ...validBody, vaultKey: rawVaultKey },
  });
  assert.equal(rawSecretAttempt.response.status, 400);
  assert.equal(rawSecretAttempt.body.error, 'invalid_request');
  assert.equal(
    (await fs.readFile(path.join(root, 'data', 'hnd.sqlite'))).includes(Buffer.from(rawVaultKey)),
    false,
  );

  const missingIfMatch = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: validBody,
  });
  assert.equal(missingIfMatch.response.status, 428);
  assert.equal(missingIfMatch.body.error, 'precondition_required');
  assert.equal(missingIfMatch.response.headers.get('etag'), initialized.body.etag);

  const stale = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({
      Cookie: owner.cookie,
      'X-Hnd-CSRF': owner.csrf,
      'If-Match': `"${'0'.repeat(64)}"`,
    }),
    body: validBody,
  });
  assert.equal(stale.response.status, 412);
  assert.equal(stale.body.error, 'precondition_failed');
  assert.equal(stale.response.headers.get('etag'), initialized.body.etag);

  const enrollment = await jsonRequest(url, '/api/web/enrollments', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { ttlSeconds: 900 },
  });
  const enrolled = await jsonRequest(url, '/v1/enroll', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${enrollment.body.enrollmentKey}`,
      'X-Hnd-Device-Name': 'reset-blocker',
    },
  });
  assert.equal(enrolled.response.status, 201);
  const blocked = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({
      Cookie: owner.cookie,
      'X-Hnd-CSRF': owner.csrf,
      'If-Match': initialized.body.etag,
    }),
    body: validBody,
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error, 'active_devices_present');
  assert.equal(blocked.body.activeDeviceCount, 1);
  const stillLegacy = await jsonRequest(url, '/api/web/vault/status', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(stillLegacy.body.keyManaged, false);

  const revoked = await jsonRequest(url, `/api/web/devices/${enrolled.body.device.id}/revoke`, {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: {},
  });
  assert.equal(revoked.response.status, 200);

  const reset = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({
      Cookie: owner.cookie,
      'X-Hnd-CSRF': owner.csrf,
      'If-Match': initialized.body.etag,
    }),
    body: validBody,
  });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.body.reset, true);
  assert.match(reset.body.revisionId, /^[a-f0-9]{64}$/);
  assert.equal(reset.response.headers.get('etag'), reset.body.etag);
  const resetStatus = await jsonRequest(url, '/api/web/vault/status', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(resetStatus.body.keyManaged, false);
  const snapshot = await jsonRequest(url, '/api/web/vault/snapshot', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(snapshot.body.snapshot, resetEnvelope.toString('base64url'));
  const members = await jsonRequest(url, '/api/web/account/members', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(members.response.status, 200);
  assert.deepEqual(
    members.body.members.map((memberEntry) => memberEntry.role).sort(),
    ['admin', 'member', 'owner'],
  );
});

test('legacy web reset cannot erase a vault adopted after a stale status check', async (t) => {
  const { url } = await fixture(t);
  const owner = await registerOwner(null, url);
  const vaultKey = generateVaultKey();
  const initialEnvelope = encryptSnapshot(
    { schemaVersion: 1, files: [] },
    vaultKey,
  );
  const initialized = await jsonRequest(url, '/api/web/vault/initialize', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: {
      version: 1,
      algorithm: 'AES-256-GCM',
      snapshot: initialEnvelope.toString('base64url'),
    },
  });
  assert.equal(initialized.response.status, 201);

  const staleStatus = await jsonRequest(url, '/api/web/vault/status', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(staleStatus.response.status, 200);
  assert.equal(staleStatus.body.keyManaged, false);

  const adopted = await jsonRequest(url, '/api/web/vault/key/adopt', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { vaultKey: vaultKey.toString('base64url') },
  });
  assert.equal(adopted.response.status, 201);

  const resetKey = generateVaultKey();
  const resetEnvelope = encryptSnapshot({ schemaVersion: 1, files: [] }, resetKey);
  const rejected = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({
      Cookie: owner.cookie,
      'X-Hnd-CSRF': owner.csrf,
      'If-Match': initialized.body.etag,
    }),
    body: {
      version: 1,
      algorithm: 'AES-256-GCM',
      snapshot: resetEnvelope.toString('base64url'),
      confirmation: 'RESET_VAULT',
    },
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error, 'vault_already_managed');
  assert.equal(rejected.response.headers.get('etag'), initialized.body.etag);

  const snapshot = await jsonRequest(url, '/api/web/vault/snapshot', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(snapshot.response.status, 200);
  assert.equal(snapshot.body.etag, initialized.body.etag);
  assert.equal(snapshot.body.snapshot, initialEnvelope.toString('base64url'));
  const status = await jsonRequest(url, '/api/web/vault/status', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(status.response.status, 200);
  assert.equal(status.body.keyManaged, true);
  const revisions = await jsonRequest(url, '/api/web/revisions', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(revisions.response.status, 200);
  assert.equal(revisions.body.revisions.length, 1);

  vaultKey.fill(0);
  resetKey.fill(0);
});

test('vault reset rejects an uninitialized vault and a stale passkey session', async (t) => {
  let now = Date.parse('2026-08-31T00:00:00.000Z');
  const { url } = await fixture(t, { clock: () => now });
  const owner = await registerOwner(null, url);
  const resetEnvelope = encryptSnapshot({ schemaVersion: 1, files: [] }, generateVaultKey());
  const resetBody = {
    version: 1,
    algorithm: 'AES-256-GCM',
    snapshot: resetEnvelope.toString('base64url'),
    confirmation: 'RESET_VAULT',
  };
  const missingPrecondition = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: resetBody,
  });
  assert.equal(missingPrecondition.response.status, 428);
  assert.equal(missingPrecondition.body.error, 'precondition_required');
  const absent = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({
      Cookie: owner.cookie,
      'X-Hnd-CSRF': owner.csrf,
      'If-Match': `"${'0'.repeat(64)}"`,
    }),
    body: resetBody,
  });
  assert.equal(absent.response.status, 409);
  assert.equal(absent.body.error, 'vault_not_initialized');

  const initialized = await jsonRequest(url, '/api/web/vault/initialize', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: {
      version: 1,
      algorithm: 'AES-256-GCM',
      snapshot: resetEnvelope.toString('base64url'),
    },
  });
  assert.equal(initialized.response.status, 201);
  const wildcard = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({
      Cookie: owner.cookie,
      'X-Hnd-CSRF': owner.csrf,
      'If-Match': '*',
    }),
    body: resetBody,
  });
  assert.equal(wildcard.response.status, 412);
  assert.equal(wildcard.body.error, 'precondition_failed');
  now += 6 * 60 * 1000;
  const staleAuth = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({
      Cookie: owner.cookie,
      'X-Hnd-CSRF': owner.csrf,
      'If-Match': initialized.body.etag,
    }),
    body: resetBody,
  });
  assert.equal(staleAuth.response.status, 401);
  assert.equal(staleAuth.body.error, 'reauthentication_required');
});

test('vault reset attempts are rate limited', async (t) => {
  const { url } = await fixture(t);
  const owner = await registerOwner(null, url);
  const resetBody = {
    version: 1,
    algorithm: 'AES-256-GCM',
    snapshot: encryptSnapshot({ schemaVersion: 1, files: [] }, generateVaultKey()).toString('base64url'),
    confirmation: 'RESET_VAULT',
  };
  const invalidAttempts = [
    [{ ...resetBody, confirmation: 'reset_vault' }, 'invalid_confirmation'],
    [{ ...resetBody, vaultKey: generateVaultKey().toString('base64url') }, 'invalid_request'],
    [{ ...resetBody, version: 2 }, 'invalid_snapshot'],
    [{ ...resetBody, algorithm: 'AES-GCM' }, 'invalid_snapshot'],
    [{ ...resetBody, snapshot: 'AA==' }, 'invalid_snapshot'],
  ];
  for (const [body, errorCode] of invalidAttempts) {
    const response = await jsonRequest(url, '/api/web/vault/reset', {
      method: 'POST',
      headers: mutationHeaders({
        Cookie: owner.cookie,
        'X-Hnd-CSRF': owner.csrf,
        'If-Match': `"${'0'.repeat(64)}"`,
      }),
      body,
    });
    assert.equal(response.response.status, 400);
    assert.equal(response.body.error, errorCode);
  }
  const limited = await jsonRequest(url, '/api/web/vault/reset', {
    method: 'POST',
    headers: mutationHeaders({
      Cookie: owner.cookie,
      'X-Hnd-CSRF': owner.csrf,
      'If-Match': `"${'0'.repeat(64)}"`,
    }),
    body: resetBody,
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
});

test('owner can issue tenant invites and add passkeys while members cannot manage invites', async (t) => {
  const { server, url } = await fixture(t);
  const owner = await registerOwner(server, url);
  const invitation = await jsonRequest(url, '/api/web/account/invites', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { role: 'member', ttlSeconds: 3600 },
  });
  assert.equal(invitation.response.status, 201);
  assert.match(invitation.body.code, /^hnda_/);

  const registration = await jsonRequest(url, '/api/web/auth/register/options', {
    method: 'POST',
    headers: mutationHeaders(),
    body: {
      username: 'member',
      displayName: 'Member',
      code: invitation.body.code,
    },
  });
  const member = await jsonRequest(url, '/api/web/auth/register/verify', {
    method: 'POST',
    headers: mutationHeaders(),
    body: {
      flowId: registration.body.flowId,
      response: { id: 'member_credential', response: { clientDataJSON: 'test' } },
    },
  });
  assert.equal(member.response.status, 200);
  const memberCookie = member.response.headers.get('set-cookie').split(';', 1)[0];
  const memberCsrf = member.response.headers.get('x-hnd-csrf');
  const forbidden = await jsonRequest(url, '/api/web/account/invites', {
    headers: { Cookie: memberCookie },
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.error, 'forbidden');

  const enrollment = await jsonRequest(url, '/api/web/enrollments', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { name: 'managed-device', ttlSeconds: 900 },
  });
  const enrolled = await jsonRequest(url, '/v1/enroll', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${enrollment.body.enrollmentKey}`,
      'X-Hnd-Device-Name': 'managed-device',
    },
  });
  const forbiddenRename = await jsonRequest(
    url,
    `/api/web/devices/${enrolled.body.device.id}`,
    {
      method: 'PATCH',
      headers: mutationHeaders({ Cookie: memberCookie, 'X-Hnd-CSRF': memberCsrf }),
      body: { name: 'member-name' },
    },
  );
  assert.equal(forbiddenRename.response.status, 403);
  assert.equal(forbiddenRename.body.error, 'forbidden');

  const invalidRename = await jsonRequest(url, `/api/web/devices/${enrolled.body.device.id}`, {
    method: 'PATCH',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { name: '   ' },
  });
  assert.equal(invalidRename.response.status, 400);
  assert.equal(invalidRename.body.error, 'invalid_device_name');

  const renamed = await jsonRequest(url, `/api/web/devices/${enrolled.body.device.id}`, {
    method: 'PATCH',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { name: '  배포 PC  ' },
  });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.body.device.name, '배포 PC');
  const devices = await jsonRequest(url, '/api/web/devices', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(devices.body.devices[0].name, '배포 PC');

  const forbiddenRevoke = await jsonRequest(
    url,
    `/api/web/devices/${enrolled.body.device.id}/revoke`,
    {
      method: 'POST',
      headers: mutationHeaders({ Cookie: memberCookie, 'X-Hnd-CSRF': memberCsrf }),
      body: {},
    },
  );
  assert.equal(forbiddenRevoke.response.status, 403);
  assert.equal(forbiddenRevoke.body.error, 'forbidden');

  const members = await jsonRequest(url, '/api/web/account/members', {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(members.response.status, 200);
  assert.deepEqual(members.body.members.map((item) => item.role), ['owner', 'member']);

  const passkeyOptions = await jsonRequest(url, '/api/web/security/passkeys/options', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { name: 'Backup passkey' },
  });
  assert.equal(passkeyOptions.response.status, 200);
  const added = await jsonRequest(url, '/api/web/security/passkeys/verify', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: {
      flowId: passkeyOptions.body.flowId,
      response: { id: 'owner_backup_credential', response: { clientDataJSON: 'test' } },
    },
  });
  assert.equal(added.response.status, 201);
  assert.equal(added.body.passkey.label, 'Backup passkey');
  const passkeys = await jsonRequest(url, '/api/web/security/passkeys', {
    headers: { Cookie: owner.cookie },
  });
  assert.deepEqual(passkeys.body.passkeys.map((passkey) => passkey.id), [
    'owner_credential',
    'owner_backup_credential',
  ]);

  const settings = await jsonRequest(url, '/api/web/settings', {
    method: 'PUT',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { signupMode: 'closed', revisionRetention: 75, language: 'en' },
  });
  assert.equal(settings.response.status, 200);
  assert.equal(settings.body.signupMode, 'disabled');
  assert.equal(settings.body.user.language, 'en');
});

test('sensitive device issuance requires recent passkey authentication and supports reauthentication', async (t) => {
  let now = Date.parse('2026-08-27T00:00:00.000Z');
  const { server, url } = await fixture(t, { clock: () => now });
  const owner = await registerOwner(server, url);
  const vaultKey = generateVaultKey();
  const initialized = await jsonRequest(url, '/api/web/vault/initialize', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: {
      version: 1,
      algorithm: 'AES-256-GCM',
      snapshot: encryptSnapshot({ schemaVersion: 1, files: [] }, vaultKey).toString('base64url'),
    },
  });
  assert.equal(initialized.response.status, 201);
  const adopted = await jsonRequest(url, '/api/web/vault/key/adopt', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { vaultKey: vaultKey.toString('base64url') },
  });
  assert.equal(adopted.response.status, 201);
  now += 6 * 60 * 1000;

  const staleInvitation = await jsonRequest(url, '/api/web/connections', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { ttlSeconds: 900 },
  });
  assert.equal(staleInvitation.response.status, 401);
  assert.equal(staleInvitation.body.error, 'reauthentication_required');

  const staleUnlock = await jsonRequest(url, '/api/web/vault/key/unlock', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: {},
  });
  assert.equal(staleUnlock.response.status, 401);
  assert.equal(staleUnlock.body.error, 'reauthentication_required');

  const staleAdoption = await jsonRequest(url, '/api/web/vault/key/adopt', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { vaultKey: vaultKey.toString('base64url') },
  });
  assert.equal(staleAdoption.response.status, 401);
  assert.equal(staleAdoption.body.error, 'reauthentication_required');

  const stale = await jsonRequest(url, '/api/web/enrollments', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { ttlSeconds: 900 },
  });
  assert.equal(stale.response.status, 401);
  assert.equal(stale.body.error, 'reauthentication_required');

  const options = await jsonRequest(url, '/api/web/auth/reauth/options', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: {},
  });
  assert.equal(options.response.status, 200);
  const verified = await jsonRequest(url, '/api/web/auth/reauth/verify', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: {
      flowId: options.body.flowId,
      response: {
        id: 'owner_credential',
        response: { userHandle: owner.body.user.webauthnUserId },
      },
    },
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.reauthenticated, true);

  const issued = await jsonRequest(url, '/api/web/enrollments', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { ttlSeconds: 900 },
  });
  assert.equal(issued.response.status, 201);
  assert.match(issued.body.enrollmentKey, /^hnde_/);

  const issuedInvitation = await jsonRequest(url, '/api/web/connections', {
    method: 'POST',
    headers: mutationHeaders({ Cookie: owner.cookie, 'X-Hnd-CSRF': owner.csrf }),
    body: { ttlSeconds: 900 },
  });
  assert.equal(issuedInvitation.response.status, 201);
  assert.match(issuedInvitation.body.connectionCode, /^hndj_/);
});

test('rate limiting separates nginx clients using explicitly trusted private proxy metadata', async (t) => {
  const { url } = await fixture(t);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const allowed = await jsonRequest(url, '/api/web/auth/login/options', {
      method: 'POST',
      headers: mutationHeaders({ 'X-Real-IP': '203.0.113.10' }),
      body: {},
    });
    assert.equal(allowed.response.status, 200);
  }
  const limited = await jsonRequest(url, '/api/web/auth/login/options', {
    method: 'POST',
    headers: mutationHeaders({ 'X-Real-IP': '203.0.113.10' }),
    body: {},
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error, 'rate_limited');

  const otherClient = await jsonRequest(url, '/api/web/auth/login/options', {
    method: 'POST',
    headers: mutationHeaders({ 'X-Real-IP': '203.0.113.11' }),
    body: {},
  });
  assert.equal(otherClient.response.status, 200);
  const invalidProxyHeader = await jsonRequest(url, '/api/web/auth/login/options', {
    method: 'POST',
    headers: mutationHeaders({ 'X-Real-IP': 'not-an-ip' }),
    body: {},
  });
  assert.equal(invalidProxyHeader.response.status, 400);
  assert.equal(invalidProxyHeader.body.error, 'invalid_header');
});
