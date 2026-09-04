# hnd

`hnd`는 Claude Code, Codex, Cursor가 중앙 서버의 같은 룰과 작업 상태를 이어
쓰게 해주는 도구입니다. 서버는 24시간 실행하는 것을 기본으로 하되, 연결할 수
없는 동안에는 마지막 로컬 캐시로 계속 작업하고 연결이 복구되면 자동으로
동기화합니다.

- 룰: 전체, 저장소, 환경, 이 PC 순서로 합성
- 자동 진행 저장: 세션 응답 종료와 세션 종료 시 Git 상태 체크포인트 기록
- 수동 보강: 결정 이유, 실패한 방법, 다음 할 일을 구조화해서 기록
- 자동 동기화: 로컬 변경과 세션 훅이 중앙 서버에 연결하고 실패한 변경은 pending 처리
- 장기 지식: 사용자가 남기기로 한 메모를 공통·프로젝트·환경 범위로 저장하고 검색
- 중앙 저장: 계정·보호된 보관함 키·암호화 snapshot을 서버에서 함께 관리
- 오프라인 동작: 서버가 꺼져도 마지막 로컬 캐시로 계속 작업하고 다음 훅에서 재시도

## 웹에서 처음 설정

HND의 첫 화면은 제품 소개 페이지가 아니라 설치된 서버의 입구입니다. 계정이
있으면 패스키 로그인만 보여주고, 계정이 하나도 없으면 초기 설정을 보여줍니다.

```sh
docker compose up -d --build
```

그다음 `https://hnd.example.com/`을 엽니다. 서버 터미널이나 별도 시작 코드 없이
웹에서 첫 소유자 계정을 바로 만들 수 있습니다. 초기 설정은 다음 순서로 진행합니다.

1. 소유자 계정 이름 설정
2. 패스키 등록
3. 계정 복구 코드 보관
4. 서버 보관함 준비
5. 필요한 PC에 연결 도구 설치·계정 연결(나중에 해도 됨)
6. 설정 확인 후 작업 공간 열기

설정이 끝난 계정은 `/`에서 패스키로 로그인하면 바로 `/app`으로 이동합니다.
기본 `open` 정책에서는 새 방문자도 초대 없이 같은 `/setup` 안내를 따라 자신만의
계정과 분리된 작업 공간을 만들 수 있습니다. 소유자는 앱 설정에서 가입을 초대
전용 또는 닫힘으로 바꿀 수 있습니다.

### 웹에서 프로젝트 관리

로그인 후 **프로젝트**를 열면 연결된 Git 저장소를 GitHub의 저장소 목록처럼
찾고 관리할 수 있습니다. 프로젝트를 웹에서 미리 만들 필요는 없습니다. 연결된
PC의 실제 Git 저장소에서 Claude Code, Codex 또는 Cursor를 처음 열면 HND가
저장소를 자동 등록하고, 첫 동기화 뒤 웹 목록에 표시합니다.

프로젝트 상세 화면에서는 다음 내용을 한곳에서 처리합니다.

- 웹에 표시할 프로젝트 이름과 설명
- 프로젝트 전체 룰과 환경별 룰
- 다른 에이전트가 이어받을 진행 작업
- 공통과 분리해 보관하는 프로젝트·환경별 장기 지식
- PC 연결, 체크아웃별 환경 선택, 첫 세션 시작 안내

웹에서 바꾼 이름·설명·룰·작업은 기존 암호화 snapshot에 저장됩니다. 연결된 PC는
다음 세션 훅에서 최신 내용을 받고, 브라우저가 오프라인이면 로컬 사본에 먼저
저장한 뒤 연결이 돌아올 때 동기화합니다. 이 화면은 HND의 프로젝트 컨텍스트를
관리하며 Git 소스 코드, 이슈 또는 Pull Request를 호스팅하지는 않습니다.

빈 서버는 첫 계정 생성을 완료한 방문자를 서버 소유자로 확정합니다. 공개 DNS나
nginx 접근을 열기 전에 설정을 마치거나, 설정하는 동안 관리자 IP만 접근하도록
제한하세요. 이후 공개 가입자는 기존 소유자의 데이터가 아닌 별도 작업 공간을
받습니다.

