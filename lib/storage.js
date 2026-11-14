// All persistent data: keys, schema, migrations and small atomic-ish actions.
import { DEFAULT_STATE, PAUSE_MAX_MS, removeFromAllowlists } from './planner.js';
import { t } from './i18n.js';
import { matchSite, findDomain, normalizeDomain } from './domains.js';

export const KEYS = {
  schemaVersion: 'schemaVersion',
  settings: 'settings',
  paused: 'paused',
  state: 'state',
  alerts: 'alerts',
  approvals: 'approvals',
  log: 'log',
  consent: 'consent', // true once you agreed on the welcome page; nothing is turned off before
  asks: 'asks', // { domain: ms } detected sites that wait for your choice of protection level
  // storage.session (cleared when the browser or the extension restarts):
  flaggedTabs: 'flaggedTabs', // { tabId: host } tabs with a detected sensitive field
  framedTabs: 'framedTabs', // { tabId: [host] } protected hosts loaded in sub-frames of a tab
  prerenderTabs: 'prerenderTabs', // { tabId: [host] } protected pages being prerendered in a tab
  loadTimes: 'tabLoadTimes', // { tabId: ms } when each tab last committed a page
  inheritedTabs: 'inheritedTabs', // { tabId: { host, auto } } popups opened by a protected page
  loadHistory: 'loadHistory', // { tabId: [{ url, at }] } recent documents, for back/forward restores
  updatePending: 'updatePending',
  booted: 'booted',
  storageWarned: 'storageWarned',
};

export const SCHEMA_VERSION = 6;
export const LOG_MAX = 200;

export const DEFAULT_SETTINGS = {
  sites: [], // [{ domain, extra: [extensionId], level: 'login' | 'site' | 'strict' }]
  globalWhitelist: [], // "Always on"
  fieldDetection: false, // protect pages with a password field (needs website access)
  sensitiveFields: false, // also credit card, CVC, 2FA, IBAN, national ID fields
  detectionExclusions: [], // domains where detection never triggers
  clearClipboard: false,
};

// Protection levels of a configured site:
//   login:  extensions off only on pages with a detected sensitive field (needs field detection)
//   site:   extensions off while the site is open
//   strict: as "site", plus logging out and clearing the clipboard when you leave
const LEVELS = ['login', 'site', 'strict'];

export function normalizeSettings(raw) {
  const { loginOnly, ...rest } = raw || {};
  const settings = { ...DEFAULT_SETTINGS, ...rest };
  settings.sites = (settings.sites || []).map((site) => ({
    domain: site.domain,
    extra: site.extra || [],
    // Before schema 5 the level was a boolean `cleanup` ("strict" when true).
    level: LEVELS.includes(site.level) ? site.level : site.cleanup ? 'strict' : 'site',
  }));
  // Before schema 5, "Login pages only" was a separate list of domains.
  for (const domain of loginOnly || []) {
    if (!settings.sites.some((x) => x.domain === domain)) settings.sites.push({ domain, extra: [], level: 'login' });
  }
  return settings;
}

// The detected sites that still wait for a choice: not configured, excluded or answered.
export function openAsks(asks, settings) {
  return Object.keys(asks || {})
    .filter((domain) => !matchSite(domain, settings.sites) && !findDomain(domain, settings.detectionExclusions))
    .sort();
}

const local = chrome.storage.local;
const session = chrome.storage.session;

async function getOne(area, key, fallback) {
  const { [key]: value } = await area.get(key);
  return value ?? fallback;
}

// --- Settings -------------------------------------------------------------------------

export async function getSettings() {
  return normalizeSettings(await getOne(local, KEYS.settings));
}

// Read, change and write in one go. Every writer (popup, options, background) goes
// through this, so the window in which two pages could overwrite each other's
// change is a single storage round trip instead of a whole task.
export async function updateSettings(mutator) {
  const settings = await getSettings();
  const result = mutator(settings);
  await local.set({ [KEYS.settings]: normalizeSettings(settings) });
  return result;
}

