// Makes the Chrome Web Store screenshots (1280 × 800 PNG) and promo images in dist/screenshots/
// from the preview pages. Run with `npm run screenshots`.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = join(ROOT, 'dist', 'screenshots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const SHOTS = [
  { file: '1-question.png', page: 'popup', s: 'detected', caption: 'A login page turns your other extensions off' },
  { file: '2-strict.png', page: 'popup', s: 'strict', caption: 'Your bank: extensions off while it is open, logged out when you leave' },
  { file: '3-settings.png', page: 'options', s: 'strict', caption: 'Choose your sites, their level and the extensions you trust' },
  { file: '4-risk.png', page: 'options', s: 'strict', scroll: 'global', caption: 'See the risk of every extension and choose which ones you trust' },
  { file: '5-welcome.png', page: 'welcome', s: 'setup', caption: 'Nothing changes until you agree. No data leaves your browser.' },
];
// Promo images: the small tile appears on the store's home page, in categories and in search.
const PROMOS = [
  { file: 'promo-small-440x280.png', size: 'small', width: 440, height: 280 },
  { file: 'promo-marquee-1400x560.png', size: 'marquee', width: 1400, height: 560 },
];

// Serves the project folder, read-only, on a free local port.
function serve() {
  const server = createServer((req, res) => {
    const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!path.startsWith(ROOT) || !existsSync(path) || statSync(path).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' }).end(readFileSync(path));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

mkdirSync(OUT, { recursive: true });
const server = await serve();
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  for (const shot of SHOTS) {
    const query = new URLSearchParams({ page: shot.page, s: shot.s, caption: shot.caption, scroll: shot.scroll || '' });
    await page.goto(`http://127.0.0.1:${server.address().port}/tools/screenshots/frame.html?${query}`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 800)); // the preview renders after its module scripts load
    await page.screenshot({ path: join(OUT, shot.file) });
    console.log(join('dist', 'screenshots', shot.file));
  }
  for (const promo of PROMOS) {
    await page.setViewport({ width: promo.width, height: promo.height, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${server.address().port}/tools/screenshots/promo.html?size=${promo.size}`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: join(OUT, promo.file) });
    console.log(join('dist', 'screenshots', promo.file));
  }
} finally {
  await browser.close();
  server.close();
}
