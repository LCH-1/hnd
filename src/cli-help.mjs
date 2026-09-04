export const HELP = `hnd — 코딩 에이전트 룰·진행 상태 공유

처음 한 번:
  1. HND 웹의 [기기 → PC 연결]에서 만든 명령 실행
  2. hnd setup
  3. Git 프로젝트에서 AI 세션 시작 (프로젝트 자동 등록)

평소에 필요한 명령:
  hnd status                         현재 프로젝트·환경·동기화 확인
  hnd rule list                      적용 가능한 룰 목록
  hnd rule set <all|repo|env|pc> ... 룰 저장
  hnd env set LABEL                  현재 체크아웃의 환경 선택
  hnd work list                      진행 중 작업 확인
  hnd know find QUERY                오래 남긴 지식 검색
  hnd lang show                      현재 언어 확인

프로젝트를 지금 직접 등록하려면 Git 저장소에서 hnd init을 실행합니다.
진행 상태 저장과 서버 동기화는 기본적으로 자동입니다.

주제별 도움말:
  hnd project help   프로젝트 등록·환경
  hnd rule help      전체·프로젝트·환경·PC 룰
  hnd work help      작업 인계
  hnd know help      장기 지식
  hnd sync help      자동 동기화·복구
  hnd setup help     PC 연결·에이전트 설정
  hnd advanced help  진단·내부·이전 호환 명령
  hnd lang help      표시 언어

같은 방식으로 hnd rule --help도 사용할 수 있습니다.
버전 확인: hnd --version
`;

const HELP_EN = `hnd — shared rules and progress for coding agents

One-time setup:
  1. Run the command created under [Devices → Connect PC] in the HND web app
  2. hnd setup
  3. Start an AI session in a Git project (the project is registered automatically)

Everyday commands:
  hnd status                         Check the current project, environment, and sync
  hnd rule list                      List available rules
  hnd rule set <all|repo|env|pc> ... Save a rule
  hnd env set LABEL                  Select an environment for this checkout
  hnd work list                      Show active work
  hnd know find QUERY                Search long-term knowledge
  hnd lang show                      Show the current language

Run hnd init in a Git repository to register it immediately.
Progress capture and server sync are automatic by default.

Topic help:
  hnd project help   Project registration and environments
  hnd rule help      Account, project, environment, and PC rules
  hnd work help      Work handoff
  hnd know help      Long-term knowledge
  hnd sync help      Automatic sync and recovery
  hnd setup help     PC connection and agent setup
  hnd advanced help  Diagnostics, internals, and legacy commands
  hnd lang help      Display language

hnd rule --help works the same way.
Language: hnd lang set <ko|en> · hnd lang auto
Version: hnd --version
`;

const PROJECT_HELP = `hnd project — 프로젝트 등록과 환경

권장 흐름:
  Git 저장소에서 Claude Code·Codex·Cursor 세션을 시작하면 자동 등록됩니다.
  즉시 직접 등록하거나 자동 등록을 확인하려면 아래 명령을 사용합니다.

  hnd init [--cwd DIR] [--env LABEL]        현재 Git 저장소 등록
  hnd status [--cwd DIR] [--json]           현재 상태 확인
  hnd env set LABEL [--cwd DIR]             이 체크아웃의 환경 선택
  hnd env show [--cwd DIR]                  선택한 환경 확인
  hnd env clear [--cwd DIR]                 환경 선택 해제

드문 경우:
  hnd repo list [--json]                    등록된 프로젝트 목록
  hnd repo register [--cwd DIR] [--name NAME]
  hnd repo link REPOSITORY_ID [--cwd DIR] [--force]
  hnd repo unlink [--cwd DIR]

같은 원격 Git 저장소라도 prod/test 체크아웃마다 다른 환경을 선택할 수 있습니다.
`;