// Paused: { sites: [domain], until: ms } (see isPauseActive in planner.js), or false.
const validPause = (p) => (p && typeof p === 'object' && Array.isArray(p.sites) && Number.isFinite(p.until) ? p : false);
export const isPaused = async () => validPause(await getOne(local, KEYS.paused, false));
export const setPaused = (paused) => local.set({ [KEYS.paused]: validPause(paused) });
export const pauseFor = (sites, now = Date.now()) => setPaused({ sites: [...sites], until: now + PAUSE_MAX_MS });

// Small, named actions shared by the popup and the options page.
export const actions = {
  // New sites are "strict" unless you pick another level.
  addSite: (domain, level = 'strict') => updateSettings((s) => {
    if (!s.sites.some((x) => x.domain === domain)) s.sites.push({ domain, extra: [], level });
  }),
  removeSite: (domain) => updateSettings((s) => { s.sites = s.sites.filter((x) => x.domain !== domain); }),
  setSiteLevel: (domain, level) => updateSettings((s) => {
    const site = s.sites.find((x) => x.domain === domain);
    if (site) site.level = level;
  }),
  // The answer to "how should this site be protected?": a level, or "never" (an exclusion).
  chooseLevel: async (domain, choice) => {
    await updateSettings((s) => {
      if (choice === 'never') {
        s.detectionExclusions = toggle(s.detectionExclusions, domain, true);
        return;
      }
      const site = s.sites.find((x) => x.domain === domain);
      if (site) site.level = choice;
      else s.sites.push({ domain, extra: [], level: choice });
    });
    const asks = await getAsks();
    delete asks[domain];
    await local.set({ [KEYS.asks]: asks });
  },
  // `approved`: the permissions shown to you when you allowed it (see permissionSnapshot), stored
  // with the change so consent is bound to what you saw, not to what it has by the next check.
  setSiteExtra: (domain, id, on, approved) => allow(id, on, approved, (s) => {
    const site = s.sites.find((x) => x.domain === domain);
    if (site) site.extra = toggle(site.extra, id, on);
  }),
  setAlwaysOn: (id, on, approved) => allow(id, on, approved, (s) => { s.globalWhitelist = toggle(s.globalWhitelist, id, on); }),
  addExclusion: (domain) => updateSettings((s) => { s.detectionExclusions = toggle(s.detectionExclusions, domain, true); }),
  removeExclusion: (domain) => updateSettings((s) => { s.detectionExclusions = toggle(s.detectionExclusions, domain, false); }),
  setOption: (key, value) => updateSettings((s) => { s[key] = value; }),
  dismissAlert: async (id) => {
    const alerts = await getAlerts();
    await local.set({ [KEYS.alerts]: alerts.filter((a) => a.id !== id) });
  },
  // "Allow again": approve exactly the permissions shown in the alert (not whatever the
  // extension has by now), restore it to its lists and close the alert, in one write.
  // Returns false for alerts without a stored snapshot (made by 0.5.0): those must be reviewed
  // and re-added by hand, so nothing is approved that you never saw.
  allowAgain: async (id) => {
    const data = await local.get([KEYS.settings, KEYS.alerts, KEYS.approvals]);
    const alerts = data[KEYS.alerts] || [];
    const alert = alerts.find((a) => a.id === id);
    if (!alert?.approved) return false;
    const settings = normalizeSettings(data[KEYS.settings]);
    const approvals = { ...(data[KEYS.approvals] || {}) };
    approvals[id] = alert.approved;
    if (alert.where?.global) settings.globalWhitelist = toggle(settings.globalWhitelist, id, true);
    for (const domain of alert.where?.sites || []) {
      const site = settings.sites.find((x) => x.domain === domain);
      if (site) site.extra = toggle(site.extra, id, true);
    }
    await local.set({
      [KEYS.settings]: normalizeSettings(settings),
      [KEYS.approvals]: approvals,
      [KEYS.alerts]: alerts.filter((a) => a.id !== id),
    });
    return true;
  },
  removeFromAllowlists: (ids) => updateSettings((s) => Object.fromEntries(ids.map((id) => [id, removeFromAllowlists(s, id)]))),
};

