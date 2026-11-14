// All persistent data: keys, schema, migrations and small atomic-ish actions.
import { DEFAULT_STATE, removeFromAllowlists } from './planner.js';
import { t } from './i18n.js';

export const KEYS = {
  schemaVersion: 'schemaVersion',
  settings: 'settings',
  paused: 'paused',
  state: 'state',
  alerts: 'alerts',
  approvals: 'approvals',
  log: 'log',
  // storage.session (cleared when the browser or the extension restarts):
  flaggedTabs: 'flaggedTabs', // { tabId: host } tabs with a detected sensitive field
  framedTabs: 'framedTabs', // { tabId: [host] } protected hosts loaded in sub-frames of a tab
  loadTimes: 'tabLoadTimes', // { tabId: ms } when each tab last committed a page
  booted: 'booted',
};

export const SCHEMA_VERSION = 3;
export const LOG_MAX = 200;

export const DEFAULT_SETTINGS = {
  sites: [], // [{ domain, extra: [extensionId], cleanup: bool }]
  globalWhitelist: [], // "Always on"
  fieldDetection: false, // protect pages with a password field (needs website access)
  sensitiveFields: false, // also credit card, CVC, 2FA, IBAN, national ID fields
  detectionExclusions: [], // domains where detection never triggers
  clearClipboard: false,
};

export function normalizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  settings.sites = (settings.sites || []).map((site) => ({
    domain: site.domain,
    extra: site.extra || [],
    cleanup: !!site.cleanup,
  }));
  return settings;
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

export const isPaused = () => getOne(local, KEYS.paused, false);
export const setPaused = (paused) => local.set({ [KEYS.paused]: !!paused });

// Small, named actions shared by the popup and the options page.
export const actions = {
  addSite: (domain) => updateSettings((s) => {
    if (!s.sites.some((x) => x.domain === domain)) s.sites.push({ domain, extra: [], cleanup: false });
  }),
  removeSite: (domain) => updateSettings((s) => { s.sites = s.sites.filter((x) => x.domain !== domain); }),
  setSiteCleanup: (domain, on) => updateSettings((s) => {
    const site = s.sites.find((x) => x.domain === domain);
    if (site) site.cleanup = on;
  }),
  setSiteExtra: (domain, id, on) => updateSettings((s) => {
    const site = s.sites.find((x) => x.domain === domain);
    if (site) site.extra = toggle(site.extra, id, on);
  }),
  setAlwaysOn: (id, on) => updateSettings((s) => { s.globalWhitelist = toggle(s.globalWhitelist, id, on); }),
  addExclusion: (domain) => updateSettings((s) => { s.detectionExclusions = toggle(s.detectionExclusions, domain, true); }),
  removeExclusion: (domain) => updateSettings((s) => { s.detectionExclusions = toggle(s.detectionExclusions, domain, false); }),
  setOption: (key, value) => updateSettings((s) => { s[key] = value; }),
  restoreAllowlists: (id, where) => updateSettings((s) => {
    if (where?.global) s.globalWhitelist = toggle(s.globalWhitelist, id, true);
    for (const domain of where?.sites || []) {
      const site = s.sites.find((x) => x.domain === domain);
      if (site) site.extra = toggle(site.extra, id, true);
    }
  }),
  removeFromAllowlists: (ids) => updateSettings((s) => Object.fromEntries(ids.map((id) => [id, removeFromAllowlists(s, id)]))),
};

function toggle(list, value, on) {
  const set = new Set(list);
  on ? set.add(value) : set.delete(value);
  return [...set];
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
    case 'clipboard': return t('logClipboard');
    case 'detected': return t('logDetected', { site: entry.site });
    case 'alert': return t('logAlert', { name: entry.name, detail: entry.detail });
    case 'intrusion': return t('logIntrusion', { names });
    case 'frameRace': return t('logFrameRace', { site: entry.site });
    case 'error': return t('logError', { context: entry.context, message: entry.message });
    default: return entry.type;
  }
}

// --- Session data (per browser session) ---------------------------------------------------

export const getFlaggedTabs = () => getOne(session, KEYS.flaggedTabs, {});
export const setFlaggedTabs = (tabs) => session.set({ [KEYS.flaggedTabs]: tabs });
export const getFramedTabs = () => getOne(session, KEYS.framedTabs, {});
export const setFramedTabs = (tabs) => session.set({ [KEYS.framedTabs]: tabs });
export const isBooted = () => getOne(session, KEYS.booted, false);
export const markBooted = () => session.set({ [KEYS.booted]: true });
export const getLoadTimes = () => getOne(session, KEYS.loadTimes, {});
export const setLoadTimes = (times) => session.set({ [KEYS.loadTimes]: times });

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

  await local.set({
    [KEYS.settings]: normalizeSettings(settings),
    [KEYS.paused]: !!paused,
    [KEYS.state]: state,
    [KEYS.alerts]: alerts,
    [KEYS.schemaVersion]: SCHEMA_VERSION,
  });
  await session.remove('passwordTabs');
  return true;
}
