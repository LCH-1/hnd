---
name: "HND Muted Cobalt"
description: "채도를 낮춘 코발트 하나로 행동을 표시하고, 상태색 다섯 개는 형광기를 뺀 채 유지하는 HND 작업 UI"
colors:
  canvas: "#F8FAFC"
  surface: "#FFFFFF"
  chip: "#F1F5F9"
  surface-hover: "#E9EEF5"
  ink: "#0F172A"
  ink-strong: "#0B1220"
  text-muted: "#475569"
  text-soft: "#7C899C"
  border-quiet: "#DFE5EC"
  border-strong: "#C3CCD8"
  accent: "#3763CE"
  accent-strong: "#2B4C9E"
  accent-pressed: "#243F83"
  accent-soft: "#EAF0FB"
  accent-ink: "#2B4C9E"
  accent-on: "#FFFFFF"
  success: "#197D5F"
  success-soft: "#E9F4EF"
  warning: "#A15A18"
  warning-soft: "#F8F0E4"
  progress: "#7150C4"
  progress-soft: "#F0ECFA"
  danger: "#C4323D"
  danger-hover: "#A82A34"
  danger-soft: "#FBECEC"
  tag-bg: "#EEF1F5"
  tag-ink: "#52607A"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Apple SD Gothic Neo, Noto Sans KR, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "-0.028em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Apple SD Gothic Neo, Noto Sans KR, sans-serif"
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  metric:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Apple SD Gothic Neo, Noto Sans KR, sans-serif"
    fontSize: "25px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.03em"
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
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
  badge:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Apple SD Gothic Neo, Noto Sans KR, sans-serif"
    fontSize: "11px"
    fontWeight: 650
    lineHeight: 1.4
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.75
rounded:
  badge: "5px"
  control: "6px"
  card: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "40px"
  4xl: "48px"
elevation:
  resting: "0 1px 2px rgba(15, 23, 42, 0.05)"
  floating: "0 12px 30px -14px rgba(15, 23, 42, 0.3)"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-on}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    borderColor: "{colors.border-quiet}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "40px"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "40px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    borderColor: "{colors.border-quiet}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 11px"
    height: "40px"
  nav-current:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "7px 11px"
  card:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border-quiet}"
    rounded: "{rounded.card}"
    padding: "15px 16px"
    shadow: "{elevation.resting}"
  status-badge:
    backgroundColor: "{colors.chip}"
    textColor: "{colors.text-muted}"
    typography: "{typography.badge}"
    rounded: "{rounded.badge}"
    padding: "4px 10px"
  tag:
    backgroundColor: "{colors.tag-bg}"
    textColor: "{colors.tag-ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.badge}"
    padding: "3px 9px"
---

# Design System: HND Muted Cobalt

## Overview

**Creative North Star: "Muted Cobalt"**

HND는 설치된 개인 서버의 조용한 제품 입구다. 서늘한 중립 바탕에 중립 먹 텍스트를 두고,
행동에는 채도를 낮춘 코발트 하나만 쓴다. 서버 상태 확인에서 패스키 설정과 작업 공간까지
한 흐름으로 이어지며, 첫 화면은 홍보 대신 지금 해야 할 한 가지 작업을 내놓는다.

시각적 성격은 차분하고 조밀하며 운영 중심이다. 정보는 떠 있는 카드 모음보다 헤어라인으로
나뉜 밀집 표에 쌓이고, 상태·시간·다음 행동을 빠르게 교차 확인하게 한다. gradient hero,
glass chrome, 짙은 sidebar, 과한 shadow, 알약 배지 같은 관습은 사용하지 않는다.

**Key Characteristics:**

- 서늘한 중립 canvas 위에 흰 surface와 1px 헤어라인으로 구획한다.
- 강조는 코발트 하나뿐이다. 주 동작, 현재 위치, focus, 차트가 같은 파랑을 쓴다.
- 상태색 다섯 개를 모두 유지하되 형광기를 뺀다. 색을 없애지 않고 채도만 낮춘다.
- 분류(저장소·유형 태그)에는 색을 쓰지 않는다. 색은 상태에만 쓴다.
- 모서리는 카드 8px, 컨트롤 6px, 배지 5px로 조인다. 알약을 쓰지 않는다.

