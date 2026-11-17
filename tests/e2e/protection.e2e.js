// Browser tests: Tab Chaperone in a real Chrome (Chrome for Testing, installed by Puppeteer).
// They check the whole chain: navigation events, the detector, turning extensions off and on.
// Run with `npm run test:chrome`. Slower than `npm test`, so kept separate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = new URL('../../', import.meta.url).pathname;
const DUMMY = new URL('./dummy-extension/', import.meta.url).pathname;
const FILES = ['manifest.json', '_locales', 'icons', 'lib', 'background.js', 'detector.js', 'detector-extended.js',
  'offscreen.html', 'offscreen.js', 'welcome.html', 'welcome.js', 'popup.html', 'popup.js', 'options.html', 'options.js', 'styles.css'];

// A copy of the extension with website access granted at install: in the real extension it is
// optional and Chrome asks for it, which a test can't click.
function extensionCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'tab-chaperone-e2e-'));
  for (const file of FILES) cpSync(join(ROOT, file), join(dir, file), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = manifest.optional_host_permissions;
  delete manifest.optional_host_permissions;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

// A page that opens its login form as an overlay, the way many shops do.
const OVERLAY_PAGE = `<button id="open">Log in</button><script>
document.getElementById('open').onclick = () => {
  const overlay = document.createElement('div');
  overlay.id = 'overlay';
  overlay.innerHTML = '<input type="password"><button id="done">Done</button>';
  document.body.append(overlay);
  document.getElementById('done').onclick = () => overlay.remove();
};
</script>`;

// Test pages: a login form that posts and redirects, a page with a login overlay and a page
// without fields.
function startServer() {
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      req.resume();
      res.writeHead(302, { Location: '/list' }).end();
      return;
    }
    const body = req.url.startsWith('/login')
      ? '<form method="post"><input type="password" name="password"><button>Log in</button></form>'
      : req.url.startsWith('/deals') ? OVERLAY_PAGE : '<h1>List</h1><p>No fields here.</p>';
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Polls `check` until it returns true, or fails after `ms`.
async function waitFor(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

// Starts Chrome with Tab Chaperone and the dummy, stores `local` and returns helpers.
async function start(local) {
  const extension = extensionCopy();
  const server = await startServer();
  const browser = await puppeteer.launch({
    headless: true,
    args: [`--disable-extensions-except=${extension},${DUMMY}`, `--load-extension=${extension},${DUMMY}`],
  });
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
  const worker = await target.worker();
  const dummyId = await worker.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name === 'Tab Chaperone test dummy').id);
  // Wait for the first start (migration) to finish, or it may overwrite the test settings.
  await waitFor(() => worker.evaluate(async () => (await chrome.storage.session.get('booted')).booted === true), 10000, 'boot');
  await worker.evaluate((items) => chrome.storage.local.set(items), local);
  const page = await browser.newPage();
  const port = server.address().port;
  return {
    page,
    url: (host, path) => `http://${host}:${port}${path}`,
    dummyOn: () => worker.evaluate(async (id) => (await chrome.management.get(id)).enabled, dummyId),
    async stop() {
      await browser.close();
      server.close();
      rmSync(extension, { recursive: true, force: true });
    },
  };
}

const settings = (extra) => ({ sites: [], globalWhitelist: [], fieldDetection: false, sensitiveFields: false, detectionExclusions: [], clearClipboard: false, ...extra });

test('a whole-site protected site turns other extensions off, leaving turns them back on', async () => {
  const chrome = await start({ consent: true, settings: settings({ sites: [{ domain: '127.0.0.1', extra: [], level: 'site' }] }) });
  try {
    await chrome.page.goto(chrome.url('127.0.0.1', '/list'));
    await waitFor(async () => !(await chrome.dummyOn()), 8000, 'dummy off');
    // Tab Chaperone restarts the navigation into a protected site; leaving within milliseconds,
    // faster than a person can, would race with that restart.
    await waitFor(() => chrome.page.evaluate(() => location.hostname === '127.0.0.1' && document.readyState === 'complete').catch(() => false), 5000, 'page loaded');
    await new Promise((r) => setTimeout(r, 500));
    await chrome.page.goto(chrome.url('localhost', '/list'));
    await waitFor(() => chrome.dummyOn(), 10000, 'dummy back on');
  } finally {
    await chrome.stop();
  }
});

test('a detected password field: off on the login page, back on after logging in', async () => {
  const chrome = await start({ consent: true, settings: settings({ fieldDetection: true }) });
  try {
    await chrome.page.goto(chrome.url('127.0.0.1', '/login'));
    await waitFor(async () => !(await chrome.dummyOn()), 8000, 'dummy off on the login page');
    await chrome.page.waitForSelector('form');
    await Promise.all([chrome.page.waitForNavigation(), chrome.page.$eval('form', (form) => form.submit())]);
    assert.ok(chrome.page.url().endsWith('/list'));
    await waitFor(() => chrome.dummyOn(), 20000, 'dummy back on after logging in');
  } finally {
    await chrome.stop();
  }
});

test('a login overlay: the reload closes it, the tab stays protected until the form is gone', async () => {
  const chrome = await start({ consent: true, settings: settings({ fieldDetection: true }) });
  const page = chrome.page;
  const loaded = () => page.evaluate(() => document.readyState === 'complete' && !!document.getElementById('open')).catch(() => false);
  try {
    await page.goto(chrome.url('127.0.0.1', '/deals'));
    await waitFor(loaded, 5000, 'deals page');
    assert.equal(await chrome.dummyOn(), true, 'no field yet');
    await page.evaluate(() => { window.firstDocument = true; });
    await page.click('#open');
    await waitFor(async () => !(await chrome.dummyOn()), 8000, 'dummy off when the form opens');
    await waitFor(async () => (await loaded()) && !(await page.evaluate(() => window.firstDocument).catch(() => true)), 8000, 'the reload');
    await new Promise((r) => setTimeout(r, 5000)); // longer than the grace period
    assert.equal(await chrome.dummyOn(), false, 'still off after the reload, without a field');

    await page.evaluate(() => { window.secondDocument = true; });
    await page.click('#open'); // open the login form again
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(await page.evaluate(() => window.secondDocument), true, 'no second reload');
    assert.equal(await chrome.dummyOn(), false);

    await page.click('#done'); // logged in: the form closes
    await new Promise((r) => setTimeout(r, 5000));
    assert.equal(await chrome.dummyOn(), false, 'a short gap without a field keeps it off');
    await waitFor(() => chrome.dummyOn(), 20000, 'dummy back on after the form is gone');
    assert.equal(await page.evaluate(() => window.secondDocument), true, 'the page was not reloaded');
  } finally {
    await chrome.stop();
  }
});

test('nothing is turned off before consent on the welcome page', async () => {
  const chrome = await start({ consent: false, settings: settings({ sites: [{ domain: '127.0.0.1', extra: [], level: 'site' }] }) });
  try {
    await chrome.page.goto(chrome.url('127.0.0.1', '/list'));
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(await chrome.dummyOn(), true);
  } finally {
    await chrome.stop();
  }
});
