import './chrome-stub.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, computeAllowed, removeFromAllowlists, DEFAULT_STATE } from '../lib/planner.js';
import { normalizeSettings } from '../lib/storage.js';

const GRACE = 3000;
const NOW = 100_000;
const ext = (id, extra = {}) => ({ id, name: id.toUpperCase(), type: 'extension', enabled: true, mayDisable: true, ...extra });
const off = (id) => ext(id, { enabled: false });

function input(overrides = {}) {
  return {
    now: NOW,
    graceMs: GRACE,
    settings: normalizeSettings({ sites: [{ domain: 'bank.com' }, { domain: 'tax.gov' }], globalWhitelist: ['pw'] }),
    state: { ...DEFAULT_STATE },
    paused: false,
    tabs: [],
    flaggedTabs: {},
    framedTabs: {},
    loadTimes: {},
    extensions: [ext('pw'), ext('ads'), ext('grammar'), ext('self')],
    selfId: 'self',
    ...overrides,
  };
}

// State after protection has been active for a while (extensions turned off at 90s).
const activeState = (extra = {}) => ({
  ...DEFAULT_STATE, disabledByUs: ['ads', 'grammar'], activeSites: ['bank.com'], allowedIds: ['pw'],
  disabledAt: { ads: 90_000, grammar: 90_000 }, seenSites: ['bank.com'], ...extra,
});

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
  assert.deepEqual(p.stamp.sort(), ['ads', 'grammar']);
  assert.deepEqual(p.restartNavigation, { tabId: 1, url: 'https://www.bank.com/' });
  assert.equal(p.badge.mode, 'on');
});

test('already-open protected tabs are reloaded when protection starts', () => {
  const p = plan(input({ tabs: [{ id: 1, url: 'https://bank.com/' }, { id: 2, url: 'https://news.com/' }], loadTimes: { 1: 50_000 } }));
  assert.deepEqual(p.reloadTabIds, [1]);
});

test('a tab loaded after extensions went off is not reloaded; one loaded before is', () => {
  const tabs = [{ id: 1, url: 'https://bank.com/' }, { id: 2, url: 'https://bank.com/a' }];
  const p = plan(input({ state: activeState(), tabs, loadTimes: { 1: 95_000, 2: 80_000 }, extensions: [ext('pw'), off('ads'), off('grammar')] }));
  assert.deepEqual(p.reloadTabIds, [2]);
  const again = plan(input({ state: p.nextState, tabs, loadTimes: { 1: 95_000, 2: 99_000 }, extensions: [ext('pw'), off('ads'), off('grammar')] }));
  assert.deepEqual(again.reloadTabIds, [], 'no reload loop after the reload');
});

test('audit fix: redirect to a stricter protected site reloads the tab', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com', extra: ['E'] }, { domain: 'secure.bank.com' }], globalWhitelist: [] });
  const extensions = [ext('E')];
  const onA = plan(input({ settings, extensions, tabs: [{ id: 1, url: 'https://bank.com/' }], loadTimes: { 1: 1 } }));
  assert.deepEqual(onA.disable, []);
  // Server redirect: the tab commits B while E is still on; no navigation object.
  const onB = plan(input({ settings, extensions, state: onA.nextState, tabs: [{ id: 1, url: 'https://secure.bank.com/login' }], loadTimes: { 1: NOW - 1 } }));
  assert.deepEqual(onB.disable, ['E']);
  assert.deepEqual(onB.intrusion, [], 'E was allowed before: not an intrusion');
  assert.deepEqual(onB.reloadTabIds, [1], 'the tab is reloaded so E\'s script is gone');
});

test('audit fix: the same holds through an unprotected page within the grace period', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com', extra: ['E'] }, { domain: 'secure.bank.com' }], globalWhitelist: [] });
  const extensions = [ext('E'), ext('X')];
  const onA = plan(input({ settings, extensions, tabs: [{ id: 1, url: 'https://bank.com/' }], loadTimes: { 1: 1 } }));
  const between = plan(input({ settings, extensions: [ext('E'), off('X')], state: onA.nextState, tabs: [{ id: 1, url: 'https://shop.com/' }] }));
  assert.equal(between.badge.mode, 'on', 'still within grace');
  const onB = plan(input({ settings, extensions: [ext('E'), off('X')], state: between.nextState, tabs: [{ id: 1, url: 'https://secure.bank.com/' }], loadTimes: { 1: NOW } }));
  assert.deepEqual(onB.reloadTabIds, [1]);
});

