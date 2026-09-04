# HND connector

HND의 중앙 서버와 로컬 Git 저장소, Claude Code, Codex, Cursor를 연결하는
command-line 도구입니다. 웹에서만 룰·작업·지식을 관리한다면 설치하지 않아도
됩니다.

## 설치

Node.js 24.12 이상, npm, Git이 필요합니다.

Windows PowerShell:

```powershell
npm.cmd install --global '@lch-1/hnd@0.2.2'
hnd.cmd --version
```

macOS·Linux:

```sh
npm install --global '@lch-1/hnd@0.2.2'
hnd --version
```

이 패키지는 lifecycle `install`/`postinstall` script를 실행하지 않으며 외부
runtime dependency가 없습니다. 설치한 뒤 HND 서버의 초기 설정 화면에서 만든
PC 연결 명령을 실행하세요. 기존 `0.1.x` 또는 `0.2.0` 설치본은 최신 launcher로
한 번 갱신해야 합니다. `0.2.1`은 현재 중앙 runtime과 호환되며, 이후 일반 runtime
갱신에는 npm 재설치나 재배포가 필요하지 않습니다.

## 처음 연결

먼저 현재 PC의 등록 상태와 다음 단계를 확인합니다.

```sh
hnd sync status
```

HND 웹에 로그인하고 **기기 → PC 연결**에서 15분짜리 일회용 코드를 만드세요.
첫 PC와 추가 PC의 연결 방법은 같습니다. 연결할 PC에서 화면이 만든
`hnd connect` 명령을 실행하고 코드를 붙여넣습니다.

연결 기준은 최초 PC가 아니라 HND 계정입니다. 서버는 계정별 보관함 키를
`/data/server-vault.key`로 다시 암호화해 보관하며, 최근 패스키 확인을 마친
브라우저와 PC에 같은 키를 전달합니다. 따라서 이 방식은 E2EE나 zero-knowledge가
아니며, 서버 관리자에게 데이터 복호화 권한이 있습니다. 각 PC는 마지막 로컬
사본으로 오프라인 작업을 계속하고 서버 연결이 복구되면 자동 동기화합니다.

예전 버전의 보관함은 로컬 키가 남은 브라우저에서 로그인하면 한 번만 계정형으로
전환됩니다. 키가 어디에도 없으면 소유자가 웹에서 기존 암호문 삭제를 명시적으로
확인하고 새 보관함을 만들어야 하며, HND가 자동으로 초기화하지 않습니다.

PC 등록을 확인한 뒤 실제 Git 저장소에서 자동화를 설치합니다.

```sh
hnd init
hnd setup --dry-run
hnd setup
hnd doctor
```

## 주요 명령

```text
hnd --help
hnd init --env <환경>
hnd setup --dry-run
hnd setup
hnd doctor
hnd connect --url <서버 주소> --code-stdin --name <PC 이름>
hnd sync status
```

HND는 정상 사용 중 세션 훅으로 진행 상태와 암호화 snapshot을 자동 동기화합니다.
서버에 연결할 수 없으면 마지막으로 검증한 로컬 사본을 사용하고 다음 훅에서
재시도합니다.

이 npm package는 최초 설치용 고정 launcher입니다. PC 연결 뒤 connector runtime은
HND 서버의 Ed25519 서명을 검증해 자동 갱신합니다. `hnd`를 실행할 때 마지막 확인이
6시간 이상 지났으면 짧은 background 확인을 시작하며, 상시 daemon은 없습니다.
서버가 꺼져 있으면 마지막 정상 버전을 계속 사용합니다. 필요할 때만 아래 명령으로
직접 확인하거나 되돌립니다.

```sh
hnd update status
hnd update check
hnd update apply
hnd update rollback
```

## 제거

먼저 Git 저장소에서 HND가 관리하는 설정을 확인하고 제거한 뒤 package를
삭제합니다.

```sh
hnd uninstall --dry-run
hnd uninstall
npm uninstall --global '@lch-1/hnd'
```

License: MIT
