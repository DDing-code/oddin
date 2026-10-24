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

프로 기능(2026-10-24, 형식은 스킬 oddin-studio references/edit-format.md):

    c = e.clip(pic, arena, 0, speed=2)                                   # 배속·reverse=True·freeze=1.0(초)·속도 램프는 key(c, "speed", …)
    e.trans(c, "in", "slide", 0.4, dir="left"); e.trans(c, "out", "whip", 0.3, dir="left")
    f = e.fx(c, "color", saturation=1.2, contrast=1.1); e.fx_key(f, "brightness", 0, -0.3); e.fx_key(f, "brightness", 0.5, 0)
    e.fx(c, "glow", radius=20, strength=1); e.fx(c, "lut", file="looks/teal.cube", strength=0.7)
    e.mask(c, 200, 120, 400, 300, shape="ellipse", feather=40)          # 원본 픽셀
    light = e.clip(pic, e.media("fx/light-leak.mp4"), 3, blend="screen", opacity=0.8)
    e.adjust(pic, 10, 14, [{"type": "color", "saturation": 0}])          # 조정 레이어(아래 그림 전체)
    e.camera(zoom=1); e.camera_key("z", 0, 0); e.camera_key("z", 4, 300)   # 2.5D: z 를 준 층만 시차
    box = e.shape(cap, 2, 5, "rect", w=600, h=120, radius=24, fill={"from": "#ff0066", "to": "#ffaa00", "angle": 90})
    e.text(cap, 2.1, 5, "보스 2페이즈", unit="char", stagger=0.04, anim_in="pop", loop={"type": "wave", "amp": 6})
    e.track_audio(bgm, duck={"by": "해설", "amount": -12}, eq="music"); e.track_audio(voice_tr, eq="voice", comp=True, denoise=0.4)
    e.loudness(-14); e.output("h265", quality="high", bit_depth=10)    # 또는 prores·prores4444(투명)·vp9·gif
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

EASES = {"linear", "ease", "in", "out", "hold", "snap", "expo", "sine", "circ", "back", "elastic", "bounce", "bezier"}
ANIMS = {"none", "fade", "pop", "slideUp", "slideDown", "slideLeft", "slideRight", "zoom", "type", "blur", "drop", "rise", "wipeLeft", "wipeRight", "wipeUp", "wipeDown", "spin", "flip"}
TRANS = {"fade", "slide", "wipe", "iris", "zoom", "blur", "whip", "spin", "flip"}
FX = {"color", "lut", "curves", "blur", "glow", "shadow", "sharpen", "grain", "vignette", "pixelate", "chroma", "invert", "mirror", "tint", "rgbsplit", "lens", "wave", "wiggle"}
SHAPES = {"rect", "ellipse", "line", "arrow", "polygon", "star", "path"}
IMAGE = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}


def _ffprobe() -> str | None:
    return os.environ.get("FFPROBE") or shutil.which("ffprobe") or next((p for p in ("C:/ffmpeg/bin/ffprobe.exe", "C:/Program Files/ffmpeg/bin/ffprobe.exe") if Path(p).exists()), None)


def probe(path: str | Path) -> dict:
    """길이·크기·fps·소리 유무 (ffprobe). 그림은 크기만, HTML 장면은 data-duration 등을 읽는다"""
    p = Path(path)
    ext = p.suffix.lower()
    if p.name.lower().endswith(".oddin-edit.json"):  # 편집 안 편집
        d = json.loads(p.read_text(encoding="utf-8"))
        return {"kind": "edit", "duration": _doc_duration(d), "width": int(d.get("width", 1080)), "height": int(d.get("height", 1920)), "fps": d.get("fps", 30), "audio": any(t.get("kind") != "text" and t.get("clips") for t in d.get("tracks", []))}
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


def _clip_len(c: dict) -> float:
    if c.get("freeze"):
        return float(c["freeze"])
    span = float(c.get("out", 0)) - float(c.get("in", 0))
    ks = (c.get("keys") or {}).get("speed")
    if ks:  # 속도 램프: 대강(엔진이 정확히 다시 잰다)
        avg = sum(k["v"] for k in ks) / len(ks)
        return span / max(0.05, avg)
    return span / (float(c.get("speed", 1)) or 1)


