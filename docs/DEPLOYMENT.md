# 중앙 서버 배포와 connector 설치

hnd 서버는 24시간 실행하는 중앙 동기화 지점입니다. 각 클라이언트는 세션 훅과
로컬 변경 시 자동으로 서버에 연결하지만, 검증된 로컬 캐시도 유지합니다. 서버나
네트워크가 일시적으로 중단되어도 에이전트 시작과 context 합성은 로컬 캐시로
계속되며, pending 변경은 연결이 복구된 다음 훅에서 자동으로 동기화됩니다.

서버는 tenant별 vault key를 `/data/server-vault.key`로 보호해 관리하고 암호화
snapshot과 revision을 `/data/hnd.sqlite`에 저장합니다. 서버 프로세스는 필요하면
snapshot을 복호화할 수 있으므로 이 구조는 E2EE나 zero-knowledge가 아닙니다.
오프라인 fallback을 위한 각 클라이언트의 룰·handoff·checkpoint·복구 cache는
현재 hnd 자체 암호화가 적용되지 않은 평문 private 파일입니다. Unix에서 디렉터리는
`0700`, 파일은 `0600`으로 제한하며, 분실한 PC의 저장 데이터 보호에는 OS 디스크
암호화를 사용해야 합니다.

## 1. 서버 시작

요구사항은 Docker Compose, 호스트 nginx, 운영 도메인과 유효한 TLS 인증서입니다.

```sh
# 최초 1회만 복사하고 기존 .env는 보존
[ -e .env ] || cp .env.example .env
# .env를 검토하되 host nginx 구성에서는 loopback bind를 유지
# sequence는 이전에 배포한 값보다 반드시 크게 지정
HND_RELEASE_SEQUENCE=1 \
HND_RELEASE_PRIVATE_KEY_FILE=/secure/outside-the-repository/signing-key.pem \
HND_RELEASE_MIN_LAUNCHER_VERSION=0.2.0 \
  node scripts/build-connector-release.mjs
npm test
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8787/healthz
```

Docker image는 사전에 검증한 `dist/connector-release/manifest.json`과 digest 이름의
`.hndb` 파일만 복사합니다. 서명 개인키는 저장소·`dist`·Docker build context와
image에 넣지 않습니다. build script도 저장소 내부의 개인키 경로, 권한이 넓은
개인키, 고정 공개키와 짝이 맞지 않는 키를 거부합니다.

`.env`에서 조정할 수 있는 값은 다음과 같습니다.

| 변수 | 기본값 | 용도 |
|---|---:|---|
| `HND_BIND_ADDRESS` | `127.0.0.1` | host listen 주소; host nginx 사용 시 변경하지 않음 |
| `HND_PORT` | `8787` | nginx가 연결할 host port |
| `HND_TRUST_PROXY` | `true` | private/loopback nginx의 `X-Real-IP`를 rate limit에 사용 |
| `HND_SERVER_MAX_REVISIONS` | `50` | tenant별 보존 revision 수 |
| `HND_IMAGE` | `hnd-server:local` | build·실행할 image tag |
| `HND_PUBLIC_ORIGIN` | `https://hnd.example.com` | 브라우저가 접속할 정확한 HTTPS origin |
| `HND_WEBAUTHN_RP_ID` | `hnd.example.com` | 패스키를 묶을 정확한 domain |
| `HND_SIGNUP_MODE` | `open` | 초대 없이 각 사용자의 분리된 계정·작업 공간 생성 허용 |

현재 릴리스는 서버 프로세스 하나와 로컬 persistent volume을 전제로 합니다.
tenant, device, credential hash, invitation, 보호된 vault key, 암호화 snapshot과
revision은 `/data/hnd.sqlite`에 저장합니다. 서버는 첫 실행에 raw 32-byte
`/data/server-vault.key`를 mode `0600`으로 원자 생성하고 이후 같은 파일을
재사용합니다. 둘 중 하나라도 잃으면 DB의 보관함 데이터를 복구할 수 없으므로
SQLite와 key 파일을 반드시 함께 백업합니다. 공유 network filesystem을 사용하는
active-active replica는 지원하지 않습니다.

Compose는 의도적으로 다음처럼 loopback에만 port를 공개합니다.

```text
Internet ── HTTPS ──> host nginx ── HTTP ──> 127.0.0.1:8787 ──> hnd container
```

