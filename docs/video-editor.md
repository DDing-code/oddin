# ODDIN 영상 편집기

2026-10-10 사용자 요구: "오딘에 딱 맞는 영상편집 툴을 만들거야 프리미어/애프터이펙트 분석해주고 오딘에 맞게 바꿔줘 나는 간단한 싱크 수정/디자인/모션 수정 정도 할 거 같아".
분석·설계: `replica/recon.md`(프리미어·AE 화면·흐름·사용자 기준), `replica/features.csv`(기능 표 — `python <스킬>/replica-diff/parity.py replica/features.csv`로 점수), `replica/architecture.md`.

## 무엇인가

AI 작업자가 1차 편집을 만들고, 사용자는 ODDIN 화면(집·회사·원격·폰)에서 **싱크·디자인·모션**을 손본 뒤 MP4로 뽑는 편집기. 편집 하나 = 원본 옆 **`<이름>.oddin-edit.json` 파일 하나**(형식은 `replica/architecture.md`·공유 스킬 `oddin-video`). AI와 사용자가 같은 파일을 고친다 — 편집기는 2초마다 파일을 확인해 바뀌면 다시 읽고, 사용자의 변경은 0.7초 뒤 자동 저장한다(그 사이 다른 곳이 바꿨으면 409 → "다시 읽기 / 내 것으로 덮기").

## 여는 곳

- 경로 오른쪽 클릭(폰은 길게 누르기): 편집 파일 → **영상 편집기로 열기**, 영상 파일 → **이 영상으로 편집 만들기**(같은 이름 `.srt`/`.ko.srt`가 있으면 자막 트랙으로, 같은 이름 편집 파일이 있으면 그것을 연다). 확장 지점 `window.hubPathItems`(`tools-ui.js` pathMenu).
- 작업 카드: 결과에 `*.oddin-edit.json` 경로가 있으면 "영상 편집기로 열기"(그 세션으로 AI 부탁이 이어짐).
- 검색 팔레트(Ctrl+K): "영상 편집기 · 최근 편집 열기", "경로로 열기…".
- 코드: `window.hubVideo.open(path, { sessionId })`, `hubVideo.create(videoPath)`, 시험·자동화용 `hubVideo.cmd`(select·seek·play·splitAt·setEdge·nudge·snapOnset·undo…).

## 화면

- **미리보기**: 원본 `<video>`를 그대로(원본마다 A/B 두 개를 번갈아 다음 컷을 미리 감아 둠 → 컷 경계 끊김 줄임) + 글자 레이어(`video-core.js renderOverlay` — 렌더와 같은 그리기). 레이어·영상을 눌러 고르고 끌어 옮김(가운데에 자석). 안전 영역·가운데 안내선. 재생 시계는 소리 나는 원본(없으면 시스템 시계).
- **타임라인**: 트랙(영상·소리·자막), 막대 끌기(옮기기)·가장자리 끌기(자르기, 원본 범위를 넘지 않음), 자석(재생 헤드·다른 가장자리·마커·0), 리플(뒤 것이 따라옴), **자막 붙여 두기**(맞닿은 자막 경계를 같이 움직임 — 리플 중엔 꺼짐), 썸네일 띠·파형(보이는 부분만 캔버스), 마커(두 번 눌러 지우기), 트랙 소리 끄기·숨기기·잠그기·이름 바꾸기(두 번), 트랙 더하기. Ctrl+휠 확대(사용자가 확대하기 전까지는 창 너비에 맞춰 전체가 보이게).
- **속성**: 아무것도 안 고르면 편집 전체(제목·배경색·**자막 점검**: 1초 미만 빈칸 "모두 붙이기"·겹침 "모두 고치기"·한 줄 넘침·이 PC에 없는 글꼴). 자막을 고르면 글·시간(타임코드 입력, [ ] 단추, **발화 시작에 맞추기**)·글자 모양(스타일 선택·"스타일 전체에 / 이 자막만"·글꼴(이 PC 윈도에 등록된 글꼴 목록 `/api/video/fonts`)·크기·두께·색·그라디언트·테두리·그림자·배경 상자·자간·행간·정렬·한 줄 고정·스타일 복사/붙여넣기)·등장/퇴장(프레임)·위치·크기·회전·불투명도(◆ 키프레임, ‹ › 이전/다음 키, 이 키 다음 움직임 = 이징 7종). 영상 클립은 원본 구간·음량 dB·소리 페이드(프레임)·화면 맞춤(꽉 채우기/다 보이게)·변형·**펀치 인/아웃**(6프레임 쫀득 확대). 숫자 이름을 좌우로 끌면 값이 바뀐다(Shift 10배).
- **위쪽**: 저장 상태, 되돌리기/다시(200단계), **AI에게**(고른 것 id·재생 헤드 시각을 붙여 세션에 요청 — 그 세션이 작업 중이면 예약), SRT 받기, **렌더**(진행률·중지·결과 보기), 닫기.
- 단축키: Space 재생 · ←→ 1프레임(Shift 10) · Alt+←→ 고른 것 밀기 · , . 고른 것 1프레임 밀기 · S 자르기 · [ ] 시작/끝을 재생 헤드로 · Q W 리플로 · Delete(Shift = 빈칸 닫기) · T 글자 · M 마커 · J K L · Ctrl+Z/Y · Ctrl+S · Esc.
- 화면이 새 버전으로 바뀌어도 편집기가 열려 있으면 조용히 새로고침하지 않는다(`ui-refresh.js` busy).