def _doc_duration(d: dict) -> float:
    out = 0.0
    for tr in d.get("tracks", []):
        for x in tr.get("clips") or tr.get("items") or []:
            out = max(out, x.get("end", 0) if tr.get("kind") == "text" else x.get("start", 0) + _clip_len(x))
    return round(out, 4)


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
        if meta.get("kind") == "edit" and Path(path).resolve() == getattr(self, "_self_path", None):
            raise ValueError("편집 파일을 자기 안에 넣을 수 없어요")
        self.doc["media"][mid] = {"path": key.replace("\\", "/"), "name": name or Path(path).name, **meta, **({"source": source} if source else {})}
        self._paths[key] = mid
        return mid

    def adjust_media(self) -> str:
        """조정 레이어 원본(경로 없음) id"""
        for k, m in self.doc["media"].items():
            if m.get("kind") == "adjust":
                return k
        mid = self._id("m")
        self.doc["media"][mid] = {"path": "", "kind": "adjust", "name": "조정 레이어"}
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
             fit: str | None = None, x: float = 0, y: float = 0, scale: float = 1, rotation: float = 0, opacity: float = 1,
             speed: float = 1, reverse: bool = False, freeze: float = 0, interp: str | None = None, blend: str | None = None, motion_blur: bool = False,
             z: float | None = None, rotation_x: float = 0, rotation_y: float = 0, effects: list | None = None, mask: dict | None = None,
             trans_in: dict | str | None = None, trans_out: dict | str | None = None) -> dict:
        """원본 구간 in_~out 을 시퀀스 start 에. 그림은 length(기본 3초). volume·fade_in/out 은 소리(dB·초), vfade_in/out 은 화면 들어오기/나가기(초)
        speed(배속)·reverse(되감기)·freeze(in 프레임을 그 초만큼 멈춤)·interp("blend"|"flow" 느린 화면 사이 프레임)·blend(screen 등 섞기)
        z(카메라 깊이, 주면 3D 층)·rotation_x/y(3D 기울이기)·effects·mask·trans_in/out — 타임라인 길이 = (out-in)/speed"""
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
        extra = {"speed": speed if speed != 1 else None, "reverse": True if reverse else None, "freeze": freeze or None, "interp": interp, "blend": blend if blend and blend != "normal" else None,
                 "motionBlur": True if motion_blur else None, "z": z, "rotationX": rotation_x or None, "rotationY": rotation_y or None, "effects": effects, "mask": mask,
                 "transIn": {"type": trans_in} if isinstance(trans_in, str) else trans_in, "transOut": {"type": trans_out} if isinstance(trans_out, str) else trans_out}
        c.update({k: v for k, v in extra.items() if v is not None})
        track["clips"].append(c)
        return c

    def text(self, track: dict, start: float, end: float, text: str, *, style: str | None = None, x: float = 0, y: float | None = None, scale: float = 1,
             anim_in: str = "none", anim_out: str = "none", in_dur: float = 0.2, out_dur: float = 0.15, unit: str | None = None, stagger: float | None = None, order: str | None = None,
             loop: dict | str | None = None, effects: list | None = None, mask: dict | None = None, blend: str | None = None, z: float | None = None,
             rotation_x: float = 0, rotation_y: float = 0, **override) -> dict:
        """글자·자막 한 개. override 에 font=·size=·color= 등을 주면 이 글자만 바꾼다(역할이 다르면 style 을 따로 만들기)
        unit = char|word|line(글자·낱말·줄 하나씩 등장, stagger 초 간격, order forward|reverse|center|random), loop = {"type": pulse|shake|wave|float|blink|spin|swing, "amp", "freq"}"""
        assert track["kind"] == "text", "글자 트랙에"
        assert anim_in in ANIMS and anim_out in ANIMS, (anim_in, anim_out)
        it = {"id": self._id("x"), "start": round(start, 4), "end": round(end, 4), "text": text, "style": style, "override": override, "x": x,
              "y": y if y is not None else round(self.doc["height"] * 0.36), "scale": scale, "rotation": 0, "opacity": 1,
              "anim": {"in": anim_in, "out": anim_out, "inDur": in_dur, "outDur": out_dur}, "keys": {}}
        if unit and unit != "all":
            it["anim"].update(unit=unit, stagger=0.05 if stagger is None else stagger)
        if order:
            it["anim"]["order"] = order
        extra = {"loop": {"type": loop} if isinstance(loop, str) else loop, "effects": effects, "mask": mask, "blend": blend, "z": z, "rotationX": rotation_x or None, "rotationY": rotation_y or None}
        it.update({k: v for k, v in extra.items() if v is not None})
        track["items"].append(it)
        return it

    def shape(self, track: dict, start: float, end: float, type: str, *, x: float = 0, y: float = 0, scale: float = 1, rotation: float = 0, opacity: float = 1,
              anim_in: str = "none", anim_out: str = "none", in_dur: float = 0.2, out_dur: float = 0.15, loop: dict | str | None = None, effects: list | None = None, **props) -> dict:
        """도형 층(글자 트랙에): rect·ellipse·line·arrow·polygon·star·path. props = w h radius fill(색|{from,to,angle}|None) stroke{color,width,cap,join,dash}
        points=[[x,y]…](가운데 기준) d="M…"(SVG 경로) sides inner trimStart trimEnd(선 그리기 — key(obj, "trimEnd", t, v) 로 움직임)"""
        assert track["kind"] == "text", "도형은 글자 트랙에"
        assert type in SHAPES, type
        it = {"id": self._id("x"), "start": round(start, 4), "end": round(end, 4), "text": "", "style": None, "override": {}, "shape": {"type": type, **props}, "x": x, "y": y,
              "scale": scale, "rotation": rotation, "opacity": opacity, "anim": {"in": anim_in, "out": anim_out, "inDur": in_dur, "outDur": out_dur}, "keys": {}}
        if loop:
            it["loop"] = {"type": loop} if isinstance(loop, str) else loop
        if effects:
            it["effects"] = effects
        track["items"].append(it)
        return it

    def adjust(self, track: dict, start: float, end: float, effects: list, **kw) -> dict:
        """조정 레이어: 이 트랙 아래에 쌓인 그림 전체에 effects 를 건다(mask=·opacity=·trans_in= 도)"""
        assert track["kind"] == "video", "조정 레이어는 영상 트랙에"
        return self.clip(track, self.adjust_media(), start, in_=0, out=end - start, effects=effects, **kw)

    def fx(self, obj: dict, type: str, **params) -> dict:
        """효과 하나를 더한다(배열 순서대로 걸림). 키프레임은 fx_key"""
        assert type in FX, type
        f = {"type": type, **params}
        obj.setdefault("effects", []).append(f)
        return f

    def fx_key(self, fx: dict, param: str, t: float, v: float, ease: str = "ease") -> dict:
        """효과 값 키프레임(t = 그 클립 시작 기준 초)"""
        assert ease in EASES, ease
        ks = fx.setdefault("keys", {}).setdefault(param, [])
        ks.append({"t": round(t, 4), "v": v, "ease": ease})
        ks.sort(key=lambda k: k["t"])
        return fx

    def trans(self, clip: dict, which: str, type: str, dur: float = 0.5, *, dir: str | None = None, ease: str | None = None, **kw) -> dict:
        """전환: which = in|out. type = fade slide wipe iris zoom blur whip spin flip, dir = 그림이 움직이는 방향(left|right|up|down)
        밀어내기 = 앞 클립 out slide + 뒤 클립 in slide 같은 방향(겹쳐 두기)"""
        assert which in ("in", "out") and type in TRANS, (which, type)
        clip["transIn" if which == "in" else "transOut"] = {"type": type, "dur": dur, **({"dir": dir} if dir else {}), **({"ease": ease} if ease else {}), **kw}
        return clip

    def mask(self, obj: dict, x: float, y: float, w: float, h: float, *, shape: str = "rect", feather: float = 0, invert: bool = False, radius: float = 0) -> dict:
        """마스크(원본 픽셀, x·y = 왼쪽 위). 움직이려면 obj["mask"]["keys"] — 따라가기는 cli follow --apply mask"""
        obj["mask"] = {"shape": shape, "x": x, "y": y, "w": w, "h": h, "feather": feather, "invert": invert, "radius": radius, "keys": {}}
        return obj["mask"]

    def camera(self, **c) -> dict:
        """2.5D 카메라: x y z(앞으로 다가가기) zoom perspective(px, 0=자동) shake{amp,freq,seed}. z 를 준 층만 비친다"""
        cam = self.doc.setdefault("camera", {"x": 0, "y": 0, "z": 0, "zoom": 1, "keys": {}})
        cam.update(c)
        return cam

    def camera_key(self, prop: str, t: float, v: float, ease: str = "ease") -> dict:
        """카메라 키(t = 타임라인 초)"""
        cam = self.camera()
        ks = cam.setdefault("keys", {}).setdefault(prop, [])
        ks.append({"t": round(t, 4), "v": v, "ease": ease})
        ks.sort(key=lambda k: k["t"])
        return cam

    def motion_blur(self, samples: int = 8, shutter: float = 0.5, all: bool = False) -> None:
        """모션 블러 설정(클립은 motion_blur=True, all=True 면 움직이는 클립 모두)"""
        self.doc["motionBlur"] = {"samples": samples, "shutter": shutter, "all": all}

    def track_audio(self, track: dict, **a) -> dict:
        """트랙 소리: volume(dB) pan(-1~1) eq(voice|clear|music|warm|bright|bass|phone|radio|muffled 또는 띠 목록) comp(True|{threshold,ratio,attack,release,makeup})
        denoise(0~1) gate(True|{threshold}) deess(0~1) duck={"by": 트랙 이름|id, "amount": -12, "attack": 0.2, "release": 0.5, "mode": "envelope"|"sidechain"}"""
        assert track["kind"] in ("video", "audio"), "소리는 영상·소리 트랙에"
        track.setdefault("audio", {}).update(a)
        return track["audio"]

    def loudness(self, lufs: float | None = -14, limit: bool = True) -> None:
        """전체 음량 맞추기(LUFS, 유튜브 -14)·리미터(-1dB)"""
        self.doc["audio"] = {"loudness": lufs, "limit": limit}

    def output(self, codec: str = "h264", *, quality: str = "normal", bit_depth: int = 8, alpha: bool = False, audio: str | None = None, fps: float | None = None) -> None:
        """출력 형식: h264(mp4) h265(mp4) prores(mov) prores4444(mov, 투명) vp9(webm, alpha=True 면 투명) gif · quality draft|normal|high|master · bit_depth 10"""
        self.doc["output"] = {"codec": codec, "quality": quality, "bitDepth": bit_depth, "alpha": alpha, **({"audio": audio} if audio else {}), **({"fps": fps} if fps else {})}

    def key(self, obj: dict, prop: str, t: float, v: float, ease: str = "ease", bz: list | None = None) -> dict:
        """키프레임. t 는 그 클립·글자 시작 기준 초. prop = x y scale rotation opacity rotationX rotationY z (클립은 volume dB·speed 배속, 도형은 trimStart·trimEnd).
        ease 는 이 키에서 다음 키까지, ease="bezier" 면 bz=[x1, y1, x2, y2](CSS cubic-bezier 와 같음)"""
        assert ease in EASES, ease
        ks = obj.setdefault("keys", {}).setdefault(prop, [])
        ks.append({"t": round(t, 4), "v": v, "ease": ease, **({"bz": list(bz)} if bz else {})})
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
                d = max(d, x["end"] if tr["kind"] == "text" else x["start"] + _clip_len(x))
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
            if not m.get("path"):
                continue
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