nginx 예시에서 port를 바꾸려면 `proxy_pass`도 같은 값으로 맞춥니다.
`HND_BIND_ADDRESS`를 `0.0.0.0`으로 바꾸거나 `8787`을 공인 interface와 방화벽에
직접 공개하지 마세요.

## 2. 호스트 nginx 연결

[`deploy/nginx/hnd.conf.example`](../deploy/nginx/hnd.conf.example)을 호스트 nginx에
복사하고 domain과 인증서 경로를 실제 값으로 바꿉니다.

```sh
sudo install -m 0644 deploy/nginx/hnd.conf.example \
  /etc/nginx/sites-available/hnd.conf
sudoedit /etc/nginx/sites-available/hnd.conf
sudo ln -s /etc/nginx/sites-available/hnd.conf \
  /etc/nginx/sites-enabled/hnd.conf
sudo nginx -t
sudo systemctl reload nginx
```

배포판이 `sites-available` 구조를 사용하지 않으면 nginx의 `conf.d` 디렉터리에
배치합니다. 예시는 `/` 아래 웹과 API 요청을 `http://127.0.0.1:8787`로
전달합니다. device token과 snapshot 통신은 반드시 HTTPS를 통하게 합니다.

외부에서 첫 화면과 다음 endpoint를 확인합니다.

```sh
curl --fail --output /dev/null https://hnd.example.com/
curl --fail https://hnd.example.com/healthz
npm view '@lch-1/hnd@0.2.2' version
```

TLS proxy에는 인증서 자동 갱신, HTTPS redirect, request body 제한, connection/rate
limit과 access log 보존 정책도 설정하세요. 기본 server snapshot 한도는 8 MiB이므로
nginx 예시는 `client_max_body_size 10m`을 사용합니다.

`HND_PUBLIC_ORIGIN`과 `HND_WEBAUTHN_RP_ID`는 실제 주소와 정확히 일치해야 합니다.
운영 중 domain을 바꾸면 기존 패스키가 새 domain에서 동작하지 않으므로 이전
domain에서 새 패스키를 먼저 등록합니다.

## 3. 첫 웹 계정 설정

계정이 없을 때 `/`은 초기 설정 창을 보여줍니다. 기본 `open` 정책에서는 서버
터미널이나 시작 코드 없이 `/setup`에서 첫 소유자 계정을 바로 만듭니다.
소유자 이름, 패스키, 복구 코드, 서버 보관함, PC 연결을 차례로 안내하며,
PC 연결은 건너뛰고 나중에 앱에서 할 수도 있습니다.
복구 코드는 저장 여부를 확인해야 다음 단계로 넘어갑니다. 기존 sync tenant가 정확히 하나 있으면 첫 소유자가 그
tenant에 자동 연결됩니다.

기존 tenant가 여러 개인 특수한 이전 설치에서는 웹이 임의로 하나를 고르지
않습니다. 이 경우에만 연결할 tenant를 명시한 1회용 선택 코드를 만듭니다.

```sh
docker exec hnd-server node /app/bin/hnd-server.mjs account bootstrap --tenant TENANT_ID
```

빈 서버는 먼저 등록을 완료한 방문자를 소유자로 확정합니다. 공개 DNS나 nginx
접근을 열기 전에 설정을 끝내거나, 설정하는 동안 관리자 IP만 접근하도록 제한하세요.
둘 이상이 동시에 시도해도 DB 트랜잭션에서 한 계정만 첫 소유자로 확정됩니다.

첫 계정 뒤에도 기본 가입 정책은 공개 상태입니다. 새 사용자는 초대 코드 없이
자신만의 분리된 tenant를 만들며 기존 계정의 데이터에는 접근하지 못합니다. 서버
소유자는 앱 설정에서 가입을 초대 전용 또는 닫힘으로 바꿀 수 있습니다. 같은
tenant에 사람을 추가하려면 소유자 또는 관리자가 만든 1회용 초대 코드를 사용합니다.
패스키는 계정 인증을 담당하고, 서버는 인증된 계정의 tenant vault key를 보호해
브라우저와 PC 연결에 제공합니다. 특정 브라우저나 최초 PC가 기준이 되지 않습니다.

## 4. connector 설치

