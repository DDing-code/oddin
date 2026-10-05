// 이 PC 전용 지침(AGENTS.local.md): 읽기·쓰기(원래 판 백업), CLAUDE.md 불러오기 줄 판단
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLocalInstructions, writeLocalInstructions, setupStatus } from '../lib/shared-setup.mjs';

test('이 PC 전용 지침 읽기·쓰기와 CLAUDE.md 불러오기 줄', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-local-'));
  try {
    const hub = path.join(dir, 'shared'), home = path.join(dir, 'home');
    fs.mkdirSync(path.join(hub, 'sync'), { recursive: true }); fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    assert.equal(readLocalInstructions(hub).exists, false);
    const r1 = writeLocalInstructions(hub, '# 회사 지침\n- 하나', { runSync: false });
    assert.equal(r1.content, '# 회사 지침\n- 하나\n');
    writeLocalInstructions(hub, '# 회사 지침\n- 둘\n', { runSync: false });
    assert.equal(fs.readdirSync(path.join(hub, 'backups', 'local-instructions')).length, 1, '원래 판 백업');
    // CLAUDE.md 가 공용 지침만 불러오면 전용 지침 줄이 빠진 것으로
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '@~/.ai-shared/AGENTS.md\n@~/.ai-shared/memory/global/MEMORY.md\n');
    assert.deepEqual(setupStatus(hub, home).claudeMd.missing, ['@~/.ai-shared/AGENTS.local.md']);
    // ~/.codex/AGENTS.md 를 불러오고 있으면 그 안의 LOCAL 블록으로 들어가므로 빠진 것이 아님
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '@~/.ai-shared/AGENTS.md\n@~/.ai-shared/memory/global/MEMORY.md\n@C:/Users/USER/.codex/AGENTS.md\n');
    const st = setupStatus(hub, home);
    assert.deepEqual(st.claudeMd.missing, []); assert.equal(st.local.chars, '# 회사 지침\n- 둘\n'.length);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
