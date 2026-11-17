// Per-tab tracking: detected fields, questions, popups and load times.
import './chrome-stub.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTabTracker, ASK_NOTIFICATION, RELEASE_MS, GUARD_IDLE_MS } from '../lib/tabs.js';
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

test('a guarded tab stays protected on its site until the login form is gone', async () => {
  await tracker.flagTab({ id: 1, url: 'https://www.shop.com/deals' });
  await tracker.guardTab(1, 'www.shop.com');
  await tracker.forgetTab(1, 'https://www.shop.com/deals'); // the reload
  assert.deepEqual(await getTabData('flagged'), { 1: 'www.shop.com' }, 'the reload keeps the flag');
  await tracker.fieldsPresent(1); // you opened the login form again
  assert.deepEqual(await getTabData('guarded'), { 1: { domain: 'shop.com', seen: true } });
  assert.deepEqual(await getTabData('releases'), {});
  await tracker.fieldsGone(1, 1000); // logged in: the form closed
  assert.deepEqual(await getTabData('releases'), { 1: 1000 + RELEASE_MS });
  assert.equal(await tracker.expire(1000), 1000 + RELEASE_MS, 'not yet');
  assert.equal(await tracker.expire(1000 + RELEASE_MS), null);
  assert.deepEqual(await getTabData('flagged'), {});
  assert.deepEqual(await getTabData('guarded'), {});
});

test('a field that comes back in time cancels the release', async () => {
  await tracker.flagTab({ id: 1, url: 'https://forum.com/login' });
  await tracker.fieldsGone(1, 1000);
  await tracker.fieldsPresent(1); // the next login step
  assert.equal(await tracker.expire(1000 + RELEASE_MS), null);
  assert.deepEqual(await getTabData('flagged'), { 1: 'forum.com' });
});

test('a guarded tab without a login form is released after the idle time', async () => {
  await tracker.flagTab({ id: 1, url: 'https://shop.com/' });
  await tracker.guardTab(1, 'shop.com');
  const due = (await getTabData('releases'))[1];
  assert.ok(due - Date.now() > GUARD_IDLE_MS - 1000);
  await tracker.forgetTab(1, 'https://shop.com/item'); // browsing the site, no field seen yet
  assert.equal((await getTabData('releases'))[1], due, 'browsing does not shorten the wait');
  await tracker.expire(due);
  assert.deepEqual(await getTabData('flagged'), {});
});

test('after logging in, a new page without a field releases the guarded tab', async () => {
  await tracker.flagTab({ id: 1, url: 'https://shop.com/' });
  await tracker.guardTab(1, 'shop.com');
  await tracker.fieldsPresent(1);
  await tracker.forgetTab(1, 'https://shop.com/account');
  assert.deepEqual(await getTabData('flagged'), { 1: 'shop.com' });
  assert.ok((await getTabData('releases'))[1] - Date.now() <= RELEASE_MS);
});

test('a guarded tab that goes to another site, or is closed, is forgotten', async () => {
  await tracker.flagTab({ id: 1, url: 'https://shop.com/' });
  await tracker.guardTab(1, 'shop.com');
  await tracker.forgetTab(1, 'https://news.com/');
  assert.deepEqual([await getTabData('flagged'), await getTabData('guarded'), await getTabData('releases')], [{}, {}, {}]);
  await tracker.flagTab({ id: 2, url: 'https://shop.com/' });
  await tracker.guardTab(2, 'shop.com');
  await tracker.forgetTab(2);
  assert.deepEqual([await getTabData('flagged'), await getTabData('guarded'), await getTabData('releases')], [{}, {}, {}]);
});

test('"Turn extensions back on" releases the tab at once', async () => {
  await tracker.flagTab({ id: 1, url: 'https://shop.com/' });
  await tracker.guardTab(1, 'shop.com');
  await tracker.releaseTab(1);
  assert.deepEqual([await getTabData('flagged'), await getTabData('guarded'), await getTabData('releases')], [{}, {}, {}]);
});
