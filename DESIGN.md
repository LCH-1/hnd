---
name: "HND Activity Ledger"
description: "따뜻한 종이색과 네이비 원장 문법으로 서버 상태와 다음 행동을 조용히 정리하는 HND 작업 UI"
colors:
  canvas-paper: "#FAF8F3"
  sidebar-cream: "#FDF0D5"
  surface-warm: "#FFFDF8"
  surface-subtle: "#F8F1E5"
  surface-hover: "#F3E9D9"
  crisp-white: "#FFFFFF"
  ledger-navy: "#003049"
  ledger-navy-hover: "#00263A"
  ledger-navy-pressed: "#001E2E"
  selection-blue: "#669BBC"
  selection-soft: "#E8F1F5"
  text-muted: "#425D69"
  text-soft: "#536B75"
  border-quiet: "#DED8CE"
  border-strong: "#778C96"
  attention-burgundy: "#780000"
  danger-red: "#C1121F"
  danger-red-hover: "#9F0F19"
  danger-soft: "#FCEBEC"
  success-green: "#2F6F57"
  success-soft: "#EAF4EF"
  warning-ochre: "#8A4B08"
  warning-soft: "#FFF4DF"
  code-charcoal: "#202329"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Apple SD Gothic Neo, Noto Sans KR, sans-serif"
    fontSize: "30px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Apple SD Gothic Neo, Noto Sans KR, sans-serif"
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Apple SD Gothic Neo, Noto Sans KR, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Apple SD Gothic Neo, Noto Sans KR, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.55
  metadata:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Apple SD Gothic Neo, Noto Sans KR, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.75
rounded:
  compact: "7px"
  control: "8px"
  surface: "10px"
  card: "12px"
  dialog: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "40px"
  4xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.ledger-navy}"
    textColor: "{colors.crisp-white}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.ledger-navy-hover}"
    textColor: "{colors.crisp-white}"
    rounded: "{rounded.control}"
  button-secondary:
    backgroundColor: "{colors.crisp-white}"
    textColor: "{colors.ledger-navy}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "40px"
  button-danger:
    backgroundColor: "{colors.crisp-white}"
    textColor: "{colors.danger-red}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "40px"
  field:
    backgroundColor: "{colors.crisp-white}"
    textColor: "{colors.ledger-navy}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 11px"
    height: "40px"
  nav-current:
    backgroundColor: "{colors.selection-blue}"
    textColor: "{colors.ledger-navy}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
    height: "40px"
  ledger-surface:
    backgroundColor: "{colors.surface-warm}"
    textColor: "{colors.ledger-navy}"
    rounded: "{rounded.surface}"
    padding: "16px 18px"
---

# Design System: HND Activity Ledger

## Overview

**Creative North Star: "Activity Ledger"**

HND는 설치된 개인 서버의 조용한 제품 입구다. 따뜻한 종이색 바탕, cream navigation, navy 원장 문법이 서버 상태 확인에서 패스키 설정과 작업 공간까지 한 흐름으로 이어지며, 첫 화면은 홍보 대신 지금 해야 할 한 가지 작업을 내놓는다.

시각적 성격은 차분하고 조밀하며 운영 중심이다. 정보는 떠 있는 카드 모음보다 구획선으로 나뉜 원장 행에 쌓이고, 상태·시간·다음 행동을 빠르게 교차 확인하게 한다. gradient hero, glass chrome, 짙은 sidebar, 과한 shadow 같은 AI SaaS 관습은 사용하지 않는다.

**Key Characteristics:**

- 따뜻한 paper canvas와 cream sidebar 위에 navy 텍스트와 주 동작을 둔다.
- 선택은 steel blue, 주의는 작은 burgundy, 복구 불가능한 동작만 bright red로 구분한다.
- 236px navigation과 64px header가 조용한 작업 골격을 만든다.
- 카드 모자이크 대신 divider-led list와 flat tonal depth를 사용한다.

## Colors

따뜻한 중립색이 화면 대부분을 차지하고, navy와 steel blue는 행동과 선택에만 집중된다.

### Primary

- **Ledger Navy** (`ledger-navy`, hover·pressed 변형 포함): 본문, 링크, focus, 주 버튼과 핵심 아이콘에 사용한다.

### Secondary

- **Selection Blue** (`selection-blue`): 현재 navigation, 선택된 단계와 얇은 progress처럼 명확한 선택 상태에 사용한다.
- **Paper Blue** (`selection-soft`): 작은 icon tile, 선택된 segment와 보조 정보면에만 사용한다.

### Tertiary

- **Success Green** (`success-green` / `success-soft`): 연결·저장 완료처럼 실제 성공 상태에 사용한다.
- **Warning Ochre** (`warning-ochre` / `warning-soft`): 오프라인·전송 대기처럼 주의가 필요하지만 파괴적이지 않은 상태에 사용한다.
- **Attention Burgundy** (`attention-burgundy`): 충돌과 확인 필요를 작은 제목·배지·점으로 표시한다.
- **Destructive Red** (`danger-red`, hover·soft 변형 포함): 삭제·폐기·회수처럼 되돌릴 수 없는 조작에만 사용한다.

