// 글꼴: 이 PC에 등록된 글꼴 목록 · 등록이 풀린 글꼴 찾기 · 사용자 글꼴로 설치 (2026-10-10 사용자 "폰트 설치")
// 윈도는 글꼴 파일이 폴더에 있어도 레지스트리(HKLM·HKCU …\Windows NT\CurrentVersion\Fonts)에 등록돼 있지 않으면
// 어떤 프로그램도 그 글꼴을 쓰지 못한다(배민 도현·부크크가 그랬다). 설치는 지금 사용자 계정에만(관리자 권한 없음):
// 사용자 글꼴 폴더(%LOCALAPPDATA%\Microsoft\Windows\Fonts)에 파일을 두고 HKCU 에 등록한 뒤, 켜져 있는 프로그램에 글꼴이 바뀌었다고 알린다.
// 레지스트리는 PowerShell 로 UTF-8 JSON 을 받아 읽는다(reg.exe 출력은 한글 이름이 깨졌다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { error } from './env.mjs';

const FONT_RE = /\.(ttf|otf|ttc)$/i;
const isWin = process.platform === 'win32';
export const userFontDir = () => (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts') : null);
const winFontDir = () => path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');

/** 글꼴 파일의 name 표: 가족 이름(1·16)·전체 이름(4), 영어·한국어 */
export function fontNames(file) {
  const fd = fs.openSync(file, 'r');
  const read = (pos, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n); };
  const be16 = (b) => { const s = Buffer.from(b); if (s.length % 2) return ''; s.swap16(); return s.toString('utf16le'); };
  try {
    const head = read(0, 12); if (head.length < 12) return [];
    let offsets = [0];
    if (head.toString('ascii', 0, 4) === 'ttcf') { const n = Math.min(head.readUInt32BE(8), 8); const b = read(12, 4 * n); offsets = Array.from({ length: n }, (_, i) => b.readUInt32BE(4 * i)); }
    const out = [];
    for (const off of offsets) {
      const h = read(off, 12); if (h.length < 12) continue;
      const numTables = h.readUInt16BE(4), dir = read(off + 12, 16 * numTables);
      let nameOff = -1, nameLen = 0;
      for (let i = 0; i < numTables && 16 * i + 16 <= dir.length; i++) if (dir.toString('ascii', 16 * i, 16 * i + 4) === 'name') { nameOff = dir.readUInt32BE(16 * i + 8); nameLen = dir.readUInt32BE(16 * i + 12); }
      if (nameOff < 0) continue;
      const nb = read(nameOff, Math.min(nameLen, 400_000)); if (nb.length < 6) continue;
      const count = nb.readUInt16BE(2), so = nb.readUInt16BE(4);
      const got = {};
      for (let i = 0; i < count && 6 + 12 * i + 12 <= nb.length; i++) {
        const r = 6 + 12 * i, pid = nb.readUInt16BE(r), lid = nb.readUInt16BE(r + 4), nid = nb.readUInt16BE(r + 6), len = nb.readUInt16BE(r + 8), o = nb.readUInt16BE(r + 10);
        if (pid !== 3 || ![1, 4, 16].includes(nid)) continue;
        const s = be16(nb.subarray(so + o, so + o + len)).replace(/\0/g, '').trim(); if (!s) continue;
        const lang = lid === 0x0412 ? 'ko' : lid === 0x0409 ? 'en' : 'x';
        if (!got[`${nid}-${lang}`]) got[`${nid}-${lang}`] = s;
      }
      const family = got['16-en'] || got['1-en'] || got['16-x'] || got['1-x'] || got['16-ko'] || got['1-ko'];
      if (family) out.push({ family, ko: got['16-ko'] || got['1-ko'] || null, full: got['4-en'] || got['4-x'] || got['4-ko'] || family, fullKo: got['4-ko'] || null });
    }
    return out;
  } catch { return []; } finally { fs.closeSync(fd); }
}

