import { createServer } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { fileURLToPath } from 'node:url';
import {
  AuthenticationError,
  ControlStore,
  DEFAULT_MAX_BLOB_BYTES,
  PreconditionFailedError,
  PreconditionRequiredError,
  SnapshotStore,
} from './store.mjs';
import { parseEntityTags, weakEtagMatches } from './etag.mjs';
import {
  resolveWebAsset,
  sendWebAsset,
  WebStaticError,
} from '../server/web-static.mjs';
import { AccountStore } from '../server/account-store.mjs';
import {
  loadConnectorRelease,
  sendConnectorReleaseAsset,
} from '../server/connector-release.mjs';
import { WebAuthService } from '../server/web-auth.mjs';
import { WebApiRouter } from '../server/web-api.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_DIRECTORY = path.resolve(moduleDirectory, '..', 'web');
const DEFAULT_BROWSER_DIRECTORY = path.resolve(moduleDirectory, '..', 'browser');

const MAX_JSON_RESPONSE_BYTES = 256 * 1024;
const MAX_URL_BYTES = 2048;
class HttpError extends Error {
  constructor(statusCode, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

function send(res, statusCode, body = null, headers = {}) {
  const normalized = body === null
    ? null
    : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const responseHeaders = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  };
  if (normalized) responseHeaders['Content-Length'] = String(normalized.byteLength);
  res.writeHead(statusCode, responseHeaders);
  res.end(normalized);
}

function sendJson(res, statusCode, value, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (body.byteLength > MAX_JSON_RESPONSE_BYTES) {
    throw new HttpError(500, 'JSON response exceeds server limit');
  }
  send(res, statusCode, body, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function bearerToken(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || authorization.length > 512) {
    throw new AuthenticationError();
  }
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) throw new AuthenticationError();
  return match[1];
}

function headerValue(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) throw new HttpError(400, `Multiple ${name} headers are not allowed`);
  return value;
}

async function readOpaqueBody(req, maxBytes) {
  const declared = headerValue(req, 'content-length');
  if (declared !== undefined) {
    if (!/^\d+$/.test(declared)) throw new HttpError(400, 'Invalid Content-Length');
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes)) throw new HttpError(400, 'Invalid Content-Length');
    if (declaredBytes > maxBytes) {
      req.resume();
      throw new HttpError(413, `Encrypted snapshot exceeds ${maxBytes} byte limit`);
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      received += chunk.byteLength;
      if (received > maxBytes) {
        tooLarge = true;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, `Encrypted snapshot exceeds ${maxBytes} byte limit`));
      } else {
        resolve(Buffer.concat(chunks, received));
      }
    });
    req.on('aborted', () => reject(new HttpError(400, 'Request body was aborted')));
    req.on('error', reject);
  });
}

function sendOpaqueSnapshot(req, res, snapshot) {
  const ifNoneMatch = headerValue(req, 'if-none-match');
  if (ifNoneMatch !== undefined) {
    let matches;
    try {
      matches = weakEtagMatches(ifNoneMatch, snapshot.etag, true);
    } catch {
      throw new HttpError(400, 'Invalid If-None-Match header');
    }
    if (matches) {
      send(res, 304, null, { ETag: snapshot.etag });
      return;
    }
  }
  send(res, 200, snapshot.blob, {
    'Content-Type': 'application/octet-stream',
    ETag: snapshot.etag,
  });
}

function validatePutConditions(req) {
  const ifMatch = headerValue(req, 'if-match');
  const ifNoneMatch = headerValue(req, 'if-none-match');
  if (ifMatch !== undefined && ifNoneMatch !== undefined) {
    throw new HttpError(400, 'If-Match and If-None-Match cannot be combined');
  }
  try {
    if (ifMatch !== undefined) parseEntityTags(ifMatch);
    if (ifNoneMatch !== undefined) parseEntityTags(ifNoneMatch);
  } catch {
    throw new HttpError(400, 'Invalid ETag precondition');
  }
  return { ifMatch, ifNoneMatch };
}

