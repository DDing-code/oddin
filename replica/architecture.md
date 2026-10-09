# 설계: ODDIN 영상 편집기 (프리미어·AE의 싱크·디자인·모션 수정 부분을 ODDIN 안에 새로 짠 것)

근거: `replica/recon.md`, `replica/features.csv` · 2026-10-10

## 스택 (ODDIN 그대로)

| 층 | 고른 것 | 왜 |
| --- | --- | --- |
| 화면 | ODDIN `public/` 순수 JS·CSS (`video-core.js` 공용, `video-editor.js`, `video-editor.css`) | 허브는 의존성 없음이 규칙. 원격·폰에서도 같은 화면 |
| 서버 | `lib/video-edit.mjs` + `server.mjs` 경로 | 파일 읽기·쓰기 범위(`file-access`), 원격 제어 관문(`hub-auth`)을 그대로 씀 |
| 저장 | 편집 파일 `*.oddin-edit.json` (DB 없음) | AI 작업자가 그대로 읽고 고침. 원본 영상 옆에 둠 |
| 미리보기 | 브라우저 `<video>`(원본 그대로, 컷마다 A/B 두 개로 끊김 줄임) + 글자·도형은 DOM | 따로 인코딩하지 않아 바로 열림 |
| 렌더 | ffmpeg 8(이 PC 설치됨): 컷·확대·위치·소리 / ODDIN 브라우저(Edge 헤드리스): 글자·자막 레이어를 투명 PNG로 → ffmpeg 위에 합성 | 글자는 미리보기와 **같은 코드**로 그려 WYSIWYG, 영상 화질은 ffmpeg 그대로 |
| 파형·썸네일 | ffmpeg로 뽑아 `data/video-cache/`에 보관 | 원본이 바뀌면(크기·수정 시각) 다시 |
| AI | 공유 스킬 `oddin-video`(형식 설명) + 편집기 "AI에게" → 세션에 요청(진행 중이면 예약) | 사용자는 화면에서, AI는 파일로 같은 편집을 고침 |

## 편집 파일 형식 (v1)

```jsonc
{
  "oddinEdit": 1,                       // 형식 판
  "title": "먹방 3편",
  "width": 1080, "height": 1920, "fps": 30, "background": "#000000",
  "media": {                            // 원본. path 는 절대 경로 또는 이 파일 기준 상대 경로
    "m1": { "path": "raw.mp4", "duration": 742.5, "width": 1920, "height": 1080, "fps": 29.97, "audio": true }
  },
  "styles": {                           // 여러 자막이 같이 쓰는 글자 모양(역할별)
    "자막": { "font": "Pretendard", "size": 64, "weight": 800, "color": "#ffffff", "gradient": null,
              "stroke": { "color": "#000000", "width": 8 }, "shadow": { "x": 0, "y": 4, "blur": 12, "color": "#00000099" },
              "bg": null, "align": "center", "lineHeight": 1.2, "letterSpacing": 0, "maxWidth": 960, "oneLine": true }
  },
  "tracks": [                           // 아래 트랙이 먼저(뒤에) 그려진다
    { "id": "v1", "kind": "video", "name": "영상", "muted": false, "hidden": false,
      "clips": [ { "id": "c1", "media": "m1", "start": 0, "in": 12.3, "out": 20.0,      // 시퀀스 시각 start, 원본 구간 in~out
                   "volume": 0, "fadeIn": 0, "fadeOut": 0.05,                          // 소리 dB, 소리 페이드(초)
                   "fit": "cover", "x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1,
                   "keys": { "scale": [ { "t": 0, "v": 1, "ease": "snap" }, { "t": 0.3, "v": 1.25 } ] } } ] },
    { "id": "a1", "kind": "audio", "name": "배경음", "clips": [ { "id": "c2", "media": "m2", "start": 0, "in": 0, "out": 30, "volume": -14 } ] },
    { "id": "t1", "kind": "text", "name": "자막", "style": "자막",
      "items": [ { "id": "x1", "start": 1.0, "end": 2.4, "text": "안녕하세요",
                   "style": null, "override": {},                                       // 트랙 스타일 대신·덮어쓸 것
                   "x": 0, "y": 700, "scale": 1, "rotation": 0, "opacity": 1,          // 화면 가운데 기준 픽셀
                   "anim": { "in": "pop", "out": "fade", "inDur": 0.2, "outDur": 0.15 },
                   "keys": {} } ] }
  ],
  "markers": [ { "id": "k1", "t": 3.2, "label": "비트" } ]
}
```

- 시각은 모두 **초**(소수). 편집기는 프레임(1/fps)에 붙여 고친다. 키프레임 `t`는 **그 클립·자막의 시작 기준**(옮기면 키도 같이 움직임).
- 위치 `x`·`y`는 **화면 가운데 기준 픽셀**(세로·가로 화면 모두 같은 감각). 영상 클립은 `fit`(cover|contain)으로 맞춘 크기에 `scale`.
- 이징(키에서 다음 키까지): `linear` · `ease`(부드럽게) · `in` · `out` · `hold`(정지) · `snap`(쫀득: 살짝 넘쳤다 돌아옴) · `expo`(빠르게 붙음). 미리보기(JS)와 렌더(ffmpeg 식)가 **같은 공식**을 쓴다.
- 등장·퇴장 효과(`anim.in`/`out`): `none` `fade` `pop` `slideUp` `slideDown` `slideLeft` `slideRight` `zoom` — 키프레임 위에 곱해 적용.
- 영상 클립의 `opacity` 키프레임은 첫 판에서 렌더하지 않는다(고정값만).

## API (`server.mjs` → `lib/video-edit.mjs`)

