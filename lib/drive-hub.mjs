// ODDIN 드라이브 폴더 (2026-10-05 사용자 "'오딘' 공유폴더를 만들고 거기에 정리된 메모리랑 자산들을 넣자"
//   → "폴더를 구분할 필요 없이 두 기억을 합치는 느낌으로, 공유를 허용한 세션은 정제해서 오딘 폴더 안에 자동으로 메모리와 자산이 들어가는 거야").
// 구글 드라이브 "내 드라이브/ODDIN" 하나에 두 PC의 기억과 자산을 합친다(두 PC가 같은 구글 계정이라 같은 폴더가 보인다). PC별 칸은 없다.
//   ODDIN/README.md          이 폴더 설명
//   ODDIN/공유 기억/           두 PC가 함께 쓰는 지침·메모리(공유를 허용한 세션의 정리된 기억이 여기로) — ~/.ai-shared 공유 범위와 양방향으로 맞춘다(lib/shared-sync.mjs)
//   ODDIN/자산/<분류>/<이름>    공유를 허용한 세션의 다시 쓸 결과물(기억 정리가 고름, lib/oddin-assets.mjs)·공유 폴더 사본(자산/소스/, lib/shared-folders.mjs)
//   ODDIN/자산/목록.md         자산 목록(자동). 같은 목록이 공유 기억 reference-oddin-assets 로도 들어가 AI가 본다
// - 로컬 ~/.ai-shared 는 그대로 작업본이다(CLI 훅·Claude 메모리 정션이 빠르고 드라이브가 꺼져도 동작). 드라이브는 두 PC 사이 전달·보관.
// - 표식 파일 .oddin.json(id)이 있어야 쓰는 중으로 본다. 만든 PC가 먼저 다 올리고, 다른 PC는 처음 본 뒤 몇 분 동안은 맞는 파일만 기준으로 삼는다.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { detectDrive } from './drive-folders.mjs';
import { CATALOG, readCatalog } from './oddin-assets.mjs';

export const HUB_NAME = 'ODDIN', MEMORY_DIR = '공유 기억', ASSETS_DIR = '자산';
const MARK = '.oddin.json', LEGACY = ['공용']; // 예전에 만들던 빈 칸
const error = (status, message) => Object.assign(new Error(message), { status });
const IGNORE = /^(desktop\.ini|Thumbs\.db|\.DS_Store|\.tmp\.drive.*|~\$.*)$/i;

export const README = `# ODDIN

집·회사 PC의 ODDIN이 함께 쓰는 구글 드라이브 폴더입니다. 두 PC의 기억과 자산을 PC 구분 없이 한곳에 합칩니다. ODDIN이 채우고 맞춥니다.

- **공유 기억/** — 두 PC가 같이 쓰는 지침·메모리·공통 커맨드·서브 에이전트입니다. 공유를 허용한 세션(ODDIN 기억 탭 "새 기억 저장: 공유")이 끝나면 ODDIN이 정리한 장기 기억이 여기에 들어갑니다. 각 PC의 \`~/.ai-shared\`(작업본)와 자동으로 맞춥니다. 메모리 목록은 \`공유 기억/memory/global/MEMORY.md\`(주제별 블록)부터 보면 됩니다.
- **자산/<분류>/** — 공유를 허용한 세션에서 만든 결과물 중 다시 쓸 것(완성된 시안·이미지·영상·템플릿·스크립트·문서)을 ODDIN이 골라 넣습니다. \`자산/소스/\`에는 각 PC가 공유하는 폴더(플러그인 소스 등)의 사본이 원본 PC에서 계속 맞춰집니다.
- **자산/${CATALOG}** — 자산 목록입니다(자동). 같은 목록이 공유 기억(reference-oddin-assets)에도 들어가 두 PC의 AI가 봅니다.

직접 넣은 파일도 그대로 둡니다. 같은 파일을 두 PC가 동시에 고치면 드라이브가 \`이름 (1)\` 같은 사본을 만들 수 있고, ODDIN은 그런 사본을 맞추지 않습니다.
`;

export class DriveHub {
  /** driveRoot·name: 시험용(가짜 드라이브 위치·폴더 이름) */
  constructor({ driveRoot = null, name = HUB_NAME } = {}) { this.driveRoot = driveRoot; this.name = name; this.tidied = false; }
  drive() { return detectDrive(this.driveRoot || undefined); }
  /** 쓰는 중인 ODDIN 폴더 { id, root, memory, assets, createdAt, createdBy } 또는 null */
  info() {
    const d = this.drive(); if (!d) return null;
    const root = path.join(d.myDrive, this.name);
    let mark; try { mark = JSON.parse(fs.readFileSync(path.join(root, MARK), 'utf8')); } catch { return null; }
    if (!mark?.id) return null;
    const h = { id: mark.id, root, memory: path.join(root, MEMORY_DIR), assets: path.join(root, ASSETS_DIR), createdAt: mark.createdAt || null, createdBy: mark.createdBy || null };
    if (!this.tidied) { this.tidied = true; this.tidy(h); }
    return h;
  }
  /** 설명서를 지금 판으로, 예전에 만들던 빈 칸(자산/공용) 지우기. ODDIN 이 쓴 설명서만 고친다 */
  tidy(h) {
    try {
      const f = path.join(h.root, 'README.md'); let cur = null; try { cur = fs.readFileSync(f, 'utf8'); } catch {}
      if (cur !== README && (cur == null || /^# ODDIN( 공유 폴더)?\r?\n/.test(cur))) fs.writeFileSync(f, README);
      for (const n of LEGACY) { const p = path.join(h.assets, n); try { if (fs.readdirSync(p).filter((x) => !IGNORE.test(x)).length === 0) fs.rmSync(p, { recursive: true, force: true }); } catch {} }
    } catch {}
  }
  /** 만들기(이미 있으면 그대로). 같은 이름 폴더가 표식 없이 있으면 안의 파일은 두고 표식만 붙인다 */
  create(by = null) {
    const d = this.drive(); if (!d) throw error(404, '이 PC에서 구글 드라이브를 찾지 못했어요');
    const cur = this.info(); if (cur) return { ...cur, created: false };
    const root = path.join(d.myDrive, this.name);
    fs.mkdirSync(path.join(root, MEMORY_DIR), { recursive: true });
    fs.mkdirSync(path.join(root, ASSETS_DIR), { recursive: true });
    if (!fs.existsSync(path.join(root, 'README.md'))) fs.writeFileSync(path.join(root, 'README.md'), README);
    fs.writeFileSync(path.join(root, MARK), JSON.stringify({ id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), createdBy: by }, null, 2) + '\n');
    return { ...this.info(), created: true };
  }
  /** 자산: 분류 폴더(자산/<분류>)마다 { name, path, items } 와 목록 항목 수 */
  assets() {
    const h = this.info(); if (!h) return { categories: [], total: 0, catalog: null };
    let names = []; try { names = fs.readdirSync(h.assets, { withFileTypes: true }).filter((e) => e.isDirectory() && !IGNORE.test(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b)); } catch {}
    const items = readCatalog(h.assets);
    const categories = names.map((n) => { let count = 0; try { count = fs.readdirSync(path.join(h.assets, n)).filter((x) => !IGNORE.test(x)).length; } catch {} return { name: n, path: path.join(h.assets, n), items: count, listed: items.filter((it) => it.rel.split('/')[0] === n).length }; });
    return { categories, total: items.length, catalog: fs.existsSync(path.join(h.assets, CATALOG)) ? path.join(h.assets, CATALOG) : null, recent: items.slice(0, 8) };
  }
}