function parseRequestUrl(req) {
  if (typeof req.url !== 'string' || Buffer.byteLength(req.url) > MAX_URL_BYTES) {
    throw new HttpError(414, 'Request URL is too long');
  }
  let url;
  try {
    url = new URL(req.url, 'http://hnd.invalid');
  } catch {
    throw new HttpError(400, 'Malformed request URL');
  }
  return url;
}

export class OpaqueSyncServer {
  constructor(options = {}) {
    this.dataDirectory = path.resolve(options.dataDirectory ?? options.dataDir ?? 'hnd-server-data');
    this.webDirectory = options.webDirectory === false
      ? null
      : path.resolve(options.webDirectory ?? DEFAULT_WEB_DIRECTORY);
    this.browserDirectory = options.browserDirectory === false
      ? null
      : path.resolve(options.browserDirectory ?? DEFAULT_BROWSER_DIRECTORY);
    this.connectorDirectory = options.connectorDirectory
      ? path.resolve(options.connectorDirectory)
      : null;
    this.connectorRelease = null;
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    this.control = new ControlStore(this.dataDirectory, { clock: options.clock });
    this.snapshots = new SnapshotStore(this.dataDirectory, {
      maxBlobBytes: this.maxBlobBytes,
      maxRevisionsPerTenant: options.maxRevisionsPerTenant,
      clock: options.clock,
    });
    this.accounts = new AccountStore(this.dataDirectory, { clock: options.clock });
    const publicOrigin = options.publicOrigin ?? 'http://localhost';
    this.auth = new WebAuthService({
      store: this.accounts,
      origin: publicOrigin,
      rpId: options.rpId ?? new URL(publicOrigin).hostname,
      rpName: options.rpName ?? 'HND',
      signupMode: options.signupMode ?? 'open',
      clock: options.clock,
      webauthn: options.webauthn,
    });
    this.webApi = new WebApiRouter({
      auth: this.auth,
      accounts: this.accounts,
      control: this.control,
      snapshots: this.snapshots,
      origin: publicOrigin,
      maxBlobBytes: this.maxBlobBytes,
      clock: options.clock,
      trustProxy: options.trustProxy,
      onError: options.onError,
    });
    this.onError = options.onError ?? (() => {});
    this.httpServer = createServer((req, res) => {
      this.#handle(req, res).catch((error) => this.#handleError(res, error));
    });
    this.httpServer.requestTimeout = options.requestTimeoutMs ?? 30_000;
    this.httpServer.headersTimeout = options.headersTimeoutMs ?? 10_000;
    this.httpServer.maxRequestsPerSocket = options.maxRequestsPerSocket ?? 1_000;
    this.url = null;
  }

  async init() {
    try {
      await this.control.init();
      await this.snapshots.init();
      await this.accounts.init();
      this.connectorRelease = await loadConnectorRelease(this.connectorDirectory);
      const settings = this.accounts.serverSettings({
        signupMode: this.auth.signupMode,
        revisionRetention: this.snapshots.maxRevisionsPerTenant,
      });
      this.auth.signupMode = settings.signupMode;
      this.snapshots.maxRevisionsPerTenant = settings.revisionRetention;
      return this;
    } catch (error) {
      this.control.close();
      this.snapshots.close();
      this.accounts.close();
      throw error;
    }
  }

  async createEnrollmentKey(tenantId, options = {}) {
    return this.control.createEnrollmentKey(tenantId, options);
  }

  async createBootstrapCode(options = {}) {
    return this.accounts.createBootstrapCode(options);
  }

