// 빌드한 프로그램이 이 PC 허브 폴더를 찾을 수 있게 위치를 적어 둔다 (desktop/ 의 상위 폴더)
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
if (!fs.existsSync(path.join(root, 'server.mjs'))) { console.error('허브 폴더를 찾지 못했어요: ' + root); process.exit(1); }
fs.writeFileSync(path.join(__dirname, '..', 'hub-root.json'), JSON.stringify({ root }, null, 2));
console.log('허브 폴더: ' + root);