async function allow(id, on, approved, mutator) {
  const data = await local.get([KEYS.settings, KEYS.approvals]);
  const settings = normalizeSettings(data[KEYS.settings]);
  mutator(settings);
  const approvals = { ...(data[KEYS.approvals] || {}) };
  // An existing approval is kept: it is what you approved first, and anything added since
  // must still raise an alert.
  if (on && approved && !approvals[id]) approvals[id] = approved;
  await local.set({ [KEYS.settings]: normalizeSettings(settings), [KEYS.approvals]: approvals });
}

function toggle(list, value, on) {
  const set = new Set(list);
  on ? set.add(value) : set.delete(value);
  return [...set];
}

// --- Export and import ------------------------------------------------------------------

const EXPORT_APP = 'exterminator';
const EXTENSION_ID = /^[a-p]{32}$/;

// Settings as a file, for a backup or another Chrome profile.
export async function exportSettings() {
  return { app: EXPORT_APP, schema: SCHEMA_VERSION, exported: new Date().toISOString(), settings: await getSettings() };
}

// Checks an exported file and returns the settings to store. Invalid domains and extension IDs
// are dropped. Extensions that are allowed in the file but were never approved in this profile
// are left out (`skipped`): a changed file must not make an extension trusted without your
// review. Throws when the file is not an Exterminator export.
export function prepareImport(data, approvals) {
  if (data?.app !== EXPORT_APP || typeof data.settings !== 'object') throw new Error('not an Exterminator export');
  const settings = normalizeSettings(data.settings);
  const domains = (list) => [...new Set((list || []).map(normalizeDomain).filter(Boolean))];
  const skipped = new Set();
  const approved = (ids) => [...new Set(ids || [])].filter((id) => {
    if (!EXTENSION_ID.test(id)) return false;
    if (!approvals[id]) skipped.add(id);
    return !!approvals[id];
  });
  settings.sites = settings.sites
    .map((site) => ({ ...site, domain: normalizeDomain(site.domain), extra: approved(site.extra) }))
    .filter((site, i, all) => site.domain && all.findIndex((x) => x.domain === site.domain) === i);
  settings.globalWhitelist = approved(settings.globalWhitelist);
  settings.detectionExclusions = domains(settings.detectionExclusions);
  for (const key of ['fieldDetection', 'sensitiveFields', 'clearClipboard']) settings[key] = settings[key] === true;
  return { settings, skipped: [...skipped].sort() };
}

// Replaces the settings with those from an export. Returns the extension IDs left out.
// Automatic protection stays off without website access: only you can grant that, in Chrome.
export async function importSettings(data, hasSiteAccess) {
  const { settings, skipped } = prepareImport(data, await getApprovals());
  if (!hasSiteAccess) settings.fieldDetection = false;
  await local.set({ [KEYS.settings]: settings });
  return skipped;
}

// --- State, alerts, approvals, log ------------------------------------------------------

export async function getState() {
  return { ...DEFAULT_STATE, ...(await getOne(local, KEYS.state, {})) };
}
export const setState = (state) => local.set({ [KEYS.state]: state });

export const getAlerts = () => getOne(local, KEYS.alerts, []);
export const setAlerts = (alerts) => local.set({ [KEYS.alerts]: alerts });
export const getApprovals = () => getOne(local, KEYS.approvals, {});
export const setApprovals = (approvals) => local.set({ [KEYS.approvals]: approvals });

export const hasConsent = async () => (await getOne(local, KEYS.consent, false)) === true;
export const giveConsent = () => local.set({ [KEYS.consent]: true });

export const getAsks = () => getOne(local, KEYS.asks, {});
export const setAsks = (asks) => local.set({ [KEYS.asks]: asks });

export const getLog = () => getOne(local, KEYS.log, []);
export const clearLog = () => local.set({ [KEYS.log]: [] });
export async function addLog(entry) {
  const log = await getLog();
  log.unshift({ t: Date.now(), ...entry });
  await local.set({ [KEYS.log]: log.slice(0, LOG_MAX) });
}

