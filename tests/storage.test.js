import './chrome-stub.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, getSettings, isPaused, getState, actions, addLog, getLog, logText, LOG_MAX, SCHEMA_VERSION } from '../lib/storage.js';

beforeEach(() => {
  chrome.storage.local.reset();
  chrome.storage.session.reset();
});

test('migrates v1 data to the current schema', async () => {
  chrome.storage.local.reset({
    settings: { sites: [{ domain: 'bank.com', extra: [] }], globalWhitelist: ['pw'], passwordDetection: true, paused: true },
    state: { disabledByUs: ['ads'], autoSites: ['x.com'] },
    alerts: [{ id: 'a', reason: 'permissions', added: ['cookies'] }],
  });
  assert.equal(await migrate(), true);
  const settings = await getSettings();
  assert.equal(settings.fieldDetection, true);
  assert.equal('passwordDetection' in settings, false);
  assert.equal('paused' in settings, false);
  assert.equal(settings.sites[0].cleanup, false);
  assert.equal(await isPaused(), true);
  assert.equal('autoSites' in (await getState()), false);
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
  await actions.restoreAllowlists('grammar', where.grammar);
  assert.deepEqual((await getSettings()).sites[0].extra, ['grammar']);
});

test('log is capped and readable', async () => {
  for (let i = 0; i < LOG_MAX + 5; i++) await addLog({ type: 'clipboard' });
  assert.equal((await getLog()).length, LOG_MAX);
  assert.equal(logText({ type: 'enabled', names: ['A', 'B'] }), 'Turned 2 extension(s) back on: A, B');
  assert.equal(logText({ type: 'error', context: 'reloading a tab', message: 'boom' }), 'Error while reloading a tab: boom');
});
