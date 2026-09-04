# ADR: 중앙 동기화와 offline-first 로컬 캐시

- 상태: Accepted, 현재 구현 기준
- 날짜: 2026-08-31
- 관련 문서: [`PLAN.md`](../PLAN.md)

## 맥락

`PLAN.md`는 여러 에이전트에서 전역·저장소·환경별 룰과 작업 인수인계를
일관되게 쓰려는 요구, 그리고 100명 규모 서비스까지 검토한 조사 원문이다.
제품 구현 방식은 그 문서의 평문 서버·웹 UI·Go/SQLite 제안을 그대로 따르지
않는다. 현재 목표는 혼자 또는 신뢰하는 소규모 팀이 24시간 중앙 서버를 운영해
기기 사이의 상태를 자동으로 맞추되, Bitwarden과 유사하게 서버 장애나 오프라인
상태에서는 마지막 로컬 캐시로 계속 작업할 수 있게 하는 것이다.

## 결정

```text
로컬 hnd 캐시 ──> 클라이언트 합성 ──> Claude/Codex 훅 또는 Cursor .mdc ──> 에이전트
      │
      └── 훅 기반 자동 sync ── AES-256-GCM snapshot ──> 계정 중심 중앙 Node 서버
```

1. 동기화는 기본으로 켜져 있지만 에이전트 시작 경로는 offline-first다.
   `SessionStart`가 짧은 제한 시간 안에서 원격 변경을 확인하고, 성공 여부와
   관계없이 검증된 로컬 캐시를 합성해 세션을 시작한다. 단순 네트워크 실패로
   처리하지 못한 변경은 pending으로 남기고 다음 훅이 재시도한다.
   각 사용자 입력 직전에도 짧게 동기화하고, 유효 룰·선택한 활성 handoff·관련
   knowledge·자동 checkpoint를 합친 세션별 Live Context revision이 달라진 경우에만 최신 전체
   snapshot을 전달한다. `hnd sync auto on/off/status`로 자동 동기화를 관리한다.
2. 공개 npm 패키지 `@lch-1/hnd`는 Windows/macOS/Linux에 고정 launcher와
   검증된 fallback runtime을 최초 한 번 설치한다. lifecycle 설치 script와
   server/web/DB 코드는 넣지 않으며, 설치만으로 Git 저장소, PC 연결 또는 에이전트
   설정을 바꾸지 않는다. PC 연결 뒤 launcher는 인증된 중앙 서버에서 Ed25519로
   서명된 client-only runtime을 받아 digest와 단조 release sequence를 검증하고
   원자적으로 전환한다. 서버 장애나 검증 실패 시 마지막 정상 runtime, 그마저
   없으면 npm fallback으로 실행한다. 일반 runtime release에는 npm publish가
   필요하지 않다. `hnd setup --dry-run`과 `hnd setup`은 최초 에이전트 연동을
   명시적으로 설치하며, 이후 서명 runtime은 기존 HND 관리 skill만 안전하게
   갱신한다. 이는 launcher 설치와 훅 실행 권한에 대한 신뢰 결정을 분리한다.
3. Claude Code와 Codex는 사용자 범위 session-start 훅으로 합성 문서를 받는다.
   Cursor는 `additional_context`가 전달되지 않는 릴리스가 있으므로, 현재 세션의
   주 전달 수단으로 checkout-local `.cursor/rules/50-hnd.mdc`를 materialize한다.
   파일은 `alwaysApply: true`이고 hnd 소유 마커를 가지며, Git의
   `.git/info/exclude`에만 추가된다. 새 checkout은 첫 AI 세션의 시작 훅에서
   저장소 등록과 materialize를 자동 처리한다. 세 에이전트 모두 Stop과 SessionEnd 훅으로
   브랜치, HEAD, 마지막 commit과 working-tree 변경 경로를 자동 checkpoint에
   기록한다. 동일한 Git fingerprint는 다시 쓰지 않는다. `Stop`과
   `SessionEnd`, Claude의 `PreCompact`는 checkpoint를 로컬에 확정한 뒤 원격 동기화를 시도한다. 자동
   checkpoint와 사람이 작성한 handoff는 서로 덮어쓰지 않는다.
4. 정책은 `global -> repo -> 선택한 environment -> local override` 순으로 한
   문서에 합성한다. local override는 가장 뒤에 붙고 동기화하지 않는다.
   PLAN의 별도 `guard.md` 역할은 이 local override가 맡는다. 기존 범위별 단일
   정책은 호환성을 위해 유지하고, 이름 있는 정책 record는 초안/사용 중, 자동/수동,
   경로와 파일 glob 조건을 가진다. 경로는 현재 prompt와 Git checkpoint의 변경
   경로로 결정적으로 판정하며, 경로를 아직 알 수 없으면 조건 자체를 정책에 명시한다.