패스키는 로그인용 공개키이고 데이터 암호화 키는 아닙니다. 서버는 tenant별
보관함 키를 `/data/server-vault.key`로 보호해 관리하고, 인증된 계정에 필요한 키를
제공합니다. 따라서 새 브라우저나 첫 PC를 기존 기기에서 승인할 필요가 없습니다.
복구 코드는 파일 저장이나 복사를 한 뒤 확인해야 설정이 끝납니다.

## connector 설치

connector는 웹 앱을 설치하는 것이 아니라 로컬 Git 저장소와 에이전트를 HND에
이어 주는 작은 연결 도구입니다. 브라우저에서는 할 수 없는 다음 작업을 맡습니다.

- Claude Code·Codex·Cursor에 합성된 룰과 작업 인계 전달
- 응답·세션 종료 때 Git 상태 체크포인트 자동 저장
- 암호화 snapshot 동기화와 서버 장애 중 로컬 cache 사용
- HND가 관리하는 훅과 skill의 안전한 설치·제거

웹에서 룰·작업·지식만 보고 편집한다면 connector 없이 사용할 수 있습니다. 로컬
에이전트 자동 연동이 필요한 PC마다 한 번 설치하고 연결합니다. 기본 배포 패키지는
`@lch-1/hnd`이고, 설치 뒤 실행 명령은 모든 플랫폼에서 `hnd`입니다. Node.js 24.12
이상, 함께 설치되는 npm, Git이 필요합니다.

### Windows

Windows 10/11의 PowerShell에서 실행합니다.

```powershell
npm install --global '@lch-1/hnd@0.2.2'
hnd --version
```

npm이 사용자 global prefix에 `hnd.cmd`를 만들고 실행 경로를 관리합니다. 명령을
찾지 못하면 새 PowerShell 창을 열고 `npm prefix --global`의 경로가 `PATH`에
포함되어 있는지 확인합니다.

### macOS·Linux

터미널에서 같은 공개 패키지를 설치합니다. HND가 Linux용 최초 설치 명령을 만들
때는 배포판의 system Node가 사용하는 `/usr/local` 권한 문제를 피하도록
`sudo -H npm`을 사용합니다. nvm·Volta처럼 사용자 소유 Node를 쓰는 PC에서는
일반 `npm install --global`을 사용해도 됩니다.

```sh
sudo -H npm install --global '@lch-1/hnd@0.2.2'
hnd --version
```

npm 패키지는 connector 파일만 포함하고 lifecycle `install`/`postinstall` script와
외부 runtime dependency가 없습니다. 설치만으로 Git 저장소를 초기화하거나
에이전트 설정을 바꾸거나 기기를 등록하지 않습니다. npm은 이 고정 launcher를
PC마다 처음 한 번 설치하는 용도입니다.

PC를 서버에 연결한 뒤 `hnd`를 실행할 때 마지막 확인이 6시간 이상 지났으면
launcher가 인증된 서버의 Ed25519 서명 runtime을 짧게 background에서 확인합니다.
상시 daemon은 없습니다. 검증과 설치가 끝나도 현재 명령은 그대로 마치고 다음
실행부터 새 버전을 사용합니다. 서버가 꺼져 있거나 update가 실패하면 마지막 정상
버전 또는 npm에 포함된 버전으로 계속 동작합니다.

```sh
hnd update status
hnd update check
hnd update apply
hnd update rollback
```

`hnd update status`, `check`, `apply`는 서로 독립적인 npm 런처 버전과 중앙
런타임 버전을 구분해 표시합니다. npm의 `@lch-1/hnd@0.2.2`는 설치와 안전한
업데이트를 담당하는 고정 런처이고, 서버가 배포하는 런타임은 별도 버전 체계
(`1.0.0`부터 시작)를 사용합니다. 따라서 일반 기능 업데이트에는 npm publish가
필요하지 않습니다.

로컬 런타임과 서버 제공 런타임에는 버전 외에도 단조 증가하는 릴리스 시퀀스와
번들 SHA-256 앞 12자리를 표시합니다. 업데이트 후 양쪽 해시가 같은 것은 로컬 PC가
서버의 서명된 런타임을 정확히 받았다는 뜻입니다. 서버 API와 웹 UI 코드는 Docker
이미지 안에서만 실행되며 이 런타임 번들에 포함되거나 PC로 내려가지 않습니다.