## Colors

중립색이 화면 대부분을 차지하고, 코발트는 행동과 선택에만 집중된다. 상태색은 각자
고유한 색상을 지키되 채도를 낮춰 표 안에서 튀지 않는다.

### Primary

- **Accent Cobalt** (`accent`, strong·pressed·soft·ink 변형 포함): 주 버튼, 링크, 현재
  navigation, focus ring, 진행 막대, 차트에 사용한다. 화면에서 파랑은 이 하나뿐이다.

### Semantic

다섯 상태는 모두 자기 색을 가진다. 배경은 각 색의 옅은 tint, 텍스트는 같은 계열의 짙은 값이다.

- **Success** (`success` / `success-soft`): 저장 완료, 연결됨, 활성 기기.
- **Progress** (`progress` / `progress-soft`): 진행 중, 추가·수정처럼 아직 끝나지 않은 변경.
- **Warning** (`warning` / `warning-soft`): 오프라인·전송 대기처럼 주의가 필요하지만 파괴적이지 않은 상태.
- **Danger** (`danger` / `danger-soft`): 충돌, 확인 필요, 삭제·폐기·회수처럼 되돌릴 수 없는 조작.
- **Neutral** (`chip` / `text-muted`): 보류, 취소, 값 없음처럼 의미가 비어 있는 상태.

### Neutral

- **Canvas** (`canvas`), **Surface** (`surface`), **Chip** (`chip`): 배경, 카드, 눌린 면의 세 단계를 만든다.
- **Muted Ink** (`text-muted` / `text-soft`): 설명과 metadata를 낮은 위계로 유지한다.
- **Quiet Rules** (`border-quiet` / `border-strong`): 카드 그림자 대신 section과 row 경계를 만든다.
- **Tag** (`tag-bg` / `tag-ink`): 저장소와 유형처럼 상태가 아닌 분류에 쓰는 무채색 칩이다.

### Named Rules

**The Single Accent Rule.** 파랑은 코발트 하나뿐이다. 주 동작, 현재 위치, focus, 차트가
같은 값을 쓰고, 다른 파랑 계열을 추가하지 않는다.

**The Muted Semantics Rule.** 상태색은 없애지 않고 채도만 낮춘다. 초록·보라·황토·빨강은
각자 남되 형광으로 튀지 않는다. 어느 상태도 회색으로 통일하지 않는다.

**The Classification Has No Color Rule.** 저장소 이름, 지식 유형처럼 상태가 아닌 분류에는
색을 쓰지 않는다. 무채색 칩만 쓴다. 표에 색 있는 칩이 늘어서는 것을 막는 규칙이다.

**The Red Means Irreversible Rule.** 빨강은 충돌·확인 필요와, 삭제·폐기처럼 되돌릴 수 없는
동작에만 쓴다. 개수 링크나 일반 navigation에는 쓰지 않는다.

**The Never Color Alone Rule.** 모든 status badge는 점과 텍스트 라벨을 함께 쓴다.
색만으로 상태를 전달하지 않는다.

## Typography

**Display / Body / Label Font:** HND System Sans (system UI와 한국어 OS fallback)
**Mono Font:** System Mono

**Character:** 외부 font 없이 기기 고유의 선명함을 유지하는 실용적 sans다. 400–700 weight를
쓰며, 지표 숫자는 700에 -0.03em 자간으로 조여 밀도를 만든다.

### Hierarchy

- **Headline** (`headline`): 로그인·설정 제목과 vault gate처럼 한 작업을 여는 제목에 사용한다.
- **Title** (`title`): view 제목과 dialog 제목에 사용한다.
- **Metric** (`metric`): 지표 카드의 큰 숫자에 사용하며 tabular figures를 쓴다.
- **Body** (`body`): 한국어 본문과 설명의 기본 역할이다.
- **Label** (`label`): form label, navigation, button에 사용한다.
- **Metadata** (`metadata`): 시간, 상태 보조문구, helper text에 사용하며 숫자는 tabular figures를 쓴다.
- **Badge** (`badge`): status badge와 tag에 사용한다.
- **Mono** (`mono`): 설치 명령, 복구 코드, 기기 연결 명령에만 사용한다.

