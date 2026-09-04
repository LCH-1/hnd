import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  AccountStore,
  AccountStoreError,
} from '../src/server/account-store.mjs';
import {
  WebAuthService,
  clearWebSessionCookie,
  serializeWebSessionCookie,
  sessionTokenFromCookieHeader,
} from '../src/server/web-auth.mjs';
import {
  ControlStore,
  DEFAULT_DATABASE_FILENAME,
} from '../src/sync/store.mjs';

async function temporaryDirectory(t, prefix = 'hnd-web-auth-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fakeWebAuthn() {
  const calls = {
    registrationOptions: [],
    registrationVerification: [],
    authenticationOptions: [],
    authenticationVerification: [],
  };
  let challengeSequence = 0;
  const implementation = {
    async generateRegistrationOptions(options) {
      calls.registrationOptions.push(options);
      challengeSequence += 1;
      return {
        challenge: `registration_challenge_${String(challengeSequence).padStart(4, '0')}`,
        rp: { id: options.rpID, name: options.rpName },
        user: {
          id: Buffer.from(options.userID).toString('base64url'),
          name: options.userName,
          displayName: options.userDisplayName,
        },
        authenticatorSelection: options.authenticatorSelection,
        attestation: options.attestationType,
      };
    },
    async verifyRegistrationResponse(options) {
      calls.registrationVerification.push(options);
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: options.response.id,
            publicKey: new Uint8Array([1, 2, 3, 4, 5]),
            counter: 0,
            transports: ['internal'],
          },
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
        },
      };
    },
    async generateAuthenticationOptions(options) {
      calls.authenticationOptions.push(options);
      challengeSequence += 1;
      return {
        challenge: `authentication_challenge_${String(challengeSequence).padStart(4, '0')}`,
        rpId: options.rpID,
        allowCredentials: options.allowCredentials,
        userVerification: options.userVerification,
      };
    },
    async verifyAuthenticationResponse(options) {
      calls.authenticationVerification.push(options);
      return {
        verified: true,
        authenticationInfo: {
          newCounter: options.credential.counter + 1,
          credentialBackedUp: true,
        },
      };
    },
  };
  return { calls, implementation };
}

async function fixture(t, options = {}) {
  const directory = await temporaryDirectory(t);
  const core = new ControlStore(directory, { clock: options.clock });
  await core.init();
  t.after(() => core.close());
  const store = new AccountStore(directory, {
    clock: options.clock,
    sessionIdleTtlMs: options.sessionIdleTtlMs,
    sessionAbsoluteTtlMs: options.sessionAbsoluteTtlMs,
  });
  await store.init();
  t.after(() => store.close());
  const fake = fakeWebAuthn();
  const service = new WebAuthService({
    store,
    origin: 'https://hnd.example.com',
    rpId: 'hnd.example.com',
    rpName: 'HND',
    signupMode: options.signupMode ?? 'first-user',
    clock: options.clock,
    webauthn: fake.implementation,
  });
  return { directory, core, store, service, fake };
}

async function register(service, details) {
  const registration = await service.registrationOptions(details);
  const verified = await service.verifyRegistration({
    flowId: registration.flowId,
    response: {
      id: details.credentialId,
      response: { clientDataJSON: 'test-registration-response' },
    },
    label: details.label,
  });
  return { registration, verified };
}