// 스크립트는 임시 .ps1(UTF-8 BOM)로 실행한다 — 글꼴이 많으면 명령 줄 길이(32K)를 넘었다
function powershell(script, timeout = 60_000) {
  const file = path.join(os.tmpdir(), `oddin-studio-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.ps1`);
  fs.writeFileSync(file, `﻿${script}`, 'utf8');
  try {
    const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(-3).join(' ') || `PowerShell 종료 코드 ${r.status}`);
    return (r.stdout || '').trim();
  } finally { try { fs.rmSync(file, { force: true }); } catch {} }
}
const b64json = (v) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');

let REG = null;
/** 레지스트리에 등록된 글꼴: [{ name, file, hive }] (10분 기억, 설치하면 지움) */
export function registeredFonts() {
  if (REG && Date.now() - REG.at < 10 * 60_000) return REG.list;
  let list = [];
  if (isWin) {
    try {
      const out = powershell(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$skip=@('PSPath','PSParentPath','PSChildName','PSDrive','PSProvider'); $out=@()
foreach($k in @('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts','HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')){
  try { $p=Get-ItemProperty -LiteralPath $k -ErrorAction Stop; foreach($n in $p.PSObject.Properties){ if($skip -notcontains $n.Name){ $out += [pscustomobject]@{ n=$n.Name; v=[string]$n.Value; h=$(if($k -like 'HKCU*'){'cu'}else{'lm'}) } } } } catch {}
}
ConvertTo-Json -Compress -InputObject @($out)`, 30_000);
      const rows = out ? JSON.parse(out) : [];
      list = (Array.isArray(rows) ? rows : [rows]).filter((x) => x && FONT_RE.test(x.v || '')).map((x) => ({ name: x.n, file: path.isAbsolute(x.v) ? x.v : path.join(winFontDir(), x.v), hive: x.h }));
    } catch { list = []; }
  }
  REG = { at: Date.now(), list };
  return list;
}

let FONTS = null;
/** 이 PC에서 쓸 수 있는 글꼴 가족(등록된 파일만). [{ family, ko }] */
export function listFonts() {
  if (FONTS && Date.now() - FONTS.at < 10 * 60_000) return FONTS.list;
  let files = registeredFonts().map((x) => x.file);
  if (!files.length) { // 레지스트리를 못 읽는 곳(윈도 아님 등)은 폴더를 그대로
    for (const d of [winFontDir(), userFontDir(), '/usr/share/fonts', path.join(process.env.HOME || '', '.fonts')].filter(Boolean)) { try { for (const n of fs.readdirSync(d)) if (FONT_RE.test(n)) files.push(path.join(d, n)); } catch {} }
  }
  const map = new Map();
  for (const file of files) { if (!fs.existsSync(file)) continue; for (const f of fontNames(file)) if (!map.has(f.family)) map.set(f.family, { family: f.family, ko: f.ko }); else if (f.ko && !map.get(f.family).ko) map.set(f.family, { family: f.family, ko: f.ko }); }
  const list = [...map.values()].filter((f) => !/^(\.|@)/.test(f.family)).sort((a, b) => (!!b.ko - !!a.ko) || a.family.localeCompare(b.family));
  FONTS = { at: Date.now(), list };
  return list;
}
export function forgetFonts() { REG = null; FONTS = null; }

/** 사용자 글꼴 폴더에 파일은 있는데 등록이 풀려 쓸 수 없는 글꼴(같은 가족이 다른 등록 파일로 이미 있으면 뺀다) */
export function installableFonts() {
  const dir = userFontDir(); if (!isWin || !dir) return [];
  const reg = new Set(registeredFonts().map((x) => path.resolve(x.file).toLowerCase()));
  const have = new Set(listFonts().map((f) => f.family.toLowerCase()));
  const out = [];
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  for (const n of names) {
    if (!FONT_RE.test(n)) continue;
    const file = path.join(dir, n); if (reg.has(file.toLowerCase())) continue;
    const fams = fontNames(file).filter((f) => !have.has(f.family.toLowerCase()));
    if (!fams.length) continue;
    out.push({ file, name: n, families: fams.map((f) => f.family), ko: fams.find((f) => f.ko)?.ko || null, size: fs.statSync(file).size });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

/** 사용자 글꼴로 설치: 사용자 글꼴 폴더 밖 파일은 복사해 두고(덮어쓰지 않음) HKCU 에 등록, 켜진 프로그램에 알림 */
export function installFonts(files) {
  if (!isWin) throw error(400, '글꼴 설치는 윈도에서만 돼요');
  const dir = userFontDir(); if (!dir) throw error(500, '사용자 글꼴 폴더를 찾지 못했어요');
  fs.mkdirSync(dir, { recursive: true });
  const regByFile = new Map(registeredFonts().map((x) => [path.resolve(x.file).toLowerCase(), x]));
  const items = [], skipped = [];
  for (const raw of [].concat(files || [])) {
    const src = path.resolve(String(raw || ''));
    if (!FONT_RE.test(src)) { skipped.push({ file: src, reason: '글꼴 파일(.ttf·.otf·.ttc)이 아니에요' }); continue; }
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) { skipped.push({ file: src, reason: '파일이 없어요' }); continue; }
    const names = fontNames(src);
    if (!names.length) { skipped.push({ file: src, reason: '글꼴 이름을 읽지 못했어요(망가진 파일일 수 있어요)' }); continue; }
    let target = src;
    if (path.resolve(path.dirname(src)).toLowerCase() !== path.resolve(dir).toLowerCase()) {
      target = path.join(dir, path.basename(src));
      for (let i = 2; fs.existsSync(target); i++) {
        if (fs.statSync(target).size === fs.statSync(src).size) break; // 같은 파일이 이미 있다
        target = path.join(dir, `${path.basename(src, path.extname(src))} (${i})${path.extname(src)}`);
      }
      if (!fs.existsSync(target)) fs.copyFileSync(src, target);
    }
    if (regByFile.has(target.toLowerCase())) { skipped.push({ file: target, reason: '이미 등록돼 있어요' }); continue; }
    const n = names[0];
    items.push({ file: target, name: `${n.fullKo || n.full || n.family} (TrueType)`, family: n.family, ko: n.ko });
  }
  if (items.length) {
    const out = powershell(`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$items = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64json(items.map(({ file, name }) => ({ file, name })))}')))
Add-Type -Namespace OddinStudio -Name Fonts -MemberDefinition '[DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern int AddFontResourceW(string f); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeoutW(System.IntPtr h, uint m, System.UIntPtr w, System.IntPtr l, uint f, uint t, out System.UIntPtr r);'
$key = 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
$res = @()
foreach ($it in @($items)) {
  New-ItemProperty -LiteralPath $key -Name $it.name -Value $it.file -PropertyType String -Force | Out-Null
  $res += [pscustomobject]@{ file = $it.file; loaded = [OddinStudio.Fonts]::AddFontResourceW($it.file) }
}
$r = [System.UIntPtr]::Zero
[void][OddinStudio.Fonts]::SendMessageTimeoutW([System.IntPtr]0xffff, 0x001D, [System.UIntPtr]::Zero, [System.IntPtr]::Zero, 2, 2000, [ref]$r)
ConvertTo-Json -Compress -InputObject @($res)`, 120_000);
    const rows = out ? JSON.parse(out) : [];
    const loaded = new Map((Array.isArray(rows) ? rows : [rows]).map((x) => [String(x.file).toLowerCase(), Number(x.loaded) || 0]));
    for (const it of items) it.loaded = loaded.get(it.file.toLowerCase()) || 0;
  }
  forgetFonts();
  return { installed: items, skipped };
}
