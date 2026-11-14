import './chrome-stub.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, getSettings, isPaused, pauseFor, getState, actions, addLog, getLog, logText, normalizeSettings, LOG_MAX, SCHEMA_VERSION, getAsks, setAsks, openAsks, hasConsent, giveConsent, exportSettings, importSettings, prepareImport } from '../lib/storage.js';
import { PAUSE_MAX_MS } from '../lib/planner.js';

beforeEach(() => {
  chrome.storage.local.reset();
  chrome.storage.session.reset();
});

test('migrates v1 data to the current schema', async () => {
  chrome.storage.local.reset({
    settings: { sites: [{ domain: 'bank.com', extra: [] }], globalWhitelist: ['pw'], passwordDetection: true, paused: true },
    state: { disabledByUs: ['ads'], autoSites: ['x.com'], protectedTabIds: [1], cleanSince: 5 },
    alerts: [{ id: 'a', reason: 'permissions', added: ['cookies'] }],
  });
  assert.equal(await migrate(), true);
  const settings = await getSettings();
  assert.equal(settings.fieldDetection, true);
  assert.equal('passwordDetection' in settings, false);
  assert.equal('paused' in settings, false);
  assert.equal(settings.sites[0].level, 'site');
  assert.equal(await isPaused(), false, 'an old global pause is dropped');
  const state = await getState();
  assert.equal('autoSites' in state, false);
  assert.equal('protectedTabIds' in state, false);
  assert.equal('cleanSince' in state, false);
  assert.deepEqual((await getState()).disabledByUs, ['ads']);
  const { alerts, schemaVersion } = await chrome.storage.local.get(['alerts', 'schemaVersion']);
  assert.equal('reason' in alerts[0], false);
  assert.equal(schemaVersion, SCHEMA_VERSION);
  assert.equal(await migrate(), false, 'running twice is a no-op');
});

test('v4 data: the cleanup flag and the login-only list become a level per site', async () => {
  chrome.storage.local.reset({
    schemaVersion: 4,
    settings: { sites: [{ domain: 'bank.com', extra: ['pw'], cleanup: true }, { domain: 'mail.com', extra: [], cleanup: false }], loginOnly: ['forum.com', 'bank.com'] },
  });
  assert.equal(await migrate(), true);
  const settings = await getSettings();
  assert.deepEqual(settings.sites, [
    { domain: 'bank.com', extra: ['pw'], level: 'strict' },
    { domain: 'mail.com', extra: [], level: 'site' },
    { domain: 'forum.com', extra: [], level: 'login' },
  ]);
  assert.equal('loginOnly' in settings, false);
  const { settings: stored } = await chrome.storage.local.get('settings');
  assert.equal('cleanup' in stored.sites[0], false);
});

test('consent: existing users count as agreed, a fresh install must agree first', async () => {
  chrome.storage.local.reset({ schemaVersion: 5, settings: { sites: [] } });
  await migrate();
  assert.equal(await hasConsent(), true);
  chrome.storage.local.reset();
  await migrate();
  assert.equal(await hasConsent(), false);
  await giveConsent();
  assert.equal(await hasConsent(), true);
});

test('actions update settings without duplicates', async () => {
  await actions.addSite('bank.com');
  await actions.addSite('bank.com');
  await actions.setSiteExtra('bank.com', 'grammar', true);
  await actions.setSiteLevel('bank.com', 'site');
  await actions.setSiteLevel('bank.com', 'strict');
  await actions.setAlwaysOn('pw', true);
  await actions.addExclusion('shop.com');
  const s = await getSettings();
  assert.deepEqual(s.sites, [{ domain: 'bank.com', extra: ['grammar'], level: 'strict' }]);
  assert.deepEqual(s.globalWhitelist, ['pw']);
  assert.deepEqual(s.detectionExclusions, ['shop.com']);

  const where = await actions.removeFromAllowlists(['grammar', 'pw']);
  assert.deepEqual(where.grammar, { global: false, sites: ['bank.com'] });
});

test('new sites are strict unless another level is chosen', async () => {
  await actions.addSite('bank.com');
  await actions.addSite('forum.com', 'site');
  assert.deepEqual((await getSettings()).sites.map((x) => [x.domain, x.level]), [['bank.com', 'strict'], ['forum.com', 'site']]);
});

test('answering the question stores the level and closes the question', async () => {
  await setAsks({ 'forum.com': 1, 'bank.com': 2, 'shop.com': 3, 'social.com': 4, 'news.com': 5 });
  await actions.chooseLevel('forum.com', 'login');
  await actions.chooseLevel('bank.com', 'strict');
  await actions.chooseLevel('social.com', 'site');
  await actions.chooseLevel('shop.com', 'never');
  const s = await getSettings();
  assert.deepEqual(s.sites.map((x) => [x.domain, x.level]), [['forum.com', 'login'], ['bank.com', 'strict'], ['social.com', 'site']]);
  assert.deepEqual(s.detectionExclusions, ['shop.com']);
  assert.deepEqual(Object.keys(await getAsks()), ['news.com']);
  assert.deepEqual(openAsks({ 'news.com': 1, 'login.social.com': 2 }, s), ['news.com'], 'a site that is already covered is not asked about');
});