`0.1.x` 또는 `0.2.0` 설치본은 런처를 npm으로 한 번 갱신해야 합니다. `0.2.1`은
현재 중앙 런타임과 호환되므로 강제 갱신 대상이 아닙니다. 이후 일반 런타임
릴리스에는 npm publish가 필요하지 않습니다.

## PC에서 처음 한 번

HND 웹에 로그인한 뒤 **기기 → PC 연결**에서 15분짜리 일회용 연결 코드를
만듭니다. 첫 PC와 추가 PC 모두 같은 방식이며, 다른 PC에서 초대를 만들거나
암호화 키 파일을 내려받을 필요가 없습니다. 설정 화면의 Linux/Windows/macOS
탭과 설치 상태를 고르면 짧은 명령을 만듭니다. 브라우저가 실행 중인 PC가 아니라
명령을 붙여넣을 터미널의 운영체제를 선택하세요. 이미 `hnd --version`이 실행되면
**이미 설치됨**을 선택하고 npm 설치를 다시 하지 않습니다. 명령은 Git 저장소 밖을
포함해 어느 폴더에서나 실행할 수 있습니다. 다음은 macOS·Linux에서 처음 설치할 때
예시입니다.

```sh
sudo -H npm install --global '@lch-1/hnd@0.2.2' &&
printf '%s\n' '웹에서 발급한 일회용 코드' | hnd connect \
  --url https://hnd.example.com \
  --code-stdin \
  --name laptop &&
hnd setup
```

이미 설치된 PC에서는 첫 줄 없이 `connect`, `setup` 두 명령만 실행합니다. 기존
global 설치가 root 소유인 상태에서 일반 사용자로 npm을 다시 실행하면 `EACCES`가
날 수 있습니다. 이때 웹에서 **이미 설치됨**을 선택하면 npm 설치를 생략합니다.
실제로 다시 설치해야 한다면 system Node에서는 `sudo -H npm`, 사용자 소유 Node에서는
일반 `npm`을 사용합니다. `&&`로 연결되어 있어 설치나 연결이 실패하면 `setup`은
실행되지 않습니다.

`setup`은 기존 에이전트 설정을 보존하면서 hnd가 관리하는 훅과 스킬만
추가합니다. Claude Code, Codex, Cursor가 새 훅을 처음 볼 때 신뢰 확인을 요청할
수 있습니다. 연결 코드가 만료되거나 사용됐다면 웹에서 새 코드를 만들어 같은
명령을 다시 실행합니다.

이후 Git 저장소에서 Claude Code, Codex 또는 Cursor 세션을 처음 시작하면 HND가
`origin`과 Git 이력을 확인해 프로젝트를 자동 등록합니다. 새 프로젝트의 환경은
그 체크아웃에 `default`로 선택됩니다. 보안상 같은 원격 주소인데 Git 이력이
일치하지 않거나 fork 여부가 모호한 경우에만 자동 연결을 멈추고 `hnd repo link`를
요청합니다.

## 짧은 명령

기본 사용에서는 아래 명령만 기억하면 됩니다.

| 명령 | 용도 |
|---|---|
| `hnd rule` | 오래 유지할 룰 |
| `hnd work` | 사람이 보강하는 작업 인계 |
| `hnd know` | 오래 남길 지식 저장·검색 |
| `hnd connect` | 웹 계정에 PC 연결 |
| `hnd sync` | 자동 동기화 상태 확인·복구 |

기존 긴 명령인 `policy`, `handoff`, `knowledge`, `remote`도 계속 동작합니다.
`hnd --help`는 평소 필요한 명령만 보여 주며, 상세 문법은 `hnd project help`,
`hnd rule help`, `hnd work help`, `hnd know help`, `hnd sync help`,
`hnd setup help`, `hnd advanced help`로 나누어 확인합니다. `hnd rule --help`처럼
명령 뒤에 `--help`를 붙여도 같은 안내가 나옵니다.

### 언어

웹은 기본적으로 브라우저 언어를 따릅니다. 로그인 후 **설정 → 계정 → 언어**에서
`브라우저 언어 자동`, `한국어`, `English` 중 하나를 선택할 수 있으며 계정에
저장되어 다른 브라우저에도 적용됩니다.

