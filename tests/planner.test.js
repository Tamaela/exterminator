import './chrome-stub.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, computeAllowed, removeFromAllowlists, DEFAULT_STATE } from '../lib/planner.js';
import { normalizeSettings } from '../lib/storage.js';

const GRACE = 3000;
const ext = (id, extra = {}) => ({ id, name: id.toUpperCase(), type: 'extension', enabled: true, mayDisable: true, ...extra });

function input(overrides = {}) {
  return {
    now: 100_000,
    graceMs: GRACE,
    settings: normalizeSettings({ sites: [{ domain: 'bank.com' }, { domain: 'tax.gov' }], globalWhitelist: ['pw'] }),
    state: { ...DEFAULT_STATE },
    paused: false,
    tabs: [],
    flaggedTabs: {},
    loadTimes: {},
    extensions: [ext('pw'), ext('ads'), ext('grammar'), ext('self')],
    selfId: 'self',
    ...overrides,
  };
}

test('nothing protected: nothing happens', () => {
  const p = plan(input({ tabs: [{ id: 1, url: 'https://news.com/' }] }));
  assert.deepEqual(p.disable, []);
  assert.deepEqual(p.enable, []);
  assert.equal(p.badge.mode, 'off');
});

test('entering a protected site disables everything except "Always on" and ourselves', () => {
  const p = plan(input({
    extraUrls: ['https://www.bank.com/'],
    navigation: { tabId: 1, url: 'https://www.bank.com/' },
    tabs: [{ id: 1, url: 'https://news.com/' }],
  }));
  assert.deepEqual(p.disable.sort(), ['ads', 'grammar']);
  assert.deepEqual(p.restartNavigation, { tabId: 1, url: 'https://www.bank.com/' });
  assert.deepEqual(p.nextState.disabledByUs.sort(), ['ads', 'grammar']);
  assert.equal(p.badge.mode, 'on');
});

test('already-open protected tabs are reloaded when protection starts', () => {
  const p = plan(input({ tabs: [{ id: 1, url: 'https://bank.com/' }, { id: 2, url: 'https://news.com/' }], loadTimes: { 1: 50_000 } }));
  assert.deepEqual(p.reloadTabIds, [1]);
});

test('extensions turned off by the user are not ours to restore', () => {
  const p = plan(input({ tabs: [{ id: 1, url: 'https://bank.com/' }], extensions: [ext('pw'), ext('off', { enabled: false })] }));
  assert.deepEqual(p.disable, []);
});

test('policy-managed extensions are left alone', () => {
  const p = plan(input({ tabs: [{ id: 1, url: 'https://bank.com/' }], extensions: [ext('corp', { mayDisable: false })] }));
  assert.deepEqual(p.disable, []);
});

test('leaving: wait for the grace period, then restore', () => {
  const state = { ...DEFAULT_STATE, disabledByUs: ['ads'], activeSites: ['bank.com'], seenSites: ['bank.com'] };
  const waiting = plan(input({ state, tabs: [{ id: 1, url: 'https://news.com/' }] }));
  assert.deepEqual(waiting.enable, []);
  assert.equal(waiting.scheduleCheck, true);
  assert.equal(waiting.nextState.inactiveSince, 100_000);

  const later = plan(input({ now: 100_000 + GRACE, state: waiting.nextState, tabs: [{ id: 1, url: 'https://news.com/' }] }));
  assert.deepEqual(later.enable, ['ads']);
  assert.deepEqual(later.nextState.disabledByUs, []);
  assert.equal(later.badge.mode, 'off');
});

test('restore skips extensions that were uninstalled meanwhile', () => {
  const state = { ...DEFAULT_STATE, disabledByUs: ['ads', 'gone'], inactiveSince: 0 };
  assert.deepEqual(plan(input({ state })).enable, ['ads']);
});

test('clipboard is cleared once, when protection ends', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com' }], clearClipboard: true });
  const state = { ...DEFAULT_STATE, disabledByUs: ['ads'], activeSites: ['bank.com'], inactiveSince: 0 };
  assert.equal(plan(input({ settings, state })).clearClipboard, true);
  assert.equal(plan(input({ settings })).clearClipboard, false);
});

test('pause restores immediately and lifts itself once you leave', () => {
  const state = { ...DEFAULT_STATE, disabledByUs: ['ads'], activeSites: ['bank.com'] };
  const paused = plan(input({ state, paused: true, tabs: [{ id: 1, url: 'https://bank.com/' }] }));
  assert.deepEqual(paused.enable, ['ads']);
  assert.equal(paused.badge.mode, 'pause');
  assert.equal(paused.unpause, false);
  assert.equal(plan(input({ paused: true })).unpause, true);
});

test('several protected sites: only extensions allowed on all of them stay on', () => {
  const settings = normalizeSettings({
    sites: [{ domain: 'bank.com', extra: ['grammar', 'ads'] }, { domain: 'tax.gov', extra: ['grammar'] }],
    globalWhitelist: ['pw'],
  });
  const p = plan(input({ settings, tabs: [{ id: 1, url: 'https://bank.com/' }, { id: 2, url: 'https://tax.gov/' }] }));
  assert.deepEqual(p.disable, ['ads']);
  assert.deepEqual([...computeAllowed(settings.sites, settings.globalWhitelist)].sort(), ['grammar', 'pw']);
});

