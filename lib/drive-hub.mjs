// ODDIN 드라이브 폴더 (2026-10-05 사용자 "'오딘' 공유폴더를 만들고 거기에 정리된 메모리랑 자산들을 넣자").
// 구글 드라이브 "내 드라이브/ODDIN" 하나에 두 PC가 함께 쓸 것을 모은다(두 PC가 같은 구글 계정이라 같은 폴더가 보인다).
//   ODDIN/README.md          이 폴더 설명
//   ODDIN/공유 기억/           ~/.ai-shared 의 공유 범위(지침·메모리·공통 커맨드·서브 에이전트·동기화 스크립트) — 각 PC의 ODDIN 이 양방향으로 맞춘다(lib/shared-sync.mjs)
//   ODDIN/자산/<PC>/<폴더>/    각 PC가 "공유 폴더"로 정한 폴더(플러그인 소스 등) — 원본 PC가 한 방향으로 올린다(lib/shared-folders.mjs)
//   ODDIN/자산/공용/           사람이 직접 넣는 함께 쓸 파일(폰트·효과음·템플릿 등)
// - 로컬 ~/.ai-shared 는 그대로 작업본이다(CLI 훅·Claude 메모리 정션이 빠르고 드라이브가 꺼져도 동작). 드라이브는 두 PC 사이 전달·보관.
// - 표식 파일 .oddin.json(id)이 있어야 쓰는 중으로 본다. 만든 PC가 먼저 다 올리고, 다른 PC는 처음 본 뒤 몇 분 동안은 맞는 파일만 기준으로 삼는다(같은 파일을 두 PC가 동시에 올려 드라이브에 같은 이름 파일이 둘 생기지 않게).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { detectDrive } from './drive-folders.mjs';

export const HUB_NAME = 'ODDIN', MEMORY_DIR = '공유 기억', ASSETS_DIR = '자산', COMMON_DIR = '공용';
const MARK = '.oddin.json';
const error = (status, message) => Object.assign(new Error(message), { status });
const IGNORE = /^(desktop\.ini|Thumbs\.db|\.DS_Store|\.tmp\.drive.*|~\$.*)$/i;

const README = `# ODDIN 공유 폴더

집·회사 PC의 ODDIN이 함께 쓰는 구글 드라이브 폴더입니다. ODDIN이 만들고 맞춥니다.

- **공유 기억/** — 두 PC가 같은 기억을 쓰도록 모아 둔 지침·메모리·공통 커맨드·서브 에이전트입니다. 각 PC의 \`~/.ai-shared\`(작업본)와 ODDIN이 자동으로 맞춥니다. 여기서 직접 고쳐도 몇십 초 안에 두 PC에 반영됩니다. 메모리 목록은 \`공유 기억/memory/global/MEMORY.md\`(주제별 블록)부터 보면 됩니다.
- **자산/<PC 이름>/<폴더>/** — 각 PC가 ODDIN "공유 폴더"로 정한 폴더(어도비 플러그인 소스 등)의 사본입니다. 원본 PC가 계속 올리므로 여기서 고치면 다음 차례에 원본 내용으로 돌아갑니다. 고치려면 원본 PC에서.
- **자산/공용/** — 두 PC가 함께 쓸 파일(폰트·효과음·템플릿·참고 자료 등)을 직접 넣는 곳입니다. ODDIN 작업 폴더 목록에 "ODDIN 자산"으로 나옵니다.

같은 파일을 두 PC가 동시에 고치면 드라이브가 \`이름 (1)\` 같은 사본을 만들 수 있습니다. ODDIN은 그런 사본을 맞추지 않습니다.
`;

export class DriveHub {
  /** driveRoot·name: 시험용(가짜 드라이브 위치·폴더 이름) */
  constructor({ driveRoot = null, name = HUB_NAME } = {}) { this.driveRoot = driveRoot; this.name = name; }
  drive() { return detectDrive(this.driveRoot || undefined); }
  /** 쓰는 중인 ODDIN 폴더 { id, root, memory, assets, common, createdAt, createdBy } 또는 null */
  info() {
    const d = this.drive(); if (!d) return null;
    const root = path.join(d.myDrive, this.name);
    let mark; try { mark = JSON.parse(fs.readFileSync(path.join(root, MARK), 'utf8')); } catch { return null; }
    if (!mark?.id) return null;
    return { id: mark.id, root, memory: path.join(root, MEMORY_DIR), assets: path.join(root, ASSETS_DIR), common: path.join(root, ASSETS_DIR, COMMON_DIR), createdAt: mark.createdAt || null, createdBy: mark.createdBy || null };
  }
  /** 만들기(이미 있으면 그대로). 같은 이름 폴더가 표식 없이 있으면 안의 파일은 두고 표식만 붙인다 */
  create(by = null) {
    const d = this.drive(); if (!d) throw error(404, '이 PC에서 구글 드라이브를 찾지 못했어요');
    const cur = this.info(); if (cur) return { ...cur, created: false };
    const root = path.join(d.myDrive, this.name);
    fs.mkdirSync(path.join(root, MEMORY_DIR), { recursive: true });
    fs.mkdirSync(path.join(root, ASSETS_DIR, COMMON_DIR), { recursive: true });
    if (!fs.existsSync(path.join(root, 'README.md'))) fs.writeFileSync(path.join(root, 'README.md'), README);
    fs.writeFileSync(path.join(root, MARK), JSON.stringify({ id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), createdBy: by }, null, 2) + '\n');
    return { ...this.info(), created: true };
  }
  /** 자산 폴더 목록: 자산/공용, 자산/<PC>/<폴더> */
  assets() {
    const h = this.info(); if (!h) return [];
    const dirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !IGNORE.test(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b)); } catch { return []; } };
    const count = (dir) => { let n = 0; const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (n > 9999 || IGNORE.test(e.name)) continue; if (e.isDirectory()) walk(path.join(d, e.name)); else n++; } }; walk(dir); return n; };
    const out = [];
    for (const top of dirs(h.assets)) {
      const p = path.join(h.assets, top);
      if (top === COMMON_DIR) { out.push({ name: COMMON_DIR, path: p, files: count(p), common: true }); continue; }
      for (const sub of dirs(p)) out.push({ name: `${top}/${sub}`, pc: top, folder: sub, path: path.join(p, sub), files: count(path.join(p, sub)) });
    }
    return out;
  }
}
