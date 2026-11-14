// Shared helpers for the background worker, popup and options page.

export const DEFAULT_SETTINGS = {
  // [{ domain: 'mybank.com', extra: ['<extension-id>'], cleanup: false }]
  sites: [],
  // Extensions that stay on on every protected page ("Always on").
  globalWhitelist: [],
  // Temporarily off; cleared automatically once no protected tab is open.
  paused: false,
  // Automatically protect pages with a password field (requires website access).
  passwordDetection: false,
  // Also detect credit card, CVC, one-time code, IBAN and national ID fields.
  sensitiveFields: false,
  // Clear the clipboard after leaving protected pages.
  clearClipboard: false,
  // Domains where sensitive fields never trigger protection: ['example.com'].
  detectionExclusions: [],
};

// Host permissions only needed for the (optional) field detection.
export const DETECTOR_ORIGINS = ['http://*/*', 'https://*/*'];
export const LOG_MAX = 200;

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

export async function updateSettings(mutator) {
  const settings = await getSettings();
  mutator(settings);
  await saveSettings(settings);
}

export async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return {
    disabledByUs: [], // extensions Exterminator turned off itself
    activeSites: [], // domains for which protected mode is active
    autoSites: [], // subset of those protected because of a sensitive field
    seenSites: [], // domains that were open at the previous check
    leftSites: {}, // { domain: time left } for cleanup after the grace period
    inactiveSince: null, // since when no protected tab has been open
    ...(state || {}),
  };
}

// Tabs in which a sensitive field was seen: { [tabId]: host }.
// A tab stays protected for as long as it stays on that same host.
export async function getPasswordTabs() {
  const { passwordTabs } = await chrome.storage.session.get('passwordTabs');
  return passwordTabs || {};
}

export async function addLog(entry) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift({ t: Date.now(), ...entry });
  await chrome.storage.local.set({ log: log.slice(0, LOG_MAX) });
}

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Turns input like "https://www.mybank.com/personal" into "mybank.com".
export function normalizeDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#:]/)[0];
  s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  return s;
}

export function suggestDomain(host) {
  return host.replace(/^www\./, '');
}

// A site matches the domain itself and all its subdomains; the most specific one wins.
export function matchSite(host, sites) {
  if (!host) return null;
  let best = null;
  for (const site of sites) {
    if (host === site.domain || host.endsWith('.' + site.domain)) {
      if (!best || site.domain.length > best.domain.length) best = site;
    }
  }
  return best;
}

// True when host is one of the domains or a subdomain of one.
export function hostInDomains(host, domains) {
  return !!host && (domains || []).some((d) => host === d || host.endsWith('.' + d));
}

// Only regular extensions (no themes/apps) and never ourselves.
export function isManageable(ext) {
  return ext.id !== chrome.runtime.id && ext.type === 'extension';
}

// Allowed = global whitelist ∪ (intersection of the extras of all active sites).
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
  for (const site of settings.sites) (site.extra || []).forEach((id) => ids.add(id));
  return ids;
}

// Removes an extension from every list and returns where it was.
export function removeFromAllowlists(settings, id) {
  const where = { global: settings.globalWhitelist.includes(id), sites: [] };
  settings.globalWhitelist = settings.globalWhitelist.filter((x) => x !== id);
  for (const site of settings.sites) {
    if ((site.extra || []).includes(id)) {
      where.sites.push(site.domain);
      site.extra = site.extra.filter((x) => x !== id);
    }
  }
  return where;
}

// --- Risk analysis -------------------------------------------------------------

const HIGH_PERMS = {
  debugger: 'can fully control tabs (debugger)',
  webRequest: 'can read network traffic and submitted forms',
  webRequestBlocking: 'can intercept and modify network traffic',
  cookies: 'can read cookies and login sessions',
  management: 'can turn other extensions on and off',
  nativeMessaging: 'can communicate with programs on your computer',
  proxy: 'can reroute all your internet traffic',
};
const MEDIUM_PERMS = {
  scripting: 'can inject scripts into pages',
  tabs: 'can see the addresses of all your tabs',
  clipboardRead: 'can read your clipboard',
  history: 'can read your browsing history',
  webNavigation: 'can see where you navigate',
  desktopCapture: 'can record your screen',
  tabCapture: 'can record tabs',
  declarativeNetRequestWithHostAccess: 'can modify requests to websites',
};
const OTHER_PERMS = {
  storage: 'store data',
  alarms: 'schedule tasks',
  notifications: 'show notifications',
  contextMenus: 'add items to the right-click menu',
  activeTab: 'access the current tab after a click',
  downloads: 'manage downloads',
  bookmarks: 'read and change bookmarks',
  identity: 'sign in with your Google account',
  offscreen: 'use hidden documents',
  sidePanel: 'show a side panel',
  unlimitedStorage: 'store unlimited data',
  clipboardWrite: 'write to your clipboard',
  declarativeNetRequest: 'block or modify requests to websites',
  privacy: 'change privacy settings',
  geolocation: 'request your location',
  idle: 'detect whether you are using your computer',
  topSites: 'read your most visited sites',
};

const isBroadHost = (h) => h === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(h);

export function riskOf(ext) {
  let level = 0;
  const reasons = [];
  const hosts = ext.hostPermissions || [];
  if (hosts.some(isBroadHost)) {
    level = 2;
    reasons.push('can read and change all websites');
  } else if (hosts.length) {
    level = 1;
    reasons.push(`access to ${hosts.length} specific website(s)`);
  }
  for (const perm of ext.permissions || []) {
    if (HIGH_PERMS[perm]) {
      level = 2;
      reasons.push(HIGH_PERMS[perm]);
    } else if (MEDIUM_PERMS[perm]) {
      level = Math.max(level, 1);
      reasons.push(MEDIUM_PERMS[perm]);
    }
  }
  return { level: ['low', 'medium', 'high'][level], reasons };
}

// Human-readable description of a permission or host pattern.
export function describePermission(perm) {
  if (isBroadHost(perm)) return 'access to all websites';
  if (perm.includes('://')) return `access to ${perm}`;
  return HIGH_PERMS[perm] || MEDIUM_PERMS[perm] || OTHER_PERMS[perm] || `permission "${perm}"`;
}

export const RISK_LABELS = { high: 'high risk', medium: 'medium risk', low: 'low risk' };

// Extensions that can manage other extensions (e.g. 1Password) are extra sensitive:
// they could turn disabled extensions back on. Exterminator turns those off again
// right away during protected mode, but it remains a risk.
export function canManageExtensions(ext) {
  return (ext.permissions || []).includes('management');
}

export function iconUrl(ext) {
  if (!ext.icons?.length) return null;
  const sorted = [...ext.icons].sort((a, b) => a.size - b.size);
  return (sorted.find((i) => i.size >= 16) || sorted[0]).url;
}

export function logText(entry) {
  switch (entry.type) {
    case 'disabled':
      return `Turned off ${entry.names.length} extension(s) (${entry.sites.join(', ')}): ${entry.names.join(', ')}`;
    case 'enabled':
      return `Turned ${entry.names.length} extension(s) back on: ${entry.names.join(', ')}`;
    case 'cleanup':
      return `Cleared cookies and site data for ${entry.site}`;
    case 'clipboard':
      return 'Clipboard cleared';
    case 'detected':
      return `Sensitive field found on ${entry.site}`;
    case 'alert':
      return `${entry.name} removed from "Always on": ${entry.detail}`;
    default:
      return entry.type;
  }
}
