// Pure decision logic: given the current situation, decide what has to happen.
// No chrome.* calls here, so all of it can be unit tested.
import { hostOf, matchSite, findDomain } from './domains.js';

export const DEFAULT_STATE = {
  disabledByUs: [], // extensions Tab Chaperone turned off itself (and must restore)
  activeSites: [], // domains protected mode is active for
  allowedIds: [], // extensions allowed to stay on at the previous check
  disabledAt: {}, // { extensionId: ms } when we last turned it off (not for intrusions)
  siteHosts: {}, // { domain: [host] } protected hosts actually visited, for "log out when leaving"
  seenSites: [], // domains open at the previous check (to notice leaving)
  leftSites: {}, // { domain: time left } for "log out when leaving" after the grace period
  inactiveSince: null, // since when no protected tab has been open
  incognitoSites: [], // cleanup sites visited in an incognito tab (Chrome can't clear those)
};

// Longest a pause lasts, even while you stay on the paused sites.
export const PAUSE_MAX_MS = 60 * 60 * 1000;

// A pause covers only the sites that were open when you pressed it, and for a limited time.
export function isPauseActive(paused, openDomains, now) {
  if (!paused || typeof paused !== 'object' || !Array.isArray(paused.sites)) return false;
  if (!(now < paused.until) || !openDomains.length) return false;
  return openDomains.every((domain) => paused.sites.includes(domain));
}

// --- Allowlists -----------------------------------------------------------------

// Allowed = "Always on" ∪ (intersection of the per-site extras of all open sites).
// With several protected sites open at once, the strictest combination wins.
export function computeAllowed(activeSites, globalWhitelist) {
  const allowed = new Set(globalWhitelist);
  if (activeSites.length) {
    let common = new Set(activeSites[0].extra || []);
    for (const site of activeSites.slice(1)) {
      const extra = new Set(site.extra || []);
      common = new Set([...common].filter((id) => extra.has(id)));
    }
    common.forEach((id) => allowed.add(id));
  }
  return allowed;
}

// All extensions that are allowed to stay on anywhere.
export function allowlistedIds(settings) {
  const ids = new Set(settings.globalWhitelist);
  for (const site of settings.sites) site.extra.forEach((id) => ids.add(id));
  return ids;
}

// Removes an extension from every list (mutates settings) and returns where it was.
export function removeFromAllowlists(settings, id) {
  const where = { global: settings.globalWhitelist.includes(id), sites: [] };
  settings.globalWhitelist = settings.globalWhitelist.filter((x) => x !== id);
  for (const site of settings.sites) {
    if (site.extra.includes(id)) {
      where.sites.push(site.domain);
      site.extra = site.extra.filter((x) => x !== id);
    }
  }
  return where;
}

// --- Tabs ---------------------------------------------------------------------------

// Configured sites that are protected as a whole ("site" and "strict"), as opposed to "login",
// which is protected only on pages with a detected field. Frames and prerenders count only
// for these: their fields are not detected.
export const wholeSites = (settings) => settings.sites.filter((s) => s.level !== 'login');

// Everything the UI and the planner need to know about one tab. `site` is the configured
// site of any level; `detected` says a sensitive field was found on this page.
export function describeTab(url, tabId, settings, flaggedTabs) {
  const host = hostOf(url);
  if (!host) return { host: null, site: null, exclusion: null, detected: false };
  const site = matchSite(host, settings.sites);
  const exclusion = findDomain(host, settings.detectionExclusions);
  const detected = (!site || site.level === 'login') && !exclusion && settings.fieldDetection
    && tabId != null && flaggedTabs[tabId] === host;
  return { host, site, exclusion, detected };
}

// The site that protects this tab: a configured site, or a detected sensitive field.
export function siteForTab(url, tabId, settings, flaggedTabs) {
  const { host, site, detected } = describeTab(url, tabId, settings, flaggedTabs);
  if (site && site.level !== 'login') return site;
  if (!detected) return null;
  // A "login" site keeps its own extras; any other page gets "Always on" only.
  return site ? { ...site, auto: true } : { domain: host, extra: [], auto: true };
}