### Named Rules

**The Calm Weight Rule.** 한국어 본문은 굵기로 소리치지 않는다. 제목은 650–700, action과
label은 600을 기준으로 삼고, 강조는 굵기보다 색과 배치로 만든다.

## Layout

Desktop app과 setup은 236px sidebar와 64px header를 공유한다. app content는 최대 1280px
안에서 28–32px page padding을 사용하고, setup content는 744px surface 안에 집중한다.
간격은 8px rhythm의 4, 8, 12, 16, 24, 32, 40, 48px 단계로 제한한다.

지표는 4개의 독립 카드가 14px gap으로 늘어서고, 각 카드는 icon chip, 라벨, 큰 숫자,
보조 칩을 세로로 쌓는다. 활동 기록은 `시각 / 항목 / 분류 / 상태` 네 열의 밀집 행으로
쌓이고, 지식은 icon chip과 제목·요약의 두 열로 쌓인다.

1100px에서 metric을 2열로 줄이고, 840px에서 sidebar를 drawer로 바꾸며 setup sidebar는
`n / 7` label, 단계명, 3px progress로 대체한다. 620px에서 page padding은 16px, toolbars와
forms는 한 열이 되고, 440px에서 metric은 한 열이 된다.

## Elevation & Depth

기본 깊이는 1px 헤어라인과 아주 얕은 resting shadow가 만든다. floating shadow는 dialog,
toast, mobile drawer처럼 실제로 떠 있는 층에 한정한다.

### Shadow Vocabulary

- **Resting** (`0 1px 2px rgba(15, 23, 42, 0.05)`): 카드, 지표, panel의 기본 깊이다.
- **Floating** (`0 12px 30px -14px rgba(15, 23, 42, 0.3)`): dialog, toast, 열린 mobile drawer에만 사용한다.
- **Neutral Backdrop** (`rgba(17, 24, 39, 0.42)`): blur 없이 modal 배경을 분리한다.

### Named Rules

**The Flat-by-Default Rule.** 정지 상태의 일반 surface와 row는 평평하게 두고, 실제 z축 변화가
없는 hover에는 lift나 translate를 추가하지 않는다. 주 버튼에도 색 glow를 넣지 않는다.

## Shapes

카드와 panel은 8px, control은 6px, badge와 tag는 5px를 쓴다. **알약(999px)을 쓰지 않는다** —
상태 배지, 분류 태그, segmented control, 이니셜 칩이 모두 같은 5–6px 대역에 있다.
아바타도 원형 대신 6px 사각 라운드를 쓴다.

1px quiet border가 기본 외곽선이며, 같은 위계의 surface를 중첩하지 않는다.

## Brand Mark

HND 마크는 원장과 열린 페이지를 겹쳐 만든 `H` 실루엣이다. 로그인·설정 header와 app
navigation, favicon, Apple touch icon, 설치형 웹앱 icon, Open Graph/Twitter 미리보기에
같은 원본을 사용한다.

- **Shipping asset:** `src/web/hnd-icon.png` (1254×1254 RGBA PNG)
- **Source asset:** `images/exec-5e8cecd7-890d-43f7-a9e3-1fc52d6646cc.png`
- **Provenance:** OpenAI built-in image generation, logo-brand mode; 사용자가 선택한 결과 ID `exec-5e8cecd7-890d-43f7-a9e3-1fc52d6646cc`
- **Usage:** 비율을 바꾸거나 색을 덧씌우지 않는다. UI에서는 빈 `alt`와 인접한 HND 텍스트를 함께 써 중복 낭독을 피하고, 공유 이미지에는 `HND 로고` 대체 설명을 제공한다.
- **Open follow-up:** 마크의 navy·steel blue·cream 3색은 이전 팔레트에서 나왔다. 새 중립
  bg 위에서 읽히기는 하지만 accent와 계열이 다르다. 코발트 계열 1도 변형을 만들지는
  아직 정하지 않았다.