## 서버 (`lib/video-edit.mjs`, `server.mjs` `/api/video/*`)

| 경로 | 하는 일 |
| --- | --- |
| GET `/api/video/edit?path=` · `/mtime` | 읽기(정리·고친 점 `problems`) · 수정 시각 |
| PUT `/api/video/edit {path, doc, baseMtime, force}` | 저장(원자적, 이름이 `.oddin-edit.json`이어야, 바뀌었으면 409 `CHANGED`) |
| POST `/api/video/new {video}` | 영상으로 새 편집 |
| GET `/api/video/probe`·`/peaks`(초당 100개, base64)·`/thumbs`(`&meta=1` 간격·칸 크기) | 원본 정보·파형·썸네일 띠(`data/video-cache/`) |
| GET `/api/video/fonts` | 이 PC 윈도 레지스트리에 등록된 글꼴(가족 이름·한글 이름) |
| GET `/api/video/srt?path=` | 자막 SRT |
| POST `/api/video/render {path}` · `/render/:id/cancel` · GET `/renders` | 렌더(실시간 `video_render` 이벤트) |

경로 범위는 `/api/file`과 같다(아는 폴더, 권한 "모든 폴더"면 전체). 저장·새로 만들기·렌더는 제어 기능(`hub-auth.isControl` — 원격은 ODDIN 화면에서만).

### 렌더

1. 모든 클립 경계(프레임에 붙임)로 시간 조각을 나눈다. 조각마다 ffmpeg 하나: 그 시각 보이는 영상 클립(`-ss` 정확한 자르기) → `fps` → 확대 전 고정 크기 `scale` → `format=rgba` → (회전 `rotate` 고정 크기) → (불투명도) → **크기가 바뀌는 `scale ... eval=frame`은 맨 끝**(ffmpeg 시험: 뒤에 다른 필터가 오면 첫 크기로 굳는다) → `overlay x='W/2+X(t)-w/2'`. 소리: 클립마다 `volume`·`afade`·`apad/atrim` → `amix(normalize=0)`. 조각은 H.264(crf 12)+PCM mkv. 동시에 `config.video.parallel`(기본 3)개.
2. 조각을 concat 으로 잇고, 글자 레이어가 있으면 ODDIN 브라우저 탭(화면 크기, 투명 배경)이 `video-render.html`로 프레임마다 그린 PNG(서명이 같으면 앞 그림 재사용)를 `image2pipe`로 받아 맨 위에 합성 → libx264(`config.video.crf` 18, `preset` medium)+AAC 192k, `+faststart`. 결과는 편집 파일 옆 `<이름>.mp4`(있으면 `<이름> (2).mp4`).
3. 키프레임 이징은 JS(`video-core.js EASE`)와 ffmpeg 식(`EASE_EXPR`·`keyExpr`)이 같은 공식 — 시험이 값을 대조한다.
4. 글꼴이 이 PC에 없으면 렌더는 하되 경고를 남긴다(`warnings`).

## 작업자 AI

공유 스킬 `oddin-video`(형식·사용자 기준) + `node scripts/video.mjs new|check|srt|import-srt|render <파일> [--wait]`.

## 한계(다음 단계)

- 원본을 화면에서 트랙에 끌어 넣기, 키프레임 마름모 끌기, 크기 손잡이, 값 그래프는 아직 없다(AI·숫자로).
- 열린 프리미어 시퀀스 가져오기·프리미어 XML 내보내기는 아직 — 지금은 SRT로 주고받는다.
- 영상 클립 불투명도 키프레임은 렌더하지 않는다(고정값만).
- 다른 PC 세션의 파일은 그 PC의 ODDIN에서 연다(편집 API는 연결된 PC로 넘기지 않음).
- 미리보기는 브라우저가 원본을 그대로 재생하므로 브라우저가 못 여는 코덱(예: 일부 HEVC·ProRes)은 미리보기가 안 될 수 있다(렌더는 ffmpeg라 됨).

## 시험

`tests/video-edit.test.mjs`: 이징 JS=ffmpeg 식, 키프레임 식 대조(조각 이동 포함), 정리, 등장/퇴장, SRT, 문지기, 글꼴 목록, 서버(새 편집·SRT 자막·저장 충돌 409·파형·렌더 120프레임+소리·임시 폴더 정리).