test('a tab on a site that still allows the extension is not reloaded when the allowed set shrinks', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com', extra: ['E'] }, { domain: 'tax.gov' }], globalWhitelist: [] });
  const onA = plan(input({ settings, extensions: [ext('E')], tabs: [{ id: 1, url: 'https://bank.com/' }], loadTimes: { 1: 1 } }));
  const both = plan(input({ settings, extensions: [ext('E')], state: onA.nextState,
    tabs: [{ id: 1, url: 'https://bank.com/' }, { id: 2, url: 'https://tax.gov/' }], loadTimes: { 1: 1, 2: 2 } }));
  assert.deepEqual(both.disable, ['E']);
  assert.deepEqual(both.reloadTabIds, [2], 'only the tax.gov tab, where E is not allowed');
});

test('extension turned on during protected mode: turned off again, flagged, no reload of open tabs', () => {
  const p = plan(input({ state: activeState(), tabs: [{ id: 1, url: 'https://bank.com/' }], loadTimes: { 1: 95_000 },
    extensions: [ext('pw'), ext('ads'), off('grammar')] }));
  assert.deepEqual(p.disable, ['ads']);
  assert.deepEqual(p.intrusion, ['ads']);
  assert.deepEqual(p.stamp, []);
  assert.deepEqual(p.reloadTabIds, []);
  assert.equal(p.nextState.disabledAt.ads, 90_000, 'the original disable time is kept');
});

test('detected tab: reloaded only if it loaded before extensions went off', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com' }], globalWhitelist: ['pw'], fieldDetection: true });
  const tabs = [{ id: 1, url: 'https://bank.com/' }, { id: 2, url: 'https://shop.com/login' }, { id: 3, url: 'https://forum.com/login' }];
  const p = plan(input({ settings, state: activeState(), tabs, flaggedTabs: { 2: 'shop.com', 3: 'forum.com' },
    loadTimes: { 1: 95_000, 2: 95_000, 3: 80_000 }, extensions: [ext('pw'), off('ads'), off('grammar')] }));
  assert.deepEqual(p.reloadTabIds, [3]);
  assert.deepEqual(p.nextState.activeSites.sort(), ['bank.com', 'forum.com', 'shop.com']);
});

test('detected fields are ignored on excluded domains and when detection is off', () => {
  const flaggedTabs = { 2: 'shop.com' };
  const tabs = [{ id: 2, url: 'https://shop.com/login' }];
  assert.equal(plan(input({ tabs, flaggedTabs })).badge.mode, 'off');
  assert.equal(plan(input({ tabs, flaggedTabs, settings: normalizeSettings({ fieldDetection: true, detectionExclusions: ['shop.com'] }) })).badge.mode, 'off');
  assert.equal(plan(input({ tabs, flaggedTabs, settings: normalizeSettings({ fieldDetection: true }) })).badge.mode, 'on');
});

test('audit fix: a protected site inside an iframe turns protection on, without reloading the page', () => {
  const p = plan(input({ tabs: [{ id: 5, url: 'https://shop.com/checkout' }], framedTabs: { 5: ['acs.bank.com'] }, loadTimes: { 5: 1 } }));
  assert.deepEqual(p.disable.sort(), ['ads', 'grammar']);
  assert.deepEqual(p.nextState.activeSites, ['bank.com']);
  assert.deepEqual(p.reloadTabIds, [], 'the checkout page itself is not reloaded');
});

test('leaving: wait for the grace period, then restore', () => {
  const state = { ...DEFAULT_STATE, disabledByUs: ['ads'], activeSites: ['bank.com'], seenSites: ['bank.com'] };
  const waiting = plan(input({ state, tabs: [{ id: 1, url: 'https://news.com/' }] }));
  assert.deepEqual(waiting.enable, []);
  assert.equal(waiting.scheduleCheck, true);
  const later = plan(input({ now: NOW + GRACE, state: waiting.nextState, tabs: [{ id: 1, url: 'https://news.com/' }] }));
  assert.deepEqual(later.enable, ['ads']);
  assert.deepEqual(later.nextState.disabledByUs, []);
  assert.deepEqual(later.nextState.disabledAt, {});
});

test('restore skips extensions that were uninstalled meanwhile', () => {
  assert.deepEqual(plan(input({ state: { ...DEFAULT_STATE, disabledByUs: ['ads', 'gone'], inactiveSince: 0 } })).enable, ['ads']);
});