5. handoff는 정책이 아닌 구조화된 작업 상태다. 우선순위, workflow 상태, 상위·선행
   작업, 준비 여부, 만료되는 세션 선점, 차단 원인·해제 조건과 항목별 감사 기록을 가진다. 새 handoff는 현재
   worktree/branch에 자동 선택되고, `hnd work use`로 선택을 바꾼다. 동기화로
   들어온 여러 active handoff 중 로컬 선택이 없으면 임의로 고르지 않고 선택
   목록을 주입한다. 만료된 handoff는 본문을 자동 주입하지 않고 stale 알림만
   넣는다. 결정, 실패한 접근, 변경 파일, 검증, 다음 작업과 열린 질문은
   명시적으로 저장한다.
6. 클라이언트가 최종 바이트를 결정한다. 기본 32 KiB 예산은 필수 정책, 활성 handoff,
   관련 knowledge(최대 5개/6 KiB), checkpoint(4 KiB) 순으로 배분한다. 블록 중간은
   자르지 않고 후순위 정보 블록을 생략하며, 필수 정책이 한도를 넘으면 합성을 거부한다. 서버가
   암호화 키를 관리하더라도 에이전트별 합성과 용량 절단은 클라이언트 책임으로
   유지한다.
7. 저장소의 주 식별자는 hnd가 발급한 UUID다. credential을 제거해 정규화한
   `origin` remote와 공유 root history가 모두 확인될 때만 checkout 경로와 무관하게
   자동 매칭한다. remote 문자열만 복제한 unrelated checkout에는 private policy를
   연결하지 않는다. root commit은 fork도 공유할 수 있으므로 단독 자동 연결
   근거로 쓰지 않는다. shallow clone, 애매한 이력, fork는 사용자가
   `repo link/register`로 결정한다.
8. 동기화 서버가 계정과 암호화 키 custody의 기준이다. 클라이언트는 tenant vault
   key로 snapshot을 AES-256-GCM 암호화하지만, 서버는 그 vault key를 raw 32-byte
   `/data/server-vault.key`로 보호해 `/data/hnd.sqlite`에 저장한다. master key는 첫
   실행에 mode `0600`으로 원자 생성하고 재사용한다. 실행 중인 서버는 vault key와
   snapshot을 복호화할 수 있으므로 이 구조는 E2EE나 zero-knowledge가 아니다.
   정상 기기 연결은 로그인한 웹 계정이 tenant 범위의 일회용 invitation을 발급하고
   새 PC가 `hnd connect`로 소비한다. 첫 PC와 추가 PC는 완전히 같은 절차이며 특정
   PC나 열린 브라우저가 연결의 기준이 되지 않는다. `hnd sync invite`는 코드를
   만들지 않고 웹 연결 화면만 안내한다. 이전 `hndj_` 코드 소비 형식은 `0.2.0`
   connector 호환을 위해 유지한다. 해시로 저장한 device token, token에서만 파생한
   tenant 범위, device revoke를 사용한다. snapshot 교체는 strong ETag와
   `If-Match`/`If-None-Match`로 경쟁 쓰기를 거부한다. 클라이언트는 최근 ETag
   체크포인트를 기억해 이미 지나간 revision의 재제시를 거부하고, 다중 파일
   restore는 전역 generation lock과 복구 journal로 처리한다.
9. 같은 origin의 웹 앱을 제공한다. `/`은 로그인 또는 초기 설정만 보여주며,
   로그인 뒤 `/app`에서 룰·작업·장기 지식을 관리한다. 패스키는 계정 인증에만
   사용하고 vault key와 분리한다. 인증된 새 브라우저는 서버에서 같은 tenant vault
   key를 받아 로컬 non-extractable wrapping key로 감싸 IndexedDB에 보관한다. 이
   로컬 사본은 오프라인 사용을 위한 것이지 새 기기 승인의 기준이 아니다. PC 연결
   코드도 계정 권한을 확인한 서버가 관리 중인 vault key로 발급한다. 계정 복구 뒤
   SQLite와 server master key가 온전하면 다른 기기 없이 보관함을 다시 열 수 있다.
   명시적 vault reset은 데이터를 버리려는 소유자 작업일 뿐 일반적인 키 복구 절차가
   아니다. reset은 최근 패스키 확인, 활성 device 0대, strong ETag 비교를 요구하고
   다른 장치의 로컬 사본은 지우지 못한다. WebAuthn 검증과 cookie 처리는 Docker
   서버 image 안의 version 고정 라이브러리를 사용한다. 서비스 워커는 인증 API나
   설정 화면이 아니라 `/app` 화면 코드만 보관하며, 오프라인 접근 표식과 snapshot은
   vault key로 암호화한다. 재연결 시 세션·tenant를 다시 확인한 뒤 pending 변경을
   전송한다.
