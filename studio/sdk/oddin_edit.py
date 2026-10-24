"""ODDIN 스튜디오 편집 파일(*.oddin-edit.json) 짜기 — 파이썬 빌드 스크립트용 (의존성 없음, ffprobe 만)

2026-10-24 사용자 "AI가 편집기로 조립하는 게 이상적 — 없는 기능은 더 추가해줘":
예전에는 빌드 스크립트가 글자·화살표·페이드까지 프레임에 다 그려 넣고, 효과음·음악도 미리 섞어서 편집기에서 고칠 게 없었다.
이 도우미로 **그림은 장면별 재료 영상**만 만들고, 글자·자막·효과음·음악·확대/이동·전환은 편집 파일 안에 따로 둔다.
최종 영상은 `node <ODDIN>/studio/cli.mjs render <편집> --wait` 로 뽑고 `verify <영상> --strict` 로 확인한다.

    import sys; sys.path.insert(0, r"<ODDIN 폴더>/studio/sdk")
    from oddin_edit import Edit

    e = Edit("키식스 공략", 1920, 1080, fps=30)
    e.style("해설", font="Galmuri11", size=44, color="#ffffff", stroke={"color": "#000000", "width": 6})
    arena = e.media("seg/arena-01.mp4", source="python build.py --layer arena --seg 1")   # 재료 영상(글자 없이)
    pic = e.track("video", "그림")
    c = e.clip(pic, arena, start=0, label="1페이즈", vfade_in=0.3)
    e.key(c, "scale", 0, 1.0, "snap"); e.key(c, "scale", 0.2, 1.12, "hold")              # 펀치 인
    cap = e.track("text", "해설", style="해설")
    e.text(cap, 1.0, 3.2, "전원 산개!", y=380, anim_in="pop", anim_out="fade")
    sfx = e.track("audio", "효과음")
    e.clip(sfx, e.media("sfx/alarm.wav"), start=1.0, volume=-6)                         # 효과음은 소리마다 그 시각에
    bgm = e.track("audio", "음악")
    m = e.clip(bgm, e.media("music/phase1.wav"), start=0, volume=-14, fade_out=1.0)
    e.key(m, "volume", 10.0, -14); e.key(m, "volume", 11.0, -24)                         # 줄였다 키우기(dB)
    e.marker(1.0, "산개")
    path = e.save("out/키식스.oddin-edit.json")
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

EASES = {"linear", "ease", "in", "out", "hold", "snap", "expo"}
ANIMS = {"none", "fade", "pop", "slideUp", "slideDown", "slideLeft", "slideRight", "zoom"}
IMAGE = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}


def _ffprobe() -> str | None:
    return os.environ.get("FFPROBE") or shutil.which("ffprobe") or next((p for p in ("C:/ffmpeg/bin/ffprobe.exe", "C:/Program Files/ffmpeg/bin/ffprobe.exe") if Path(p).exists()), None)


def probe(path: str | Path) -> dict:
    """길이·크기·fps·소리 유무 (ffprobe). 그림은 크기만, HTML 장면은 data-duration 등을 읽는다"""
    p = Path(path)
    ext = p.suffix.lower()
    if ext in (".html", ".htm"):
        import re
        t = p.read_text(encoding="utf-8", errors="ignore")
        num = lambda k, d: float(m.group(1)) if (m := re.search(rf'data-{k}="([\d.]+)"', t)) else d
        return {"kind": "html", "duration": num("duration", 5), "width": int(num("width", 0)), "height": int(num("height", 0))}
    bin_ = _ffprobe()
    if not bin_:
        raise RuntimeError("ffprobe 를 찾지 못했어요 (FFPROBE 환경변수나 PATH)")
    out = subprocess.run([bin_, "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", str(p)], capture_output=True, text=True, encoding="utf-8")
    if out.returncode:
        raise RuntimeError(f"원본을 읽지 못했어요: {p} — {out.stderr.strip()[-200:]}")
    j = json.loads(out.stdout or "{}")
    vs = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), None)
    has_audio = any(s.get("codec_type") == "audio" for s in j.get("streams", []))
    if ext in IMAGE:
        return {"kind": "image", "duration": 0, "width": int(vs["width"]) if vs else 0, "height": int(vs["height"]) if vs else 0}
    fps = 0.0
    if vs and vs.get("r_frame_rate"):
        a, _, b = vs["r_frame_rate"].partition("/")
        fps = round(float(a) / float(b or 1), 3) if float(b or 1) else 0.0
    return {"kind": "video", "duration": float(j.get("format", {}).get("duration") or 0), "width": int(vs["width"]) if vs else 0, "height": int(vs["height"]) if vs else 0, "fps": fps, "audio": has_audio}


class Edit:
    """편집 파일 하나. 시각은 모두 초(소수), 위치 x·y 는 화면 가운데 기준 픽셀(y 양수 = 아래)"""

    def __init__(self, title: str, width: int = 1080, height: int = 1920, fps: float = 30, background: str = "#000000"):
        self.doc = {"oddinEdit": 1, "title": title, "width": int(width), "height": int(height), "fps": fps, "background": background, "media": {}, "styles": {}, "tracks": [], "markers": []}
        self._n = 0
        self._paths: dict[str, str] = {}
        self._base: Path | None = None  # save() 때 정해지는 편집 파일 폴더(원본 경로를 상대 경로로)

    def _id(self, p: str) -> str:
        self._n += 1
        return f"{p}{self._n}"

    # ---------- 원본 ----------
    def media(self, path: str | Path, *, name: str | None = None, source: str | None = None, info: dict | None = None) -> str:
        """원본(영상·소리·그림·HTML 장면)을 등록하고 id 를 돌려준다. 같은 경로는 같은 id.
        source = 이 재료를 어떻게 만들었는지(스크립트 명령 등) — 편집기에 "만든 방법"으로 보이고, 다시 만들 때 쓴다"""
        key = str(Path(path).resolve())
        if key in self._paths:
            return self._paths[key]
        meta = info or probe(path)
        mid = self._id("m")
        self.doc["media"][mid] = {"path": key.replace("\\", "/"), "name": name or Path(path).name, **meta, **({"source": source} if source else {})}
        self._paths[key] = mid
        return mid

    # ---------- 트랙 ----------
    def track(self, kind: str, name: str | None = None, *, style: str | None = None) -> dict:
        """kind = video | audio | text. 영상 트랙은 나중에 만든 것이 위에 그려진다"""
        assert kind in ("video", "audio", "text"), kind
        tr = {"id": self._id(kind[0]), "kind": kind, "name": name or {"video": "영상", "audio": "소리", "text": "자막"}[kind]}
        if kind == "text":
            tr.update(style=style, items=[])
        else:
            tr["clips"] = []
        self.doc["tracks"].append(tr)
        return tr

    # ---------- 클립 ----------
    def clip(self, track: dict, media: str, start: float, *, in_: float = 0, out: float | None = None, length: float | None = None, label: str | None = None,
             volume: float = 0, fade_in: float = 0, fade_out: float = 0, vfade_in: float = 0, vfade_out: float = 0,
             fit: str | None = None, x: float = 0, y: float = 0, scale: float = 1, rotation: float = 0, opacity: float = 1) -> dict:
        """원본 구간 in_~out 을 시퀀스 start 에. 그림은 length(기본 3초). volume·fade_in/out 은 소리(dB·초), vfade_in/out 은 화면 들어오기/나가기(초)"""
        assert track["kind"] in ("video", "audio"), "글자는 text() 로"
        m = self.doc["media"][media]
        if out is None:
            out = in_ + (length if length is not None else (m["duration"] - in_ if m.get("duration") else 3.0))
        if fit is None:
            fit = "none" if m.get("kind") == "image" and m.get("width", 0) < self.doc["width"] and m.get("height", 0) < self.doc["height"] else "cover"
        c = {"id": self._id("c"), "media": media, "start": round(start, 4), "in": round(in_, 4), "out": round(out, 4), "volume": volume, "fadeIn": fade_in, "fadeOut": fade_out,
             "vfadeIn": vfade_in, "vfadeOut": vfade_out, "fit": fit, "x": x, "y": y, "scale": scale, "rotation": rotation, "opacity": opacity, "keys": {}}
        if label:
            c["label"] = label
        track["clips"].append(c)
        return c

    def text(self, track: dict, start: float, end: float, text: str, *, style: str | None = None, x: float = 0, y: float | None = None, scale: float = 1,
             anim_in: str = "none", anim_out: str = "none", in_dur: float = 0.2, out_dur: float = 0.15, **override) -> dict:
        """글자·자막 한 개. override 에 font=·size=·color= 등을 주면 이 글자만 바꾼다(역할이 다르면 style 을 따로 만들기)"""
        assert track["kind"] == "text", "글자 트랙에"
        assert anim_in in ANIMS and anim_out in ANIMS, (anim_in, anim_out)
        it = {"id": self._id("x"), "start": round(start, 4), "end": round(end, 4), "text": text, "style": style, "override": override, "x": x,
              "y": y if y is not None else round(self.doc["height"] * 0.36), "scale": scale, "rotation": 0, "opacity": 1,
              "anim": {"in": anim_in, "out": anim_out, "inDur": in_dur, "outDur": out_dur}, "keys": {}}
        track["items"].append(it)
        return it

    def key(self, obj: dict, prop: str, t: float, v: float, ease: str = "ease") -> dict:
        """키프레임. t 는 그 클립·글자 시작 기준 초. prop = x y scale rotation opacity (클립은 volume dB 도). ease 는 이 키에서 다음 키까지"""
        assert ease in EASES, ease
        ks = obj.setdefault("keys", {}).setdefault(prop, [])
        ks.append({"t": round(t, 4), "v": v, "ease": ease})
        ks.sort(key=lambda k: k["t"])
        return obj

    def punch(self, clip: dict, t: float, to: float = 1.15, frames: int = 6) -> dict:
        """쫀득한 펀치 인: t(클립 기준)에서 frames 프레임 동안 to 배로"""
        base = clip.get("scale", 1)
        return self.key(self.key(clip, "scale", t, base, "snap"), "scale", t + frames / self.doc["fps"], to, "hold")

    def style(self, name: str, **s) -> dict:
        """글자 스타일(역할별로 따로: 해설·발화·강조…). font·size·weight·color·stroke{color,width}·shadow{x,y,blur,color}·bg{color,padX,padY,radius}·align·oneLine·maxWidth"""
        self.doc["styles"][name] = {**self.doc["styles"].get(name, {}), **s}
        return self.doc["styles"][name]

    def marker(self, t: float, label: str = "") -> None:
        self.doc["markers"].append({"id": self._id("k"), "t": round(t, 4), "label": label})

    def duration(self) -> float:
        d = 0.0
        for tr in self.doc["tracks"]:
            for x in tr.get("clips") or tr.get("items") or []:
                d = max(d, x["end"] if tr["kind"] == "text" else x["start"] + x["out"] - x["in"])
        return round(d, 4)

    # ---------- 저장 ----------
    def save(self, path: str | Path) -> Path:
        """편집 파일로 저장(이름은 .oddin-edit.json 으로 끝나야). 편집 폴더 안의 원본은 상대 경로로 적는다"""
        p = Path(path)
        if not p.name.lower().endswith(".oddin-edit.json"):
            raise ValueError("편집 파일 이름은 .oddin-edit.json 으로 끝나야 해요")
        p.parent.mkdir(parents=True, exist_ok=True)
        base = p.parent.resolve()
        doc = json.loads(json.dumps(self.doc))
        for m in doc["media"].values():
            try:
                m["path"] = Path(m["path"]).resolve().relative_to(base).as_posix()
            except ValueError:
                pass
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, p)
        return p


def cli(oddin: str | Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    """ODDIN 스튜디오 명령줄: cli(ODDIN, "render", 편집, "--wait") · cli(ODDIN, "verify", 영상, "--strict")"""
    return subprocess.run(["node", str(Path(oddin) / "studio" / "cli.mjs"), *map(str, args)], check=check, text=True, encoding="utf-8")
