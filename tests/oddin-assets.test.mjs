// ODDIN 자산: 기억 정리가 고른 결과물을 드라이브 ODDIN/자산/<분류>/ 로 — 결과에 나온 경로만, 비밀·시스템 폴더 빼고, 목록·공유 기억 갱신, 되돌리기
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DriveHub } from '../lib/drive-hub.mjs';
import { checkAsset, saveAssets, undoAssets, readCatalog } from '../lib/oddin-assets.mjs';

const put = (root, files) => { for (const [rel, text] of Object.entries(files)) { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); } };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-assets-'));
  fs.mkdirSync(path.join(dir, 'drive', '내 드라이브'), { recursive: true });
  const hub = new DriveHub({ driveRoot: path.join(dir, 'drive') }).create('home');
  const shared = path.join(dir, 'shared'); put(shared, { 'memory/global/MEMORY.md': '# 공용 메모리 (전역)\n\n## ODDIN·공유 기억\n- [가](a.md) — 가\n\n## 미분류\n', 'memory/global/a.md': '가' });
  const work = path.join(dir, 'work');
  put(work, { 'out/썸네일.png': 'PNG1', 'tpl/a.txt': '템플릿 a', 'tpl/b/c.txt': '템플릿 c', 'tpl/node_modules/x.js': 'x', 'tpl/.env': 'KEY=1', '.env': 'SECRET=1' });
  return { dir, hub, shared, work };
}

test('자산 후보 검사: 결과에 나온 경로만, 비밀 파일·사용자 폴더 전체는 안 됨', () => {
  const { dir, hub, shared, work } = setup();
  try {
    const png = path.join(work, 'out', '썸네일.png');
    const mentioned = `만든 파일: ${png.replace(/\\/g, '/')} 그리고 ${path.join(work, '.env')}`;
    const ok = checkAsset({ path: png, name: '썸네일 시안', category: '이미지', description: '유튜브 썸네일 최종안' }, { mentioned, hub, hubDir: shared });
    assert.equal(ok.ok, true); assert.equal(ok.isDir, false);
    assert.match(checkAsset({ path: path.join(work, 'tpl'), name: 't', category: '문서', description: 'd' }, { mentioned, hub, hubDir: shared }).why, /결과·보고에 나온 경로가 아니/);
    assert.match(checkAsset({ path: path.join(work, '.env'), name: 'e', category: '문서', description: 'd' }, { mentioned, hub, hubDir: shared }).why, /비밀/);
    assert.match(checkAsset({ path: 'out/썸네일.png', name: 'x', category: '이미지', description: 'd' }, { mentioned, hub }).why, /절대 경로/);
    assert.match(checkAsset({ path: dir, name: 'x', category: '기타', description: 'd' }, { mentioned: dir, hub, homeDir: dir }).why, /사용자 폴더/);
    assert.match(checkAsset({ path: png, name: 'x', category: '이미지', description: '' }, { mentioned, hub }).why, /설명/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('자산 올리기: 파일·폴더 복사, 목록·공유 기억 갱신, 같은 판은 그대로, 되돌리기', async () => {
  const { dir, hub, shared, work } = setup();
  try {
    const png = path.join(work, 'out', '썸네일.png'), tpl = path.join(work, 'tpl');
    const mentioned = `① 썸네일 ${png} ② 템플릿 폴더 ${tpl}`;
    const items = [
      { path: png, name: '썸네일 시안', category: '이미지', description: '유튜브 썸네일 최종안' },
      { path: tpl, name: '자막 템플릿', category: '템플릿', description: '자막 스타일 템플릿' },
      { path: path.join(work, 'nope.txt'), name: '없음', category: '문서', description: '없는 파일' },
    ];
    const res = await saveAssets({ hub, hubDir: shared, items, mentioned, source: { machine: '집', at: '2026-10-05T07:00:00Z', request: '썸네일 만들어 줘' } });
    assert.deepEqual(res.map((r) => r.status), ['saved', 'saved', 'skipped']);
    assert.equal(fs.readFileSync(path.join(hub.assets, '이미지', '썸네일 시안.png'), 'utf8'), 'PNG1');
    assert.equal(fs.readFileSync(path.join(hub.assets, '템플릿', '자막 템플릿', 'b', 'c.txt'), 'utf8'), '템플릿 c');
    assert.ok(!fs.existsSync(path.join(hub.assets, '템플릿', '자막 템플릿', 'node_modules')), 'node_modules 빼기');
    assert.ok(!fs.existsSync(path.join(hub.assets, '템플릿', '자막 템플릿', '.env')), '비밀 파일 빼기');
    const cat = readCatalog(hub.assets);
    assert.deepEqual(cat.map((c) => c.rel).sort(), ['이미지/썸네일 시안.png', '템플릿/자막 템플릿']);
    assert.match(cat.find((c) => c.rel.startsWith('이미지')).rest, /유튜브 썸네일 최종안 \(집 · 2026-10-05 · 요청: 썸네일 만들어 줘\)/);
    const mem = fs.readFileSync(path.join(shared, 'memory', 'global', 'reference-oddin-assets.md'), 'utf8');
    assert.match(mem, /name: reference-oddin-assets/); assert.ok(mem.includes('이미지/썸네일 시안.png'));
    const index = fs.readFileSync(path.join(shared, 'memory', 'global', 'MEMORY.md'), 'utf8');
    assert.ok(index.indexOf('reference-oddin-assets.md') > index.indexOf('## ODDIN·공유 기억') && index.indexOf('reference-oddin-assets.md') < index.indexOf('## 미분류'), 'ODDIN·공유 기억 블록에');

    // 같은 판을 다시 → 그대로, 고친 판 → 새로 복사(새로 만든 것은 아님)
    const again = await saveAssets({ hub, hubDir: shared, items: items.slice(0, 1), mentioned, source: { machine: '회사' } });
    assert.equal(again[0].status, 'same');
    put(work, { 'out/썸네일.png': 'PNG2' });
    const newer = await saveAssets({ hub, hubDir: shared, items: items.slice(0, 1), mentioned, source: { machine: '회사' } });
    assert.equal(newer[0].status, 'saved'); assert.equal(newer[0].created, false);
    assert.equal(fs.readFileSync(path.join(hub.assets, '이미지', '썸네일 시안.png'), 'utf8'), 'PNG2');
    assert.match(readCatalog(hub.assets).find((c) => c.rel.startsWith('이미지')).rest, /회사/);

    // 되돌리기: 이 요청이 새로 만든 것만 지운다
    const undo = undoAssets({ hub, hubDir: shared, results: res });
    assert.deepEqual(undo.map((u) => u.status), ['removed', 'removed']);
    assert.ok(!fs.existsSync(path.join(hub.assets, '템플릿', '자막 템플릿')));
    assert.equal(readCatalog(hub.assets).length, 0);
    assert.equal(undoAssets({ hub, hubDir: shared, results: newer }).length, 0, '원래 있던 자산을 고친 것은 지우지 않음');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