const RULE_HELP = `hnd rule — 에이전트가 따라야 할 룰

범위:
  all   모든 프로젝트 공통
  repo  현재 프로젝트 공통
  env   현재 프로젝트의 선택한 환경
  pc    서버에 동기화하지 않는 이 PC 전용

우선순위: pc > env > repo > all

사용법:
  hnd rule list [--cwd DIR] [--environment LABEL]
  hnd rule set <all|repo|env|pc> (--text TEXT | --file PATH | --stdin)
      [--cwd DIR] [--environment LABEL]
  hnd rule show <all|repo|env|pc> [--cwd DIR] [--environment LABEL]
  hnd rule edit <all|repo|env|pc> [--cwd DIR] [--environment LABEL]
  hnd rule remove <all|repo|env|pc> [--cwd DIR] [--environment LABEL]
  hnd rule test <start|show|stop>            실제 AI 세션 전달 검증

예:
  hnd rule set all --text "항상 테스트를 실행한다."
  hnd rule set repo --file ./AGENT_RULES.md
  hnd env set prod
  hnd rule set env --text "배포 전 백업을 확인한다."
  hnd rule set pc --text "이 PC에서는 직접 배포하지 않는다."
`;

const WORK_HELP = `hnd work — 에이전트 사이 작업 인계

사용법:
  hnd work new TASK --goal TEXT [--cwd DIR]
  hnd work save [TASK] [--id ID] [--goal TEXT] [--current TEXT]
      [--decision TEXT]... [--rejected TEXT]... [--changed-file PATH]...
      [--check TEXT]... [--next TEXT]... [--question TEXT]... [--note TEXT]...
  hnd work show [TASK] [--id ID] [--cwd DIR] [--json]
  hnd work list [--all] [--cwd DIR] [--json]
  hnd work use [TASK] [--id ID] [--cwd DIR]
  hnd work done [TASK] [--id ID] [--cwd DIR]

Git 진행 상태는 자동 저장됩니다. work는 결정, 다음 단계, 열린 질문처럼
사람이 보강해야 할 인계 내용을 남길 때 사용합니다.
`;

const KNOW_HELP = `hnd know — 오래 남길 지식

범위:
  all   모든 프로젝트에서 함께 사용하는 지식 (기본값)
  repo  현재 프로젝트에서 사용하는 지식
  env   현재 프로젝트의 선택한 환경에서 사용하는 지식

사용법:
  hnd know add TITLE [--text TEXT | --file PATH | --stdin] [--tag TAG]...
      [--scope all|repo|env] [--environment LABEL]
  hnd know find QUERY [--tag TAG] [--scope all|repo|env] [--environment LABEL] [--json]
  hnd know list [--tag TAG] [--scope all|repo|env] [--environment LABEL] [--json]
  hnd know show ID [--json]
  hnd know edit ID [--title TITLE] [--text TEXT | --file PATH | --stdin]
      [--tag TAG]... [--clear-tags] [--scope all|repo|env] [--environment LABEL]
  hnd know remove ID

repo와 env는 현재 Git 프로젝트를 사용합니다. env는 --environment를 생략하면
현재 체크아웃에서 선택한 환경을 사용합니다.
대화 전문은 자동 저장하지 않습니다. 다시 검색할 가치가 있는 내용만 직접 저장합니다.
`;

const SYNC_HELP = `hnd sync — 서버 동기화와 복구

평소에는 자동 동기화를 사용합니다:
  hnd sync status [--json]                  연결·대기 상태 확인
  hnd sync auto [status|on|off]             자동 동기화 설정

문제가 있을 때만 사용합니다:
  hnd sync push [--url URL]
  hnd sync pull [--url URL] [--force]
  hnd sync merge [--url URL]
  hnd sync revisions
  hnd sync restore REVISION_ID --force
  hnd sync devices
  hnd sync revoke DEVICE_ID

서버가 꺼져 있으면 로컬 사본으로 계속 작업하고, 연결이 복구되면 자동 재시도합니다.
`;

const SETUP_HELP = `hnd setup — PC 연결과 에이전트 설정

권장 흐름:
  HND 웹의 [기기 → PC 연결]에서 OS와 설치 상태를 선택하고 표시된 명령을 실행합니다.

사용법:
  hnd connect --url URL (--code CODE | --code-stdin) [--name DEVICE]
  hnd setup [--agents all|claude,codex,cursor] [--dry-run]
  hnd doctor [--cwd DIR] [--json]
  hnd uninstall [--agents all|claude,codex,cursor] [--dry-run]

업데이트:
  hnd update status
  hnd update check
  hnd update apply
  hnd update rollback
`;