## Components

### Buttons

- **Shape:** 40px 높이, 6px corner, 8px 14px padding의 조용하고 단단한 control이다.
- **Primary:** accent fill과 white text를 쓰며 hover와 active는 accent 밝기만 바꾼다. glow shadow를 쓰지 않는다.
- **Secondary:** white fill, quiet border, ink text이며 hover에서 chip 배경만 더한다.
- **Danger:** danger text와 quiet border를 쓰고 destructive confirmation에서만 solid fill을 허용한다.
- **Focus:** 2px accent outline과 2px offset을 유지하며 이동·lift animation은 사용하지 않는다.

### Inputs / Fields

- **Style:** 40px 높이, 6px corner, white fill, quiet 1px border와 8px 11px padding을 사용한다.
- **Focus:** accent border와 3px translucent accent ring을 동시에 보여 준다.
- **Helper / Disabled:** 12px muted helper를 field 아래에 두고 disabled는 chip 배경으로 낮춘다.

### Navigation

- 236px white rail의 row를 쓰며 default는 muted ink, hover는 chip 배경, current는 accent-soft 배경과 accent ink다.
- 840px 이하는 drawer로 전환하고 neutral scrim을 사용한다.
- Navigation은 현재 위치만 표시하고 화면 이름을 별도의 상단 제목으로 반복하지 않는다.

### Metric Cards

- 4개의 독립 카드가 14px gap으로 늘어선다. 하나의 묶음 surface를 열로 나누지 않는다.
- 각 카드는 32px accent-soft icon chip과 라벨을 한 줄에 두고, 그 아래 25px 숫자, 그 아래 chip 배경의 보조 문구를 쌓는다.
- 숫자는 tabular figures를 쓴다.

### Ledger Rows

- 활동 행은 `시각 / 항목 / 분류 tag / 상태 badge` 네 열이며 1px 헤어라인으로 나뉜다.
- 지식 행은 `유형 chip / 제목 + 요약` 두 열이다.
- row 자체가 독립 card처럼 떠오르거나 동일 높이 grid로 강제되지 않는다.

### Status & Attention

- status badge는 5px corner, chip 배경, 6px 점과 텍스트 라벨을 함께 쓴다.
- 저장 완료는 success, 진행 중은 progress, 전송 대기는 warning, 충돌은 danger, 보류는 neutral이다.
- 확인할 항목의 개수 링크는 상태가 아니라 이동이므로 무채색 칩을 쓰고 hover에서만 accent가 된다.

### Dialogs

- 8px white layer, floating shadow, blur 없는 neutral backdrop, 24px title을 사용한다.
- field 간격은 16px이고 footer actions는 오른쪽에 모인다. destructive accept만 danger button으로 바뀐다.

## Do's and Don'ts

### Do:

- Do 중립 canvas와 흰 surface의 면적 우위를 유지하고 강조는 코발트 하나로만 준다.
- Do 상태색 다섯 개를 모두 살리되 채도를 낮춰 표에서 튀지 않게 한다.
- Do 저장소·유형처럼 상태가 아닌 분류에는 무채색 칩을 쓴다.
- Do 모든 status badge에 점과 텍스트를 함께 붙인다.
- Do 숫자에 tabular figures를 쓴다.

### Don't:

- Don't 알약(999px) 모서리를 쓴다. 배지와 태그는 5px다.
- Don't 파랑을 하나 더 추가하거나 주 버튼에 색 glow를 넣는다.
- Don't 상태색을 회색으로 통일해 색을 없앤다.
- Don't 빨강을 개수 링크, 일반 navigation, 비파괴적 확인 버튼에 쓴다.
- Don't gradient hero, glass header, dark sidebar, hover lift, 과한 shadow를 추가한다.