test('clipboard is cleared once, when protection ends', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com' }], clearClipboard: true });
  const state = { ...DEFAULT_STATE, disabledByUs: ['ads'], activeSites: ['bank.com'], inactiveSince: 0 };
  assert.equal(plan(input({ settings, state })).clearClipboard, true);
  assert.equal(plan(input({ settings })).clearClipboard, false);
});

test('pause restores immediately and lifts itself once you leave', () => {
  const pause = { sites: ['bank.com'], until: NOW + 60_000 };
  const paused = plan(input({ state: activeState(), paused: pause, tabs: [{ id: 1, url: 'https://bank.com/' }] }));
  assert.deepEqual(paused.enable.sort(), ['ads', 'grammar']);
  assert.equal(paused.badge.mode, 'pause');
  assert.equal(paused.unpause, false);
  assert.equal(plan(input({ paused: pause })).unpause, true);
});

test('audit fix: a pause covers only the sites it was started on, and expires', () => {
  const pause = { sites: ['bank.com'], until: NOW + 60_000 };
  const tabs = [{ id: 1, url: 'https://bank.com/' }, { id: 2, url: 'https://tax.gov/' }];
  const other = plan(input({ paused: pause, tabs }));
  assert.equal(other.unpause, true, 'opening another protected site ends the pause');
  assert.deepEqual(other.disable.sort(), ['ads', 'grammar']);
  const expired = plan(input({ now: NOW + 60_000, paused: pause, tabs: [tabs[0]] }));
  assert.equal(expired.unpause, true);
  assert.equal(expired.badge.mode, 'on');
  assert.equal(plan(input({ paused: true, tabs: [tabs[0]] })).badge.mode, 'on', 'an old global pause is ignored');
});

test('audit fix: a later, stricter disable warns about tabs protected only through an iframe', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com', extra: ['E'] }, { domain: 'tax.gov' }], globalWhitelist: [] });
  const framed = plan(input({ settings, extensions: [ext('E')], tabs: [{ id: 5, url: 'https://shop.com/' }], framedTabs: { 5: ['acs.bank.com'] } }));
  assert.deepEqual(framed.disable, [], 'E is allowed on bank.com');
  const stricter = plan(input({ settings, extensions: [ext('E')], state: framed.nextState,
    tabs: [{ id: 5, url: 'https://shop.com/' }, { id: 6, url: 'https://tax.gov/' }], framedTabs: { 5: ['acs.bank.com'] }, loadTimes: { 6: 1 } }));
  assert.deepEqual(stricter.disable, ['E']);
  assert.deepEqual(stricter.frameRace, [], 'E is still allowed on bank.com: no warning');
  const settings2 = normalizeSettings({ sites: [{ domain: 'bank.com' }], globalWhitelist: [] });
  const s1 = plan(input({ settings: settings2, extensions: [ext('E')], tabs: [{ id: 5, url: 'https://shop.com/' }], framedTabs: { 5: ['acs.bank.com'] } }));
  assert.deepEqual(s1.frameRace, [{ tabId: 5, domain: 'bank.com' }]);
  assert.deepEqual(s1.reloadTabIds, [], 'never reloaded automatically');
});

test('audit fix: a protected page being prerendered keeps protection on', () => {
  const p = plan(input({ tabs: [{ id: 3, url: 'https://search.com/' }], prerenderTabs: { 3: ['bank.com'] } }));
  assert.deepEqual(p.nextState.activeSites, ['bank.com']);
  assert.deepEqual(p.reloadTabIds, []);
});

test('audit fix: an about:blank popup of a protected page and a blob: page count as protected, without reloads', () => {
  const tabs = [{ id: 1, url: 'https://news.com/' }, { id: 2, url: 'about:blank', openerTabId: 9 }, { id: 9, url: 'https://bank.com/', incognito: false }];
  const popup = plan(input({ tabs: tabs.slice(1), loadTimes: { 9: NOW + 1 } }));
  assert.deepEqual(popup.nextState.activeSites, ['bank.com']);
  const closedOpener = plan(input({ tabs: [tabs[1]] }));
  assert.equal(closedOpener.badge.mode, 'off', 'without a protected opener it is not protected');
  const blob = plan(input({ tabs: [{ id: 4, url: 'blob:https://bank.com/0b1c' }] }));
  assert.deepEqual(blob.nextState.activeSites, ['bank.com']);
  assert.deepEqual(blob.reloadTabIds, [], 'a blob: page would be lost by a reload');
});

