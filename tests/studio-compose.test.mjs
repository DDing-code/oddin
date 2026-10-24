// 편집기 중심 제작(2026-10-24 사용자 "AI가 편집기로 조립하는 게 이상적 — 없는 기능은 더 추가해줘", docs/studio.md "편집기 중심 제작"):
// 영상 클립 불투명도 키프레임·화면 들어오기/나가기, 소리 크기 키프레임, 이름표·만든 방법, 통째로 구운 편집 찾기,
// AI 고치기 창구(/api/patch), 최신 렌더 확인(/api/verify), 파이썬 도우미(studio/sdk/oddin_edit.py)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './_port.mjs';
import { core, opacityExpr, opacitySpans, keyExpr, encodeArgs, editHash } from '../studio/engine/edit.mjs';
import { tools } from '../studio/engine/media.mjs';
import { findBrowser } from '../lib/browser.mjs';

const V = core();
const plain = (v) => JSON.parse(JSON.stringify(v));
const FF = tools({});
// ffmpeg 식을 JS 로(if·lt·gte·pow·clip)
function evalExpr(expr, vars) {
  const js = expr.replace(/\bif\(/g, 'IF(').replace(/\blt\(/g, 'LT(').replace(/\bgte\(/g, 'GTE(').replace(/\bpow\(/g, 'Math.pow(').replace(/\bclip\(/g, 'CLIP(');
  return new Function(...Object.keys(vars), 'IF', 'LT', 'GTE', 'CLIP', `return ${js};`)(...Object.values(vars), (c, a, b) => (c ? a : b), (a, b) => (a < b ? 1 : 0), (a, b) => (a >= b ? 1 : 0), (x, a, b) => Math.min(b, Math.max(a, x)));
}

test('불투명도: 화면(clipOpacity)과 렌더 식(opacityExpr, geq 의 T)이 같은 값 — 키프레임 × 화면 들어오기·나가기', () => {
  const c = { start: 3, in: 0, out: 4, opacity: 0.9, vfadeIn: 0.5, vfadeOut: 0.8, keys: { opacity: [{ t: 1, v: 1, ease: 'ease' }, { t: 2, v: 0.3, ease: 'snap' }, { t: 2.5, v: 0.8, ease: 'linear' }] } };
  for (const off of [0, 0.7, 2.2]) {
    const ex = opacityExpr(c, off);
    for (let T = 0; T < 4 - off; T += 0.041) assert.ok(Math.abs(V.clipOpacity(c, c.start + off + T) - evalExpr(ex, { T })) < 1e-5, `off=${off} T=${T.toFixed(3)}`);
  }
  assert.deepEqual(opacitySpans(c), [[1, 2.5], [0, 0.5], [3.2, 4]], '바뀌는 구간: 키 · 들어오기 · 나가기');
  assert.deepEqual(opacitySpans({ in: 0, out: 2, keys: { opacity: [{ t: 0, v: 0.5 }, { t: 1, v: 0.5 }] } }), [], '값이 같은 키는 바뀌지 않음');
  assert.equal(V.clipBox({ width: 100, height: 100, media: { m: {} } }, { ...c, media: 'm', x: 0, y: 0, scale: 1, rotation: 0, fit: 'cover' }, 3.25).opacity, V.clipOpacity(c, 3.25), '미리보기 상자도 같은 불투명도');
});

test('소리 크기 키프레임: clipGain 과 렌더 식이 같은 dB', () => {
  const c = { start: 1, in: 0, out: 5, volume: -6, keys: { volume: [{ t: 0.5, v: -6, ease: 'ease' }, { t: 1.5, v: -24, ease: 'hold' }, { t: 3, v: -3 }] } };
  const ex = keyExpr(c.volume, c.keys.volume, 0.4);
  for (let t = 0; t < 4; t += 0.05) assert.ok(Math.abs(V.clipGain(c, c.start + 0.4 + t) - evalExpr(ex, { t })) < 1e-5, `t=${t}`);
  assert.equal(V.clipGain({ start: 0, volume: -12, keys: {} }, 5), -12);
});

test('편집 파일 정리: 이름표·만든 방법·화면 들어오기/나가기·소리 크기 키를 지키고, 소리 키는 -60~24dB 로', () => {
  const { doc } = V.normalize({ fps: 30, media: { m1: { path: 'a.mp4', duration: 10, width: 1920, height: 1080, source: 'python build.py --seg 1' } },
    tracks: [{ kind: 'video', clips: [{ id: 'c1', media: 'm1', start: 0, in: 0, out: 4, label: '1페이즈', vfadeIn: 0.3, vfadeOut: 99, keys: { volume: [{ t: 0, v: -100 }, { t: 1, v: 3 }], opacity: [{ t: 0, v: 1 }] } }] }] });
  const c = doc.tracks[0].clips[0];
  assert.equal(doc.media.m1.source, 'python build.py --seg 1'); assert.equal(c.label, '1페이즈');
  assert.equal(c.vfadeIn, 0.3); assert.equal(c.vfadeOut, 10, '최대 10초');
  assert.deepEqual(plain(c.keys.volume.map((k) => k.v)), [-60, 3]); assert.equal(c.keys.opacity.length, 1);
  assert.deepEqual(plain(Object.keys(V.normalize({ tracks: [{ kind: 'text', items: [{ text: 'a', keys: { volume: [{ t: 0, v: 1 }] } }] }] }).doc.tracks[0].items[0].keys)), [], '글자에는 소리 키가 없다');
});

test('통째로 구운 편집 찾기: 그림 영상 하나뿐 + 글자 칸 없음 = 고칠 수 없는 감싸기, 나눈 편집은 통과', () => {
  const media = { p: { path: 'picture.mp4', duration: 120, width: 1920, height: 1080, audio: false }, mu: { path: 'music-final.wav', duration: 120, audio: true }, sf: { path: 'sfx-final.wav', duration: 120, audio: true } };
  const wrap = { fps: 30, media, tracks: [
    { kind: 'video', clips: Array.from({ length: 6 }, (_, i) => ({ media: 'p', start: i * 20, in: i * 20, out: i * 20 + 20 })) },
    { kind: 'audio', name: '음악', clips: [{ media: 'mu', start: 0, in: 0, out: 120 }] }, { kind: 'audio', name: '효과음', clips: [{ media: 'sf', start: 0, in: 0, out: 120 }] }] };
  const e1 = V.editability(V.normalize(wrap).doc);
  assert.equal(e1.flattened, true);
  assert.ok(e1.notes.some((n) => /영상 한 개뿐/.test(n)) && e1.notes.some((n) => /글자·자막 칸/.test(n)) && e1.notes.some((n) => /효과음 트랙 "효과음"이 한 덩어리/.test(n)) && e1.notes.some((n) => /미리 섞은 한두 덩어리/.test(n)), e1.notes.join('\n'));
  const rich = { fps: 30, media: { ...media, a: { path: 'arena-1.mp4', duration: 60, width: 1920, height: 1080, audio: false }, b: { path: 'arena-2.mp4', duration: 60, width: 1920, height: 1080, audio: false }, h: { path: 'hit.wav', duration: 0.5, audio: true } },
    tracks: [{ kind: 'video', clips: [{ media: 'a', start: 0, in: 0, out: 60 }, { media: 'b', start: 60, in: 0, out: 60 }] }, { kind: 'text', items: [{ start: 1, end: 3, text: '산개' }] },
      { kind: 'audio', name: '효과음', clips: [{ media: 'h', start: 1, in: 0, out: 0.5 }, { media: 'h', start: 30, in: 0, out: 0.5 }] }, { kind: 'audio', name: '음악', clips: [{ media: 'mu', start: 0, in: 0, out: 120 }] }] };
  const e2 = V.editability(V.normalize(rich).doc);
  assert.equal(e2.flattened, false); assert.deepEqual(plain(e2.notes), []);
  assert.deepEqual(plain(V.editability(V.normalize({ fps: 30, media, tracks: [{ kind: 'video', clips: [{ media: 'p', start: 0, in: 0, out: 3 }] }] }).doc)), { flattened: false, notes: [] }, '5초 안 되는 짧은 편집은 따지지 않음');
});

test('인코더 인자: 그래픽카드(nvenc)는 품질 고정(cq), 아니면 x264 crf', () => {
  assert.deepEqual(encodeArgs('libx264', { piece: true }).slice(0, 6), ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12']);
  assert.ok(encodeArgs('h264_nvenc', { crf: 18 }).join(' ').includes('-cq 19'));
  assert.equal(editHash({ a: 1 }), editHash({ a: 1 })); assert.notEqual(editHash({ a: 1 }), editHash({ a: 2 }));
});

const PY = (() => { for (const b of ['python', 'py']) { try { if (spawnSync(b, ['--version'], { windowsHide: true }).status === 0) return b; } catch {} } return null; })();

test('엔진: 화면 들어오기·불투명도 키·소리 크기 키가 렌더에 그대로, AI 고치기 창구, 최신 렌더 확인, 파이썬 도우미', { skip: (!FF.ffmpeg || !FF.ffprobe) && 'ffmpeg 없음', timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oddin-compose-'));
  const media = path.join(dir, '재료'), data = path.join(dir, 'data');
  for (const d of [media, data]) fs.mkdirSync(d, { recursive: true });
  const ff = (args) => { const r = spawnSync(FF.ffmpeg, ['-v', 'error', '-y', ...args], { windowsHide: true }); assert.equal(r.status, 0, String(r.stderr)); };
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(media, '빨강.mp4')]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x180', '-frames:v', '1', path.join(media, '초록.png')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-c:a', 'pcm_s16le', path.join(media, '소리.wav')]);
  const [port, scenePort, hubPort] = [await freePort(), await freePort(), await freePort()];
  const engine = spawn(process.execPath, [fileURLToPath(new URL('../studio/engine/server.mjs', import.meta.url))], { env: { ...process.env, STUDIO_PORT: String(port), STUDIO_SCENE_PORT: String(scenePort), STUDIO_DATA_DIR: data, ODDIN_HUB: `http://127.0.0.1:${hubPort}`, STUDIO_ENCODER: 'libx264' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, opt = {}) => { const res = await fetch(base + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } }); const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: res.status, body: j }; };
  const post = (p, body) => call(p, { method: 'POST', body: JSON.stringify(body) });
  const render = async (f) => {
    const rs = await post('/api/render', { path: f }); assert.equal(rs.status, 202, JSON.stringify(rs.body));
    let st; for (let i = 0; i < 1500; i++) { st = (await call('/api/renders')).body.find((x) => x.id === rs.body.id); if (st.status !== 'running') break; await new Promise((x) => setTimeout(x, 200)); }
    assert.equal(st.status, 'done', st.error || ''); return st.out;
  };
  const pixel = (file, t) => spawnSync(FF.ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=1:1:160:90,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }).stdout;
  const rms = (file, a, b) => { const r = spawnSync(FF.ffmpeg, ['-v', 'info', '-ss', String(a), '-t', String(b - a), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }); return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1]); };
  try {
    for (let i = 0; i < 300; i++) { try { await fetch(base + '/api/status'); break; } catch { await new Promise((x) => setTimeout(x, 100)); } }
    const f = (await post('/api/blank', { dir: media, title: '조립 시험', width: 320, height: 180, fps: 30 })).body.path;
    const add = (await post('/api/add', { path: f, files: [path.join(media, '빨강.mp4'), path.join(media, '초록.png')], at: 0, length: 2 })).body;
    assert.equal(add.placed.length, 2, JSON.stringify(add));
    const [red, green] = add.placed.map((x) => x.clip);
    const snd = (await post('/api/add', { path: f, files: [path.join(media, '소리.wav')], at: 0 })).body.placed[0].clip;
    // AI 고치기 창구: 화면 들어오기 · 불투명도 키 · 소리 크기 키 · 이름표 · 만든 방법 · 스타일 · 마커 · 글자
    const pt = await post('/api/patch', { path: f, ops: [
      { op: 'set', id: red, props: { vfadeIn: 0.5, label: '빨강 장면' } },
      { op: 'set', id: green, props: { 'keys.opacity': [{ t: 0, v: 1, ease: 'linear' }, { t: 1, v: 0, ease: 'linear' }] } },
      { op: 'set', id: snd, props: { 'keys.volume': [{ t: 0, v: 0, ease: 'hold' }, { t: 2, v: -20 }] } },
      { op: 'set', id: 'm1', props: { source: 'ffmpeg color=red' } },
      { op: 'style', name: '해설', props: { size: 20, color: '#ffffff' } },
      { op: 'marker', t: 1, label: '빨강 끝까지' },
      ...(findBrowser() ? [{ op: 'text', text: '산개', start: 0.2, dur: 1, style: '해설', track: '해설', y: 60, in: 'pop' }] : []),
    ] });
    assert.equal(pt.status, 200, JSON.stringify(pt.body));
    assert.equal((await post('/api/patch', { path: f, ops: [{ op: 'set', id: 'nope', props: {} }] })).status, 404);
    const d = (await call(`/api/edit?path=${encodeURIComponent(f)}`)).body.doc;
    const clipOf = (id) => d.tracks.flatMap((t) => t.clips || []).find((c) => c.id === id);
    assert.equal(clipOf(red).vfadeIn, 0.5); assert.equal(clipOf(red).label, '빨강 장면'); assert.equal(d.media.m1.source, 'ffmpeg color=red');
    assert.equal(clipOf(green).keys.opacity.length, 2); assert.equal(clipOf(snd).keys.volume.length, 2); assert.equal(d.markers.length, 1); assert.equal(d.styles['해설'].size, 20);
    const ck = (await call(`/api/check?path=${encodeURIComponent(f)}`)).body;
    assert.equal(ck.editability.flattened, false);
    const out = await render(f);
    // 빨강: 0.5초 동안 들어온다(0.1초 ≈ 20%, 1초 = 꽉) · 초록: 1초 동안 사라진다(2.5초 ≈ 50%)
    assert.ok(pixel(out, 0.1)[0] < 90, `0.1초 빨강은 아직 흐림: ${pixel(out, 0.1)[0]}`);
    assert.ok(pixel(out, 1.0)[0] > 220, `1초 빨강은 꽉: ${pixel(out, 1.0)[0]}`);
    const g = pixel(out, 2.5)[1]; assert.ok(g > 90 && g < 170, `2.5초 초록은 반쯤: ${g}`);
    assert.ok(pixel(out, 3.9)[1] < 30, '거의 다 사라짐');
    // 소리: 2초까지 0dB, 그 뒤 -20dB
    const loud = rms(out, 0.3, 1.7), quiet = rms(out, 2.3, 3.7);
    assert.ok(Math.abs(loud - quiet - 20) < 2, `소리 크기 차이 ${loud} → ${quiet}`);
    // 최신 렌더 확인: 지금은 최신, 편집 파일을 고치면 아님, 밖에서 만든 영상은 스튜디오 렌더 아님
    let vf = (await call(`/api/verify?path=${encodeURIComponent(out)}`)).body;
    assert.equal(vf.studio, true); assert.equal(vf.current, true); assert.equal(path.resolve(vf.edit), path.resolve(f)); assert.equal(vf.encoder, 'libx264');
    await post('/api/patch', { path: f, ops: [{ op: 'set', id: red, props: { vfadeIn: 0.3 } }] });
    vf = (await call(`/api/verify?path=${encodeURIComponent(out)}`)).body; assert.equal(vf.current, false, '렌더 뒤 바뀜');
    vf = (await call(`/api/verify?path=${encodeURIComponent(path.join(media, '빨강.mp4'))}`)).body; assert.equal(vf.studio, false);
    // 명령줄: verify --strict 는 최신이 아니면 실패(종료 코드 2), check --strict 는 통과
    const cli = (args) => spawnSync(process.execPath, [fileURLToPath(new URL('../studio/cli.mjs', import.meta.url)), ...args], { encoding: 'utf8', env: { ...process.env, STUDIO_PORT: String(port) } });
    const v1 = cli(['verify', out, '--strict']); assert.equal(v1.status, 2, v1.stdout + v1.stderr); assert.match(v1.stdout, /렌더 뒤에 바뀌었어요/);
    const c1 = cli(['check', f, '--strict']); assert.equal(c1.status, 0, c1.stdout + c1.stderr);
    const t1 = cli(['text', f, '--text', '두 번째', '--at', '2', '--dur', '1', '--track', '해설']); assert.equal(t1.status, 0, t1.stderr); assert.match(t1.stdout, /글자 넣음/);
    const s1 = cli(['set', f, red, 'opacity=0.5', 'anim.in=pop']); assert.equal(s1.status, 0, s1.stderr);
    assert.equal((await call(`/api/edit?path=${encodeURIComponent(f)}`)).body.doc.tracks.flatMap((t) => t.clips || []).find((c) => c.id === red).opacity, 0.5);
    // 파이썬 도우미: 재료 + 글자 + 효과음 + 키프레임으로 편집 파일을 짜고, 엔진이 그대로 읽는다
    if (PY) {
      const py = path.join(dir, 'build.py'), ef = path.join(media, '파이썬.oddin-edit.json');
      fs.writeFileSync(py, [
        'import sys', `sys.path.insert(0, r"${fileURLToPath(new URL('../studio/sdk', import.meta.url))}")`, 'from oddin_edit import Edit',
        'e = Edit("파이썬 조립", 320, 180, fps=30)', 'e.style("해설", size=24)',
        `a = e.media(r"${path.join(media, '빨강.mp4')}", source="ffmpeg color=red")`, 'v = e.track("video", "그림")', 'c = e.clip(v, a, 0, label="장면 1", vfade_in=0.3)', 'e.punch(c, 0.5)',
        't = e.track("text", "해설", style="해설")', 'e.text(t, 0.2, 1.5, "산개!", anim_in="pop")',
        `s = e.track("audio", "효과음")`, `e.clip(s, e.media(r"${path.join(media, '소리.wav')}"), 0.5, out=0.4, volume=-6)`, 'e.marker(0.5, "펀치")',
        `print(e.save(r"${ef}"))`].join('\n'));
      const r = spawnSync(PY, ['-X', 'utf8', py], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
      const pd = (await call(`/api/edit?path=${encodeURIComponent(ef)}`)).body;
      assert.deepEqual(pd.problems, []); const pc = pd.doc.tracks[0].clips[0];
      assert.equal(pc.label, '장면 1'); assert.equal(pc.vfadeIn, 0.3); assert.equal(pc.keys.scale.length, 2); assert.equal(pd.doc.media[pc.media].path, '빨강.mp4', '편집 폴더 안 원본은 상대 경로');
      assert.equal(pd.doc.tracks[1].items[0].text, '산개!'); assert.equal(pd.doc.tracks[2].clips[0].out, 0.4);
      assert.equal((await call(`/api/check?path=${encodeURIComponent(ef)}`)).body.missingMedia.length, 0);
    }
  } finally {
    try { await fetch(`${base}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"force":true}' }); } catch {}
    await new Promise((x) => setTimeout(x, 1000));
    engine.kill();
    await new Promise((x) => setTimeout(x, 300));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  }
});

test('작업자 지시문: 영상을 만들거나 고치는 작업에만 "편집기 중심 제작" 규칙 — 질문·눈으로 확인·다른 일·끈 설정은 빼고', async () => {
  const { buildWorkerPrompt, studioRule } = await import('../lib/planner.mjs');
  const { JobManager } = await import('../lib/jobs.mjs');
  const m = Object.assign(Object.create(JobManager.prototype), { config: { tools: {}, defaults: {} } });
  const job = (goal, extra = {}) => ({ id: 'j', goal, cwd: 'C:/p', intercepts: [], tasks: [], ...extra });
  const task = { id: 't1', title: '작업', prompt: '하기', assignee: 'codex' };
  const st = m.studioFor(job('키식스 공략 영상 4분 만들어줘'), task);
  assert.ok(st && st.cli.endsWith(path.join('studio', 'cli.mjs')) && st.sdk.endsWith('oddin_edit.py'));
  assert.equal(m.studioFor(job('로그 파서 고쳐줘'), task), null);
  assert.equal(m.studioFor(job('영상 몇 개야?', { answer: true }), task), null, '질문');
  assert.equal(m.studioFor(job('영상 만들어줘'), { ...task, visualCheck: true }), null, '눈으로 확인 작업');
  m.config.studio = { rule: false }; assert.equal(m.studioFor(job('영상 만들어줘'), task), null, '설정으로 끔');
  const p = buildWorkerPrompt({ job: job('영상 만들어줘'), task, siblings: [], depResults: [], hubDir: '', memoryCtx: '', studio: st });
  assert.match(p, /편집기 중심 제작/); assert.match(p, /verify "<영상>" --strict/); assert.match(p, /render <편집> --wait/);
  assert.doesNotMatch(buildWorkerPrompt({ job: job('파서'), task, siblings: [], depResults: [], hubDir: '', memoryCtx: '' }), /편집기 중심 제작/);
  assert.equal(studioRule(null), '');
});
