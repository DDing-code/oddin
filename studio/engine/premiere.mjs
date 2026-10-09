// 프리미어 가져오기 (2026-10-10 사용자 "프리미어 가져오기도 만들어줘")
// 열린 프리미어 시퀀스를 ODDIN 어도비 플러그인(ODDIN.pr.editExport, adobe/plugin/host/oddin.jsx)으로 읽어 편집 파일로 바꾼다.
// 플러그인은 값만 그대로 넘기고(구성 요소 matchName·표시 이름·속성 값·키프레임) 뜻은 여기서 정한다 — 고칠 때 플러그인을 다시 깔지 않게.
// 옮기는 것: 화면 크기·fps·영상/소리 트랙·클립(시퀀스 위치·원본 구간)·모션(위치·크기·회전)·불투명도·소리 크기·글자 클립의 글·마커.
// 못 옮기는 것(문제 목록에 적음): 속도 바꾼 클립(원래 속도로), 효과·전환·색 보정, 꺼 둔 클립, 캡션 트랙(프리미어 스크립트로 읽을 수 없음 — SRT 로 내보내 넣기).
import path from 'node:path';

const r4 = (v) => Math.round(v * 10000) / 10000;
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
// 구성 요소 찾기: matchName 이 기준, 없으면 표시 이름(영어·한국어 프리미어)
const isMotion = (c) => c.mn === 'AE.ADBE Motion' || /^(motion|모션)$/i.test(c.dn);
const isOpacity = (c) => c.mn === 'AE.ADBE Opacity' || /^(opacity|불투명도)$/i.test(c.dn);
const isVolume = (c) => /volume/i.test(c.mn) || /^(volume|볼륨)$/i.test(c.dn);
const isText = (c) => /text|capsule|graphic/i.test(c.mn) || /^(text|텍스트)$/i.test(c.dn);
const prop = (c, i, re) => (c.props || []).find((p) => re && re.test(p.dn)) || (c.props || [])[i] || null;

/** 프리미어 글자(Source Text) 값 → 글. 새 판은 JSON 문자열(textEditValue), 예전 판은 그냥 글 */
export function sourceText(v) {
  if (v == null) return '';
  let s = String(v);
  try { const j = JSON.parse(s); const t = j?.textEditValue ?? j?.mTextParam?.mStyleSheet?.mText ?? j?.text; if (typeof t === 'string') s = t; } catch {
    const m = s.match(/"textEditValue"\s*:\s*"((?:[^"\\]|\\.)*)"/); if (m) { try { s = JSON.parse(`"${m[1]}"`); } catch { s = m[1]; } }
  }
  return s.replace(/\r\n?/g, '\n').trim();
}
/** 프리미어 소리 크기(Level) → dB. 스크립트 값은 0dB = 0.1778(= 10^(-15/20)) 꼴의 비율이다(추정: 프리미어 스크립트 커뮤니티 공식) */
export const levelToDb = (v) => (Number(v) > 0 ? Math.max(-60, Math.min(24, Math.round((20 * Math.log10(Number(v)) + 15) * 10) / 10)) + 0 : -60);

/**
 * seq: ODDIN.pr.editExport 결과, probes: Map(원본 절대 경로 → probe 정보), editFile: 만들 편집 파일 경로
 * 반환: { doc, problems }
 */