10. 웹 UI는 계정 설정이 없으면 브라우저 언어를, CLI는 로컬 설정이 없으면 OS
   언어를 따라 한국어와 영어 중 하나를 선택한다. 웹 선택은 계정과 브라우저에,
   CLI 선택은 device-local `config.json`에 저장한다. 번역 설정은 동기화 snapshot에
   포함하지 않으며 `hnd lang set ko|en`과 `hnd lang auto`로 바꾼다.
11. `hnd rule test start`는 현재 저장소와 선택 환경에만 묶인 1시간짜리 로컬 검증
   지시를 합성한다. 기존 룰이나 동기화 snapshot을 수정하지 않고 global, project,
   environment 각각의 정확한 입력·출력 쌍을 현재 또는 새 에이전트 세션에서
   확인하게 한다. `hnd rule test stop`으로 즉시 제거할 수 있다.
12. knowledge JSON은 원본이고 `cache/knowledge-fts.sqlite`는 언제든 재생성 가능한
   device-local FTS5 색인이다. 지식은 유형·상태·승인·고정·출처·관계·피드백·변경
   이력을 가지며, pending/rejected와 contradicted/retired/superseded 항목은 자동
   주입하지 않는다. 가져오기는 기본 preview이고 모든 후보는 review inbox로 간다.
   JSON, Markdown, OKF 형태의 전체 또는 범위별 내보내기를 지원한다.

따라서 PLAN의 서버측 평문 합성과 Go 단일 바이너리 설계는 제외하고, 중앙 영속
계층에는 SQLite를 채택한다. 이것은 결제·공개 SaaS 운영 기능을 갖춘 100명용
서비스가 아니라 Docker로 한 운영자가 배포하는 self-host encrypted sync 앱이다.

## 위협 모델

신뢰 경계에는 로컬 OS와 hnd 클라이언트, 사용자가 검토해 설치한 훅뿐 아니라 중앙
서버 프로세스, `/data/server-vault.key`, SQLite와 그 백업을 다루는 운영자가 포함된다.
서버는 tenant vault key를 풀어 snapshot을 복호화할 수 있으므로 서버 운영자를
신뢰하지 않는 E2EE 모델이 아니다. 실행 중인 서버, master key와 DB backup을 함께
얻은 공격자는 동기화된 룰·작업·지식을 읽을 수 있다.

오프라인 동작을 위해 정책, handoff, 명시적으로 저장한 장기 지식, checkpoint,
merge 보고서와 복구 snapshot은
로컬에 남는다. 현재 이 데이터는 hnd 자체 암호화를 적용하지 않은 평문 private
파일이다. Unix에서는 hnd 상태 디렉터리를 `0700`, 파일을 `0600`으로 제한하지만,
로컬 관리자·동일 사용자 권한의 프로세스·암호화되지 않은 디스크로부터 내용을
숨기지는 못한다. device-at-rest 보호는 OS 디스크 암호화에 맡긴다.

tenant vault key를 master key로 감싸는 구조는 SQLite 파일만 유출된 경우의 내용을
보호한다. 실행 중인 서버 침해, master key 유출, 운영자 접근까지 막지는 않는다.
AES-GCM 인증을 통과하지 못한 snapshot은 클라이언트가 거부하고 서로 다른 tenant의
key는 분리한다. 인증된 요청의 tenant는 본문이나 URL 입력이 아니라 계정 membership
또는 device token의 서버측 매핑에서 정한다. SQLite foreign key와 모든 query의
tenant 조건은 우발적인 교차 접근을 줄인다.

암호화와 인증은 다음 위험까지 막지 않는다.

- 빈 서버는 웹에서 먼저 등록을 완료한 방문자를 서버 소유자로 확정한다. Origin
  검사와 패스키는 요청 무결성과 사용자 확인을 제공하지만 그 방문자가 실제
  운영자인지는 증명하지 않는다. 초기 설정 전에는 공개 접근을 제한해야 한다.
  기본 `open` 정책의 이후 가입자는 분리된 tenant를 받지만 서버 자원을 사용할 수
  있으므로 운영 규모에 따라 초대 전용 또는 닫힘 정책과 rate limit을 사용한다.
