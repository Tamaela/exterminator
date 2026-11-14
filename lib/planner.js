// Pure decision logic: given the current situation, decide what has to happen.
// No chrome.* calls here, so all of it can be unit tested.
import { hostOf, matchSite, findDomain } from './domains.js';

export const DEFAULT_STATE = {
  disabledByUs: [], // extensions Exterminator turned off itself (and must restore)
  activeSites: [], // domains protected mode is active for
  allowedIds: [], // extensions allowed to stay on at the previous check
  disabledAt: {}, // { extensionId: ms } when we last turned it off (not for intrusions)
  siteHosts: {}, // { domain: [host] } protected hosts actually visited, for "log out when leaving"
  seenSites: [], // domains open at the previous check (to notice leaving)
  leftSites: {}, // { domain: time left } for "log out when leaving" after the grace period
  inactiveSince: null, // since when no protected tab has been open
};

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

// Everything the UI and the planner need to know about one tab.
export function describeTab(url, tabId, settings, flaggedTabs) {
  const host = hostOf(url);
  if (!host) return { host: null, site: null, exclusion: null, detected: false };
  const site = matchSite(host, settings.sites);
  const exclusion = findDomain(host, settings.detectionExclusions);
  const detected = !site && !exclusion && settings.fieldDetection && tabId != null && flaggedTabs[tabId] === host;
  return { host, site, exclusion, detected };
}

// The site that protects this tab: a configured site, or a detected sensitive field.
export function siteForTab(url, tabId, settings, flaggedTabs) {
  const { host, site, detected } = describeTab(url, tabId, settings, flaggedTabs);
  if (site) return site;
  if (detected) return { domain: host, extra: [], auto: true }; // only "Always on" applies
  return null;
}

// Extensions a single site allows: "Always on" plus its own extras.
function allowedOnSite(site, globalWhitelist) {
  return new Set([...globalWhitelist, ...(site.extra || [])]);
}

// --- The plan --------------------------------------------------------------------

/**
 * Decides what to do. Input:
 *   now, graceMs, settings, state, paused, tabs [{id,url,pendingUrl}], flaggedTabs {tabId: host},
 *   framedTabs {tabId: [host]} (protected hosts loaded in sub-frames), loadTimes {tabId: ms},
 *   extensions (chrome.management.ExtensionInfo[]), selfId, extraUrls, excludeTabId, navigation {tabId,url}
 * Output: actions to apply, plus the next state to store.
 */
export function plan(input) {
  const {
    now, graceMs, settings, state, paused, tabs, loadTimes, extensions, selfId,
    extraUrls = [], excludeTabId, navigation, framedTabs = {},
  } = input;
  const flaggedTabs = settings.fieldDetection ? input.flaggedTabs : {};

  // 1. Which protected sites are open, which tabs are protected, and which hosts were visited.
  const sites = new Map();
  const protectedTabs = []; // [{ id, site }] by top-level URL
  const siteHosts = Object.fromEntries(Object.entries(state.siteHosts)
    .filter(([domain]) => settings.sites.some((s) => s.domain === domain && s.cleanup)));
  const consider = (url, tabId) => {
    const site = siteForTab(url, tabId, settings, flaggedTabs);
    if (!site) return null;
    sites.set(site.domain, site);
    if (site.cleanup) { // only tracked when it will be needed for cleanup
      const host = hostOf(url);
      const hosts = new Set(siteHosts[site.domain] || []);
      if (!hosts.has(host)) siteHosts[site.domain] = [...hosts, host].sort();
    }
    return site;
  };
  for (const url of extraUrls) consider(url, null);
  for (const tab of tabs) {
    if (tab.id === excludeTabId) continue;
    const site = tab.url ? consider(tab.url, tab.id) : null;
    if (site) protectedTabs.push({ id: tab.id, site });
    if (tab.pendingUrl) consider(tab.pendingUrl, tab.id);
    // A protected site inside an iframe (e.g. a bank's 3-D Secure frame on a shop) counts too.
    for (const host of framedTabs[tab.id] || []) consider(`https://${host}/`, null);
  }
  const openDomains = [...sites.keys()];

  // 2. "Log out when leaving": clean up sites once they've been left for the grace period.
  const leftSites = { ...state.leftSites };
  for (const domain of state.seenSites) {
    const wantsCleanup = settings.sites.some((s) => s.domain === domain && s.cleanup);
    if (wantsCleanup && !sites.has(domain)) leftSites[domain] ??= now;
  }
  for (const domain of openDomains) delete leftSites[domain];
  const cleanup = [];
  for (const domain of Object.keys(leftSites)) {
    if (now - leftSites[domain] < graceMs) continue;
    const hosts = new Set([domain, `www.${domain}`, ...(siteHosts[domain] || [])]);
    cleanup.push({ domain, hosts: [...hosts].sort() });
    delete leftSites[domain];
    delete siteHosts[domain];
  }
  const tracking = { seenSites: openDomains, leftSites, siteHosts };

  const result = {
    cleanup,
    unpause: paused && !sites.size, // pausing only lasts while you're on protected pages
    clearClipboard: false,
    disable: [],
    stamp: [], // extensions whose disabledAt must be set once they are actually off
    enable: [],
    intrusion: [],
    reloadTabIds: [],
    restartNavigation: null,
    badge: { mode: 'off', count: 0 },
    scheduleCheck: Object.keys(leftSites).length > 0,
    nextState: null,
  };

  const installed = new Set(extensions.map((e) => e.id));
  const pausedNow = paused && sites.size > 0;

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
      clearClipboard: !pausedNow && wasProtected && settings.clearClipboard,
      enable: state.disabledByUs.filter((id) => installed.has(id)),
      badge: { mode: pausedNow ? 'pause' : 'off', count: 0 },
      nextState: { ...DEFAULT_STATE, ...tracking },
    };
  }

  // 3b. Protected: everything not explicitly allowed goes off, including new extensions.
  const allowed = computeAllowed([...sites.values()], settings.globalWhitelist);
  const disable = extensions
    .filter((e) => e.id !== selfId && e.type === 'extension' && e.enabled && e.mayDisable && !allowed.has(e.id))
    .map((e) => e.id);
  const enable = state.disabledByUs.filter((id) => allowed.has(id) && installed.has(id));
  const disabledByUs = new Set(state.disabledByUs.filter((id) => installed.has(id) && !allowed.has(id)));
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