// A top-level page without its own web origin (about:blank popup written by its opener):
// it belongs to the opener's site. blob: and filesystem: URLs carry their origin (see hostOf).
function inheritedUrl(tab, byId) {
  if (!tab.url?.startsWith('about:') || tab.openerTabId == null) return null;
  return byId.get(tab.openerTabId)?.url || null;
}

// Only real web pages are reloaded: reloading about:blank or a revoked blob: URL loses the page.
const isWebUrl = (url) => /^https?:/i.test(url || '');

// Extensions a single site allows: "Always on" plus its own extras.
function allowedOnSite(site, globalWhitelist) {
  return new Set([...globalWhitelist, ...(site.extra || [])]);
}

// --- The plan --------------------------------------------------------------------

/**
 * Decides what to do. Input:
 *   now, graceMs, settings, state, paused, tabs [{id,url,pendingUrl}], flaggedTabs {tabId: host},
 *   framedTabs {tabId: [host]} (protected hosts loaded in sub-frames), loadTimes {tabId: ms},
 *   prerenderTabs {tabId: [host]} (protected pages being prerendered), paused {sites, until} | false,
 *   inheritedTabs {tabId: {host, auto}} (popups opened by a protected page, recorded at creation),
 *   extensions (chrome.management.ExtensionInfo[]), selfId, excludeTabId, navigation {tabId,url},
 *   extraUrls (top-level navigation targets), frameUrls (sub-frame navigation targets)
 * Output: actions to apply, plus the next state to store.
 */