function inspectDatabase(directory, operation) {
  const database = new DatabaseSync(path.join(directory, DEFAULT_DATABASE_FILENAME), { readOnly: true });
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

test('account schema is an additive, idempotent v3 extension that remains core-store compatible', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-account-schema-');
  const missing = new AccountStore(directory);
  await assert.rejects(() => missing.init(), /requires an initialized hnd\.sqlite/);

  const core = new ControlStore(directory);
  await core.init();
  core.close();

  const first = new AccountStore(directory);
  const second = new AccountStore(directory);
  t.after(() => first.close());
  t.after(() => second.close());
  await Promise.all([first.init(), second.init()]);

  const schema = inspectDatabase(directory, (database) => ({
    userVersion: Number(database.prepare('PRAGMA user_version').get().user_version),
    accountVersion: database.prepare(`
      SELECT value FROM schema_metadata WHERE key = 'account_schema_version'
    `).get().value,
    tables: new Set(database.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table'
    `).all().map((row) => row.name)),
  }));
  assert.equal(schema.userVersion, 1);
  assert.equal(schema.accountVersion, '3');
  for (const table of [
    'users',
    'tenant_memberships',
    'passkey_credentials',
    'account_invites',
    'webauthn_flows',
    'passkey_registration_flows',
    'web_sessions',
    'account_recovery_codes',
  ]) {
    assert.equal(schema.tables.has(table), true);
  }

  first.close();
  second.close();
  const reopenedCore = new ControlStore(directory);
  await reopenedCore.init();
  await reopenedCore.createEnrollmentKey('core-still-compatible');
  reopenedCore.close();
});

test('account schema migrates persisted v1 sessions and WebAuthn flows in place', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-account-v1-migration-');
  const core = new ControlStore(directory);
  await core.init();
  core.close();
  const initialized = new AccountStore(directory);
  await initialized.init();
  initialized.close();

  const database = new DatabaseSync(path.join(directory, DEFAULT_DATABASE_FILENAME));
  database.exec(`
    DROP TABLE passkey_registration_flows;
    ALTER TABLE web_sessions DROP COLUMN recovery_required;
    ALTER TABLE webauthn_flows DROP COLUMN session_id;
    UPDATE schema_metadata SET value = '1' WHERE key = 'account_schema_version';
  `);
  database.close();

  const migrated = new AccountStore(directory);
  await migrated.init();
  t.after(() => migrated.close());
  const schema = inspectDatabase(directory, (readOnly) => ({
    version: readOnly.prepare(`
      SELECT value FROM schema_metadata WHERE key = 'account_schema_version'
    `).get().value,
    sessionColumns: new Set(readOnly.prepare('PRAGMA table_info(web_sessions)').all().map((row) => row.name)),
    flowColumns: new Set(readOnly.prepare('PRAGMA table_info(webauthn_flows)').all().map((row) => row.name)),
    registrationTable: readOnly.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'table' AND name = 'passkey_registration_flows'
    `).get(),
  }));
  assert.equal(schema.version, '3');
  assert.equal(schema.sessionColumns.has('recovery_required'), true);
  assert.equal(schema.flowColumns.has('session_id'), true);
  assert.equal(schema.registrationTable.present, 1);
});

test('web-first owner binds to one existing tenant and bootstrap resolves an ambiguous tenant', async (t) => {
  const single = await fixture(t);
  await single.core.createEnrollmentKey('existing-tenant');
  const owner = await register(single.service, {
    username: 'owner',
    displayName: 'Owner',
    credentialId: 'credential_existing_owner',
  });
  assert.equal(owner.verified.activeTenantId, 'existing-tenant');

  const ambiguous = await fixture(t);
  await ambiguous.core.createEnrollmentKey('tenant-one');
  await ambiguous.core.createEnrollmentKey('tenant-two');
  await assert.rejects(
    () => ambiguous.service.registrationOptions({ username: 'owner', displayName: 'Owner' }),
    (error) => error instanceof AccountStoreError && error.code === 'tenant_required',
  );
  const bootstrap = ambiguous.store.createBootstrapCode({ tenantId: 'tenant-two' });
  const selected = await register(ambiguous.service, {
    username: 'owner',
    displayName: 'Owner',
    code: bootstrap.code,
    credentialId: 'credential_selected_owner',
  });
  assert.equal(selected.verified.activeTenantId, 'tenant-two');
});

