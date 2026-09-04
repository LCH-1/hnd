import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('setup keeps a server retry path and lets users defer the optional PC connection', async () => {
  const [html, script, release, entry, styles, rootPackage] = await Promise.all([
    readFile(new URL('../src/web/setup.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/setup.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/connector-release.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  assert.match(entry, /첫 소유자 계정을 웹에서 바로 만듭니다/u);
  assert.match(entry, /소유자 계정 만들기/u);
  assert.match(entry, /HND에 로그인/u);
  assert.doesNotMatch(entry, /계속할 방법을 선택하세요/u);
  assert.doesNotMatch(entry, /계정이 있으면 로그인하고, 처음이라면 새 계정을 만드세요/u);
  assert.match(entry, /id="signup-link"[\s\S]*?class="button button-secondary button-wide"/u);
  assert.doesNotMatch(entry, /docker exec/u);
  assert.match(script, /session\.signup\.requiresCode !== true/u);
  assert.match(script, /showStep\(state\.codeFreeSignup \? 1 : 0/u);
  assert.match(script, /configureStepProgress\(state\.codeFreeSignup\)/u);
  assert.match(script, /heading\.tabIndex = -1/u);
  assert.match(styles, /\.setup-code-free \.setup-step\[data-step="1"\]/u);
  assert.match(styles, /\.stepper li\.is-current small\s*\{\s*color: var\(--forest\)/u);
  assert.match(html, /id="code-form"/u);
  assert.match(script, /error\?\.code === "tenant_required"/u);
  assert.match(html, /id="skip-device"[\s\S]*?>\s*나중에 연결/u);
  assert.match(html, /id="complete-device-status"/u);
  assert.doesNotMatch(
    html.match(/<button\s+id="skip-device"[^>]*>/u)?.[0] || '',
    /\bdisabled\b/u,
  );
  assert.match(
    script,
    /\$\("#skip-device"\)\.addEventListener\("click",[\s\S]*?showStep\(6\)/u,
  );
  assert.match(script, /localVault && state\.vaultInitialized/u);
  const advanceAfterVault = script.slice(
    script.indexOf('async function advanceAfterVault()'),
    script.indexOf('async function configureVaultStep'),
  );
  assert.doesNotMatch(advanceAfterVault, /api\.devices/u);
  assert.match(
    advanceAfterVault,
    /state\.deviceConnected = false;[\s\S]*?showStep\(5\)/u,
  );
  const authenticatedStep = script.slice(
    script.indexOf('async function deriveAuthenticatedStep'),
    script.indexOf('async function initialize'),
  );
  assert.doesNotMatch(authenticatedStep, /api\.devices/u);
  assert.match(
    authenticatedStep,
    /state\.deviceConnected = false;[\s\S]*?showStep\(5, \{ focus: false \}\)/u,
  );
  assert.match(script, /같은 키로 다시 시도/u);
  assert.match(html, /id="setup-exit"/u);
  assert.match(html, /id="recovery-retry"/u);
  assert.match(
    script,
    /\$\("#recovery-retry"\)\.addEventListener\("click", loadRecoveryCodes\)/u,
  );
  assert.match(script, /api\.recoveryConfirm/u);
  assert.match(script, /withRecentAuthentication[\s\S]*?unlockManagedBrowserVault/u);
  assert.match(script, /withRecentAuthentication[\s\S]*?adoptBrowserVaultKey/u);
  assert.match(
    script,
    /catch \(error\) \{[\s\S]*?setHidden\(createPanel, !retryWithCreate\)[\s\S]*?setHidden\(pairPanel, retryWithCreate\)/u,
  );
  assert.match(
    script,
    /state\.vaultInitialized === null[\s\S]*?configureVaultStep\(\{ force: true \}\)/u,
  );
  assert.doesNotMatch(html, /id="first-env-name"|id="first-repo-path"/u);
  assert.doesNotMatch(html, /id="repository-command"|id="install-command"/u);
  assert.match(html, /웹에서만 쓴다면 설치하지 않아도 됩니다/u);
  assert.match(html, /진행 상태를 저장하고/u);
  assert.match(html, /data-install-platform="windows"/u);
  assert.match(html, /data-install-platform="macos"/u);
  assert.match(html, /data-install-platform="linux"/u);
  assert.ok(
    html.indexOf('data-install-platform="linux"') <
      html.indexOf('data-install-platform="windows"') &&
      html.indexOf('data-install-platform="windows"') <
        html.indexOf('data-install-platform="macos"'),
  );
  assert.match(html, /data-install-mode="install"/u);
  assert.match(html, /data-install-mode="existing"/u);
  assert.match(html, /브라우저[\s\S]*?실제 터미널/u);
  assert.doesNotMatch(html, /npm을 사용할 수 없나요|\/install\.(?:ps1|sh)/u);
  assert.doesNotMatch(script, /function detectInstallPlatform/u);
  assert.match(script, /installPlatform: "linux"/u);
  assert.match(script, /includeConnectorInstall: true/u);
  assert.match(script, /npm install --global/u);
  assert.doesNotMatch(script, /npm\.cmd/u);
  assert.match(script, /hnd connect --url/u);
  assert.match(script, /"hnd setup"/u);
  assert.match(script, /sudo -H/u);
  assert.doesNotMatch(script, /Get-Command|LASTEXITCODE|set -eu|setup --dry-run|hnd --version/u);
  assert.doesNotMatch(script, /Invoke-WebRequest -UseBasicParsing/u);
  assert.doesNotMatch(script, /LOCALAPPDATA/u);
  assert.doesNotMatch(script, /export PATH=/u);
  assert.match(release, /CONNECTOR_PACKAGE_NAME = "@lch-1\/hnd"/u);
  assert.match(release, new RegExp(`CONNECTOR_PACKAGE_VERSION = "${rootPackage.version.replaceAll('.', '\\.')}"`, 'u'));
  assert.match(html, /id="create-device-invitation"/u);
  assert.match(html, /id="cancel-device-auth"[\s\S]*?패스키 인증 취소/u);
  assert.match(html, /id="device-invitation"/u);
  assert.match(html, /id="setup-account-vault"/u);
  assert.doesNotMatch(html, /download-vault-key|hnd-vault\.key/u);
  assert.match(html, /계정이 암호화 키를 관리/u);
  assert.doesNotMatch(html, /hnd sync key import|hnd sync invite/u);
  assert.doesNotMatch(html, /모든 보관함 암호화 키 사본을[\s\S]*?서버의 암호문/u);
  assert.match(script, /createAccountConnection\(\{ ttlSeconds: 900 \}\)/u);
  assert.doesNotMatch(script, /createDeviceInvitation|pairBrowserVault/u);
  assert.doesNotMatch(script, /Read-Host|IFS= read/u);
  assert.match(script, /state\.deviceInvitation\?\.invitation/u);
  assert.match(script, /npm install --global[\s\S]*?hnd connect --url[\s\S]*?"hnd setup"/u);
  assert.match(script, /dataset\.installMode === "install"/u);
  assert.doesNotMatch(script, /hnd init --env|repositoryPath|first-repo-path/u);
  assert.match(script, /deviceReauthController\?\.abort\(\)/u);
  assert.match(script, /signal: deviceReauthController\.signal/u);
  assert.match(script, /copyButton\.disabled = !commandReady/u);
  assert.match(script, /clearSetupDeviceInvitation[\s\S]*?updateCommands\(\)/u);
  assert.match(script, /hnd connect --url/u);
  assert.doesNotMatch(script, /enrollmentCreate|enrollmentStatus|hnd sync enroll|hnd-vault\.key/u);
  assert.match(script, /deviceIdsBeforeInvitation/u);
  assert.match(script, /deviceIdsBeforeInvitation = activeDeviceIds\(await api\.devices\(\)\)/u);
  assert.match(script, /expectedName:[\s\S]*?issuedAt: Date\.now\(\)/u);
  assert.match(script, /device\.name !== state\.deviceInvitation\.expectedName/u);
  assert.doesNotMatch(script, /Set-Location 'C:\\\\path/u);
  assert.doesNotMatch(script, /"cd \/path\/to\/repository"/u);
  assert.match(script, /const shellQuote/u);
  assert.match(script, /const powerShellQuote/u);
  assert.match(script, /--name \$\{shellQuote\(name\)\}/u);
  assert.doesNotMatch(script, /hnd init --env \$\{name\}/u);
  assert.match(html, /AI 세션을 열 때 자동으로 등록/u);
});
