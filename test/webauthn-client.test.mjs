import assert from 'node:assert/strict';
import test from 'node:test';

import { getPasskey } from '../src/web/webauthn.js';

test('passkey authentication forwards cancellation and returns a retryable message', async (t) => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else delete globalThis.window;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  });

  const controller = new AbortController();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { PublicKeyCredential: function PublicKeyCredential() {} },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      credentials: {
        async get(options) {
          assert.equal(options.signal, controller.signal);
          const error = new Error('cancelled');
          error.name = 'AbortError';
          throw error;
        },
      },
    },
  });

  await assert.rejects(
    getPasskey({ challenge: 'AQ' }, { signal: controller.signal }),
    /패스키 인증을 취소했습니다\. 다시 시도해 주세요\./u,
  );
});
