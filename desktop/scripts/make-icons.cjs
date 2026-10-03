// 앱 아이콘 만들기: SVG → build/icon-512.png · icon.png(256) · icon.ico(16~256, PNG 9장) · tray.png(16) · tray@2x.png(32)
// 실행(desktop 폴더): npx electron scripts/make-icons.cjs <앱.svg> [트레이.svg] [--out <폴더>]
// 트레이 SVG를 안 주면 앱 SVG로 트레이도 만든다. Electron 화면 밖 창에서 캔버스로 그려 크기마다 따로 래스터화한다.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(1);
const svgs = args.filter((a) => /[.]svg$/i.test(a));
const outAt = args.indexOf('--out');
const OUT = path.resolve(outAt >= 0 ? args[outAt + 1] : path.join(__dirname, '..', 'build'));
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// 크기마다 width·height 를 박아 넣어 그 크기로 래스터화되게 한다
const sized = (svg, n) => svg.replace(/<svg\b([^>]*)>/, (m, attrs) => `<svg${attrs.replace(/\s(width|height)=("[^"]*"|'[^']*')/g, '')} width="${n}" height="${n}">`);

function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ size, buf }, i) => {
    const o = 6 + 16 * i;
    head[o] = size >= 256 ? 0 : size; head[o + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(buf.length, o + 8); head.writeUInt32LE(off, o + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.buf)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    if (!svgs.length) throw new Error('앱 SVG 경로가 필요해요: npx electron scripts/make-icons.cjs <앱.svg> [트레이.svg]');
    const appSvg = fs.readFileSync(svgs[0], 'utf8');
    const traySvg = svgs[1] ? fs.readFileSync(svgs[1], 'utf8') : appSvg;
    const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,<!doctype html><title>icons</title>');
    const render = async (svg, n) => {
      const src = 'data:image/svg+xml;base64,' + Buffer.from(sized(svg, n)).toString('base64');
      const url = await win.webContents.executeJavaScript(`new Promise((ok, no) => {
        const img = new Image();
        img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${n}; const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, ${n}, ${n}); ok(c.toDataURL('image/png')); };
        img.onerror = () => no(new Error('SVG를 그리지 못했어요'));
        img.src = ${JSON.stringify(src)};
      })`);
      return Buffer.from(url.split(',')[1], 'base64');
    };
    fs.mkdirSync(OUT, { recursive: true });
    const write = (name, buf) => { fs.writeFileSync(path.join(OUT, name), buf); console.log(`${name}  ${buf.length} B`); };
    write('icon-512.png', await render(appSvg, 512));
    write('icon.png', await render(appSvg, 256));
    const pngs = []; for (const size of ICO_SIZES) pngs.push({ size, buf: await render(appSvg, size) });
    write('icon.ico', ico(pngs));
    write('tray.png', await render(traySvg, 16));
    write('tray@2x.png', await render(traySvg, 32));
    app.exit(0);
  } catch (e) {
    console.error('아이콘 만들기 실패:', e.message);
    app.exit(1);
  }
});