### Neutral

- **Canvas Paper** (`canvas-paper`), **Sidebar Cream** (`sidebar-cream`), **Warm Surface** (`surface-warm`): 배경, navigation, 작업 surface의 온도 차이를 만든다.
- **Muted Ink** (`text-muted` / `text-soft`): 설명과 metadata를 낮은 위계로 유지한다.
- **Quiet Rules** (`border-quiet` / `border-strong`): 카드 그림자 대신 section과 row 경계를 만든다.
- **Code Charcoal** (`code-charcoal`): 설치·연결 명령 블록에만 쓰는 중립 dark surface다.

### Named Rules

**The Red Means Irreversible Rule.** 밝은 빨강은 삭제나 폐기처럼 되돌릴 수 없는 동작에만 쓴다. 충돌과 확인 필요는 버건디를 작은 상태 문구에만 쓰고, 해결 버튼은 네이비를 유지한다.

**The Warm Majority Rule.** 따뜻한 중립색이 항상 화면 면적의 대부분을 차지하며 navy와 blue를 큰 배경 wash로 확장하지 않는다.

## Typography

**Display Font:** HND System Sans (system UI와 한국어 OS fallback)
**Body Font:** HND System Sans (system UI와 한국어 OS fallback)
**Label/Mono Font:** HND System Sans / System Mono

**Character:** 외부 font 없이 기기 고유의 선명함을 유지하는 실용적 sans다. 400–650 weight를 중심으로 작은 크기에서도 조용한 위계와 높은 주사성을 만든다.

### Hierarchy

- **Headline** (`headline`): 로그인·설정 제목과 vault gate처럼 한 작업을 여는 제목에 사용한다.
- **Title** (`title`): view 제목과 dialog 제목에 사용한다.
- **Body** (`body`): 한국어 본문과 설명의 기본 역할이다.
- **Label** (`label`): form label, navigation, button에 사용한다.
- **Metadata** (`metadata`): 시간, 상태 보조문구, helper text에 사용하며 숫자는 tabular figures를 쓴다.
- **Mono** (`mono`): 설치 명령, 복구 코드, 기기 연결 명령에만 사용한다.

### Named Rules

**The Calm Weight Rule.** 한국어 UI는 700을 넘지 않고, 제목은 650, action과 label은 600을 기준으로 삼아 굵기만으로 소리치지 않는다.

## Layout

Desktop app과 setup은 236px cream sidebar와 64px white header를 공유한다. app content는 최대 1280px 안에서 28–32px page padding을 사용하고, setup content는 744px surface 안에 집중한다. 간격은 8px rhythm의 4, 8, 12, 16, 24, 32, 40, 48px 단계로 제한한다.

요약 수치는 하나의 surface 안에서 divider로 나뉘고, 작업·지식·설정은 개별 floating card가 아니라 row가 이어지는 ledger로 쌓인다. 인증 화면은 432px 단일 column이며 한 viewport에서 서버 문맥과 즉시 실행할 한 가지 과업을 보여 준다.

1100px에서 metric을 2열로 줄이고, 840px에서 sidebar를 drawer로 바꾸며 setup sidebar는 `n / 7` label, 단계명, 3px progress로 대체한다. 620px에서 page padding은 16px, toolbars와 forms는 한 열이 되고, 440px에서 metric은 한 열이 된다.

## Elevation & Depth

기본 깊이는 shadow가 아니라 canvas, sidebar, surface의 미세한 tonal 차이와 1px divider로 만든다. Quiet surface shadow는 큰 묶음의 경계를 겨우 분리하는 데만 쓰고, floating shadow는 dialog, toast, mobile drawer처럼 실제로 떠 있는 층에 한정한다.

### Shadow Vocabulary

- **Quiet Surface** (`0 1px 2px rgba(16, 24, 40, 0.035)`): auth/setup surface와 묶인 ledger의 낮은 경계에 사용한다.
- **Floating Layer** (`0 12px 32px rgba(16, 24, 40, 0.12)`): dialog, toast, 열린 mobile drawer에만 사용한다.
- **Neutral Backdrop** (`rgba(17, 24, 39, 0.42)`): blur 없이 modal 배경을 분리한다.

### Named Rules

**The Flat-by-Default Rule.** 정지 상태의 일반 surface와 row는 평평하게 두고, 실제 z축 변화가 없는 hover에는 lift나 translate를 추가하지 않는다.

## Shapes

Control은 절제된 8px, ledger surface는 10px, auth/setup card는 12px를 사용한다. 14px는 떠 있는 dialog만의 좁은 예외다. 내부 row는 별도 radius 없이 divider로 연결하고, capsule은 tag·status·progress처럼 짧은 값이나 진행 상태에만 허용한다.

1px quiet border가 기본 외곽선이며, 같은 위계의 surface를 중첩하거나 모든 행을 독립된 둥근 카드로 만들지 않는다.