export function plan(input) {
  const {
    now, graceMs, settings, state, paused, tabs, loadTimes, extensions, selfId,
    extraUrls = [], frameUrls = [], excludeTabId, navigation, framedTabs = {}, prerenderTabs = {}, inheritedTabs = {},
  } = input;
  const flaggedTabs = settings.fieldDetection ? input.flaggedTabs : {};

  // 1. Which protected sites are open, which tabs are protected, and which hosts were visited.
  const sites = new Map();
  const protectedTabs = []; // [{ id, site }] by top-level URL
  const siteHosts = Object.fromEntries(Object.entries(state.siteHosts)
    .filter(([domain]) => settings.sites.some((s) => s.domain === domain && s.level === 'strict')));
  const incognitoSites = new Set();
  const visited = new Set(); // sites you actually opened as a page (only those are ever logged out)
  // `visit`: a top-level document. Frames and prerenders turn protection on but never make a
  // site eligible for "log out when leaving": any web page can embed or prerender your bank.
  const consider = (url, tabId, { incognito = false, visit = false } = {}) => {
    const site = siteForTab(url, tabId, settings, flaggedTabs);
    if (!site) return null;
    sites.set(site.domain, site);
    if (!visit || site.level !== 'strict') return site; // only tracked when it will be needed for cleanup
    visited.add(site.domain);
    if (incognito) incognitoSites.add(site.domain);
    const host = hostOf(url);
    const hosts = new Set(siteHosts[site.domain] || []);
    if (!hosts.has(host)) siteHosts[site.domain] = [...hosts, host].sort();
    return site;
  };
  const viaFrames = []; // [{ id, sites }] tabs with a protected site in an iframe
  const stale = []; // [{ id, site }] protected pages that can't be reloaded (about:blank, blob:)
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  for (const url of extraUrls) consider(url, null, { visit: true });
  for (const url of frameUrls) consider(url, null);
  for (const tab of tabs) {
    if (tab.id === excludeTabId) continue;
    const opts = { incognito: !!tab.incognito, visit: true };
    let site = tab.url ? consider(tab.url, tab.id, opts) : null;
    if (site && isWebUrl(tab.url)) protectedTabs.push({ id: tab.id, site });
    if (!site) {
      // A popup without a web origin of its own belongs to the page that opened it.
      const inherited = inheritedTabs[tab.id];
      if (inherited?.auto && settings.fieldDetection) {
        site = { domain: inherited.host, extra: [], auto: true };
        sites.set(site.domain, site);
      } else if (inherited) {
        site = consider(`https://${inherited.host}/`, null, opts);
      }
      const fromOpener = !site && inheritedUrl(tab, byId);
      if (fromOpener) site = consider(fromOpener, tab.openerTabId, opts);
    }
    if (site && !isWebUrl(tab.url)) stale.push({ id: tab.id, site });
    if (tab.pendingUrl) consider(tab.pendingUrl, tab.id, opts);
    // A protected site inside an iframe (e.g. a bank's 3-D Secure frame on a shop) counts too.
    const framed = (framedTabs[tab.id] || []).map((host) => consider(`https://${host}/`, null)).filter(Boolean);
    if (framed.length) viaFrames.push({ id: tab.id, sites: framed });
    // A protected page being prerendered in this tab: it may become visible at any moment.
    for (const host of prerenderTabs[tab.id] || []) consider(`https://${host}/`, null);
  }
  const openDomains = [...sites.keys()];
  // Visited sites stay "seen" while they are still open in any way, e.g. only in an iframe.
  const seen = [...new Set([...visited, ...state.seenSites.filter((d) => sites.has(d))])].sort();

  // 2. "Log out when leaving": clean up sites once they've been left for the grace period.
  const leftSites = { ...state.leftSites };
  for (const domain of state.seenSites) {
    const wantsCleanup = settings.sites.some((s) => s.domain === domain && s.level === 'strict');
    if (wantsCleanup && !sites.has(domain)) leftSites[domain] ??= now;
  }
  for (const domain of openDomains) delete leftSites[domain];
  const cleanup = [];
  for (const domain of Object.keys(leftSites)) {
    if (now - leftSites[domain] < graceMs) continue;
    const hosts = new Set([domain, `www.${domain}`, ...(siteHosts[domain] || [])]);
    const incognito = (state.incognitoSites || []).includes(domain);
    cleanup.push({ domain, hosts: [...hosts].sort(), ...(incognito && { incognito }) });
    delete leftSites[domain];
    delete siteHosts[domain];
  }
  const cleaned = new Set(cleanup.map((c) => c.domain));
  for (const domain of state.incognitoSites || []) {
    if (!cleaned.has(domain) && (sites.has(domain) || domain in leftSites)) incognitoSites.add(domain);
  }
  const tracking = { seenSites: seen, leftSites, siteHosts, incognitoSites: [...incognitoSites].sort() };
  const pausedNow = isPauseActive(paused, openDomains, now);

  const result = {
    cleanup,
    // A pause ends when you leave the paused sites, open another protected site, or it expires.
    unpause: !!paused && !pausedNow,
    // Leaving a "strict" site also clears the clipboard.
    clearClipboard: cleanup.length > 0,
    disable: [],
    stamp: [], // extensions whose disabledAt must be set once they are actually off
    enable: [],
    intrusion: [],
    reloadTabIds: [],
    frameRace: [], // [{ tabId, domain }] tabs to warn about (a protected iframe)
    staleTabs: [], // [{ tabId, domain }] protected pages that can't be reloaded
    restartNavigation: null,
    badge: { mode: 'off', count: 0 },
    scheduleCheck: Object.keys(leftSites).length > 0,
    nextState: null,
  };

  const installed = new Set(extensions.map((e) => e.id));

  // 3a. Nothing protected (or paused): restore, after the grace period.
  if (pausedNow || !sites.size) {
    const inactiveSince = state.inactiveSince ?? now;
    if (!pausedNow && state.disabledByUs.length && now - inactiveSince < graceMs) {
      return {
        ...result,
        badge: { mode: 'on', count: state.disabledByUs.length },
        scheduleCheck: true,
        nextState: { ...state, ...tracking, inactiveSince },
      };
    }
    const wasProtected = state.disabledByUs.length > 0 || state.activeSites.length > 0;
    return {
      ...result,
      clearClipboard: result.clearClipboard || (!pausedNow && wasProtected && settings.clearClipboard),
      enable: state.disabledByUs.filter((id) => installed.has(id)),
      badge: { mode: pausedNow ? 'pause' : 'off', count: 0 },
      nextState: { ...DEFAULT_STATE, ...tracking },
    };
  }

  // 3b. Protected: everything not explicitly allowed goes off, including new extensions.
  const allowed = computeAllowed([...sites.values()], settings.globalWhitelist);
  // Every kind of add-on that can run code (extensions, apps); themes can't.
  const disable = extensions
    .filter((e) => e.id !== selfId && e.type !== 'theme' && e.enabled && e.mayDisable && !allowed.has(e.id))
    .map((e) => e.id);
  // Extensions only come back after a site you left has been logged out (same order as when
  // protection ends completely): until then they stay off, even if the remaining site allows them.
  const waitForCleanup = Object.keys(leftSites).length > 0;
  const enable = waitForCleanup ? [] : state.disabledByUs.filter((id) => allowed.has(id) && installed.has(id));
  const disabledByUs = new Set(state.disabledByUs.filter((id) => installed.has(id) && (waitForCleanup || !allowed.has(id))));
  disable.forEach((id) => disabledByUs.add(id));

  // Turned on while protected mode was already active and not allowed before:
  // by you, by a new install, or by another extension. These get a notification
  // instead of reloading tabs (no reloads in the middle of a bank transfer).
  const wasActive = state.activeSites.length > 0;
  const previouslyAllowed = new Set(state.allowedIds);
  const intrusion = wasActive ? disable.filter((id) => !previouslyAllowed.has(id)) : [];
  const stamp = disable.filter((id) => !intrusion.includes(id));

  const disabledAt = {};
  for (const id of disabledByUs) {
    if (stamp.includes(id)) disabledAt[id] = now;
    else if (id in state.disabledAt) disabledAt[id] = state.disabledAt[id];
  }

  // Reload a protected tab when its document was loaded while an extension that this
  // site does not allow was still on. This covers tabs that just became protected and
  // tabs whose allowed set shrank (e.g. a redirect to a stricter protected site).
  const reloadTabIds = protectedTabs
    .filter(({ id, site }) => {
      if (id === navigation?.tabId) return false;
      const siteAllowed = allowedOnSite(site, settings.globalWhitelist);
      const loadedAt = loadTimes[id] ?? 0;
      return Object.entries(disabledAt).some(([ext, at]) => !siteAllowed.has(ext) && loadedAt <= at);
    })
    .map(({ id }) => id);

  // Iframes are never reloaded automatically (it may be a payment step): when an extension
  // the framed site doesn't allow was on until now, ask. Also when the page around it is a
  // protected site that does allow it, so the tab itself is not reloaded.
  const reloading = new Set(reloadTabIds);
  const frameRace = [];
  for (const { id, sites: framed } of viaFrames) {
    if (reloading.has(id) || id === navigation?.tabId) continue;
    const raced = framed.find((site) => {
      const siteAllowed = allowedOnSite(site, settings.globalWhitelist);
      return stamp.some((ext) => !siteAllowed.has(ext));
    });
    if (raced) frameRace.push({ tabId: id, domain: raced.domain });
  }

  // Protected pages that would be lost by a reload: tell the user instead.
  const staleTabs = stale
    .filter(({ site }) => {
      const siteAllowed = allowedOnSite(site, settings.globalWhitelist);
      return stamp.some((ext) => !siteAllowed.has(ext));
    })
    .map(({ id, site }) => ({ tabId: id, domain: site.domain }));

  // A navigation into a protected site may race with turning extensions off: restart it.
  const restartNavigation = navigation && disable.length
    && siteForTab(navigation.url, navigation.tabId, settings, flaggedTabs) ? navigation : null;

  return {
    ...result,
    disable,
    stamp,
    enable,
    intrusion,
    reloadTabIds,
    frameRace,
    staleTabs,
    clearClipboard: result.clearClipboard || (enable.length > 0 && settings.clearClipboard), // before they come back
    restartNavigation,
    badge: { mode: 'on', count: disabledByUs.size },
    // Spread DEFAULT_STATE first so the key order is stable (the background skips
    // writes when the state is unchanged, comparing as JSON).
    nextState: {
      ...DEFAULT_STATE,
      disabledByUs: [...disabledByUs],
      activeSites: openDomains,
      allowedIds: [...allowed],
      disabledAt,
      inactiveSince: null,
      ...tracking,
    },
  };
}