| 경로 | 하는 일 | 누가 | 입력 | 출력 | 흐름 |
| --- | --- | --- | --- | --- | --- |
| GET `/api/video/edit?path=` | 편집 파일 읽기(정리·검사) | 화면 | 경로 | `{ doc, mtime, path, problems }` | 모두 |
| PUT `/api/video/edit` | 저장(원자적), 그 사이 바뀌었으면 409 | 화면(원격은 화면 쿠키) | `{ path, doc, baseMtime }` | `{ mtime }` | 모두 |
| POST `/api/video/new` | 영상으로 새 편집(같은 이름 SRT → 자막) | 화면 | `{ video, out? }` | `{ path }` | F01 시작 |
| GET `/api/video/probe?path=` | 원본 정보(길이·크기·fps·소리·회전) | 화면 | 경로 | 정보 | 가져오기 |
| GET `/api/video/peaks?path=` | 파형(초당 100개) | 화면 | 경로 | `{ rate, peaks(base64 Int8) }` | F01 F02 F04 |
| GET `/api/video/thumbs?path=` | 썸네일 띠(JPEG 한 장) | 화면 | 경로 | 이미지 + 머리(간격·칸 너비) | F02 F03 |
| POST `/api/video/render` | 렌더 시작 | 화면(원격은 화면 쿠키) | `{ path, out? }` | `{ id, out }` | F10 |
| POST `/api/video/render/:id/cancel` | 렌더 중지 | 화면 | — | — | F10 |
| GET `/api/video/renders` | 렌더 목록·진행 | 화면 | — | 목록 | F10 |
| GET `/api/video/srt?path=&track=` | 자막 SRT 내보내기 | 화면 | 경로 | SRT | F10 |
| 실시간 `video_render` | 진행률·완료·실패 | 서버 | — | `{ id, progress, status, out, error }` | F10 |

경로 검사는 `/api/file`과 같은 범위(아는 폴더, 권한 "모든 폴더"면 전체). 저장은 `.oddin-edit.json`만. 렌더 결과는 편집 파일 옆 `<이름>.mp4`(있으면 `<이름> (2).mp4`).

## 렌더

1. 길이 D = 모든 클립·자막 끝의 최댓값, 프레임 수 = ceil(D×fps).
2. ffmpeg `filter_complex`: 배경색 캔버스 → 영상 클립마다 `-ss in -t 길이 -i 원본` → `setpts`로 시퀀스 시각에 → `scale`(키가 있으면 `eval=frame`·시각 식) → (회전이 있으면 `rotate`) → `overlay=x='W/2+X(t)-w/2':y=…:enable='between(t,s,e)'`.
3. 글자·자막: ODDIN 브라우저 탭(화면 크기 W×H, 투명 배경)에서 `video-render.html`이 `video-core.js`로 그 프레임을 그림 → 바뀐 프레임만 PNG로 찍고 같은 프레임은 앞 그림을 다시 보냄 → `image2pipe`로 ffmpeg에 → 맨 위에 합성.
4. 소리: 클립마다 `volume`(dB)·`afade`·`adelay` → `amix(normalize=0)` → 길이 D.
5. `libx264 -crf 18 -preset veryfast -pix_fmt yuv420p` + `aac 192k`, `+faststart`.

## 아픈 곳

- **미리보기 = 렌더**: 글자는 같은 DOM 코드로 그려 맞춘다. 영상 확대·위치는 같은 식(가운데 기준·fit 크기×scale)을 JS와 ffmpeg 식에 두 번 쓴다 → 시험으로 숫자를 대조한다.
- **이징 공식 두 벌**: JS 함수와 ffmpeg 식 문자열을 한 표에서 만든다(`video-edit.mjs`의 `EASE_EXPR`와 `video-core.js`의 `EASE`), 시험이 같은 값인지 본다.
- **컷 경계 재생**: 같은 원본의 컷이 이어지면 한 `<video>`가 되감아야 해서 끊긴다 → 원본마다 A/B 두 개를 번갈아 미리 감아 둔다.
- **폰트**: 렌더 브라우저와 미리보기 브라우저가 같은 PC 폰트를 써야 한다. 편집기가 `document.fonts.check`로 대체를 알리고, 렌더도 그리기 전에 확인해 없으면 실패 대신 경고를 남긴다.
- **긴 영상**: 파형은 초당 100개, 썸네일은 길이에 맞춰 간격을 늘린다. 렌더는 바뀐 글자 프레임만 찍어 빠르게.
- **동시 수정**: AI가 파일을 고치는 사이 화면도 고치면 → 저장 때 `baseMtime`이 다르면 409, 화면이 "다시 읽기/내 것으로 덮기"를 묻는다.
- **원격**: 미디어는 `/api/file`(범위 요청)로 흘려보낸다. 저장·렌더는 제어 기능(원격은 ODDIN 화면 쿠키만).

## 만드는 순서

1. **세로 한 줄(지금)**: 영상으로 새 편집 → 편집기 열기 → 재생·자막 보기 → 자막 시작/끝 고치기 → 저장 → 렌더 MP4. (S02·S03·S07·S12 / `edit`·`new`·`render`)
2. **반드시**: 트림·이동·자르기·리플 지우기·밀기·스냅·파형·되돌리기, 스타일·변형·키프레임·이징·등장/퇴장, SRT 내보내기.
3. **하면 좋음**: 붙여 두기·발화 시작에 맞추기·한 줄 넘침/폰트 대체 경고·AI에게·썸네일·음량·페이드.
4. **다음**: 열린 프리미어 시퀀스 가져오기, 프리미어 XML, 값 그래프.