const ADVANCED_HELP = `hnd advanced — 진단·내부·이전 호환 명령

진단과 생성 결과 확인:
  hnd context [--cwd DIR] [--task TASK | --handoff-id ID] [--json]
  hnd preview [--agent all|claude|codex|cursor] [--cwd DIR] [--json]
  hnd materialize [--cwd DIR] [--dry-run] [--json]
  hnd auto [status|on|off]

에이전트 훅 내부 명령:
  hnd hook <claude|codex|cursor> [start|stop|end]

이전 설치 전환용:
  hnd sync join --url URL (--invite INVITATION | --invite-stdin) [--name DEVICE]
  hnd sync enroll --url URL (--key ONE_TIME_KEY | --key-stdin) [--name DEVICE]
      (--vault-key-file PATH | --create-vault-key)
  hnd sync key <export|import> ...

기존 긴 별칭도 계속 동작합니다: policy, handoff, remote, knowledge, global,
local, start, select, close.
`;

const LANG_HELP = `hnd lang — 표시 언어

기본값은 OS 언어 자동 감지입니다. 환경변수를 직접 설정할 필요가 없습니다.

  hnd lang show             현재 설정과 실제 언어 확인
  hnd lang set ko           한국어로 고정
  hnd lang set en           영어로 고정
  hnd lang auto             OS 언어 자동 감지로 복귀

kr, ko-KR, en-US 같은 입력 별칭도 사용할 수 있습니다.
`;