CLI는 OS 언어를 자동으로 감지합니다. 환경변수를 직접 설정할 필요 없이 다음
명령으로 영구 변경하거나 다시 자동 감지로 돌릴 수 있습니다. `kr`, `ko-KR`도
입력 별칭으로 받지만 저장 값은 `ko`입니다.

```sh
hnd lang show
hnd lang set ko
hnd lang set en
hnd lang auto
```

### 룰

```sh
# 모든 저장소
hnd rule set all --file ~/.config/agent-rule.md

# 현재 저장소
hnd rule set repo --text "작업을 넘기기 전에 테스트를 실행한다."

# 현재 Git 체크아웃에 선택한 환경
hnd env set laptop
hnd rule set env --file ./ops/laptop-notes.md

# 같은 저장소를 배포·테스트 서버에서 다르게 사용
# 배포 서버에서는 prod, 테스트 서버에서는 test를 각각 한 번 선택
hnd env set prod
hnd rule set env --file ./ops/prod-rule.md

# 이 PC에서만 적용하며 동기화하지 않음
hnd rule set pc --text "이 장치에서는 배포하지 않는다."

hnd rule list
hnd rule show repo
```

실제 에이전트가 세 범위의 룰을 받았는지 기존 룰을 건드리지 않고 확인하려면 현재
Git 프로젝트에서 아래 명령을 실행합니다. 이 PC에만 1시간짜리 테스트 지시를
추가하며 서버의 실제 `all`, `repo`, `env` 룰은 덮어쓰지 않습니다.

```sh
hnd rule test start
# 출력된 GLOBAL, PROJECT, ENV 프롬프트를 현재 또는 새 AI 세션에 각각 정확히 입력
hnd rule test show
hnd rule test stop
```

현재 버전의 훅이 설치되어 있으면 실행 중인 세션도 다음 입력 직전에 변경된 최신
Live Context를 받습니다. 세 입력에 대해 표시된 예상 문자열만 정확히 응답하면
`all → repo → env` 전달이 실제 세션까지 정상입니다. 테스트가 끝나면 `stop`으로
즉시 제거하세요.

적용 순서는 `all → repo → env → work/checkpoint → pc`입니다. `pc`가 항상
마지막이며 서버로 올라가지 않습니다. 웹에서는 `all`, `repo`, `env` 룰을
관리하고, PC 전용 룰은 적용할 PC의 터미널에서만 설정합니다. 인자 없이 처음
`hnd init`을 실행하면 `default` 환경을 선택하지만 `prod`, `test` 같은 역할은
호스트명으로 추측하지 않습니다. 환경 선택은 PC 전체가 아니라 현재 Git 체크아웃에
저장되므로, 같은 저장소의 배포·테스트 체크아웃에서 `prod`, `test`를 각각 선택할
수 있습니다.

### 자동 진행 저장

자동 저장은 기본으로 켜져 있습니다.

```sh
hnd auto
hnd auto off
hnd auto on
```

`setup`이 설치한 `Stop` 훅은 에이전트가 응답을 마칠 때 체크포인트를 만들고,
`SessionEnd` 훅은 세션 종료 때 한 번 더 확인한 뒤 중앙 서버 동기화를
시도합니다. 같은 Git 상태는 다시 쓰지 않습니다.

자동 체크포인트에는 다음 검증 가능한 정보만 들어갑니다.

- 브랜치와 HEAD
- 마지막 커밋
- 수정·추가·삭제·이름 변경된 경로
- 저장 시각과 사용한 에이전트

대화 전문이나 소스 파일 내용은 자동 복사하지 않습니다. 결정 이유나 실패한
접근처럼 Git만으로 알 수 없는 내용은 필요할 때 `work save`로 보강합니다.

### 작업 인계

```sh
hnd work new auth-refresh --goal "refresh token 교체를 안전하게 완료"

hnd work save auth-refresh \
  --current "구현 완료, rollback 테스트가 남음" \
  --decision "경합 방지를 위해 기존 token을 5분간 허용" \
  --rejected "DB trigger 방식은 장애 처리를 숨겨서 제외" \
  --changed-file src/auth/rotate.mjs \
  --check "인증 통합 테스트: 통과" \
  --next "rollback 통합 테스트 추가"

hnd work show auth-refresh
hnd work list
hnd work use auth-refresh
hnd work done auth-refresh
```

