import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('app shell supports encrypted offline reopen without caching APIs or account data', async () => {
  const [html, app, snapshotData, worker, api, styles] = await Promise.all([
    readFile(new URL('../src/web/app.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/snapshot-data.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/api.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/styles.css', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /id="app-error-gate"/u);
  assert.match(app, /serviceWorker\.register\("\/sw\.js"/u);
  assert.match(app, /listLocalVaultIds/u);
  assert.match(app, /offlineWorkspaceEnabled/u);
  assert.match(snapshotData, /sealBrowserValue[\s\S]*?offline-access:/u);
  assert.doesNotMatch(snapshotData, /rememberedAt|WORKSPACE_HINT_KEY/u);
  assert.match(worker, /request\.mode === "navigate"[\s\S]*?\/app/u);
  assert.match(worker, /async function staticAsset[\s\S]*?await fetch\(request\)/u);
  assert.match(worker, /hnd-app-shell-v30/u);
  assert.match(html, /class="app-title sr-only"/u);
  assert.match(html, /class="app-mobile-brand"/u);
  assert.match(worker, /\/web\/hnd-icon\.png/u);
  assert.match(worker, /\/site\.webmanifest/u);
  assert.match(worker, /\/web\/i18n\.js/u);
  assert.match(
    worker,
    /event\.data\?\.type !== "hnd-vault-reset"[\s\S]*?clients[\s\S]*?client\.navigate\(client\.url\)/u,
  );
  assert.match(worker, /\/web\/connector-release\.js/u);
  assert.doesNotMatch(worker, /["']\/api\/web/u);
  assert.doesNotMatch(worker, /APP_ASSETS[\s\S]*?["']\/(?:setup)?["']/u);
  assert.match(html, /id="sync-retry"/u);
  assert.match(html, /id="sync-reconnect-vault"/u);
  assert.match(html, /id="sync-keep-local"/u);
  assert.match(html, /id="sync-use-server"/u);
  assert.doesNotMatch(html, /id="device-install-command"/u);
  assert.match(html, /id="create-device-invitation"/u);
  assert.match(html, /id="cancel-device-auth"[\s\S]*?패스키 인증 취소/u);
  assert.match(html, /id="device-invitation"/u);
  assert.match(html, /id="connect-device"[\s\S]*?disabled/u);
  assert.match(html, /id="devices-retry"[\s\S]*?hidden/u);
  assert.match(app, /view === "devices"[\s\S]*?devices-retry/u);
  assert.match(app, /devices-retry[\s\S]*?setView\("devices", \{ force: true \}\)/u);
  assert.match(html, /data-device-platform="windows"/u);
  assert.match(html, /data-device-platform="macos"/u);
  assert.match(html, /data-device-platform="linux"/u);
  assert.ok(
    html.indexOf('data-device-platform="linux"') <
      html.indexOf('data-device-platform="windows"') &&
      html.indexOf('data-device-platform="windows"') <
        html.indexOf('data-device-platform="macos"'),
  );
  assert.match(html, /data-device-install-mode="install"/u);
  assert.match(html, /data-device-install-mode="existing"/u);
  assert.match(html, /브라우저[\s\S]*?실제 터미널/u);
  assert.doesNotMatch(html, /npm 없이 설치|\/install\.(?:ps1|sh)/u);
  assert.match(app, /function updateDeviceCommands/u);
  assert.doesNotMatch(app, /activeDeviceCount/u);
  assert.match(app, /connectButton\.textContent = "PC 연결"/u);
  assert.match(
    app,
    /\$\("#connect-device"\)\.addEventListener\("click",[\s\S]*?clearDeviceInvitation\(\)[\s\S]*?device-dialog/u,
  );
  assert.match(app, /이 계정의 일회용 코드를 만드세요/u);
  assert.match(app, /createAccountConnection\(\{ ttlSeconds: 900 \}\)/u);
  assert.doesNotMatch(app, /createDeviceInvitation|pairBrowserVault/u);
  assert.match(app, /npm install --global/u);
  assert.doesNotMatch(app, /npm\.cmd/u);
  assert.match(app, /deviceInstallPlatform: "linux"/u);
  assert.match(app, /includeDeviceConnectorInstall: true/u);
  assert.match(app, /hnd connect --url/u);
  assert.match(app, /"hnd setup"/u);
  assert.match(app, /sudo -H/u);
  assert.doesNotMatch(app, /Get-Command|LASTEXITCODE|set -eu|setup --dry-run|hnd --version/u);
  assert.doesNotMatch(app, /Invoke-WebRequest -UseBasicParsing/u);
  assert.doesNotMatch(app, /Read-Host|IFS= read/u);
  assert.match(app, /deviceConnectionCode/u);
  assert.match(app, /npm install --global[\s\S]*?hnd connect --url[\s\S]*?"hnd setup"/u);
  assert.match(app, /deviceInstallMode === "install"/u);
  assert.match(app, /copyButton\.disabled = !connectionCode/u);
  assert.match(html, /id="device-connection-status"[\s\S]*?data-state="idle"/u);
  assert.match(html, /id="check-device-connection"[\s\S]*?지금 확인/u);
  assert.match(app, /deviceIdsBeforeConnection: new Set\(\)/u);
  assert.match(app, /state\.deviceIdsBeforeConnection = activeDeviceIds\(await api\.devices\(\)\)/u);
  assert.match(app, /async function checkDeviceConnection/u);
  assert.match(app, /renderDeviceConnectionStatus\("connected", connected\)/u);
  assert.match(app, /startDeviceConnectionPolling\(\)/u);
  assert.match(app, /clearDeviceInvitation\(\{ preserveStatus: true \}\)/u);
  assert.match(app, /deviceReauthController\?\.abort\(\)/u);
  assert.match(app, /signal: deviceReauthController\.signal/u);
  assert.match(html, /AI 세션을 열 때 자동 등록/u);
  assert.match(app, /hnd connect --url/u);
  assert.match(app, /기존 hnd를 그대로 사용합니다/u);
  assert.match(app, /data-action": "rename-device"/u);
  assert.match(app, /function editDeviceName/u);
  assert.match(app, /maxlength: 100/u);
  assert.match(app, /await api\.renameDevice\(button\.dataset\.id, name\)/u);
  assert.match(app, /toast\("PC 이름을 변경했습니다\."\)/u);
  assert.match(api, /renameDevice: \(id, name\)[\s\S]*?method: "PATCH"/u);
  assert.match(api, /invalid_device_name: "PC 이름은/u);
  assert.match(styles, /\.device-rename-form[\s\S]*?grid-template-columns/u);
  assert.doesNotMatch(app, /기존 PC가 만든|hnd sync join|hnd sync invite/u);
  assert.match(html, /id="vault-account-unlock"/u);
  assert.match(html, /서버가[\s\S]*?보관함 키를[\s\S]*?보호 저장소/u);
  assert.doesNotMatch(html, /hnd sync key import|hnd sync invite/u);
  assert.match(html, /id="vault-reset-dialog"/u);
  assert.match(html, /id="device-dialog"[\s\S]*?aria-labelledby="device-dialog-title"/u);
  assert.match(html, /id="vault-reset-dialog"[\s\S]*?aria-labelledby="vault-reset-dialog-title"/u);
  assert.match(html, /id="vault-reset-confirmation"/u);
  assert.match(html, /서버의 기존 암호문과 모든 저장 기록을 삭제합니다/u);
  assert.match(html, /연결된 PC가 0대여야/u);
  assert.match(html, /다른 기기의 로컬 사본과 내보낸 파일은 지울 수 없습니다/u);
  assert.match(
    html,
    /href="#devices"[\s\S]*?href="#security"[\s\S]*?href="#settings"/u,
  );
  assert.match(
    app,
    /const vaultContentViews = new Set\(\[[\s\S]*?"home"[\s\S]*?"projects"[\s\S]*?"rules"[\s\S]*?"work"[\s\S]*?"knowledge"[\s\S]*?\]\)/u,
  );
  assert.match(
    app,
    /const gated = state\.vaultLocked && vaultContentViews\.has\(selected\)/u,
  );
  assert.match(app, /const connectionUnavailable = state\.offlineBoot \|\| !state\.keyManaged/u);
  assert.match(app, /connectButton\.disabled = connectionUnavailable/u);
  assert.match(app, /resetBrowserVault\(state\.tenantId, status\.etag\)/u);
  assert.match(app, /withRecentAuthentication\([\s\S]*?resetBrowserVault/u);
  assert.match(
    app,
    /!state\.vaultLocked \|\| !state\.legacyResetAllowed \|\| !userIsOwner\(\)/u,
  );
  assert.match(app, /if \(status\?\.keyManaged === true\)[\s\S]*?초기화하지 않고/u);
  assert.match(app, /if \(await hasLocalVault\(state\.tenantId\)\)[\s\S]*?초기화를 중단/u);
  assert.match(
    app,
    /window\.addEventListener\("online"[\s\S]*?api\.vaultStatus\(\)[\s\S]*?adoptBrowserVaultKey/u,
  );
  assert.match(app, /value !== "보관함 초기화"/u);
  assert.match(app, /function recoverStaleManagedCache/u);
  assert.match(app, /function reconnectManagedVault/u);
  assert.match(app, /sync-reconnect-vault[\s\S]*?reconnectManagedVault/u);
  assert.match(
    app,
    /vault_key_mismatch[\s\S]*?!dataStore\.hasLocalContent\(\)[\s\S]*?resetBrowserWorkspaceCache\(state\.tenantId\)[\s\S]*?unlockManagedBrowserVault\(state\.tenantId\)[\s\S]*?new SnapshotDataStore\(state\.tenantId\)/u,
  );
  const beginReset = app.indexOf(
    "await beginBrowserWorkspaceReset(state.tenantId)",
  );
  const remoteReset = app.indexOf(
    "resetBrowserVault(state.tenantId, status.etag)",
    beginReset,
  );
  const announceBeforeReset = app.indexOf(
    "announceVaultReset(state.tenantId)",
    beginReset,
  );
  const finalizeReset = app.indexOf(
    "await finalizeBrowserWorkspaceReset(state.tenantId, resetEpoch)",
    remoteReset,
  );
  const announceReset = app.indexOf(
    "announceVaultReset(state.tenantId)",
    finalizeReset,
  );
  const reopenedStore = app.indexOf(
    "const dataStore = new SnapshotDataStore(state.tenantId)",
    announceReset,
  );
  assert.ok(
    beginReset >= 0 &&
      beginReset < announceBeforeReset &&
      announceBeforeReset < remoteReset &&
      remoteReset < finalizeReset &&
      finalizeReset < announceReset &&
      announceReset < reopenedStore,
    "the local reset barrier must surround the exact remote reset before reopening",
  );
  assert.match(app, /BroadcastChannel\("hnd:vault-reset"\)/u);
  assert.match(app, /serviceWorker\?\.controller\?\.postMessage\(message\)/u);
  assert.equal(
    app.match(/enableOfflineWorkspace\(state\.tenantId\)\.catch/g)?.length,
    4,
  );
  assert.match(
    app,
    /state\.offlineBoot \|\| !state\.keyManaged[\s\S]*?새 PC를 연결할 수 있습니다/u,
  );
  assert.doesNotMatch(app, /이후 명령을 중단했습니다/u);
  assert.doesNotMatch(html, /이 브라우저에서만 복호화|브라우저에서만 열 수/u);
  assert.match(app, /resolveConflict\(strategy\)/u);
  assert.doesNotMatch(app, /api\.vaultStatus\(\)\.catch\(\(\) => null\)/u);
  assert.match(html, /href="#projects"[\s\S]*?data-view-link="projects"/u);
  assert.doesNotMatch(html, /workspace-avatar/u);
  assert.doesNotMatch(styles, /\.workspace-avatar/u);
  assert.doesNotMatch(html, /workspace-label|sidebar-server/u);
  assert.doesNotMatch(styles, /\.workspace-label/u);
  assert.doesNotMatch(app, /sidebar-server/u);
  assert.match(html, /data-view="projects"[\s\S]*?id="projects-list"/u);
  assert.doesNotMatch(
    html,
    /data-view="projects"[\s\S]*?data-action="refresh"[\s\S]*?data-target="projects"/u,
  );
  assert.match(html, /id="project-guide-title"[\s\S]*?hnd env set dev/u);
  assert.match(html, /id="project-dialog"[\s\S]*?id="project-form"/u);
  assert.match(app, /async function loadProjects/u);
  assert.match(app, /state\.dataStore\.project\(repository\.id\)/u);
  assert.match(app, /state\.dataStore\.updateProject\(values\.id, values\)/u);
  assert.match(styles, /\.search-field svg ~ input\s*\{[\s\S]*?padding-left:\s*39px/u);
  assert.match(app, /const enteringProjects = selected === "projects" && state\.view !== "projects"/u);
  assert.match(app, /window\.addEventListener\("focus", \(\) => void revalidateProjectsOnReturn\(\)\)/u);
  assert.match(app, /Git 저장소에서 첫 세션을 시작하세요/u);
  assert.match(app, /replace\(\/\^github\\\.com\\\/\/iu, ""\)/u);
  assert.match(app, /function repositoryOptionLabel/u);
  assert.match(app, /text: repositoryOptionLabel\(repository\)/u);
  assert.match(app, /label: repositoryOptionLabel\(repository\)/u);
  assert.doesNotMatch(app, /프로젝트 다시 확인/u);
  assert.doesNotMatch(app, /"PC 연결", "기기 화면에서 계정과 개발 PC를 연결합니다\."/u);
});

test('connection commands wrap without crossing the copy control', async () => {
  const styles = await readFile(new URL('../src/web/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.code-block pre\s*\{[\s\S]*white-space:\s*pre-wrap/u);
  assert.match(styles, /\.code-block pre\s*\{[\s\S]*overflow-wrap:\s*anywhere/u);
  assert.match(styles, /\.copy-button\s*\{[\s\S]*z-index:\s*1/u);
});

test('rule form reveals only the fields required by the selected scope', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../src/web/app.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/app.js', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(html, /<option value="pc">/u);
  assert.match(html, /class="field-grid rule-scope-fields" hidden/u);
  assert.match(html, /data-rule-field="repository" hidden/u);
  assert.match(html, /name="repository" disabled/u);
  assert.match(html, /data-rule-field="environment" hidden/u);
  assert.match(html, /name="environment"[\s\S]*?disabled/u);
  assert.match(html, /hnd rule set pc/u);
  assert.match(app, /function updateRuleScopeFields/u);
  assert.match(app, /repository\.disabled = !needsRepository/u);
  assert.match(app, /environment\.required = needsEnvironment/u);
  assert.match(app, /scopeControl\.disabled = editing/u);
  assert.match(app, /values\.scope = form\.elements\.namedItem\("scope"\)\.value/u);
});

test('knowledge can be managed by account, project, or environment scope', async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL('../src/web/app.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/styles.css', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /id="knowledge-filter"[\s\S]*?name="scope"[\s\S]*?value="all-scopes"/u);
  assert.match(html, /id="knowledge-form"[\s\S]*?value="global"[\s\S]*?value="repo"[\s\S]*?value="env"/u);
  assert.match(html, /class="field-grid knowledge-scope-fields" hidden/u);
  assert.match(html, /id="project-knowledge-list"/u);
  assert.match(html, /data-action="new-project-knowledge"/u);
  assert.match(app, /function updateKnowledgeScopeFields/u);
  assert.match(app, /function updateKnowledgeFilterFields/u);
  assert.match(app, /state\.dataStore\.knowledge\(values\)/u);
  assert.match(app, /await returnAfterResourceSave\("knowledge"\)/u);
  assert.match(app, /function renderProjectKnowledge/u);
  assert.match(styles, /\.project-knowledge-section/u);
});

test('recovery-code rotation stays unconfirmed until the explicit save dialog completes', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../src/web/app.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/web/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="recovery-dialog"/u);
  assert.match(html, /id="app-recovery-confirmed"/u);
  assert.match(app, /pendingRecoveryConfirmationId/u);
  assert.match(app, /recovery-confirm-form[\s\S]*?api\.recoveryConfirm/u);
});