  async listen(options = {}) {
    const normalized = typeof options === 'number' ? { port: options } : options;
    const port = normalized.port ?? 0;
    const host = normalized.host ?? '127.0.0.1';
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.httpServer.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.httpServer.off('error', onError);
        resolve();
      };
      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      this.httpServer.listen(port, host);
    });
    const address = this.httpServer.address();
    const printableHost = address.address.includes(':') ? `[${address.address}]` : address.address;
    this.url = `http://${printableHost}:${address.port}`;
    return Object.freeze({ ...address, url: this.url });
  }

  async close() {
    try {
      if (this.httpServer.listening) {
        this.httpServer.closeIdleConnections?.();
        await new Promise((resolve, reject) => {
          this.httpServer.close((error) => (error ? reject(error) : resolve()));
        });
        this.url = null;
      }
    } finally {
      this.control.close();
      this.snapshots.close();
      this.accounts.close();
    }
  }

  async #authenticate(req) {
    return this.control.authenticateDevice(bearerToken(req));
  }

  async #handle(req, res) {
    const url = parseRequestUrl(req);
    const { pathname } = url;

    if (pathname === '/healthz' && req.method === 'GET') {
      try {
        await this.snapshots.assertServerMasterKeyHealthy();
        sendJson(res, 200, { ok: true });
      } catch (error) {
        this.onError(error);
        sendJson(res, 503, {
          ok: false,
          status: 'degraded',
          component: 'server-vault-key',
        });
      }
      return;
    }

    if (await this.webApi.handle(req, res, url)) return;

    const webAsset = this.webDirectory ? resolveWebAsset(pathname) : null;
    if (webAsset) {
      const assetDirectory = webAsset.source === 'browser'
        ? this.browserDirectory
        : this.webDirectory;
      if (!assetDirectory) throw new HttpError(404, 'Not found');
      await sendWebAsset(req, res, assetDirectory, webAsset);
      return;
    }

    if (url.search && !pathname.startsWith('/api/web/')) {
      throw new HttpError(400, 'Query parameters are not supported');
    }

    if (pathname === '/v1/invitations' && req.method === 'POST') {
      req.resume();
      sendJson(res, 410, {
        error: 'device_delegation_retired',
        message: 'Sign in to the HND web account and create a PC connection code.',
        connect: '/api/web/connections',
      });
      return;
    }

    if (pathname === '/v1/enroll' && req.method === 'POST') {
      const deviceName = headerValue(req, 'x-hnd-device-name') ?? 'unnamed-device';
      const credential = await this.control.consumeEnrollmentKey(bearerToken(req), deviceName);
      sendJson(res, 201, {
        deviceToken: credential.deviceToken,
        device: credential.device,
      });
      return;
    }

    if (pathname === '/v1/join' && req.method === 'POST') {
      const deviceName = headerValue(req, 'x-hnd-device-name') ?? 'unnamed-device';
      const credential = await this.control.consumeDeviceInvitation(bearerToken(req), deviceName);
      try {
        sendJson(res, 201, {
          deviceToken: credential.deviceToken,
          device: credential.device,
          wrappedVaultKey: credential.wrappedVaultKey.toString('base64'),
        });
      } finally {
        credential.wrappedVaultKey.fill(0);
      }
      return;
    }

    // Non-API paths that are not part of the web application are simply
    // absent. In particular, retired standalone installer URLs must not fall
    // through to device authentication and appear to remain available.
    if (!pathname.startsWith('/v1/')) throw new HttpError(404, 'Not found');

    const device = await this.#authenticate(req);

    const connectorReleasePath = pathname === '/v1/connector/manifest'
      || /^\/v1\/connector\/releases\/[a-f0-9]{64}\.hndb$/.test(pathname);
    if (connectorReleasePath) {
      if (!this.connectorRelease) throw new HttpError(404, 'Not found');
      const asset = this.connectorRelease.asset(pathname);
      if (!asset) throw new HttpError(404, 'Not found');
      if (!['GET', 'HEAD'].includes(req.method)) {
        throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
      }
      sendConnectorReleaseAsset(req, res, asset);
      return;
    }

    if (pathname === '/v1/snapshot') {
      if (req.method === 'GET') {
        const snapshot = await this.snapshots.get(device.tenantId);
        if (!snapshot) throw new HttpError(404, 'Snapshot not found');
        sendOpaqueSnapshot(req, res, snapshot);
        return;
      }
      if (req.method === 'PUT') {
        const mediaType = String(headerValue(req, 'content-type') || '').split(';', 1)[0].trim().toLowerCase();
        if (mediaType !== 'application/octet-stream') {
          throw new HttpError(415, 'Snapshot must use application/octet-stream');
        }
        const conditions = validatePutConditions(req);
        const blob = await readOpaqueBody(req, this.maxBlobBytes);
        if (blob.byteLength === 0) throw new HttpError(400, 'Encrypted snapshot must not be empty');
        const result = await this.snapshots.putConditional(device.tenantId, blob, conditions);
        send(res, result.created ? 201 : 204, null, {
          ETag: result.etag,
          Location: `/v1/revisions/${result.revisionId}`,
        });
        return;
      }
      throw new HttpError(405, 'Method not allowed', { Allow: 'GET, PUT' });
    }

    if (pathname === '/v1/revisions' && req.method === 'GET') {
      const revisions = await this.snapshots.listRevisions(device.tenantId);
      sendJson(res, 200, { revisions });
      return;
    }

    const revisionMatch = /^\/v1\/revisions\/([a-f0-9]{64})$/.exec(pathname);
    if (revisionMatch && req.method === 'GET') {
      const revision = await this.snapshots.getRevision(device.tenantId, revisionMatch[1]);
      if (!revision) throw new HttpError(404, 'Revision not found');
      sendOpaqueSnapshot(req, res, revision);
      return;
    }

    if (pathname === '/v1/devices' && req.method === 'GET') {
      const devices = await this.control.listDevices(device.tenantId);
      sendJson(res, 200, { devices });
      return;
    }

    const revokeMatch = /^\/v1\/devices\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/revoke$/.exec(pathname);
    if (revokeMatch && req.method === 'POST') {
      const revoked = await this.control.revokeDevice(device.tenantId, revokeMatch[1]);
      if (!revoked) throw new HttpError(404, 'Device not found');
      send(res, 204);
      return;
    }

    throw new HttpError(404, 'Not found');
  }

  #handleError(res, error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof AuthenticationError) {
      sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    if (error instanceof PreconditionRequiredError) {
      const headers = error.currentEtag ? { ETag: error.currentEtag } : {};
      sendJson(res, 428, { error: 'precondition_required', message: error.message }, headers);
      return;
    }
    if (error instanceof PreconditionFailedError) {
      const headers = error.currentEtag ? { ETag: error.currentEtag } : {};
      sendJson(res, 412, { error: 'precondition_failed', message: error.message }, headers);
      return;
    }
    if (error instanceof HttpError) {
      sendJson(res, error.statusCode, { error: error.message }, error.headers);
      return;
    }
    if (error instanceof WebStaticError) {
      const headers = error.statusCode === 405 ? { Allow: 'GET, HEAD' } : {};
      sendJson(res, error.statusCode, { error: error.message }, headers);
      return;
    }
    if (error instanceof RangeError) {
      sendJson(res, 413, { error: error.message });
      return;
    }
    if (error?.message?.startsWith('Invalid ') || error?.message?.includes('cannot be combined')) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    this.onError(error);
    sendJson(res, 500, { error: 'internal_server_error' });
  }
}