- 서버와 운영자는 권한상 snapshot 평문을 복호화할 수 있고 tenant/device 식별자,
  blob 크기, IP 주소와 요청 시각도 볼 수 있다.
- 악성 또는 손상된 서버는 데이터를 삭제하거나 응답을 거부할 수 있다. 최근
  128개의 로컬 ETag 기록에 있는 과거 암호문을 다시 제시하면 거부하지만, 기록에
  없는 오래된 유효 암호문이나 모든 로컬 체크포인트를 함께 잃은 경우까지 막는
  단조 revision 프로토콜은 아니다.
- device 폐기는 이후 서버 접근을 막을 뿐 이미 내려받은 평문, 암호문 또는 vault
  key를 원격 삭제하지 못한다.
- bearer token과 snapshot은 TLS가 없으면 노출될 수 있다. 운영 URL은 HTTPS가
  필요하며 TLS 종료는 외부 reverse proxy/ingress의 책임이다.
- 로컬 관리자나 같은 사용자 권한의 공격자가 hnd 상태, 에이전트 설정 또는 훅을
  바꾸는 공격은 이 시스템의 방어 범위 밖이다.

정책은 결국 코딩 에이전트에 들어가는 지시문이다. 저장 암호화는 정책 내용 자체의
안전성 검증이나 에이전트 권한 sandbox가 아니다.

## 동기화 경계

현재 snapshot allowlist는 다음뿐이다.

- `policies/global.md`
- `repositories.json`
- `repositories/**` — 저장소 메타데이터, repo/environment 정책, active/archive
  handoff와 이름 있는 저장소/환경 룰
- `rules/**` — 이름 있는 전체 룰
- `knowledge/**` — 승인된 지식과 검토 대기 후보

다음은 device-local이라 동기화하지 않는다.

- `local-override.md`, Git 체크아웃별 환경 선택과 handoff 선택
- checkout 경로 binding, hnd config, 관리 파일 ledger
- remote URL과 ETag 상태, device token, vault key와 그 밖의 secrets
- cache, lock, 임시 blob
- Claude/Codex/Cursor 설정과 materialize된 `.mdc` 파일

자동 sync는 `SessionStart`에서 짧게 pull/reconcile한 뒤 로컬 Live Context를
합성한다. 사용자 입력 직전에는 다시 짧게 sync하고 `all`, `repo`, `env`, `pc`
정책, 선택한 활성 handoff, 현재 prompt와 관련된 승인 knowledge, 자동 checkpoint로 만든 세션별 SHA-256 revision을
비교한다. revision이 달라졌을 때만 최신 전체 snapshot을 새로 전달하고, 각
snapshot은 이전 HND snapshot을 대체한다고 명시한다. 새 세션과 resume, clear,
compact에서는 최신 snapshot을 강제로 한 번 전달한다. 전체 knowledge 목록은 싣지
않고 로컬 FTS5에서 고정 항목과 관련 항목만 선택한다.

Claude와 Codex는 prompt hook의 추가 context를 사용한다. vendor 대화 기록에서
과거 HND 메시지를 물리적으로 삭제할 수는 없으므로 가장 최근에 전달된 revision을
논리적 현재 상태로 취급한다. Cursor는 prompt hook이 추가 context를 지원하지 않아
관리되는 always-apply `.mdc` 파일을 최신 snapshot으로 원자적으로 교체한다.
`Stop`과 `SessionEnd`에서는 checkpoint를 확정한 뒤
reconcile/push한다. connector와 웹은 마지막 검증 snapshot을 base로 보관하고
base/local/server 3-way merge를 수행한다. 서로 다른 룰·작업·지식 파일은 경로
단위로 합치고, repository index와 metadata 같은 JSON map은 키 단위로 합친다.
브라우저는 암호화한 로컬본과 기준본을 IndexedDB에 함께 보관한다.
네트워크 단절·timeout처럼 재시도 가능한 실패는 로컬 변경과 pending 상태를
보존하며 다음 훅에서 다시 시도한다.