`work`는 자동 체크포인트를 대체하지 않습니다. 자동 기록 위에 사람이 판단한
맥락을 더하는 기능입니다.

### 오래 남길 지식

```sh
# 명시적으로 저장
hnd know add "패스키와 암호화 경계" \
  --text "패스키는 계정 인증용이고 서버 master key는 tenant vault key 보호용이다." \
  --tag 보안 --tag 설계

# 현재 Git 프로젝트 전체에 저장
hnd know add "API 오류 응답 원칙" --scope repo \
  --text "외부 응답은 안정된 오류 코드와 짧은 사용자 메시지를 함께 제공한다."

# 현재 프로젝트의 prod 환경에만 저장
hnd know add "운영 배포 확인" --scope env --environment prod \
  --text "배포 뒤 healthz와 로그인 흐름을 함께 확인한다."

# 제목·태그·본문을 함께 검색
hnd know find "master key"
hnd know find "배포" --scope env --environment prod
hnd know list --tag 보안
hnd know list --scope repo
hnd know show KNOWLEDGE_ID
hnd know edit KNOWLEDGE_ID --title "패스키와 암호화 경계"
hnd know remove KNOWLEDGE_ID
```

지식은 사용자가 저장한 항목만 `~/.hnd/knowledge/`에 남고 중앙 동기화 대상에
포함됩니다. `all`은 계정의 모든 프로젝트에서 찾는 공통 지식, `repo`는 현재 Git
프로젝트 전체, `env`는 현재 프로젝트의 선택한 환경 범위입니다. 웹에서도 같은 세
범위를 선택하고 프로젝트 상세에서 연결된 지식을 확인할 수 있습니다. 에이전트 대화
전문이나 소스 코드를 자동으로 수집하지 않습니다.

## 중앙 서버와 자동 동기화

`sync`는 PC끼리 직접 연결하는 P2P 기능이 아닙니다.

```text
PC A 로컬 캐시 <── 자동 sync ──> 중앙 hnd 서버 + hnd.sqlite <── 자동 sync ──> PC B 로컬 캐시
```

자동 동기화 설정은 기본으로 켜져 있으며 `hnd connect`로 계정을 연결한 뒤부터
동작합니다.

```sh
hnd sync auto status
hnd sync auto off
hnd sync auto on
```

훅의 동작 순서는 다음과 같습니다.

1. `SessionStart`는 서버에 짧게 동기화를 시도하고 현재 Git 저장소를 안전하게
   자동 등록한 뒤 로컬 캐시의 context를 에이전트에 전달합니다. 서버가 느리거나
   꺼져 있어도 세션 시작을 막지 않습니다.
2. 각 사용자 입력 직전에는 짧게 동기화한 뒤 유효 룰, 선택한 활성 작업과 자동
   체크포인트를 합친 Live Context revision을 현재 세션의 마지막 revision과
   비교합니다. 달라진 경우에만 그 시점의 최신 전체 snapshot을 전달하며, 같은
   revision은 반복하지 않습니다. 새 세션뿐 아니라 `resume`, `clear`, `compact`
   시점에도 최신 snapshot을 한 번 강제로 확인합니다.
3. `Stop`과 `SessionEnd`는 Git 체크포인트를 로컬에 저장한 뒤 동기화를
   시도합니다.
4. 네트워크 장애로 전송하지 못한 변경은 로컬에 pending으로 남고, 다음
   세션 훅이 자동으로 재시도합니다.

`rule`이나 `work`로 동기화 대상 로컬 상태를 바꿨을 때도 짧은 자동 동기화를
시도하므로, 정상 사용에서는 다음 세션까지 기다릴 필요가 없습니다.

각 snapshot에는 SHA-256 revision과 이전 HND snapshot을 대체한다는 경계가
포함됩니다. Claude와 Codex의 기존 대화 기록에 과거 HND 문장이 남을 수는 있지만
가장 최근 전달된 revision만 현재 상태로 취급합니다. Cursor는 관리되는
`.cursor/rules/50-hnd.mdc` 파일 자체를 최신 snapshot으로 교체합니다. HND가 각
에이전트의 과거 대화 메시지를 삭제할 수는 없으므로, 매우 긴 세션은 에이전트의
`compact` 기능을 사용하면 다음 훅이 최신 snapshot을 다시 전달합니다. 명시적으로
저장한 장기 지식은 모든 입력에 싣지 않고 검색할 때만 읽습니다.

