// ODDIN 새 판 받기: 임시 git 저장소(원본·허브 사본·다른 사본)로 받기·재시작 판단·거절 조건을 본다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyUpdate, checkUpdate, hubCommit } from '../lib/hub-update.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const commitFile = (repo, rel, text, msg) => {
  const f = path.join(repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text);
  git(repo, 'add', '-A'); git(repo, '-c', 'user.name=시험', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', msg);
};

test('새 판 받기: 최신이면 그대로, 화면만 바뀌면 재시작 없음, 서버가 바뀌면 재시작 필요, 고치던 것·앞선 커밋이 있으면 거절', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-update-'));
  try {
    const origin = path.join(dir, 'origin.git'), hub = path.join(dir, 'hub'), dev = path.join(dir, 'dev');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, dev]);
    commitFile(dev, 'server.mjs', '// 1', '처음'); git(dev, 'push', '-q', 'origin', 'HEAD:main');
    execFileSync('git', ['clone', '-q', origin, hub]);

    let r = await applyUpdate(hub, { restart: false });
    assert.equal(r.updated, false); assert.equal(r.message, '이미 최신이에요');

    commitFile(dev, 'public/app.js', '// 화면', '화면만'); git(dev, 'push', '-q', 'origin', 'HEAD:main');
    assert.equal((await checkUpdate(hub)).behind, 1);
    r = await applyUpdate(hub, { restart: false });
    assert.equal(r.updated, true); assert.equal(r.restart, false); assert.equal(r.files, 1);
    assert.equal(fs.readFileSync(path.join(hub, 'public', 'app.js'), 'utf8'), '// 화면');
    assert.equal(hubCommit(hub).commit, r.to);

    commitFile(dev, 'lib/jobs.mjs', '// 서버', '서버'); git(dev, 'push', '-q', 'origin', 'HEAD:main');
    r = await applyUpdate(hub, { restart: false });
    assert.equal(r.restart, true, '서버 파일이 바뀌면 재시작 필요');

    commitFile(dev, 'server.mjs', '// 2', '또'); git(dev, 'push', '-q', 'origin', 'HEAD:main');
    fs.writeFileSync(path.join(hub, 'server.mjs'), '// 고치던 것');
    await assert.rejects(applyUpdate(hub, { restart: false }), (e) => e.status === 409 && /커밋 안 한 변경/.test(e.message));
    git(hub, 'checkout', '--', 'server.mjs');
    commitFile(hub, 'local.txt', '이 PC 커밋', '이 PC만');
    await assert.rejects(applyUpdate(hub, { restart: false }), (e) => e.status === 409 && /이 PC에만 있는 커밋/.test(e.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