## Brand Mark

HND 마크는 원장과 열린 페이지를 겹쳐 만든 `H` 실루엣이다. Ledger Navy 본체, Selection Blue 뒤표지, Cream 페이지의 세 색만 사용하며 로그인·설정 header와 app navigation, favicon, Apple touch icon, 설치형 웹앱 icon, Open Graph/Twitter 미리보기에 같은 원본을 사용한다.

- **Shipping asset:** `src/web/hnd-icon.png` (1254×1254 RGBA PNG)
- **Source asset:** `images/exec-5e8cecd7-890d-43f7-a9e3-1fc52d6646cc.png`
- **Provenance:** OpenAI built-in image generation, logo-brand mode; 사용자가 선택한 결과 ID `exec-5e8cecd7-890d-43f7-a9e3-1fc52d6646cc`
- **Generation brief:** 투명한 정사각형 배경 위에 H 음각을 품은 접힌 원장 페이지를 navy, steel blue, cream의 절제된 팔레트로 표현하고 작은 favicon에서도 읽히는 독립형 개발 도구 마크로 제작한다.
- **Usage:** 비율을 바꾸거나 색을 덧씌우지 않는다. UI에서는 빈 `alt`와 인접한 HND 텍스트를 함께 써 중복 낭독을 피하고, 공유 이미지에는 `HND 로고` 대체 설명을 제공한다.

## Components

### Buttons

- **Shape:** 40px 높이, 8px corner, 8px 14px padding의 조용하고 단단한 control이다.
- **Primary:** navy fill과 white text를 쓰며 hover와 active는 navy 밝기만 바꾼다.
- **Secondary:** white fill, quiet border, navy text이며 hover에서 warm surface만 더한다.
- **Danger:** bright red outline/text를 쓰고 destructive confirmation에서만 solid red hover를 허용한다.
- **Focus:** 2px navy outline과 2px offset을 유지하며 이동·lift animation은 사용하지 않는다.

### Inputs / Fields

- **Style:** 40px 높이, 8px corner, white fill, quiet 1px border와 8px 11px padding을 사용한다.
- **Focus:** navy border와 3px translucent navy ring을 동시에 보여 준다.
- **Helper / Disabled:** 12px muted helper를 field 아래에 두고 disabled는 subtle warm surface로 낮춘다.

### Navigation

- 236px cream rail의 40px row를 쓰며 default는 muted ink, hover는 translucent warm white, current는 selection blue와 navy text다.
- 840px 이하는 drawer로 전환하고 neutral scrim을 사용한다.
- Navigation은 현재 위치만 표시하고 화면 이름을 별도의 상단 제목으로 반복하지 않는다. 각 app view의 본문 PageHeader가 유일한 시각적 제목이며, 상단 utility bar는 연결 상태와 mobile menu만 담당한다.

### Ledger Surfaces & Lists

- 10px surface 하나 안에서 1px divider가 metric, activity, knowledge, setting row를 나눈다.
- 시간은 tabular metadata column, 제목과 설명은 유연한 중심 column, 상태나 action은 오른쪽 column에 둔다.
- row 자체가 독립 card처럼 떠오르거나 동일 높이 grid로 강제되지 않는다.

### Status & Attention

- 정상 서버 상태는 7px dot과 명시적 text를 plain inline으로 표시한다.
- status/tag만 작은 capsule을 허용하며 색만으로 상태를 전달하지 않는다.
- conflict panel은 burgundy 제목과 cream surface를 쓰되 해결 action은 navy를 유지한다.

### Setup Progress

- Desktop은 cream sidebar의 44px 단계 row를 사용하고 현재 단계만 blue selection으로 표시한다.
- 840px 이하는 compact `n / 7`, 단계명, 3px blue progress bar로 바뀐다.

### Dialogs

- 14px warm-white layer, floating shadow, blur 없는 neutral backdrop, 24px title을 사용한다.
- field 간격은 16px이고 footer actions는 오른쪽에 모인다. destructive accept만 danger button으로 바뀐다.

## Do's and Don'ts

### Do:

- Do 따뜻한 canvas, cream navigation, warm-white surface의 면적 우위를 유지한다.
- Do 현재 상태, 이전 기록, 다음 행동을 divider-led ledger의 한 읽기 흐름에 정렬한다.
- Do 일반 확인과 저장은 navy, 선택은 steel blue, 성공은 작은 green semantic state로 표시한다.
- Do mobile setup에서 `n / 7`, 단계명, 3px progress를 함께 보여 준다.

### Don't:

- Don't bright red를 일반 primary action, navigation, link, conflict 해결 버튼에 사용한다.
- Don't gradient hero, glass header, dark sidebar, hover lift, 과한 shadow를 추가한다.
- Don't 모든 콘텐츠를 둥근 카드, pill, icon tile 또는 동일 높이 3열 grid로 감싼다.
- Don't 상태를 색 하나로만 전달하거나 장식용 status dot과 uppercase kicker를 반복한다.
