// 빌드한 최신 설치 파일을 이 PC에 조용히 설치한다 (사용자 폴더 설치, 관리자 권한 필요 없음)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dist = path.join(__dirname, '..', 'dist');
const ver = require('../package.json').version;
const exe = path.join(dist, `AI-Hub-Setup-${ver}.exe`);
if (!fs.existsSync(exe)) { console.error('설치 파일이 없어요. 먼저 npm run dist 를 실행하세요: ' + exe); process.exit(1); }
console.log('설치 중: ' + exe);
const r = spawnSync(exe, ['/S'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('설치 실패 (종료 코드 ' + r.status + ')'); process.exit(r.status || 1); }
console.log('설치 완료: 시작 메뉴·바탕화면의 AI Hub');
