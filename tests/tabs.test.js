// Per-tab tracking: detected fields, questions, popups and load times.
import './chrome-stub.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTabTracker, ASK_NOTIFICATION } from '../lib/tabs.js';
import { getTabData, setTabData, getAsks, getLog, normalizeSettings } from '../lib/storage.js';

let notes;
let injected;
let tabs;
let tracker;

function setup(settings = {}) {
  chrome.storage.local.reset({ settings: normalizeSettings({ fieldDetection: true, ...settings }) });
  chrome.storage.session.reset();
  notes = [];
  injected = [];
  tabs = {};
  tracker = createTabTracker({
    notify: async (id, options) => notes.push({ id, ...options }),
    inject: (tabId, files) => injected.push({ tabId, files }),
    getTab: async (tabId) => tabs[tabId] || null,
  });
}
beforeEach(() => setup());

const logTypes = async () => (await getLog()).map((e) => `${e.type}:${e.site}`);

test('a flag lasts while the tab shows that page', async () => {
  assert.equal(await tracker.flagTab({ id: 1, url: 'https://forum.com/login' }), true);
  assert.deepEqual(await getTabData('flagged'), { 1: 'forum.com' });
  await tracker.forgetTab(1, 'https://forum.com/topics');
  assert.deepEqual(await getTabData('flagged'), {}, 'another page on the same host is not protected');
});

test('a new page with a field on the same host is flagged again without a second log entry', async () => {
  await tracker.flagTab({ id: 1, url: 'https://forum.com/login' });
  await tracker.forgetTab(1, 'https://forum.com/2fa');
  assert.equal(await tracker.flagTab({ id: 1, url: 'https://forum.com/2fa' }), true);
  assert.deepEqual(await logTypes(), ['detected:forum.com']);
});

test('the first detection on an unclassified site asks once', async () => {
  await tracker.flagTab({ id: 1, url: 'https://www.forum.com/login' });
  await tracker.forgetTab(1);
  await tracker.flagTab({ id: 2, url: 'https://www.forum.com/login' });
  assert.deepEqual(Object.keys(await getAsks()), ['forum.com']);
  assert.deepEqual(notes.map((n) => n.id), [`${ASK_NOTIFICATION}forum.com`]);
});

test('classified sites are not asked about; whole sites are not logged', async () => {
  setup({ sites: [{ domain: 'forum.com', level: 'login' }, { domain: 'bank.com', level: 'strict' }], detectionExclusions: ['shop.com'] });
  assert.equal(await tracker.flagTab({ id: 1, url: 'https://forum.com/login' }), true);
  assert.equal(await tracker.flagTab({ id: 2, url: 'https://bank.com/login' }), true);
  assert.equal(await tracker.flagTab({ id: 3, url: 'https://shop.com/login' }), false, 'excluded');
  assert.deepEqual(await getAsks(), {});
  assert.deepEqual(notes, []);
  assert.deepEqual(await logTypes(), ['detected:forum.com']);
});

test('nothing is flagged when detection is off', async () => {
  setup({ fieldDetection: false });
  assert.equal(await tracker.flagTab({ id: 1, url: 'https://forum.com/login' }), false);
});

test('a reused document forces a reload by forgetting the load time', async () => {
  await setTabData('loadTimes', { 1: 5000 });
  await tracker.flagTab({ id: 1, url: 'https://forum.com/login' });
  assert.equal(await tracker.flagTab({ id: 1, url: 'https://forum.com/login' }, true), true);
  assert.deepEqual(await getTabData('loadTimes'), { 1: 0 });
});

test('a single-page app: a new address rescans, the same address does not count', async () => {
  setup({ sensitiveFields: true });
  await tracker.flagTab({ id: 1, url: 'https://app.com/login#step1' });
  assert.equal(tracker.isFlaggedPage(1, 'https://app.com/login#step2'), true);
  assert.equal(tracker.isFlaggedPage(1, 'https://app.com/home'), false);
  assert.equal(await tracker.recheckTab(1), true);
  assert.deepEqual(await getTabData('flagged'), {});
  assert.deepEqual(injected, [{ tabId: 1, files: ['detector-extended.js', 'detector.js'] }]);
  assert.equal(await tracker.recheckTab(1), false, 'an unflagged tab is left alone');
});

test('a closed tab leaves nothing behind', async () => {
  await tracker.flagTab({ id: 1, url: 'https://forum.com/login' });
  await tracker.recordFrame(1, 'bank.com');
  await tracker.recordPrerender(1, 'bank.com');
  await tracker.recordLoad(1, 1000, 'https://forum.com/login', false);
  await setTabData('inherited', { 1: { host: 'bank.com', auto: false } });
  await tracker.forgetTab(1);
  for (const name of ['flagged', 'framed', 'prerender', 'inherited', 'loadTimes', 'loadHistory']) {
    assert.deepEqual(await getTabData(name), {}, name);
  }
});

test('a popup of a protected page keeps its site until it shows a web page of its own', async () => {
  setup({ sites: [{ domain: 'bank.com', level: 'site' }] });
  tabs[1] = { id: 1, url: 'https://online.bank.com/pay' };
  await tracker.recordOpener({ sourceTabId: 1, tabId: 2 });
  tabs[2] = { id: 2, url: 'about:blank' };
  await tracker.recordOpener({ sourceTabId: 2, tabId: 3 }); // opened by the popup
  assert.deepEqual(await getTabData('inherited'), {
    2: { host: 'online.bank.com', auto: false },
    3: { host: 'online.bank.com', auto: false },
  });
  await tracker.forgetTab(2, 'about:blank');
  assert.ok(2 in await getTabData('inherited'));
  await tracker.forgetTab(2, 'https://other.com/');
  assert.equal(2 in await getTabData('inherited'), false);
});

test('a back/forward restore uses the time the page first loaded', async () => {
  await tracker.recordLoad(1, 1000, 'https://a.com/', false);
  await tracker.recordLoad(1, 2000, 'https://b.com/', false);
  await tracker.recordLoad(1, 3000, 'https://a.com/', true);
  assert.deepEqual(await getTabData('loadTimes'), { 1: 1000 });
  await tracker.recordLoad(1, 4000, 'https://c.com/', true);
  assert.deepEqual(await getTabData('loadTimes'), { 1: 0 }, 'never seen: unknown');
});

test('a replaced tab keeps what was known, merged with the new tab', async () => {
  await setTabData('framed', { 1: ['bank.com'], 2: ['pay.com'] });
  await tracker.flagTab({ id: 1, url: 'https://forum.com/login' });
  await setTabData('loadTimes', { 1: 5000 });
  await tracker.replaceTab(2, 1);
  assert.deepEqual(await getTabData('framed'), { 2: ['pay.com', 'bank.com'] });
  assert.deepEqual(await getTabData('flagged'), { 2: 'forum.com' });
  assert.deepEqual(await getTabData('loadTimes'), {}, 'unknown load time forces a reload');
  assert.equal(tracker.isFlaggedPage(2, 'https://forum.com/login'), true);
});
