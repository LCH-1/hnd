import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const ASSETS = new Map([
  ['/web/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/web/api.js', ['api.js', 'text/javascript; charset=utf-8']],
  ['/web/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
  ['/web/webauthn.js', ['webauthn.js', 'text/javascript; charset=utf-8']],
  ['/web/vault.js', ['vault.js', 'text/javascript; charset=utf-8']],
  ['/web/ui.js', ['ui.js', 'text/javascript; charset=utf-8']],
  ['/web/entry.js', ['entry.js', 'text/javascript; charset=utf-8']],
  ['/web/setup.js', ['setup.js', 'text/javascript; charset=utf-8']],
  ['/web/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/web/connector-release.js', ['connector-release.js', 'text/javascript; charset=utf-8']],
  ['/web/snapshot-data.js', ['snapshot-data.js', 'text/javascript; charset=utf-8']],
  ['/web/hnd-icon.png', ['hnd-icon.png', 'image/png']],
  ['/site.webmanifest', ['site.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
]);

const BROWSER_ASSETS = new Map([
  ['/browser/index.mjs', ['index.mjs', 'text/javascript; charset=utf-8']],
  ['/browser/crypto.mjs', ['crypto.mjs', 'text/javascript; charset=utf-8']],
  ['/browser/storage.mjs', ['storage.mjs', 'text/javascript; charset=utf-8']],
  ['/browser/vault.mjs', ['vault.mjs', 'text/javascript; charset=utf-8']],
]);

const DOCUMENTS = Object.freeze({
  entry: Object.freeze({ file: 'index.html', contentType: 'text/html; charset=utf-8' }),
  setup: Object.freeze({ file: 'setup.html', contentType: 'text/html; charset=utf-8' }),
  app: Object.freeze({ file: 'app.html', contentType: 'text/html; charset=utf-8' }),
});

const WEB_SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self)',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

export class WebStaticError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'WebStaticError';
    this.statusCode = statusCode;
  }
}

export function resolveWebAsset(pathname) {
  if (pathname === '/') return Object.freeze({ ...DOCUMENTS.entry, source: 'web' });
  if (pathname === '/setup' || pathname === '/setup/') {
    return Object.freeze({ ...DOCUMENTS.setup, source: 'web' });
  }
  if (pathname === '/app' || pathname === '/app/' || pathname.startsWith('/app/')) {
    return Object.freeze({ ...DOCUMENTS.app, source: 'web' });
  }
  const asset = ASSETS.get(pathname);
  if (asset) {
    return Object.freeze({ file: asset[0], contentType: asset[1], source: 'web' });
  }
  const browserAsset = BROWSER_ASSETS.get(pathname);
  return browserAsset
    ? Object.freeze({
        file: browserAsset[0],
        contentType: browserAsset[1],
        source: 'browser',
      })
    : null;
}

async function openWebFile(webDirectory, descriptor) {
  const root = path.resolve(webDirectory);
  let handle;
  try {
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new WebStaticError(404, 'Not found');
    }
    const canonicalRoot = await realpath(root);
    const filePath = path.join(root, descriptor.file);
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new WebStaticError(404, 'Not found');
    }
    const canonicalFile = await realpath(filePath);
    const expectedFile = path.join(canonicalRoot, descriptor.file);
    const samePath = process.platform === 'win32'
      ? canonicalFile.toLowerCase() === expectedFile.toLowerCase()
      : canonicalFile === expectedFile;
    if (!samePath) throw new WebStaticError(404, 'Not found');

    const noFollow = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW || 0);
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
    ) {
      throw new WebStaticError(404, 'Not found');
    }
    const result = { handle, size: opened.size };
    handle = null;
    return result;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof WebStaticError) throw error;
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) {
      throw new WebStaticError(404, 'Not found');
    }
    throw error;
  }
}

export async function sendWebAsset(req, res, webDirectory, descriptor) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    throw new WebStaticError(405, 'Method not allowed');
  }
  const { handle, size } = await openWebFile(webDirectory, descriptor);
  const headers = {
    ...WEB_SECURITY_HEADERS,
    'Content-Length': String(size),
    'Content-Type': descriptor.contentType,
  };
  if (req.method === 'HEAD') {
    await handle.close();
    res.writeHead(200, headers);
    res.end();
    return;
  }
  let stream;
  try {
    stream = handle.createReadStream({ autoClose: true });
    res.writeHead(200, headers);
    await pipeline(stream, res);
  } catch (error) {
    stream?.destroy();
    await handle.close().catch(() => {});
    throw error;
  }
}

export { WEB_SECURITY_HEADERS };