test('audit fix: cleanup says when a site was visited in incognito', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com', cleanup: true }] });
  const visiting = plan(input({ settings, tabs: [{ id: 1, url: 'https://bank.com/', incognito: true }] }));
  assert.deepEqual(visiting.nextState.incognitoSites, ['bank.com']);
  const left = plan(input({ settings, state: visiting.nextState }));
  const later = plan(input({ now: NOW + GRACE, settings, state: left.nextState }));
  assert.deepEqual(later.cleanup, [{ domain: 'bank.com', hosts: ['bank.com', 'www.bank.com'], incognito: true }]);
  assert.deepEqual(later.nextState.incognitoSites, []);
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

test('audit fix: "log out when leaving" cleans every visited subdomain, after the grace period', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com', cleanup: true }, { domain: 'tax.gov' }] });
  const visiting = plan(input({ settings, tabs: [{ id: 1, url: 'https://online.bank.com/' }, { id: 2, url: 'https://tax.gov/' }] }));
  assert.deepEqual(visiting.nextState.siteHosts, { 'bank.com': ['online.bank.com'] }, 'only sites with cleanup are tracked');
  const left = plan(input({ settings, state: visiting.nextState, tabs: [{ id: 2, url: 'https://tax.gov/' }] }));
  assert.deepEqual(left.cleanup, []);
  assert.equal(left.scheduleCheck, true);
  const later = plan(input({ now: NOW + GRACE, settings, state: left.nextState, tabs: [{ id: 2, url: 'https://tax.gov/' }] }));
  assert.deepEqual(later.cleanup, [{ domain: 'bank.com', hosts: ['bank.com', 'online.bank.com', 'www.bank.com'] }]);
  assert.deepEqual(later.nextState.siteHosts, {});
  const back = plan(input({ now: NOW + 1, settings, state: left.nextState, tabs: [{ id: 2, url: 'https://tax.gov/' }, { id: 3, url: 'https://bank.com/' }] }));
  assert.deepEqual(back.cleanup, [], 'returning within the grace period cancels the cleanup');
});

test('the tab being closed is not counted', () => {
  const p = plan(input({ state: { ...DEFAULT_STATE, disabledByUs: ['ads'], inactiveSince: 0 }, tabs: [{ id: 1, url: 'https://bank.com/' }], excludeTabId: 1 }));
  assert.deepEqual(p.enable, ['ads']);
});

test('an unchanged situation produces an identical state (no needless writes)', () => {
  const tabs = [{ id: 1, url: 'https://bank.com/' }];
  const first = plan(input({ tabs, loadTimes: { 1: NOW + 1 } }));
  const again = plan(input({ tabs, state: first.nextState, loadTimes: { 1: NOW + 1 }, extensions: [ext('pw'), off('ads'), off('grammar')] }));
  assert.equal(JSON.stringify(again.nextState), JSON.stringify(first.nextState));
  const idle = plan(input());
  assert.equal(JSON.stringify(plan(input({ state: idle.nextState })).nextState), JSON.stringify(idle.nextState));
});

test('removeFromAllowlists remembers where an extension was', () => {
  const settings = normalizeSettings({ globalWhitelist: ['a'], sites: [{ domain: 'x.nl', extra: ['a', 'b'] }] });
  assert.deepEqual(removeFromAllowlists(settings, 'a'), { global: true, sites: ['x.nl'] });
  assert.deepEqual(settings.globalWhitelist, []);
  assert.deepEqual(settings.sites[0].extra, ['b']);
});

test('run-3 fix: a site that was only framed or prerendered is never logged out', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com', cleanup: true }] });
  const framed = plan(input({ settings, frameUrls: ['https://bank.com/'], tabs: [{ id: 1, url: 'https://evil.com/' }], framedTabs: { 1: ['bank.com'] } }));
  assert.deepEqual(framed.nextState.seenSites, []);
  assert.deepEqual(framed.nextState.siteHosts, {});
  const gone = plan(input({ settings, state: framed.nextState, tabs: [{ id: 1, url: 'https://evil.com/' }] }));
  const later = plan(input({ now: NOW + GRACE, settings, state: gone.nextState, tabs: [{ id: 1, url: 'https://evil.com/' }] }));
  assert.deepEqual(later.cleanup, []);
});