const TOPICS_EN = Object.freeze({
  project: `hnd project — project registration and environments

Recommended flow:
  Starting Claude Code, Codex, or Cursor in a Git repository registers it automatically.
  Use these commands to register immediately or inspect automatic registration.

  hnd init [--cwd DIR] [--env LABEL]        Register the current Git repository
  hnd status [--cwd DIR] [--json]           Show current status
  hnd env set LABEL [--cwd DIR]             Select this checkout's environment
  hnd env show [--cwd DIR]                  Show the selected environment
  hnd env clear [--cwd DIR]                 Clear the selected environment

Occasional commands:
  hnd repo list [--json]                    List registered projects
  hnd repo register [--cwd DIR] [--name NAME]
  hnd repo link REPOSITORY_ID [--cwd DIR] [--force]
  hnd repo unlink [--cwd DIR]

Separate prod and test checkouts of the same Git remote can select different environments.
`,
  rule: `hnd rule — instructions agents must follow

Scopes:
  all   Shared by every project
  repo  Shared by the current project
  env   The selected environment in the current project
  pc    This PC only; never synced to the server

Priority: pc > env > repo > all

Usage:
  hnd rule list [--cwd DIR] [--environment LABEL]
  hnd rule set <all|repo|env|pc> (--text TEXT | --file PATH | --stdin)
      [--cwd DIR] [--environment LABEL]
  hnd rule show <all|repo|env|pc> [--cwd DIR] [--environment LABEL]
  hnd rule edit <all|repo|env|pc> [--cwd DIR] [--environment LABEL]
  hnd rule remove <all|repo|env|pc> [--cwd DIR] [--environment LABEL]
  hnd rule test <start|show|stop>            Verify delivery in a real AI session

Examples:
  hnd rule set all --text "Always run tests."
  hnd rule set repo --file ./AGENT_RULES.md
  hnd env set prod
  hnd rule set env --text "Verify the backup before deployment."
  hnd rule set pc --text "Do not deploy directly from this PC."
`,
  work: `hnd work — hand work to another agent

Usage:
  hnd work new TASK --goal TEXT [--cwd DIR]
  hnd work save [TASK] [--id ID] [--goal TEXT] [--current TEXT]
      [--decision TEXT]... [--rejected TEXT]... [--changed-file PATH]...
      [--check TEXT]... [--next TEXT]... [--question TEXT]... [--note TEXT]...
  hnd work show [TASK] [--id ID] [--cwd DIR] [--json]
  hnd work list [--all] [--cwd DIR] [--json]
  hnd work use [TASK] [--id ID] [--cwd DIR]
  hnd work done [TASK] [--id ID] [--cwd DIR]

Git progress is captured automatically. Use work for decisions, next steps, open questions,
and other context that needs a human explanation.
`,
  know: `hnd know — long-term knowledge

Usage:
  hnd know add TITLE [--text TEXT | --file PATH | --stdin] [--tag TAG]...
      [--scope all|repo|env] [--environment LABEL]
  hnd know find QUERY [--tag TAG] [--scope all|repo|env] [--environment LABEL] [--json]
  hnd know list [--tag TAG] [--scope all|repo|env] [--environment LABEL] [--json]
  hnd know show ID [--json]
  hnd know edit ID [--title TITLE] [--text TEXT | --file PATH | --stdin]
      [--tag TAG]... [--clear-tags] [--scope all|repo|env] [--environment LABEL]
  hnd know remove ID

Scope defaults to all. Repo and env scopes use the current Git repository; env also uses
the checkout's selected environment unless --environment is provided.
HND does not collect conversation transcripts. Save only knowledge worth finding again.
`,
  sync: `hnd sync — server sync and recovery

Automatic sync is recommended:
  hnd sync status [--json]                  Show connection and pending work
  hnd sync auto [status|on|off]             Configure automatic sync

Use these only to resolve a problem:
  hnd sync push [--url URL]
  hnd sync pull [--url URL] [--force]
  hnd sync merge [--url URL]
  hnd sync revisions
  hnd sync restore REVISION_ID --force
  hnd sync devices
  hnd sync revoke DEVICE_ID

If the server is unavailable, HND keeps working from the local copy and retries automatically.
`,
  setup: `hnd setup — PC connection and agent setup

Recommended flow:
  In the HND web app, open [Devices → Connect PC], select the OS and installation state,
  then run the displayed command.

Usage:
  hnd connect --url URL (--code CODE | --code-stdin) [--name DEVICE]
  hnd setup [--agents all|claude,codex,cursor] [--dry-run]
  hnd doctor [--cwd DIR] [--json]
  hnd uninstall [--agents all|claude,codex,cursor] [--dry-run]

Updates:
  hnd update status
  hnd update check
  hnd update apply
  hnd update rollback
`,
  advanced: `hnd advanced — diagnostics, internals, and legacy commands

Diagnostics and generated output:
  hnd context [--cwd DIR] [--task TASK | --handoff-id ID] [--json]
  hnd preview [--agent all|claude|codex|cursor] [--cwd DIR] [--json]
  hnd materialize [--cwd DIR] [--dry-run] [--json]
  hnd auto [status|on|off]

Internal agent hook command:
  hnd hook <claude|codex|cursor> [start|stop|end]

Legacy migration commands:
  hnd sync join --url URL (--invite INVITATION | --invite-stdin) [--name DEVICE]
  hnd sync enroll --url URL (--key ONE_TIME_KEY | --key-stdin) [--name DEVICE]
      (--vault-key-file PATH | --create-vault-key)
  hnd sync key <export|import> ...

Long aliases remain supported: policy, handoff, remote, knowledge, global,
local, start, select, close.
`,
  lang: `hnd lang — display language

The default follows the OS language. No environment-variable setup is required.

  hnd lang show             Show the preference and active language
  hnd lang set ko           Always use Korean
  hnd lang set en           Always use English
  hnd lang auto             Follow the OS language again

Input aliases such as kr, ko-KR, and en-US are accepted.
`,
});

const TOPICS = Object.freeze({
  project: PROJECT_HELP,
  rule: RULE_HELP,
  work: WORK_HELP,
  know: KNOW_HELP,
  sync: SYNC_HELP,
  setup: SETUP_HELP,
  advanced: ADVANCED_HELP,
  lang: LANG_HELP,
});

const TOPIC_ALIASES = Object.freeze({
  init: 'project',
  status: 'project',
  repo: 'project',
  env: 'project',
  policy: 'rule',
  handoff: 'work',
  knowledge: 'know',
  remote: 'sync',
  connect: 'setup',
  doctor: 'setup',
  uninstall: 'setup',
  update: 'setup',
  context: 'advanced',
  preview: 'advanced',
  materialize: 'advanced',
  hook: 'advanced',
  auto: 'advanced',
});

export const HELP_TOPIC_NAMES = Object.freeze(Object.keys(TOPICS));

export function helpFor(topic, language = 'ko') {
  if (topic === undefined || topic === null || topic === '') return language === 'en' ? HELP_EN : HELP;
  const normalized = String(topic).trim().toLowerCase();
  const selected = TOPIC_ALIASES[normalized] || normalized;
  return (language === 'en' ? TOPICS_EN : TOPICS)[selected] || null;
}
