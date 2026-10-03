// 빌드한 프로그램으로 시작 메뉴·바탕화면 바로가기를 만든다 (빌드 전이면 개발 실행용 바로가기)
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const exe = path.join(__dirname, '..', 'dist', 'win-unpacked', 'ODDIN.exe');
const args = ['--install-shortcuts'];
let cmd = exe;
if (!fs.existsSync(exe)) { cmd = require('electron'); args.unshift(path.join(__dirname, '..')); }
const r = spawnSync(cmd, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