export function premiereToEdit(seq, probes, editFile, { relOrAbs = (f, p) => p, styleDefault = {} } = {}) {
  const W = Math.max(16, Math.round(num(seq.width, 1920))), H = Math.max(16, Math.round(num(seq.height, 1080)));
  let fps = num(seq.fps, 30); for (const std of [23.976, 29.97, 59.94]) if (Math.abs(fps - std) < 0.01) fps = std; fps = Math.round(fps * 1000) / 1000 || 30;
  const problems = [], note = new Map();
  const tell = (key, msg) => note.set(key, { msg, n: (note.get(key)?.n || 0) + 1 });
  const doc = { oddinEdit: 1, title: String(seq.name || '프리미어 시퀀스'), width: W, height: H, fps, background: '#000000', media: {}, styles: { 자막: { ...styleDefault, size: Math.round(Math.min(W, H) * 0.06) } }, tracks: [], markers: [], source: { app: 'premiere', project: seq.project || '', sequence: seq.name || '', id: seq.id || '' } };
  const mediaId = new Map();
  const mediaOf = (file) => {
    if (mediaId.has(file)) return mediaId.get(file);
    const info = probes.get(file); if (!info) return null;
    const id = `m${mediaId.size + 1}`; mediaId.set(file, id);
    doc.media[id] = { path: relOrAbs(editFile, file), name: path.basename(file), kind: info.kind || 'video', duration: info.duration || 0, width: info.width || 0, height: info.height || 0, fps: info.fps || 0, audio: !!info.audio };
    return id;
  };
  // 위치: 새 프리미어는 0~1(화면 비율), 예전 판은 픽셀
  const posX = (v) => { const x = num(Array.isArray(v) ? v[0] : NaN, 0.5); return Math.abs(x) <= 2 ? x * W - W / 2 : x - W / 2; };
  const posY = (v) => { const y = num(Array.isArray(v) ? v[1] : NaN, 0.5); return Math.abs(y) <= 2 ? y * H - H / 2 : y - H / 2; };
  // 키프레임 시각: 프리미어는 클립 원본 시각(in 포함)으로 준다 → 클립 시작 기준으로
  const keysOf = (p, inPt, len, map) => (p?.keys || []).map((k) => ({ t: r4(Math.min(len, Math.max(0, num(k.t) - inPt))), v: r4(map(k.v)), ease: 'linear' })).filter((k, i, a) => i === 0 || Math.abs(k.t - a[i - 1].t) > 1e-4);

  (seq.video || []).forEach((tr, ti) => {
    const vt = { id: `v${ti + 1}`, kind: 'video', name: tr.name || `V${ti + 1}`, muted: true, hidden: !!tr.muted, locked: false, clips: [] };
    const text = { id: `tp${ti + 1}`, kind: 'text', name: `${tr.name || `V${ti + 1}`} 글자`, style: '자막', muted: false, hidden: !!tr.muted, locked: false, items: [] };
    for (const c of tr.clips || []) {
      const start = r4(num(c.start)), end = r4(num(c.end)), len = Math.max(1 / fps, end - start);
      if (c.disabled) { tell('disabled', '꺼 둔 클립은 뺐어요'); continue; }
      const comps = c.comps || [];
      const motion = comps.find(isMotion), opac = comps.find(isOpacity);
      const file = c.media ? path.resolve(c.media) : '';
      const id = file ? mediaOf(file) : null;
      if (!id) {
        const tc = comps.find(isText), tv = tc ? sourceText(prop(tc, 0, /source text|소스 텍스트/i)?.v) : '';
        if (tv) {
          text.items.push({ id: `x${ti + 1}_${text.items.length + 1}`, start, end, text: tv, x: motion ? Math.round(posX(prop(motion, 0, /^(position|위치)$/i)?.v)) : 0, y: Math.round(H * 0.36), anim: { in: 'none', out: 'none' } });
          tell('textStyle', '글자 클립은 글과 시간만 가져왔어요(글꼴·모양은 자막 스타일로)');
        } else if (file) tell('offline', '원본 파일을 찾지 못한 클립은 뺐어요(오프라인 미디어)');
        else tell('graphic', '조정 레이어·그래픽·색 매트 등 파일이 없는 클립은 뺐어요');
        continue;
      }
      if (Math.abs(num(c.speed, 1) - 1) > 1e-3) tell('speed', '속도를 바꾼 클립은 원래 속도로 가져왔어요');
      const inPt = num(c.inPoint), clip = { id: `c${ti + 1}_${vt.clips.length + 1}`, media: id, start, in: r4(inPt), out: r4(inPt + len), fit: 'none', x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, keys: {} };
      if (motion) {
        const pPos = prop(motion, 0, /^(position|위치)$/i), pScale = prop(motion, 1, /^(scale|비율 조정|크기 조정|scale height|높이 비율 조정)$/i), pRot = prop(motion, 4, /^(rotation|회전)$/i);
        const pUni = prop(motion, 3, /uniform|균일/i);
        if (pUni && pUni.v === false) tell('nonuniform', '가로·세로 크기를 따로 바꾼 클립은 세로 크기로 맞췄어요');
        clip.x = r4(posX(pPos?.v)); clip.y = r4(posY(pPos?.v));
        clip.scale = r4(num(pScale?.v, 100) / 100); clip.rotation = r4(num(pRot?.v, 0));
        const kx = keysOf(pPos, inPt, len, posX), ky = keysOf(pPos, inPt, len, posY), ks = keysOf(pScale, inPt, len, (v) => num(v, 100) / 100), kr = keysOf(pRot, inPt, len, (v) => num(v, 0));
        if (kx.length > 1) { clip.keys.x = kx; clip.keys.y = ky; }
        if (ks.length > 1) clip.keys.scale = ks;
        if (kr.length > 1) clip.keys.rotation = kr;
        if ((pPos?.keys?.length || 0) + (pScale?.keys?.length || 0) + (pRot?.keys?.length || 0) > 0) tell('ease', '키프레임은 위치·값만 가져오고 움직임은 "일정하게"로 했어요(프리미어 보간 방식은 스크립트로 읽지 못해요)');
      }
      if (opac) { const p = prop(opac, 0, /^(opacity|불투명도)$/i); clip.opacity = r4(Math.max(0, Math.min(1, num(p?.v, 100) / 100))); if ((p?.keys?.length || 0) > 1) tell('opkeys', '불투명도 키프레임은 고정값으로 가져왔어요'); }
      if (comps.some((x) => !isMotion(x) && !isOpacity(x) && !isText(x) && !/time ?remap|시간 다시 매핑/i.test(x.dn))) tell('fx', '효과(색 보정·흐림 등)는 가져오지 않아요 — 프리미어에서 그대로');
      vt.clips.push(clip);
    }
    doc.tracks.push(vt);
    if (text.items.length) doc.tracks.push(text);
  });
  (seq.audio || []).forEach((tr, ti) => {
    const at = { id: `a${ti + 1}`, kind: 'audio', name: tr.name || `A${ti + 1}`, muted: !!tr.muted, hidden: false, locked: false, clips: [] };
    for (const c of tr.clips || []) {
      if (c.disabled) { tell('disabled', '꺼 둔 클립은 뺐어요'); continue; }
      const file = c.media ? path.resolve(c.media) : '', id = file ? mediaOf(file) : null;
      if (!id) { tell('offline', '원본 파일을 찾지 못한 클립은 뺐어요(오프라인 미디어)'); continue; }
      const start = r4(num(c.start)), len = Math.max(1 / fps, num(c.end) - start), inPt = num(c.inPoint);
      if (Math.abs(num(c.speed, 1) - 1) > 1e-3) tell('speed', '속도를 바꾼 클립은 원래 속도로 가져왔어요');
      const vol = (c.comps || []).find(isVolume), lv = vol ? prop(vol, 1, /^(level|레벨|수준)$/i) : null;
      const clip = { id: `c${ti + 1}a_${at.clips.length + 1}`, media: id, start, in: r4(inPt), out: r4(inPt + len), volume: lv && lv.v != null ? levelToDb(lv.v) : 0 };
      if ((lv?.keys?.length || 0) > 1) tell('volkeys', '소리 크기 키프레임은 고정값으로 가져왔어요');
      at.clips.push(clip);
    }
    doc.tracks.push(at);
  });
  // 자막·글자 트랙은 영상 트랙 위(뒤쪽)로
  doc.tracks.sort((a, b) => ({ video: 0, text: 1, audio: 2 }[a.kind] - { video: 0, text: 1, audio: 2 }[b.kind]));
  if (!doc.tracks.some((t) => t.kind === 'text')) doc.tracks.splice(doc.tracks.filter((t) => t.kind === 'video').length, 0, { id: 't1', kind: 'text', name: '자막', style: '자막', items: [] });
  for (const m of seq.markers || []) doc.markers.push({ t: r4(num(m.t)), label: [m.name, m.comment].filter(Boolean).join(' · ') });
  if (seq.truncated) tell('trunc', '클립이 너무 많아 앞쪽 3000개만 가져왔어요');
  tell('captions', '캡션 트랙은 프리미어 스크립트로 읽을 수 없어요 — 프리미어에서 SRT 로 내보낸 뒤 "SRT 넣기"로 넣으세요');
  for (const { msg, n } of note.values()) problems.push(n > 1 && !/캡션/.test(msg) ? `${msg} (${n}개)` : msg);
  return { doc, problems };
}