test('"Allow again" approves the permissions shown in the alert, in one write', async () => {
  const approved = { version: '2', permissions: ['cookies'], hostPermissions: [] };
  chrome.storage.local.reset({
    settings: normalizeSettings({ sites: [{ domain: 'bank.com' }] }),
    alerts: [{ id: 'x', added: ['cookies'], approved, where: { global: true, sites: ['bank.com'] } }, { id: 'y' }],
    approvals: { other: approved },
  });
  await actions.allowAgain('x');
  const { settings, alerts, approvals } = await chrome.storage.local.get(['settings', 'alerts', 'approvals']);
  assert.deepEqual(settings.globalWhitelist, ['x']);
  assert.deepEqual(settings.sites[0].extra, ['x']);
  assert.deepEqual(alerts.map((a) => a.id), ['y']);
  assert.deepEqual(approvals.x, approved, 'the snapshot from the alert, not the current permissions');
  await actions.dismissAlert('y');
  assert.deepEqual((await chrome.storage.local.get('alerts')).alerts, []);
});

test('"Allow again" refuses alerts without a stored snapshot', async () => {
  chrome.storage.local.reset({ settings: normalizeSettings({}), alerts: [{ id: 'x', added: ['tabs'], where: { global: true, sites: [] } }] });
  assert.equal(await actions.allowAgain('x'), false);
  const { settings, alerts, approvals } = await chrome.storage.local.get(['settings', 'alerts', 'approvals']);
  assert.deepEqual(settings.globalWhitelist, []);
  assert.equal(alerts.length, 1);
  assert.equal(approvals, undefined);
});

test('allowing an extension stores the permissions you saw, without replacing an older approval', async () => {
  const seen = { version: '1', permissions: ['storage'], hostPermissions: [] };
  await actions.setAlwaysOn('a', true, seen);
  await actions.setSiteExtra('bank.com', 'a', true, { version: '2', permissions: ['cookies'], hostPermissions: [] });
  const { settings, approvals } = await chrome.storage.local.get(['settings', 'approvals']);
  assert.deepEqual(settings.globalWhitelist, ['a']);
  assert.deepEqual(approvals.a, seen);
});

test('a pause is bound to sites and a time', async () => {
  await pauseFor(['bank.com'], 1000);
  assert.deepEqual(await isPaused(), { sites: ['bank.com'], until: 1000 + PAUSE_MAX_MS });
  await chrome.storage.local.set({ paused: true });
  assert.equal(await isPaused(), false, 'a bare boolean is not a valid pause');
});

test('log is capped and readable', async () => {
  for (let i = 0; i < LOG_MAX + 5; i++) await addLog({ type: 'clipboard' });
  assert.equal((await getLog()).length, LOG_MAX);
  assert.equal(logText({ type: 'enabled', names: ['A', 'B'] }), 'Turned 2 extension(s) back on: A, B');
  assert.equal(logText({ type: 'error', context: 'reloading a tab', message: 'boom' }), 'Error while reloading a tab: boom');
});

test('migrates v2 data to the current schema', async () => {
  chrome.storage.local.reset({ schemaVersion: 2, settings: { fieldDetection: true }, paused: true, state: { disabledByUs: ['x'], protectedTabIds: [3], cleanSince: 9 } });
  assert.equal(await migrate(), true);
  assert.equal(await isPaused(), false);
  assert.equal((await getSettings()).fieldDetection, true);
  const { state } = await chrome.storage.local.get('state');
  assert.deepEqual(state, { disabledByUs: ['x'] });
});

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

test('export and import round-trip the settings', async () => {
  chrome.storage.local.reset({ approvals: { [A]: { permissions: [] } } });
  await actions.addSite('bank.com');
  await actions.setAlwaysOn(A, true);
  await actions.addExclusion('shop.com');
  const file = JSON.parse(JSON.stringify(await exportSettings()));
  chrome.storage.local.reset({ approvals: { [A]: { permissions: [] } } });
  assert.deepEqual(await importSettings(file, true), []);
  const s = await getSettings();
  assert.deepEqual(s.sites, [{ domain: 'bank.com', extra: [], level: 'strict' }]);
  assert.deepEqual(s.globalWhitelist, [A]);
  assert.deepEqual(s.detectionExclusions, ['shop.com']);
});

test('an import never trusts extensions this profile did not approve', () => {
  const data = { app: 'tab-chaperone', settings: {
    sites: [{ domain: 'https://www.Bank.com/x', extra: [A, B, 'not-an-id'], level: 'site' }, { domain: 'bank.com' }, { domain: 'bad domain' }],
    globalWhitelist: [B], detectionExclusions: ['ok.com', '???'], fieldDetection: 'yes',
  } };
  const { settings, skipped } = prepareImport(data, { [A]: {} });
  assert.deepEqual(settings.sites, [{ domain: 'bank.com', extra: [A], level: 'site' }]);
  assert.deepEqual(settings.globalWhitelist, []);
  assert.deepEqual(skipped, [B]);
  assert.deepEqual(settings.detectionExclusions, ['ok.com']);
  assert.equal(settings.fieldDetection, false);
});

test('automatic protection stays off after an import without website access', async () => {
  chrome.storage.local.reset();
  await importSettings({ app: 'tab-chaperone', settings: { fieldDetection: true } }, false);
  assert.equal((await getSettings()).fieldDetection, false);
});

test('an export made before the rename can still be imported', () => {
  assert.deepEqual(prepareImport({ app: 'exterminator', settings: { sites: [{ domain: 'bank.com' }] } }, {}).settings.sites, [{ domain: 'bank.com', extra: [], level: 'site' }]);
});

test('a file that is not an export is refused', () => {
  assert.throws(() => prepareImport({ settings: {} }, {}), /not a Tab Chaperone export/);
  assert.throws(() => prepareImport(null, {}), /not a Tab Chaperone export/);
});
