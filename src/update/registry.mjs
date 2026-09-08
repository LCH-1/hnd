// Informational only: releases are still installed exclusively from the signed
// account-server manifest. Never send device credentials to the public registry.
export const LAUNCHER_LATEST_URL = 'https://registry.npmjs.org/@lch-1%2fhnd/latest';
export const SERVER_LATEST_URL = 'https://api.github.com/repos/LCH-1/hnd/releases/latest';
export const SERVER_RELEASES_URL = 'https://github.com/LCH-1/hnd/releases';
const MAX_METADATA_BYTES = 32 * 1024;

export function isVersion(value) {
  return typeof value === 'string' && value.length <= 100
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.exec(value)?.[0] === value;
}

// Bound both headers and body reads. Also used for the authenticated server
// version endpoint; credentials are supplied only by that same-origin caller.
export async function fetchVersionMetadata(url, {
  fetchImpl = fetch,
  timeoutMs = 3_000,
  headers = { Accept: 'application/json' },
  source = 'npm registry',
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(new Error(`${source} check timed out`));
    controller.signal.addEventListener('abort', abortListener, { once: true });
  });
  let reader;
  let complete = false;
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        headers,
        redirect: 'error',
        signal: controller.signal,
      }),
      aborted,
    ]);
    reader = response.body?.getReader();
    if (!response.ok) {
      throw Object.assign(new Error(`${source} returned HTTP ${response.status}`), { status: response.status });
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_METADATA_BYTES)) {
      throw new Error(`${source} response is too large`);
    }
    if (!reader) throw new Error(`${source} returned an empty response`);
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METADATA_BYTES) throw new Error(`${source} response is too large`);
      chunks.push(Buffer.from(value));
    }
    complete = true;
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', abortListener);
    if (reader && !complete) reader.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

export async function checkLauncherRelease({ fetchImpl = fetch, timeoutMs = 3_000 } = {}) {
  try {
    const metadata = await fetchVersionMetadata(LAUNCHER_LATEST_URL, { fetchImpl, timeoutMs });
    if (metadata?.name !== '@lch-1/hnd' || !isVersion(metadata.version)) {
      throw new Error('npm registry returned invalid package metadata');
    }
    return { launcherLatestVersion: metadata.version, launcherCheckError: null };
  } catch (error) {
    return { launcherLatestVersion: null, launcherCheckError: error.message };
  }
}

export async function checkServerRelease({ fetchImpl = fetch, timeoutMs = 3_000 } = {}) {
  try {
    const metadata = await fetchVersionMetadata(SERVER_LATEST_URL, {
      fetchImpl, timeoutMs, source: 'GitHub releases',
      headers: { Accept: 'application/vnd.github+json' },
    });
    const match = typeof metadata?.tag_name === 'string'
      && /^server-v(\d+\.\d+\.\d+)$/.exec(metadata.tag_name);
    if (!match || match[0] !== metadata.tag_name || !isVersion(match[1])
      || metadata.draft !== false || metadata.prerelease !== false) {
      throw new Error('GitHub returned invalid server release metadata');
    }
    return {
      serverLatestVersion: match[1],
      serverReleaseUrl: `${SERVER_RELEASES_URL}/tag/${metadata.tag_name}`,
      serverReleaseStatus: 'available',
      serverReleaseError: null,
    };
  } catch (error) {
    return {
      serverLatestVersion: null,
      serverReleaseUrl: SERVER_RELEASES_URL,
      serverReleaseStatus: error.status === 404 ? 'not_published' : 'check_failed',
      serverReleaseError: error.message,
    };
  }
}
