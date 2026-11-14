import './chrome-stub.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, getSettings, isPaused, pauseFor, getState, actions, addLog, getLog, logText, normalizeSettings, LOG_MAX, SCHEMA_VERSION } from '../lib/storage.js';
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
  assert.equal(settings.sites[0].cleanup, false);
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

test('actions update settings without duplicates', async () => {
  await actions.addSite('bank.com');
  await actions.addSite('bank.com');
  await actions.setSiteExtra('bank.com', 'grammar', true);
  await actions.setSiteCleanup('bank.com', true);
  await actions.setAlwaysOn('pw', true);
  await actions.addExclusion('shop.com');
  const s = await getSettings();
  assert.deepEqual(s.sites, [{ domain: 'bank.com', extra: ['grammar'], cleanup: true }]);
  assert.deepEqual(s.globalWhitelist, ['pw']);
  assert.deepEqual(s.detectionExclusions, ['shop.com']);

  const where = await actions.removeFromAllowlists(['grammar', 'pw']);
  assert.deepEqual(where.grammar, { global: false, sites: ['bank.com'] });
});

test('audit fix: "Allow again" approves the permissions shown in the alert, in one write', async () => {
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

test('audit fix: a pause is bound to sites and a time', async () => {
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
