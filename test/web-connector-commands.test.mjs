import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { CONNECTOR_PACKAGE_SPEC } from '../src/web/connector-release.js';

const pages = [
  {
    file: 'setup.js', functionName: 'updateCommands',
    platformField: 'installPlatform', installField: 'includeConnectorInstall',
    nameId: '#first-device-name', helpId: '#install-platform-help',
    outputId: '#connect-command code',
    connectionState: (code) => ({ deviceInvitation: code ? { invitation: code } : null }),
  },
  {
    file: 'app.js', functionName: 'updateDeviceCommands',
    platformField: 'deviceInstallPlatform', installField: 'includeDeviceConnectorInstall',
    nameId: '#device-name', helpId: '#device-platform-help',
    outputId: '#device-join-command code',
    connectionState: (code) => ({ deviceConnectionCode: code, deviceConnection: code ? {} : null }),
  },
];

async function fixture(page, { platform = 'windows', install = true, code = "AB'CDE" } = {}) {
  const source = await readFile(new URL(`../src/web/${page.file}`, import.meta.url), 'utf8');
  const start = source.indexOf(`function ${page.functionName}()`);
  const end = source.indexOf('\n}\n', start) + 2;
  assert.ok(start >= 0 && end > start, `missing ${page.functionName}`);
  const state = {
    [page.platformField]: platform,
    [page.installField]: install,
    ...page.connectionState(code),
  };
  const output = { textContent: '' };
  const copyButton = { disabled: false };
  const elements = {
    [page.nameId]: { value: "회사 '개발' & (A)" },
    [page.helpId]: { textContent: '' },
    [page.outputId]: output,
  };
  // Run the shipped command renderer; no authenticated browser or invitation is needed.
  const context = vm.createContext({
    state, CONNECTOR_PACKAGE_SPEC,
    window: { location: { origin: 'https://hnd.example' } },
    document: { querySelector: () => copyButton },
    $: (selector) => {
      assert.ok(elements[selector], `unexpected selector: ${selector}`);
      return elements[selector];
    },
    $$: () => [],
  });
  vm.runInContext(source.slice(start, end), context);
  const render = () => {
    vm.runInContext(`${page.functionName}()`, context);
    return output.textContent;
  };
  return { state, render, copyButton };
}

for (const page of pages) {
  for (const install of [true, false]) {
    test(`${page.file}: Windows ${install ? 'installation' : 'existing connector'} uses cmd shims and quotes PowerShell input`, async () => {
      const { render, copyButton } = await fixture(page, { install });
      const expected = [
        ...(install ? ["npm.cmd install --global '@lch-1/hnd@latest'"] : []),
        "'AB''CDE' | hnd.cmd connect --url 'https://hnd.example' --code-stdin --name '회사 ''개발'' & (A)'",
        'hnd.cmd setup',
      ].join('\n');
      assert.equal(render(), expected);
      assert.equal(copyButton.disabled, false);
    });
  }

  for (const platform of ['linux', 'macos']) {
    test(`${page.file}: switching from Windows to ${platform} restores POSIX commands`, async () => {
      const { render, state } = await fixture(page);
      assert.match(render(), /hnd\.cmd setup$/u);
      state[page.platformField] = platform;
      const command = render();
      assert.ok(command.startsWith(`${platform === 'linux' ? 'sudo -H ' : ''}npm install --global`));
      assert.match(command, /\| hnd connect --url/u);
      assert.match(command, /&&\nhnd setup$/u);
      assert.doesNotMatch(command, /\b(?:hnd|npm)\.cmd\b/u);
      state[page.installField] = false;
      assert.doesNotMatch(render(), /npm install/u);
    });
  }

  test(`${page.file}: missing invitation keeps copy disabled and emits no executable commands`, async () => {
    const { render, copyButton } = await fixture(page, { code: '' });
    assert.match(render(), /^# /u);
    assert.doesNotMatch(render(), /npm|hnd/u);
    assert.equal(copyButton.disabled, true);
  });
}