따라서 PC B가 꺼져 있어도 PC A에는 영향이 없습니다. 중앙 서버가 일시적으로
꺼져도 룰 주입, 자동 체크포인트, 수동 작업 기록은 마지막 로컬 캐시를 기준으로
계속 동작합니다.

자동화가 안전하게 판단할 수 없는 경우에는 원격 내용을 덮어쓰지 않고
`attention` 상태로 멈춥니다. CLI와 웹 모두 마지막으로 확인한 기준본, 로컬본,
서버본을 비교해 서로 다른 룰·프로젝트·작업·지식 항목은 자동 병합합니다. 정말 같은
항목을 양쪽에서 바꾼 경우와 인증 실패, 암호문 무결성 검증 실패만 확인이 필요합니다.
CLI는 `hnd sync status`로 원인을 확인하고, 웹은 홈의 충돌 선택 창에서 겹친 항목에
사용할 변경을 고릅니다.

웹 앱도 내용을 먼저 암호화된 로컬 사본에 저장하고 자동 전송합니다. 한 번 이상
정상적으로 `/app`을 연 브라우저는 서버가 잠시 끊겨도 `/app`과 마지막 암호화
사본을 열 수 있습니다. 연결이 돌아오면 자동으로 다시 전송하며, 같은 항목을 양쪽에서
바꾼 진짜 충돌만 홈에 `내 변경 사용`, `서버 변경 사용`을 표시합니다. 선택 직전에
서버에 새 변경이 더 들어와도 다시 병합해 선택한 항목 외의 변경은 보존합니다.

클라이언트는 tenant 보관함 키로 snapshot을 AES-256-GCM 암호화해 전송합니다.
서버는 그 보관함 키를 `/data/server-vault.key`로 보호해 관리하므로 필요하면
snapshot을 복호화할 수 있습니다. 따라서 이 구조는 E2EE나 zero-knowledge가
아닙니다. 테넌트, 기기, 초대, token hash, 보호된 보관함 키, 암호화 snapshot과
revision은 `/data/hnd.sqlite`에서 관리됩니다.

오프라인 fallback을 위해 각 PC에는 룰, handoff, 체크포인트와 복구용 캐시가
남습니다. 현재 이 로컬 데이터는 hnd가 별도로 암호화하지 않는 평문 private
파일이며, Unix에서는 디렉터리 `0700`, 파일 `0600` 권한으로 제한합니다. PC
분실까지 대비하려면 OS 디스크 암호화를 함께 사용해야 합니다. 서버에서는 SQLite와
`server-vault.key`를 모두 백업하고 운영자 접근을 제한해야 합니다.

### 서버 실행

```sh
# 최초 1회만 복사하고 기존 .env는 보존
[ -e .env ] || cp .env.example .env
# .env에서 HND_BIND_ADDRESS=127.0.0.1 유지, 필요하면 port/image 조정
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8787/healthz
```

실서비스에서는 직접 구성한 도메인과 HTTPS reverse proxy를 앞에 둡니다.
Compose의 `8787` 포트는 `127.0.0.1`에만 열고, 호스트 nginx가
`https://hnd.example.com`의 모든 경로를 그 포트로 전달합니다. 최초 launcher는
공개 npm 패키지로 설치하고 이후 connector runtime은 이 서버에서 서명본을
배포합니다. 전체 운영 절차와 nginx 설정 예시는
[`deploy/README.md`](deploy/README.md)에 있습니다.

### PC 연결

HND 웹에 로그인한 뒤 **기기 → PC 연결**에서 일회용 코드를 만듭니다. 서버 계정이
tenant와 연결 권한을 확인하고 보호된 보관함 키로 코드를 만듭니다. 최초 PC와
추가 PC의 절차가 같으며, 기존 PC가 켜져 있거나 연결을 승인할 필요가 없습니다.
운영체제에 맞게 화면에서 만든 `hnd connect` 명령을 실행한 다음 상태를 확인합니다.