test('first owner signs up on the web without a code, then first-user mode becomes invite-only', async (t) => {
  const { store, service, fake } = await fixture(t);
  assert.deepEqual(service.publicSignupStatus(), {
    configuredMode: 'first-user',
    effectiveMode: 'first-user',
    allowed: true,
    requiresCode: false,
    codeKind: null,
  });
  const alice = await register(service, {
    username: 'Alice',
    displayName: 'Alice Owner',
    credentialId: 'credential_alice',
    label: 'Alice laptop',
  });
  assert.equal(alice.verified.user.username, 'alice');
  assert.equal(alice.verified.memberships[0].role, 'owner');
  assert.equal(alice.verified.activeTenantId, alice.verified.memberships[0].tenantId);
  assert.match(alice.verified.sessionToken, /^hnds_/);
  assert.match(alice.verified.csrfToken, /^hndc_/);
  assert.equal(
    service.session(alice.verified.sessionToken, { rotateCsrf: false })
      .recoveryCodesConfigured,
    false,
  );
  const recoverySet = service.createRecoveryCodes({
    sessionToken: alice.verified.sessionToken,
    csrfToken: alice.verified.csrfToken,
  });
  const configuredRecovery = service.session(alice.verified.sessionToken, {
    rotateCsrf: false,
  });
  assert.equal(configuredRecovery.recoveryCodesConfigured, true);
  assert.equal(configuredRecovery.recoveryCodesConfirmed, false);
  service.confirmRecoveryCodes({
    sessionToken: alice.verified.sessionToken,
    csrfToken: alice.verified.csrfToken,
    confirmationId: recoverySet.confirmationId,
  });
  assert.equal(
    service.session(alice.verified.sessionToken, { rotateCsrf: false })
      .recoveryCodesConfirmed,
    true,
  );
  assert.deepEqual(fake.calls.registrationOptions[0].authenticatorSelection, {
    residentKey: 'required',
    userVerification: 'required',
  });
  assert.equal(fake.calls.registrationOptions[0].attestationType, 'none');
  assert.deepEqual(
    {
      expectedOrigin: fake.calls.registrationVerification[0].expectedOrigin,
      expectedRPID: fake.calls.registrationVerification[0].expectedRPID,
      requireUserVerification: fake.calls.registrationVerification[0].requireUserVerification,
    },
    {
      expectedOrigin: 'https://hnd.example.com',
      expectedRPID: 'hnd.example.com',
      requireUserVerification: true,
    },
  );

  await assert.rejects(
    () => service.verifyRegistration({
      flowId: alice.registration.flowId,
      response: { id: 'credential_replay', response: {} },
    }),
    (error) => error instanceof AccountStoreError && error.code === 'invalid_auth_flow',
  );
  await assert.rejects(
    () => service.registrationOptions({ username: 'bob', displayName: 'Bob' }),
    (error) => error instanceof AccountStoreError && error.code === 'invite_required',
  );

  const invitation = store.createAccountInvite({
    actorUserId: alice.verified.user.id,
    tenantId: alice.verified.activeTenantId,
    role: 'member',
  });
  const bob = await register(service, {
    username: 'bob',
    displayName: 'Bob Member',
    code: invitation.code,
    credentialId: 'credential_bob',
  });
  assert.equal(bob.verified.activeTenantId, alice.verified.activeTenantId);
  assert.equal(bob.verified.memberships[0].role, 'member');
  assert.equal(store.userCount(), 2);
});

test('competing code-free first-owner ceremonies atomically create one owner', async (t) => {
  const { directory, store, service } = await fixture(t);
  const peerStore = new AccountStore(directory);
  await peerStore.init();
  t.after(() => peerStore.close());
  const peerService = new WebAuthService({
    store: peerStore,
    origin: 'https://hnd.example.com',
    rpId: 'hnd.example.com',
    rpName: 'HND',
    signupMode: 'first-user',
    webauthn: fakeWebAuthn().implementation,
  });
  const first = await service.registrationOptions({
    username: 'first',
    displayName: 'First',
  });
  const second = await peerService.registrationOptions({
    username: 'second',
    displayName: 'Second',
  });
  const outcomes = await Promise.allSettled([
    service.verifyRegistration({
      flowId: first.flowId,
      response: { id: 'credential_first', response: {} },
    }),
    peerService.verifyRegistration({
      flowId: second.flowId,
      response: { id: 'credential_second', response: {} },
    }),
  ]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason instanceof AccountStoreError, true);
  assert.equal(rejected[0].reason.code, 'bootstrap_closed');
  assert.equal(store.userCount(), 1);
  const committed = inspectDatabase(directory, (database) => ({
    users: Number(database.prepare('SELECT count(*) AS count FROM users').get().count),
    passkeys: Number(database.prepare('SELECT count(*) AS count FROM passkey_credentials').get().count),
    memberships: Number(database.prepare('SELECT count(*) AS count FROM tenant_memberships').get().count),
    ownerId: database.prepare(`
      SELECT value FROM schema_metadata WHERE key = 'web_server_owner_user_id'
    `).get().value,
  }));
  assert.deepEqual(
    { users: committed.users, passkeys: committed.passkeys, memberships: committed.memberships },
    { users: 1, passkeys: 1, memberships: 1 },
  );
  assert.equal(committed.ownerId, fulfilled[0].value.user.id);
});