connector는 로컬 Git 상태를 읽고 Claude Code·Codex·Cursor에 룰과 작업 인계를
전달하며, 세션 체크포인트·암호화 동기화·오프라인 cache를 처리합니다. 웹에서
룰·작업·지식만 관리한다면 설치하지 않아도 됩니다. 로컬 자동 연동이 필요한
PC마다 설치합니다. 공개 패키지는 `@lch-1/hnd`이고 설치 후 실행 명령은 `hnd`입니다.
모든 플랫폼에 Node.js 24.12 이상, 함께 설치되는 npm, Git이 필요합니다.

Windows 10/11은 관리자 권한, WSL이나 Git Bash 없이 PowerShell에서 설치합니다.
웹에서 만드는 명령은 사용자가 익숙한 `npm`, `hnd` 이름을 그대로 사용합니다.

```powershell
npm install --global '@lch-1/hnd@0.2.2'
hnd --version
```

macOS와 Linux는 터미널에서 같은 패키지를 설치합니다. 배포판의 system Node가
`/usr/local`을 사용하는 경우 웹은 권한 오류를 피하도록 `sudo -H npm` 명령을
제공합니다. nvm·Volta처럼 사용자 소유 Node에서는 일반 `npm`을 사용합니다.

```sh
sudo -H npm install --global '@lch-1/hnd@0.2.2'
hnd --version
```

npm 패키지는 이후 중앙 업데이트를 실행할 고정 launcher와 검증된 fallback
runtime을 설치합니다. lifecycle `install`/`postinstall` script와 외부 runtime
dependency는 없으며, 설치만으로 저장소 초기화, PC 연결 또는 에이전트 설정 변경을
수행하지 않습니다. npm 설치는 PC마다 최초 한 번만 필요합니다.

PC를 연결한 뒤 `hnd`를 실행할 때 마지막 확인이 6시간 이상 지났으면 launcher가
계정의 HND 서버에서 Ed25519 서명된 client-only runtime을 짧게 background에서
확인합니다. 상시 daemon은 없습니다. 새 release는 별도 npm publish 없이 다음
`hnd` 실행이나 에이전트 세션부터 적용됩니다. 필요하면 다음 명령으로 즉시
확인·적용하거나 마지막 정상 버전으로 되돌릴 수 있습니다.

```sh
hnd update status
hnd update check
hnd update apply
hnd update rollback
```

상태 출력은 npm launcher, 로컬에서 실제 선택된 client runtime, 서버가 광고하는
최신 connector release를 구분합니다. connector의 semver가 같아도 단조 증가하는
release sequence와 bundle digest 앞 12자리를 비교해 실제 적용 여부를 확인할 수
있습니다. 서버 확인에 실패해도 로컬 client 정보는 계속 표시합니다.

업데이트는 완전히 검증한 별도 디렉터리에 설치한 뒤 원자적으로 전환합니다. 새
runtime이 import되지 않으면 이전 버전, 그마저 없으면 npm에 내장된 fallback으로
실행합니다. 훅은 version 디렉터리가 아니라 고정 launcher를 가리키므로 release마다
`hnd setup`을 다시 실행할 필요가 없습니다. 관리 skill도 서명 runtime의 hash 검증이
끝난 뒤 이미 HND가 설치한 파일만 자동 갱신합니다. 없는 연동을 새로 만들거나
사용자 파일을 인수하지 않으므로 최초 설치는 계속 `hnd setup`으로 명시합니다.

## 5. PC 연결

사용자는 HND 웹에 로그인한 뒤 **기기 → PC 연결**에서 15분짜리 일회용 코드를
만듭니다. 로그인 계정이 tenant와 연결 권한을 정하고, 서버가 보호 중인 vault key로
코드를 발급합니다. 최초 PC와 추가 PC 모두 같은 절차를 사용합니다. 기존 PC가
켜져 있거나 특정 PC에서 초대를 만들거나 키 파일을 내려받을 필요가 없습니다.

설정 화면은 Linux, Windows, macOS 순서로 운영체제별 명령을 자동으로 만듭니다.
아래처럼 발급 코드, 연결, 에이전트 설정을 짧은 블록으로 실행합니다. 프로젝트는
이후 실제 Git 저장소에서 첫 AI 세션을 시작할 때 자동 등록됩니다.

```sh
printf '%s\n' '웹에서 만든 일회용 코드' | hnd connect \
  --url https://hnd.example.com \
  --code-stdin \
  --name laptop
hnd setup
```

직접 미리 등록하고 싶을 때만 실제 Git 저장소에서 다음 명령을 실행합니다.