test('extension turned on during protected mode: turned off again, flagged, no reload of open tabs', () => {
  const state = {
    ...DEFAULT_STATE, disabledByUs: ['ads'], activeSites: ['bank.com'], protectedTabIds: [1],
    allowedIds: ['pw'], cleanSince: 90_000, seenSites: ['bank.com'],
  };
  const p = plan(input({ state, tabs: [{ id: 1, url: 'https://bank.com/' }], extensions: [ext('pw'), ext('ads'), ext('grammar', { enabled: false })] }));
  assert.deepEqual(p.disable, ['ads']);
  assert.deepEqual(p.intrusion, ['ads']);
  assert.deepEqual(p.reloadTabIds, []);
});

test('a tab that becomes protected is only reloaded if it loaded before extensions went off', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com' }], globalWhitelist: ['pw'], fieldDetection: true });
  const state = {
    ...DEFAULT_STATE, disabledByUs: ['ads'], activeSites: ['bank.com'], protectedTabIds: [1],
    allowedIds: ['pw'], cleanSince: 90_000, seenSites: ['bank.com'],
  };
  const tabs = [{ id: 1, url: 'https://bank.com/' }, { id: 2, url: 'https://shop.com/login' }, { id: 3, url: 'https://forum.com/login' }];
  const flaggedTabs = { 2: 'shop.com', 3: 'forum.com' };
  const loadTimes = { 2: 95_000, 3: 80_000 }; // 2 loaded after extensions went off, 3 before
  const p = plan(input({ settings, state, tabs, flaggedTabs, loadTimes, extensions: [ext('pw'), ext('ads', { enabled: false })] }));
  assert.deepEqual(p.reloadTabIds, [3]);
  assert.deepEqual(p.nextState.activeSites.sort(), ['bank.com', 'forum.com', 'shop.com']);
});

test('detected fields are ignored on excluded domains and when detection is off', () => {
  const flaggedTabs = { 2: 'shop.com' };
  const tabs = [{ id: 2, url: 'https://shop.com/login' }];
  const off = plan(input({ tabs, flaggedTabs }));
  assert.equal(off.badge.mode, 'off');
  const excluded = plan(input({ tabs, flaggedTabs, settings: normalizeSettings({ fieldDetection: true, detectionExclusions: ['shop.com'] }) }));
  assert.equal(excluded.badge.mode, 'off');
  const on = plan(input({ tabs, flaggedTabs, settings: normalizeSettings({ fieldDetection: true }) }));
  assert.equal(on.badge.mode, 'on');
});

test('"log out when leaving" cleans up after the grace period, not before', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com', cleanup: true }, { domain: 'tax.gov' }] });
  const state = { ...DEFAULT_STATE, activeSites: ['bank.com', 'tax.gov'], seenSites: ['bank.com', 'tax.gov'], disabledByUs: ['ads'] };
  const tabs = [{ id: 2, url: 'https://tax.gov/' }];
  const first = plan(input({ settings, state, tabs }));
  assert.deepEqual(first.cleanup, []);
  assert.equal(first.scheduleCheck, true);
  const later = plan(input({ now: 100_000 + GRACE, settings, state: first.nextState, tabs }));
  assert.deepEqual(later.cleanup, ['bank.com']);
  const back = plan(input({ now: 100_001, settings, state: first.nextState, tabs: [...tabs, { id: 3, url: 'https://bank.com/' }] }));
  assert.deepEqual(back.cleanup, [], 'returning within the grace period cancels the cleanup');
});

test('the tab being closed is not counted', () => {
  const state = { ...DEFAULT_STATE, disabledByUs: ['ads'], inactiveSince: 0 };
  const p = plan(input({ state, tabs: [{ id: 1, url: 'https://bank.com/' }], excludeTabId: 1 }));
  assert.deepEqual(p.enable, ['ads']);
});

test('removeFromAllowlists remembers where an extension was', () => {
  const settings = normalizeSettings({ globalWhitelist: ['a'], sites: [{ domain: 'x.nl', extra: ['a', 'b'] }] });
  const where = removeFromAllowlists(settings, 'a');
  assert.deepEqual(where, { global: true, sites: ['x.nl'] });
  assert.deepEqual(settings.globalWhitelist, []);
  assert.deepEqual(settings.sites[0].extra, ['b']);
});

test('an unchanged situation produces an identical state (no needless writes)', () => {
  const tabs = [{ id: 1, url: 'https://bank.com/' }];
  const first = plan(input({ tabs }));
  const again = plan(input({ tabs, state: first.nextState, extensions: [ext('pw'), ext('ads', { enabled: false }), ext('grammar', { enabled: false })] }));
  assert.equal(JSON.stringify(again.nextState), JSON.stringify(first.nextState));
  const idle = plan(input());
  assert.equal(JSON.stringify(plan(input({ state: idle.nextState })).nextState), JSON.stringify(idle.nextState));
});