export async function createSyncServer(options = {}) {
  const server = new OpaqueSyncServer(options);
  return server.init();
}

function usage() {
  return [
    'Usage:',
    '  hnd-server [--data-dir PATH] [--host HOST] [--port PORT] [--max-revisions N]',
    '      [--connector-dir PATH]',
    '  hnd-server enroll TENANT [--data-dir PATH] [--ttl-seconds N]',
    '  hnd-server account bootstrap [--tenant TENANT] [--data-dir PATH] [--ttl-seconds N]',
    '',
  ].join('\n');
}

function takeOption(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function environmentBoolean(value, name, fallback = false) {
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function parseServerArguments(argv, env) {
  const args = [...argv];
  let command = 'serve';
  let tenantId;
  if (args[0] === 'enroll') {
    command = 'enroll';
    args.shift();
    tenantId = args.shift();
    if (!tenantId || tenantId.startsWith('--')) throw new Error('enroll requires a tenant id');
  } else if (args[0] === 'account') {
    args.shift();
    const action = args.shift();
    if (action !== 'bootstrap') throw new Error('account command must be bootstrap');
    command = 'bootstrap';
  }
  const parsed = {
    command,
    tenantId,
    dataDirectory: env.HND_SERVER_DATA || path.resolve('hnd-server-data'),
    webDirectory: env.HND_SERVER_WEB ? path.resolve(env.HND_SERVER_WEB) : undefined,
    connectorDirectory: env.HND_SERVER_CONNECTOR_DIR
      ? path.resolve(env.HND_SERVER_CONNECTOR_DIR)
      : undefined,
    publicOrigin: env.HND_PUBLIC_ORIGIN || 'http://localhost',
    rpId: env.HND_WEBAUTHN_RP_ID || undefined,
    signupMode: env.HND_SIGNUP_MODE || 'open',
    trustProxy: environmentBoolean(env.HND_TRUST_PROXY, 'HND_TRUST_PROXY'),
    host: env.HND_SERVER_HOST || '127.0.0.1',
    port: Number(env.HND_SERVER_PORT || 8787),
    maxRevisionsPerTenant: env.HND_SERVER_MAX_REVISIONS === undefined
      ? undefined
      : Number(env.HND_SERVER_MAX_REVISIONS),
    ttlMs: 15 * 60 * 1000,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') parsed.help = true;
    else if (argument === '--data-dir') parsed.dataDirectory = path.resolve(takeOption(args, index++, argument));
    else if (argument === '--connector-dir') {
      parsed.connectorDirectory = path.resolve(takeOption(args, index++, argument));
    }
    else if (argument === '--host') parsed.host = takeOption(args, index++, argument);
    else if (argument === '--port') parsed.port = Number(takeOption(args, index++, argument));
    else if (argument === '--max-revisions') {
      parsed.maxRevisionsPerTenant = Number(takeOption(args, index++, argument));
    }
    else if (argument === '--tenant') parsed.tenantId = takeOption(args, index++, argument);
    else if (argument === '--ttl-seconds') parsed.ttlMs = Number(takeOption(args, index++, argument)) * 1000;
    else if (argument === '--create-enroll') {
      parsed.command = 'enroll';
      parsed.tenantId = takeOption(args, index++, argument);
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 0 || parsed.port > 65535) {
    throw new Error('Port must be an integer from 0 to 65535');
  }
  if (
    parsed.maxRevisionsPerTenant !== undefined
    && (
      !Number.isSafeInteger(parsed.maxRevisionsPerTenant)
      || parsed.maxRevisionsPerTenant < 1
      || parsed.maxRevisionsPerTenant > 10_000
    )
  ) {
    throw new Error('Max revisions must be an integer from 1 to 10000');
  }
  return parsed;
}

export async function serverMain(argv = [], options = {}) {
  const parsed = parseServerArguments(argv, options.env ?? process.env);
  const stdout = options.stdout ?? process.stdout;
  if (parsed.help) {
    stdout.write(usage());
    return null;
  }
  const server = await createSyncServer({
    dataDirectory: parsed.dataDirectory,
    webDirectory: parsed.webDirectory,
    connectorDirectory: parsed.connectorDirectory ?? options.connectorDirectory,
    publicOrigin: parsed.publicOrigin,
    rpId: parsed.rpId,
    signupMode: parsed.signupMode,
    trustProxy: parsed.trustProxy,
    maxBlobBytes: options.maxBlobBytes,
    maxRevisionsPerTenant: parsed.maxRevisionsPerTenant ?? options.maxRevisionsPerTenant,
    onError: options.onError,
  });
  if (parsed.command === 'enroll') {
    try {
      const enrollment = await server.createEnrollmentKey(parsed.tenantId, { ttlMs: parsed.ttlMs });
      stdout.write(`${enrollment.enrollmentKey}\n`);
      return enrollment;
    } finally {
      await server.close();
    }
  }
  if (parsed.command === 'bootstrap') {
    try {
      const bootstrap = await server.createBootstrapCode({
        tenantId: parsed.tenantId,
        ttlMs: parsed.ttlMs,
      });
      stdout.write(`${bootstrap.code}\n`);
      return bootstrap;
    } finally {
      await server.close();
    }
  }
  const address = await server.listen({ host: parsed.host, port: parsed.port });
  stdout.write(`hnd-server listening on ${address.url}\n`);
  return server;
}