test('discoverable passkey login checks user handle, exact RP data, counters, and hashed sessions', async (t) => {
  const { directory, store, service, fake } = await fixture(t);
  const bootstrap = store.createBootstrapCode();
  const alice = await register(service, {
    username: 'alice',
    displayName: 'Alice',
    code: bootstrap.code,
    credentialId: 'credential_alice',
  });

  const badLogin = await service.authenticationOptions();
  await assert.rejects(
    () => service.verifyAuthentication({
      flowId: badLogin.flowId,
      response: {
        id: 'credential_alice',
        response: { userHandle: Buffer.alloc(32, 9).toString('base64url') },
      },
    }),
    (error) => error instanceof AccountStoreError && error.code === 'authentication_failed',
  );

  const login = await service.authenticationOptions();
  assert.deepEqual(fake.calls.authenticationOptions.at(-1), {
    rpID: 'hnd.example.com',
    allowCredentials: [],
    userVerification: 'required',
  });
  const authenticated = await service.verifyAuthentication({
    flowId: login.flowId,
    response: {
      id: 'credential_alice',
      response: { userHandle: alice.verified.user.webauthnUserId },
    },
  });
  assert.equal(authenticated.user.id, alice.verified.user.id);
  const verification = fake.calls.authenticationVerification.at(-1);
  assert.equal(verification.expectedChallenge, login.options.challenge);
  assert.equal(verification.expectedOrigin, 'https://hnd.example.com');
  assert.equal(verification.expectedRPID, 'hnd.example.com');
  assert.equal(verification.requireUserVerification, true);
  assert.equal(verification.credential.counter, 0);
  assert.equal(store.getPasskey('credential_alice').counter, 1);

  const databaseBytes = await readFile(path.join(directory, DEFAULT_DATABASE_FILENAME));
  assert.equal(databaseBytes.includes(Buffer.from(authenticated.sessionToken)), false);
  assert.equal(databaseBytes.includes(Buffer.from(authenticated.csrfToken)), false);
  assert.equal(store.verifyCsrf(authenticated.sessionToken, authenticated.csrfToken).user.id, authenticated.user.id);
  assert.throws(
    () => store.verifyCsrf(authenticated.sessionToken, 'hndc_invalid_but_well_formed________________________________'),
    (error) => error instanceof AccountStoreError && error.code === 'invalid_csrf',
  );

  const rotated = service.session(authenticated.sessionToken);
  assert.match(rotated.csrfToken, /^hndc_/);
  assert.throws(
    () => store.verifyCsrf(authenticated.sessionToken, authenticated.csrfToken),
    (error) => error instanceof AccountStoreError && error.code === 'invalid_csrf',
  );
  assert.equal(service.logout(authenticated.sessionToken, rotated.csrfToken).loggedOut, true);
  assert.throws(
    () => store.authenticateSession(authenticated.sessionToken),
    (error) => error instanceof AccountStoreError && error.code === 'invalid_session',
  );
});