반면 같은 항목의 동시 변경, 인증 실패, AES-GCM 무결성 실패는 자동으로 overwrite하거나
계속 retry하지 않고 `attention` 상태로 기록한다. connector의 동일 파일 충돌은 로컬 버전을
보존한 채 base/local/remote 보고서를 private cache에 남긴다. 웹은 서로 다른 항목을
이미 합친 snapshot에서 겹친 항목에 로컬 또는 서버 변경을 선택하며, 선택 직전의 최신
서버본과 다시 병합해 그 사이 들어온 독립 변경도 보존한다. 사용자는
`hnd sync status`로 원인을 확인하고 `sync pull/merge/push/restore`를 진단·복구
목적으로 명시적으로 실행한다. 강제 pull과 merge 전 상태 변경은 먼저 복구용
snapshot으로 저장된다. restore는 모든 입력을 검증한 뒤 journal을 기록하며,
중단되면 다음 sync나 상태 읽기 전에 복구를 완료한다.

## 운영 제약과 후속 확장

- 현재 서버는 단일 프로세스와 로컬 영속 volume을 전제로 한다. SQLite transaction
  으로 compare-and-swap을 직렬화하며, 공유 volume을 여러 replica가 동시에 쓰는
  HA 배포는 지원하지 않는다.
- Compose는 loopback에만 bind한다. domain, DNS, 인증서, TLS proxy, 방화벽과
  volume backup은 운영자가 구성한다. `/data/hnd.sqlite`와 raw 32-byte, mode `0600`
  `/data/server-vault.key`를 같은 복구 세트로 모두 백업해야 한다. 어느 하나만으로는
  기존 보관함을 복구할 수 없다.
- 운영 도메인의 host nginx는 웹과 API 경로를 `127.0.0.1:8787`로 proxy한다.
  npm registry는 최초 launcher 설치에만 사용하고, 이후 connector runtime의
  배포와 버전 선택은 인증된 HND 서버의 서명 release가 담당한다.
- npm launcher version과 connector runtime version은 독립적으로 관리한다. launcher는
  npm package 자체를 다시 배포해야 할 때만 증가하고, runtime은 npm publish 없이
  중앙 서버 release로 증가한다. 로컬 runtime과 서버 manifest의 SHA-256 일치는 같은
  bundle이 적용됐다는 무결성 증거다. 서버 API/UI JavaScript는 Docker image에만 있고
  connector runtime으로 PC에 배포하지 않는다.
- 자동 sync는 기본으로 켜져 있고 동기화 대상 로컬 mutation 직후와 세션 훅에서
  실행한다. 계속 떠 있는 background daemon이나 실시간 push 채널은 없으므로,
  다른 device의 변경은 다음 훅에서 보인다. 수동 sync는 진단·복구용이며,
  폐기된 device의 기존 로컬 사본은 지워지지 않는다.
- tenant별 암호문 revision은 기본 50개로 제한한다. tenant 수/전체 disk quota와
  rate limit 고도화, 계정 삭제·전체 내보내기, SSO, 결제, 감사 로그, 알림은
  제공하지 않는다. `hnd` 실행 시 마지막 확인에서 6시간 이상 지났으면 connector
  runtime을 짧게 background에서 확인하며 상시 daemon은 두지 않는다. 필요하면
  `hnd update apply`로 즉시 적용하고 `hnd update rollback`으로 검증된 이전 runtime에
  되돌린다.
- 조직 단위 공유·승인 workflow와 외부 에이전트 adapter는 후속 범위다.

100명용 서비스로 확장하려면 tenant 격리 테스트와 데이터 모델을 다시 검토하고,
  managed database/object storage, HA, migration, observability, abuse 대응, 계정 수명
  주기와 운영자 감사 기능이 필요하다. 서버가 복호화할 수 있는 현재 신뢰 모델에서는
  서버측 검색 색인이나 협업 기능을 추가할 수 있지만, 사용자의 민감한 룰과 지식에
  대한 접근·감사·보존 정책을 먼저 설계해야 한다. 체크포인트 기록 범위를 넘어서는
  rollback 방지가 필요하면 device가 검증하는 단조 revision 또는 서명된 hash
  chain을 별도 프로토콜로 추가한다.

## 결과

이 결정은 세 에이전트에서 같은 정책과 작업 인수인계를 자동으로 전달하면서 PC
연결과 계정 복구를 서버 계정 하나로 단순화한다. 사용자는 정상 흐름에서 수동 sync를
관리하지 않고 서버 장애 시에도 마지막 캐시로 작업할 수 있다. 대가는 서버와
운영자를 데이터 기밀성 경계 안에 두고 SQLite와 server master key를 함께 안전하게
백업해야 한다는 점, attention 상태의 수동 해결이 필요하다는 점, 현재 서버가
소규모 self-host 운영 한계를 넘지 않는다는 점이다.