연결된 PC 이름은 **기기** 목록의 **이름 변경**에서 바로 수정할 수 있습니다.
owner와 admin만 이름을 변경하거나 연결을 끊을 수 있으며, 폐기된 PC 이름은 변경할
수 없습니다.

```sh
hnd sync status
hnd setup
```

계정 복구 뒤에도 서버의 SQLite와 `server-vault.key`가 온전하면 다른 기기 없이
보관함을 다시 열 수 있습니다. `hnd sync invite`는 더 이상 코드를 만들지 않고 웹의
PC 연결 화면을 안내합니다. `hnd sync join`과 `hnd sync enroll`은 이전 설치 호환,
`hnd sync key export/import`는 예전 E2EE 로컬 키를 서버 계정형으로 전환할 때만
남겨 둔 보조 명령입니다. 새 연결과 정상 복구에는 사용하지 않습니다.

### 평소 사용과 수동 복구

```sh
hnd sync auto status
hnd sync status
hnd sync pull
hnd sync merge
hnd sync push
hnd sync revisions
hnd sync devices
```

정상 사용에서는 `pull`, `merge`, `push`를 매번 실행할 필요가 없습니다. 이
명령들은 동기화 진단, `attention` 충돌 해결, 과거 revision 복구 같은 수동
복구용입니다. 두 장치가 서로 다른 파일을 수정한 경우에는 마지막 공통 상태를
기준으로 안전하게 합치지만, 같은 파일 충돌은 자동으로 어느 한쪽을 덮어쓰지
않습니다.

소스 코드는 hnd 동기화 대상이 아닙니다. 소스 변경은 Git으로 공유하고, hnd는
룰·체크포인트·작업 인계만 공유합니다.

자세한 서버 운영, 백업, 초대와 복구 방법은
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)를 참고하세요.

## 상태 확인

```sh
hnd status
hnd context
hnd preview --agent all
hnd doctor
```

`hnd context`는 현재 Live Context의 revision과 다음 입력 또는 새 세션에 전달될
최신 합성 snapshot을 보여줍니다.

## Cursor 보조 파일

Cursor 버전에 따라 훅의 추가 context가 모델에 전달되지 않을 수 있어 hnd는
다음 파일도 관리합니다.

```text
<repository>/.cursor/rules/50-hnd.mdc
```

새 checkout에서는 첫 Cursor 세션 전에 `hnd materialize`를 실행하면 됩니다.
이 파일은 Git의 로컬 exclude에만 추가되며, 기존 tracked `.gitignore`는 수정하지
않습니다.

## 제거

```sh
hnd uninstall --dry-run
hnd uninstall
npm uninstall --global '@lch-1/hnd'
```

hnd가 만든 훅, 스킬, Cursor 보조 항목만 제거하고 사용자의 기존 설정은
보존합니다. `hnd uninstall`은 connector 프로그램이나 `~/.hnd` 데이터까지
삭제하지 않으므로 package 제거는 별도로 실행합니다.

## 소스 개발자용 확인

```sh
node scripts/check-syntax.mjs
node --test
```

### 최초 launcher npm 배포

루트 package는 server용이며 `private: true`입니다. 루트에서 publish하지 말고,
검토된 client allowlist로 생성되는 package directory만 배포합니다.

```sh
npm whoami                       # 반드시 lch-1
npm run build:npm
npm test
npm publish ./dist/npm/package --dry-run
npm publish ./dist/npm/package
npm view '@lch-1/hnd@0.2.2' version
```

npm 비밀번호·OTP·token은 파일이나 채팅에 남기지 않습니다. 같은 version은 다시
배포할 수 없습니다. publish 성공 직후 `npm view`가 잠시 404여도 dist-tag가
생겼다면 npm 보안 검사가 끝날 때까지 기다립니다. 이후 일반 connector 변경은
`docs/DEPLOYMENT.md`의 서명 release 절차로 서버 image에 넣습니다. launcher protocol,
고정 공개키 또는 최소 Node 요구사항이 바뀔 때만 package와 웹의 bootstrap version을
함께 올려 npm에 다시 배포합니다.

`HND_HOME`은 hnd 상태 경로를, `HND_USER_HOME`은 에이전트 설정 기준 경로를
바꿉니다. 설계 결정은 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), 최초
요구사항은 [`PLAN.md`](PLAN.md)에 정리되어 있습니다.