```sh
cd /path/to/repository
hnd init
hnd doctor
```

`setup`은 기존 에이전트 설정을 병합하고 hnd가 관리하는 훅과 skill만 추가합니다.
연결 코드는 한 번 사용되며, 클라이언트 device credential은 mode `0600`으로
저장되고 서버에는 SHA-256 hash만 남습니다. 기존 `0.2.0` connector가 소비하는
`hndj_` 코드 형식은 유지하지만 코드 발급 주체는 서버 계정입니다. 연결이 실패하거나
코드가 만료되면 웹에서 새 코드를 만듭니다.

## 6. 계정 복구와 이전 명령

계정 복구 코드로 계정 접근을 되찾은 뒤 패스키를 다시 등록할 수 있습니다. 서버의
`hnd.sqlite`와 `server-vault.key`가 온전하면 서버가 같은 보관함을 다시 제공하므로
기존 브라우저나 PC가 필요하지 않습니다. 반대로 master key 파일을 잃으면 DB만으로
vault key와 snapshot을 복호화할 수 없습니다. 이 경우에는 두 파일을 함께 보관한
서버 백업을 복원해야 합니다.

`hnd sync invite`는 더 이상 코드를 만들거나 로컬 key를 읽지 않고 **기기 → PC
연결**을 안내합니다. `hnd sync join`은 `hnd connect`의 이전 별칭이고,
`hnd sync enroll`과 운영자 enrollment는 이전 자동화 호환용입니다. `hnd sync key
export/import`는 예전 E2EE 설치의 로컬 key를 서버 계정형으로 전환하는 작업에만
남긴 보조 도구입니다. 새 PC 연결이나 정상 계정 복구에는 사용하지 않습니다.

## 7. 정상 운영과 장애 복구

자동 동기화는 계정 연결 후 기본으로 켜집니다.

```sh
hnd sync auto status
hnd sync auto off
hnd sync auto on
hnd sync status
```

- `SessionStart`: 짧은 제한 시간 안에서 sync하고 Git 저장소를 자동 등록한 뒤 검증된 로컬 cache로 context 합성
- 사용자 입력 직전: sync 후 유효 룰·활성 작업·checkpoint 전체의 Live Context revision을 비교하고, 달라진 경우에만 최신 전체 snapshot 전달
- 로컬 `rule`·`work`·`know` 변경: 변경을 먼저 로컬에 확정하고 짧게 sync 시도
- `Stop`·`SessionEnd`: Git checkpoint를 로컬에 저장한 뒤 sync 시도
- timeout·network·server 장애: 변경을 pending으로 유지하고 다음 mutation/hook 재시도

다른 PC가 꺼져 있어도 각 client는 중앙 서버하고만 통신하므로 영향이 없습니다.
중앙 서버가 꺼지면 룰 주입, 작업 기록과 checkpoint는 마지막 로컬 cache로 계속
동작합니다. 서버가 복구되면 사용자가 매번 `push`할 필요 없이 다음 훅이 자동으로
동기화합니다. 중앙 서버 장애 중에는 마지막으로 검증한 connector runtime을 계속
사용하므로 룰 주입과 로컬 기록이 멈추지 않습니다. 새 runtime 확인·새 PC 연결·원격
sync만 서버가 복구될 때까지 미뤄집니다.

웹 브라우저도 한 번 이상 정상 로그인해 `/app`과 보관함을 연 뒤에는 설치된 앱
화면과 암호화된 로컬 사본을 사용해 오프라인으로 열 수 있습니다. 로그인 이름 같은
계정 정보는 오프라인 표시용 평문으로 따로 저장하지 않습니다. 서버가 돌아오면 세션과
작업 공간을 다시 확인한 뒤 자동 전송합니다. 브라우저는 마지막 서버 기준본도 암호화해
보관하고 base/local/server 3-way merge로 서로 다른 항목을 자동 병합합니다. 같은
항목을 동시에 바꾼 경우에만 홈에서 그 항목에 사용할 로컬 변경이나 서버 변경을 고릅니다.
선택 직전 서버본과 다시 병합하므로 그 사이 들어온 다른 항목도 보존됩니다.

같은 항목의 충돌, 인증 실패, 암호문 무결성 실패는 자동 overwrite하지 않고
`attention`으로 멈춥니다. 다음 명령은 평상시 필수 절차가 아니라 상태 진단과
검토된 복구를 위한 수동 도구입니다.