test('session cookie helpers enforce __Host attributes and reject duplicate cookies', () => {
  const token = `hnds_${'A'.repeat(43)}`;
  const serialized = serializeWebSessionCookie(token, { maxAgeSeconds: 60 });
  assert.match(serialized, /^__Host-hnd_session=/);
  for (const attribute of ['Max-Age=60', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) {
    assert.equal(serialized.includes(attribute), true);
  }
  assert.equal(serialized.includes('Domain='), false);
  assert.equal(sessionTokenFromCookieHeader(`other=x; __Host-hnd_session=${token}`), token);
  assert.equal(
    sessionTokenFromCookieHeader(`__Host-hnd_session=${token}; __Host-hnd_session=attacker`),
    null,
  );
  const cleared = clearWebSessionCookie();
  assert.equal(cleared.includes('Max-Age=0'), true);
  assert.equal(cleared.includes('Expires=Thu, 01 Jan 1970 00:00:00 GMT'), true);
});

test('sessions expire by idle time and sensitive operations require recent passkey authentication', async (t) => {
  let now = Date.parse('2026-08-27T00:00:00.000Z');
  const clock = () => now;
  const { store, service } = await fixture(t, {
    clock,
    sessionIdleTtlMs: 2_000,
    sessionAbsoluteTtlMs: 20_000,
  });
  const bootstrap = store.createBootstrapCode();
  const alice = await register(service, {
    username: 'alice',
    displayName: 'Alice',
    code: bootstrap.code,
    credentialId: 'credential_alice',
  });
  assert.equal(service.requireRecentAuthentication(alice.verified.sessionToken).user.id, alice.verified.user.id);

  now += 2_001;
  assert.throws(
    () => store.authenticateSession(alice.verified.sessionToken),
    (error) => error instanceof AccountStoreError && error.code === 'invalid_session',
  );
});

test('reauthentication is bound to the logged-in user and refreshes recent-auth time', async (t) => {
  let now = Date.parse('2026-08-27T00:00:00.000Z');
  const clock = () => now;
  const { store, service, fake } = await fixture(t, {
    clock,
    sessionIdleTtlMs: 60 * 60 * 1000,
    sessionAbsoluteTtlMs: 24 * 60 * 60 * 1000,
  });
  const bootstrap = store.createBootstrapCode();
  const alice = await register(service, {
    username: 'alice',
    displayName: 'Alice',
    code: bootstrap.code,
    credentialId: 'credential_alice',
  });
  now += 10 * 60 * 1000;
  assert.throws(
    () => service.requireRecentAuthentication(alice.verified.sessionToken),
    (error) => error instanceof AccountStoreError && error.code === 'reauthentication_required',
  );

  const sessionBound = await service.reauthenticationOptions({
    sessionToken: alice.verified.sessionToken,
    csrfToken: alice.verified.csrfToken,
  });
  const otherSession = store.createSession(alice.verified.user.id);
  await assert.rejects(
    () => service.verifyReauthentication({
      sessionToken: otherSession.sessionToken,
      csrfToken: otherSession.csrfToken,
      flowId: sessionBound.flowId,
      response: {
        id: 'credential_alice',
        response: { userHandle: alice.verified.user.webauthnUserId },
      },
    }),
    (error) => error instanceof AccountStoreError && error.code === 'authentication_failed',
  );

  const reauth = await service.reauthenticationOptions({
    sessionToken: alice.verified.sessionToken,
    csrfToken: alice.verified.csrfToken,
  });
  assert.deepEqual(fake.calls.authenticationOptions.at(-1).allowCredentials, [{
    id: 'credential_alice',
    transports: ['internal'],
  }]);
  await service.verifyReauthentication({
    sessionToken: alice.verified.sessionToken,
    csrfToken: alice.verified.csrfToken,
    flowId: reauth.flowId,
    response: {
      id: 'credential_alice',
      response: { userHandle: alice.verified.user.webauthnUserId },
    },
  });
  assert.equal(service.requireRecentAuthentication(alice.verified.sessionToken).user.id, alice.verified.user.id);
  assert.equal(store.getPasskey('credential_alice').counter, 1);
});

test('additional passkey registration requires a recent session and is bound to that session', async (t) => {
  const { store, service, fake } = await fixture(t);
  const bootstrap = store.createBootstrapCode();
  const alice = await register(service, {
    username: 'alice',
    displayName: 'Alice',
    code: bootstrap.code,
    credentialId: 'credential_alice',
  });
  const registration = await service.passkeyRegistrationOptions({
    sessionToken: alice.verified.sessionToken,
    csrfToken: alice.verified.csrfToken,
    label: 'Backup key',
  });
  assert.deepEqual(fake.calls.registrationOptions.at(-1).excludeCredentials, [{
    id: 'credential_alice',
    transports: ['internal'],
  }]);

  const otherSession = store.createSession(alice.verified.user.id);
  await assert.rejects(
    () => service.verifyPasskeyRegistration({
      sessionToken: otherSession.sessionToken,
      csrfToken: otherSession.csrfToken,
      flowId: registration.flowId,
      response: { id: 'credential_wrong_session', response: {} },
    }),
    (error) => error instanceof AccountStoreError && error.code === 'invalid_auth_flow',
  );
  const added = await service.verifyPasskeyRegistration({
    sessionToken: alice.verified.sessionToken,
    csrfToken: alice.verified.csrfToken,
    flowId: registration.flowId,
    response: { id: 'credential_backup', response: {} },
  });
  assert.equal(added.registered, true);
  assert.equal(added.passkey.label, 'Backup key');
  assert.deepEqual(store.listPasskeys(alice.verified.user.id).map((item) => item.id), [
    'credential_alice',
    'credential_backup',
  ]);
});

test('recovery codes are hash-only, rotate as a set, consume once, and revoke old sessions', async (t) => {
  const { directory, store, service } = await fixture(t);
  const bootstrap = store.createBootstrapCode();
  const alice = await register(service, {
    username: 'alice',
    displayName: 'Alice',
    code: bootstrap.code,
    credentialId: 'credential_alice',
  });
  const firstSet = service.createRecoveryCodes({
    sessionToken: alice.verified.sessionToken,
    csrfToken: alice.verified.csrfToken,
    count: 4,
  });
  assert.equal(firstSet.codes.length, 4);
  assert.equal(new Set(firstSet.codes).size, 4);
  for (const code of firstSet.codes) assert.match(code, /^hndr_[A-Za-z0-9_-]{43}$/);
  service.confirmRecoveryCodes({
    sessionToken: alice.verified.sessionToken,
    csrfToken: alice.verified.csrfToken,
    confirmationId: firstSet.confirmationId,
  });
  assert.equal(store.recoveryCodeStatus(alice.verified.user.id).confirmed, true);

  const secondSet = service.createRecoveryCodes({
    sessionToken: alice.verified.sessionToken,
    csrfToken: alice.verified.csrfToken,
    count: 3,
  });
  assert.equal(secondSet.codes.length, 3);
  assert.equal(store.recoveryCodeStatus(alice.verified.user.id).confirmed, false);
  assert.throws(
    () => service.confirmRecoveryCodes({
      sessionToken: alice.verified.sessionToken,
      csrfToken: alice.verified.csrfToken,
      confirmationId: firstSet.confirmationId,
    }),
    (error) => error instanceof AccountStoreError && error.code === 'recovery_codes_changed',
  );
  service.confirmRecoveryCodes({
    sessionToken: alice.verified.sessionToken,
    csrfToken: alice.verified.csrfToken,
    confirmationId: secondSet.confirmationId,
  });
  assert.throws(
    () => service.useRecoveryCode({ code: firstSet.codes[0] }),
    (error) => error instanceof AccountStoreError && error.code === 'invalid_recovery_code',
  );

  const databaseBytes = await readFile(path.join(directory, DEFAULT_DATABASE_FILENAME));
  for (const code of secondSet.codes) {
    assert.equal(databaseBytes.includes(Buffer.from(code)), false);
  }
  const recovered = service.useRecoveryCode({ code: secondSet.codes[0] });
  assert.equal(recovered.user.id, alice.verified.user.id);
  assert.match(recovered.sessionToken, /^hnds_/);
  assert.equal(recovered.requiresPasskey, true);
  assert.equal(recovered.recoveryCodesConfirmed, false);
  assert.equal(store.authenticateSession(recovered.sessionToken).session.recoveryRequired, true);
  assert.throws(
    () => service.requireRecentAuthentication(recovered.sessionToken),
    (error) => error instanceof AccountStoreError && error.code === 'reauthentication_required',
  );
  assert.throws(
    () => store.authenticateSession(alice.verified.sessionToken),
    (error) => error instanceof AccountStoreError && error.code === 'invalid_session',
  );
  assert.throws(
    () => service.useRecoveryCode({ code: secondSet.codes[0] }),
    (error) => error instanceof AccountStoreError && error.code === 'invalid_recovery_code',
  );
  const recoveryRegistration = await service.passkeyRegistrationOptions({
    sessionToken: recovered.sessionToken,
    csrfToken: recovered.csrfToken,
    label: 'Recovered passkey',
  });
  const finished = await service.verifyPasskeyRegistration({
    sessionToken: recovered.sessionToken,
    csrfToken: recovered.csrfToken,
    flowId: recoveryRegistration.flowId,
    response: { id: 'credential_after_recovery', response: {} },
  });
  assert.equal(finished.recovered, true);
  assert.equal(finished.requiresPasskey, false);
  assert.equal(store.authenticateSession(recovered.sessionToken).session.recoveryRequired, false);
  assert.equal(service.requireRecentAuthentication(recovered.sessionToken).user.id, recovered.user.id);
});

test('only the first server owner can change global signup and retention settings', async (t) => {
  const { store, service } = await fixture(t, { signupMode: 'open' });
  const first = await register(service, {
    username: 'first',
    displayName: 'First',
    credentialId: 'credential_first_owner',
  });
  const second = await register(service, {
    username: 'second',
    displayName: 'Second',
    credentialId: 'credential_second_owner',
  });
  assert.equal(store.isServerOwner(first.verified.user.id), true);
  assert.equal(store.isServerOwner(second.verified.user.id), false);
  assert.throws(
    () => store.updateServerSettings(
      second.verified.user.id,
      second.verified.activeTenantId,
      { signupMode: 'closed', defaults: { revisionRetention: 50 } },
    ),
    (error) => error instanceof AccountStoreError && error.code === 'forbidden',
  );
  const pending = await service.registrationOptions({
    username: 'pending',
    displayName: 'Pending',
  });
  const updated = store.updateServerSettings(
    first.verified.user.id,
    first.verified.activeTenantId,
    { signupMode: 'closed', revisionRetention: 75 },
  );
  assert.deepEqual(updated, { signupMode: 'disabled', revisionRetention: 75 });
  await assert.rejects(
    () => service.verifyRegistration({
      flowId: pending.flowId,
      response: { id: 'credential_pending', response: {} },
    }),
    (error) => error instanceof AccountStoreError && error.code === 'invalid_auth_flow',
  );
});

test('WebAuthn configuration rejects insecure or broadened relying-party origins', async (t) => {
  const { store } = await fixture(t);
  assert.throws(
    () => new WebAuthService({
      store,
      origin: 'http://hnd.example.com',
      rpId: 'hnd.example.com',
    }),
    /HTTPS origin/,
  );
  assert.throws(
    () => new WebAuthService({
      store,
      origin: 'https://hnd.example.com',
      rpId: 'example.com',
    }),
    /exactly match/,
  );
  assert.throws(
    () => new WebAuthService({
      store,
      origin: 'https://hnd.example.com/path',
      rpId: 'hnd.example.com',
    }),
    /without credentials, path/,
  );
  assert.doesNotThrow(() => new WebAuthService({
    store,
    origin: 'http://localhost:8787',
    rpId: 'localhost',
  }));
});

test('the pinned SimpleWebAuthn implementation produces UV-required discoverable options', async (t) => {
  const directory = await temporaryDirectory(t, 'hnd-real-webauthn-');
  const core = new ControlStore(directory);
  await core.init();
  t.after(() => core.close());
  const store = new AccountStore(directory);
  await store.init();
  t.after(() => store.close());
  const service = new WebAuthService({
    store,
    origin: 'https://hnd.example.com',
    rpId: 'hnd.example.com',
    signupMode: 'first-user',
  });
  const bootstrap = store.createBootstrapCode();
  const registration = await service.registrationOptions({
    username: 'alice',
    displayName: 'Alice',
    code: bootstrap.code,
  });
  assert.match(registration.options.challenge, /^[A-Za-z0-9_-]+$/);
  assert.equal(registration.options.rp.id, 'hnd.example.com');
  assert.equal(registration.options.authenticatorSelection.residentKey, 'required');
  assert.equal(registration.options.authenticatorSelection.userVerification, 'required');
  assert.equal(registration.options.attestation, 'none');

  const authentication = await service.authenticationOptions();
  assert.equal(authentication.options.rpId, 'hnd.example.com');
  assert.equal(authentication.options.userVerification, 'required');
  assert.deepEqual(authentication.options.allowCredentials, []);
});
