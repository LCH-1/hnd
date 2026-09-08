// Informational only: releases are still installed exclusively from the signed
// account-server manifest. Never send device credentials to the public registry.
export const LAUNCHER_LATEST_URL = 'https://registry.npmjs.org/@lch-1%2fhnd/latest';
const MAX_METADATA_BYTES = 32 * 1024;

export async function checkLauncherRelease({ fetchImpl = fetch, timeoutMs = 3_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(new Error('npm registry check timed out'));
    controller.signal.addEventListener('abort', abortListener, { once: true });
  });
  let reader;
  let complete = false;
  try {
    const response = await Promise.race([
      fetchImpl(LAUNCHER_LATEST_URL, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      }),
      aborted,
    ]);
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_METADATA_BYTES)) {
      throw new Error('npm registry response is too large');
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error('npm registry returned an empty response');
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METADATA_BYTES) throw new Error('npm registry response is too large');
      chunks.push(Buffer.from(value));
    }
    complete = true;
    const metadata = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (metadata.name !== '@lch-1/hnd' || typeof metadata.version !== 'string'
      || metadata.version.length > 100
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)) {
      throw new Error('npm registry returned invalid package metadata');
    }
    return { launcherLatestVersion: metadata.version, launcherCheckError: null };
  } catch (error) {
    return { launcherLatestVersion: null, launcherCheckError: error.message };
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', abortListener);
    if (reader && !complete) reader.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