export function logText(entry) {
  const names = (entry.names || []).join(', ');
  switch (entry.type) {
    case 'disabled': return t('logDisabled', { count: entry.names.length, sites: entry.sites.join(', '), names });
    case 'enabled': return t('logEnabled', { count: entry.names.length, names });
    case 'cleanup': return t('logCleanup', { site: entry.site });
    case 'cleanupIncognito': return t('logCleanupIncognito', { site: entry.site });
    case 'storageUnrestricted': return t('logStorageUnrestricted');
    case 'clipboard': return t('logClipboard');
    case 'detected': return t('logDetected', { site: entry.site });
    case 'alert': return t('logAlert', { name: entry.name, detail: entry.detail });
    case 'intrusion': return t('logIntrusion', { names });
    case 'frameRace': return t('logFrameRace', { site: entry.site });
    case 'staleTab': return t('logStaleTab', { site: entry.site });
    case 'error': return t('logError', { context: entry.context, message: entry.message });
    default: return entry.type;
  }
}

// --- Session data (per browser session) ---------------------------------------------------

// Per-tab data, each a { tabId: value } map in storage.session (see KEYS for what they hold).
export const TAB_DATA = {
  flagged: KEYS.flaggedTabs,
  framed: KEYS.framedTabs,
  prerender: KEYS.prerenderTabs,
  inherited: KEYS.inheritedTabs,
  loadTimes: KEYS.loadTimes,
  loadHistory: KEYS.loadHistory,
};
export const getTabData = (name) => getOne(session, TAB_DATA[name], {});
export const setTabData = (name, map) => session.set({ [TAB_DATA[name]]: map });
export const getFlaggedTabs = () => getTabData('flagged');
export const getFramedTabs = () => getTabData('framed');
export const isBooted = () => getOne(session, KEYS.booted, false);
export const markBooted = () => session.set({ [KEYS.booted]: true });
export const isUpdatePending = () => getOne(session, KEYS.updatePending, false);
export const markUpdatePending = () => session.set({ [KEYS.updatePending]: true });

// --- Migrations ------------------------------------------------------------------------------

// Brings stored data up to SCHEMA_VERSION, one version step at a time.
// Returns true when something changed.
export async function migrate() {
  const data = await local.get(null);
  let version = data[KEYS.schemaVersion] || 1;
  if (version >= SCHEMA_VERSION) return false;
  const settings = { ...(data.settings || {}) };
  const state = { ...(data.state || {}) };
  let alerts = data.alerts || [];
  let paused = data[KEYS.paused];

  if (version < 2) {
    // v1 → v2: "passwordDetection" renamed to "fieldDetection"; "paused" moved to its own
    // key so the background never has to rewrite settings; unused fields dropped.
    if ('passwordDetection' in settings) settings.fieldDetection = settings.passwordDetection;
    paused = !!settings.paused;
    delete settings.passwordDetection;
    delete settings.paused;
    delete state.autoSites;
    alerts = alerts.map(({ reason, ...alert }) => alert);
    version = 2;
  }
  if (version < 3) {
    // v2 → v3: per-tab "already protected" tracking replaced by per-extension disable times.
    delete state.protectedTabIds;
    delete state.cleanSince;
    version = 3;
  }
  if (version < 4) {
    // v3 → v4: a pause is bound to the sites it was started on and expires; an old global
    // pause is dropped.
    paused = false;
    version = 4;
  }
  // v4 → v5: a site's `cleanup` flag and the "loginOnly" list became one `level` per site.
  // normalizeSettings below does the conversion; it also accepts the old shape.
  // v5 → v6: protection waits for consent on the welcome page. Existing users already use
  // Exterminator, so they count as having agreed; a fresh install has no settings yet.
  const consent = data[KEYS.consent] === true || (version < 6 && !!data.settings);

  await local.set({
    [KEYS.settings]: normalizeSettings(settings),
    [KEYS.paused]: validPause(paused),
    [KEYS.state]: state,
    [KEYS.alerts]: alerts,
    [KEYS.schemaVersion]: SCHEMA_VERSION,
    [KEYS.consent]: consent,
  });
  await session.remove('passwordTabs');
  return true;
}