```sh
hnd sync status
hnd sync pull
hnd sync merge
hnd sync push
hnd sync revisions
hnd sync restore REVISION_SHA256 --force
hnd sync devices
hnd sync revoke DEVICE_ID
```

동일 파일 충돌은 로컬 버전을 보존하고 `~/.hnd/cache/` 아래 private 보고서에
base/local/remote 버전을 남깁니다. 강제 pull과 로컬 상태를 바꾸는 merge도 먼저
복구 snapshot을 남깁니다. 내용을 검토한 뒤 명시적으로 해결하세요.

## 8. 백업과 업그레이드

- `/data/hnd.sqlite`는 server process를 멈춘 상태, SQLite-aware backup 또는
  storage-level consistent snapshot으로 백업합니다.
- `/data/server-vault.key`도 반드시 함께 백업합니다. 이 파일은 raw 32 bytes,
  mode `0600`이어야 하며 DB backup과 같은 서버 복구 세트로 접근을 제한합니다.
  SQLite만 있거나 key 파일만 있어서는 보관함을 복구할 수 없습니다.
- legacy file store에서 업그레이드하면 첫 시작 때 `control.json`과 `tenants/`를
  SQLite로 import하며 원본은 지우지 않습니다. import를 검증한 뒤 보관 처리합니다.
- tenant별 암호문 revision은 기본 50개입니다. `HND_SERVER_MAX_REVISIONS` 또는
  `hnd-server --max-revisions N`으로 1~10000 사이에서 조정하고 volume quota와
  free-space alert를 설정합니다.
- server image에는 같은 source에서 만든 서명된 connector release를 포함하고,
  검토하지 않은 `latest` image 자동 갱신은 피합니다.
- 서버는 master key로 tenant vault key와 snapshot을 복호화할 수 있습니다. 서버,
  volume, backup과 nginx/server log에 운영자만 접근하도록 권한·보존 정책을 정합니다.

connector runtime release는 npm에 다시 publish하지 않습니다. npm package 버전은
고정 launcher의 버전이고, `src/constants.mjs`의 runtime 버전은 서버가 PC에 배포하는
client-only 코드의 독립된 버전입니다. 서버 API와 웹 UI 코드는 Docker image 안에서만
실행되며 connector bundle에는 들어가지 않습니다.

검토된 고정 allowlist로 canonical JSON bundle을 만들고, 저장소 밖의 Ed25519
개인키로 manifest에 서명한 뒤 server image에 포함합니다. `sequence`는 runtime
version과도 별개인 단조 증가 정수이며 정상 배포와 중앙 rollback 모두 이전 배포보다
커야 합니다. 낮은 sequence는 이미 더 새 release를 본 PC가 rollback 공격으로
판단해 거부합니다. 배포 후 로컬과 서버의 bundle SHA-256이 같은 것은 npm 버전이
같다는 뜻이 아니라, 동일한 서명 runtime이 정상 적용됐다는 뜻입니다.

```sh
next_sequence=2
HND_RELEASE_SEQUENCE="$next_sequence" \
HND_RELEASE_PRIVATE_KEY_FILE=/secure/outside-the-repository/signing-key.pem \
HND_RELEASE_MIN_LAUNCHER_VERSION=0.2.0 \
  node scripts/build-connector-release.mjs
npm test
docker compose build --pull
docker compose up -d
docker compose ps
```

build는 같은 source, sequence, runtime version과 key에 대해 동일한 bytes를 생성합니다.
manifest는 client-only bundle의 경로·크기·SHA-256을 서명하며 서버는 시작할 때
canonical encoding과 모든 파일 digest를 다시 확인합니다. 등록된 device token이
있는 PC만 `/v1/connector/manifest`와 정확한 digest bundle을 받을 수 있습니다.

긴급 로컬 rollback은 `hnd update rollback`으로 처리합니다. 모든 PC를 이전 코드로
돌릴 때는 검토한 이전 source에서 더 높은 sequence의 새 manifest를 서명해 server를
재배포합니다. 서명키를 잃거나 교체하면 기존 launcher가 새 키를 신뢰하지 않으므로
고정 공개키를 넣은 bootstrap npm package를 다시 배포해야 합니다. 개인키 backup과
sequence 원장은 server DB backup과 분리해 보호합니다.