test('run-3 fix: a visited site stays "seen" while it is still open in an iframe', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com', cleanup: true }] });
  const visit = plan(input({ settings, tabs: [{ id: 1, url: 'https://bank.com/' }] }));
  const framed = plan(input({ settings, state: visit.nextState, tabs: [{ id: 1, url: 'https://shop.com/' }], framedTabs: { 1: ['acs.bank.com'] } }));
  assert.deepEqual(framed.nextState.seenSites, ['bank.com']);
  assert.deepEqual(framed.cleanup, []);
  const left = plan(input({ settings, state: framed.nextState, tabs: [{ id: 1, url: 'https://shop.com/' }] }));
  const later = plan(input({ now: NOW + GRACE, settings, state: left.nextState, tabs: [{ id: 1, url: 'https://shop.com/' }] }));
  assert.equal(later.cleanup.length, 1, 'logged out once it is really gone');
});

test('run-3 fix: extensions allowed on the remaining site wait for the left site to be logged out', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'bank.com', cleanup: true }, { domain: 'tax.gov', extra: ['ads'] }], globalWhitelist: ['pw'], clearClipboard: true });
  const both = plan(input({ settings, tabs: [{ id: 1, url: 'https://bank.com/' }, { id: 2, url: 'https://tax.gov/' }] }));
  assert.deepEqual(both.disable.sort(), ['ads', 'grammar']);
  const exts = [ext('pw'), off('ads'), off('grammar')];
  const left = plan(input({ settings, extensions: exts, state: both.nextState, tabs: [{ id: 2, url: 'https://tax.gov/' }] }));
  assert.deepEqual(left.enable, [], 'not before bank.com is logged out');
  assert.ok(left.nextState.disabledByUs.includes('ads'));
  const later = plan(input({ now: NOW + GRACE, settings, extensions: exts, state: left.nextState, tabs: [{ id: 2, url: 'https://tax.gov/' }] }));
  assert.equal(later.cleanup[0].domain, 'bank.com');
  assert.deepEqual(later.enable, ['ads'], 'after the cleanup, in the same check');
  assert.equal(later.clearClipboard, true);
});

test('run-3 fix: a stricter protected iframe inside a protected page gets a warning on a later disable', () => {
  const settings = normalizeSettings({ sites: [{ domain: 'shop.com', extra: ['E'] }, { domain: 'bank.com', extra: ['E'] }], globalWhitelist: [] });
  const tabs = [{ id: 5, url: 'https://shop.com/' }];
  const first = plan(input({ settings, extensions: [ext('E')], tabs, framedTabs: { 5: ['acs.bank.com'] }, loadTimes: { 5: 1 } }));
  assert.deepEqual(first.disable, []);
  const stricter = normalizeSettings({ sites: [{ domain: 'shop.com', extra: ['E'] }, { domain: 'bank.com' }], globalWhitelist: [] });
  const p = plan(input({ settings: stricter, extensions: [ext('E')], state: first.nextState, tabs, framedTabs: { 5: ['acs.bank.com'] }, loadTimes: { 5: 1 } }));
  assert.deepEqual(p.disable, ['E']);
  assert.deepEqual(p.reloadTabIds, [], 'shop.com itself still allows E');
  assert.deepEqual(p.frameRace, [{ tabId: 5, domain: 'bank.com' }]);
});

test('run-3 fix: a popup opened by a protected page stays protected after the opener leaves, and gets a warning instead of a reload', () => {
  const tabs = [{ id: 1, url: 'https://news.com/' }, { id: 2, url: 'about:blank', openerTabId: 1 }];
  const p = plan(input({ tabs, inheritedTabs: { 2: { host: 'bank.com', auto: false } } }));
  assert.deepEqual(p.nextState.activeSites, ['bank.com']);
  assert.deepEqual(p.reloadTabIds, []);
  assert.deepEqual(p.staleTabs, [{ tabId: 2, domain: 'bank.com' }]);
  const detected = plan(input({ settings: normalizeSettings({ fieldDetection: true }), tabs, inheritedTabs: { 2: { host: 'shop.com', auto: true } } }));
  assert.deepEqual(detected.nextState.activeSites, ['shop.com']);
});

test('run-3 fix: apps are turned off too, themes are left alone', () => {
  const p = plan(input({ tabs: [{ id: 1, url: 'https://bank.com/' }], extensions: [ext('pw'), ext('app', { type: 'hosted_app' }), ext('look', { type: 'theme' })] }));
  assert.deepEqual(p.disable, ['app']);
});
