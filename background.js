import { t } from './lib/i18n.js';
import { hostOf } from './lib/domains.js';
import { plan, siteForTab, describeTab, allowlistedIds } from './lib/planner.js';
import { describePermission } from './lib/risk.js';
import {
  KEYS, migrate, getSettings, updateSettings, isPaused, setPaused, getState, setState,
  getAlerts, setAlerts, getApprovals, setApprovals, addLog, actions,
  getFlaggedTabs, setFlaggedTabs, getLoadTimes, setLoadTimes, isBooted, markBooted,
} from './lib/storage.js';

// Grace period before extensions come back or a site is cleaned up, so that
// redirects between (protected) domains don't cause on/off/on flapping.
const GRACE_MS = 3000;
const CHECK_ALARM = 'exterminator-check';
const AUDIT_ALARM = 'exterminator-audit';
const DETECTOR_ID = 'field-detector';
const DETECTOR_ORIGINS = ['http://*/*', 'https://*/*'];
const INTRUSION_NOTIFICATION = 'intrusion';

// --- Task queue ---------------------------------------------------------------------------

// All tasks run one after another to avoid race conditions.
let queue = Promise.resolve();
function run(task) {
  queue = queue.then(task).catch((err) => logError('errInternal', {}, err));
  return queue;
}

// Many events fire per navigation; coalesce plain checks into one queued run.
let checkQueued = false;
function requestCheck() {
  if (checkQueued) return;
  checkQueued = true;
  run(async () => {
    checkQueued = false;
    await protect();
  });
}

async function logError(contextKey, params, err) {
  const message = err?.message || String(err);
  console.warn('[Exterminator]', contextKey, params, err);
  try {
    await addLog({ type: 'error', context: t(contextKey, params), message });
  } catch {
    // Logging must never throw.
  }
}

// --- Extension switching -----------------------------------------------------------------

// Our own re-enabling fires management.onEnabled; ignore those echoes.
const expectedEnables = new Map();
function isEcho(id) {
  const expiry = expectedEnables.get(id);
  expectedEnables.delete(id);
  return expiry !== undefined && expiry > Date.now();
}

async function setEnabled(id, enabled, name) {
  if (enabled) expectedEnables.set(id, Date.now() + 5000);
  try {
    await chrome.management.setEnabled(id, enabled);
    return true;
  } catch (err) {
    expectedEnables.delete(id);
    await logError(enabled ? 'errEnable' : 'errDisable', { name }, err);
    return false;
  }
}

// --- Field detection (optional) ------------------------------------------------------------

async function syncDetector(settings) {
  const hasPermission = await chrome.permissions.contains({ origins: DETECTOR_ORIGINS });
  const want = settings.fieldDetection && hasPermission;
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const stale = registered.filter((s) => s.id !== DETECTOR_ID).map((s) => s.id); // e.g. old ids
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  const exists = registered.some((s) => s.id === DETECTOR_ID);

  if (want && !exists) {
    await chrome.scripting.registerContentScripts([{
      id: DETECTOR_ID,
      matches: DETECTOR_ORIGINS,
      js: ['detector.js'],
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    }]);
  } else if (!want && exists) {
    await chrome.scripting.unregisterContentScripts({ ids: [DETECTOR_ID] });
  }
  if (!want) await setFlaggedTabs({});
}

// A tab with a sensitive field stays protected for as long as it stays on that host.
async function flagTab(tab) {
  const settings = await getSettings();
  const flagged = await getFlaggedTabs();
  const { host, site, exclusion } = describeTab(tab?.url, tab?.id, settings, flagged);
  if (!settings.fieldDetection || !host || exclusion || flagged[tab.id] === host) return false;
  flagged[tab.id] = host;
  await setFlaggedTabs(flagged);
  if (!site) await addLog({ type: 'detected', site: host });
  return true;
}

async function forgetTab(tabId, newUrl) {
  const flagged = await getFlaggedTabs();
  if (tabId in flagged && (newUrl === undefined || hostOf(newUrl) !== flagged[tabId])) {
    delete flagged[tabId];
    await setFlaggedTabs(flagged);
  }
  if (newUrl === undefined) {
    const times = await getLoadTimes();
    delete times[tabId];
    await setLoadTimes(times);
  }
}

async function recordLoad(tabId) {
  const times = await getLoadTimes();
  times[tabId] = Date.now();
  await setLoadTimes(times);
}

// --- Monitoring "Always on" extensions --------------------------------------------------------

function snapshot(ext) {
  return {
    version: ext.version,
    permissions: [...(ext.permissions || [])].sort(),
    hostPermissions: [...(ext.hostPermissions || [])].sort(),
  };
}

async function notify(id, options) {
  try {
    await chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', priority: 2, ...options });
  } catch (err) {
    await logError('errNotify', {}, err);
  }
}

/**
 * Compares the permissions of allowed extensions with the moment they were approved.
 * New permissions → removed from every list, plus an alert and a notification.
 */
async function reconcileApprovals() {
  const settings = await getSettings();
  const approvals = await getApprovals();
  const byId = new Map((await chrome.management.getAll()).map((e) => [e.id, e]));
  const ids = allowlistedIds(settings);
  const escalated = []; // [{ ext, added }]

  for (const id of ids) {
    const ext = byId.get(id);
    if (!ext) continue;
    const current = snapshot(ext);
    const approved = approvals[id];
    if (!approved) {
      approvals[id] = current;
      continue;
    }
    const added = [
      ...current.permissions.filter((p) => !approved.permissions.includes(p)),
      ...current.hostPermissions.filter((h) => !approved.hostPermissions.includes(h)),
    ];
    if (added.length) {
      escalated.push({ ext, added });
      delete approvals[id];
    } else {
      approvals[id] = current; // fewer permissions or a new version without extra permissions
    }
  }
  for (const id of Object.keys(approvals)) {
    if (!ids.has(id) || !byId.has(id)) delete approvals[id];
  }
  await setApprovals(approvals);
  if (!escalated.length) return;

  const where = await actions.removeFromAllowlists(escalated.map((x) => x.ext.id));
  const alerts = (await getAlerts()).filter((a) => !where[a.id]);
  for (const { ext, added } of escalated) {
    const detail = t('alertDetail', { version: ext.version, permissions: added.map(describePermission).join('; ') });
    alerts.push({ id: ext.id, name: ext.name, version: ext.version, added, where: where[ext.id], t: Date.now() });
    await addLog({ type: 'alert', name: ext.name, detail });
    await notify(`alert-${ext.id}`, {
      title: t('alertTitle', { name: ext.name }),
      message: t('alertMessage', { detail }),
    });
  }
  await setAlerts(alerts);
}

// --- After leaving ---------------------------------------------------------------------------

async function cleanupSite(domain) {
  try {
    const origins = [`https://${domain}`, `https://www.${domain}`, `http://${domain}`, `http://www.${domain}`];
    await chrome.browsingData.remove(
      { origins },
      { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true, fileSystems: true },
    );
    await addLog({ type: 'cleanup', site: domain });
  } catch (err) {
    await logError('errCleanup', { site: domain }, err);
  }
}

async function clearClipboard() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: t('clipboardJustification'),
      });
    }
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'clear-clipboard' });
    await chrome.offscreen.closeDocument();
    if (!response?.ok) throw new Error('copy command was rejected');
    await addLog({ type: 'clipboard' });
  } catch (err) {
    await logError('errClipboard', {}, err);
  }
}

// --- Evaluate & apply ------------------------------------------------------------------------

let checkTimer = null;
function scheduleCheck() {
  if (checkTimer) return;
  checkTimer = setTimeout(() => {
    checkTimer = null;
    requestCheck();
  }, GRACE_MS + 100);
  chrome.alarms.create(CHECK_ALARM, { delayInMinutes: 0.5 }); // safety net if the worker stops
}
function cancelCheck() {
  if (checkTimer) {
    clearTimeout(checkTimer);
    checkTimer = null;
  }
  chrome.alarms.clear(CHECK_ALARM);
}

let lastBadge = null;
async function setBadge({ mode, count }) {
  const key = `${mode}:${count}`;
  if (key === lastBadge) return;
  lastBadge = key;
  const cfg = {
    on: { text: 'ON', color: '#1a7f37', title: t('badgeOnTitle', { count }) },
    pause: { text: 'II', color: '#9a6700', title: t('badgePausedTitle') },
    off: { text: '', color: '#1a7f37', title: t('extName') },
  }[mode];
  await chrome.action.setBadgeText({ text: cfg.text });
  await chrome.action.setBadgeBackgroundColor({ color: cfg.color });
  await chrome.action.setTitle({ title: cfg.title });
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function evaluate(opts = {}) {
  const [settings, state, paused, flaggedTabs, loadTimes, tabs, extensions] = await Promise.all([
    getSettings(), getState(), isPaused(), getFlaggedTabs(), getLoadTimes(),
    chrome.tabs.query({}), chrome.management.getAll(),
  ]);
  const p = plan({
    now: Date.now(), graceMs: GRACE_MS, settings, state, paused, tabs, flaggedTabs, loadTimes,
    extensions, selfId: chrome.runtime.id, ...opts,
  });
  const names = new Map(extensions.map((e) => [e.id, e.name]));
  const nameOf = (id) => names.get(id) || id;

  for (const domain of p.cleanup) await cleanupSite(domain);
  if (p.unpause) await setPaused(false);
  if (p.clearClipboard) await clearClipboard(); // before extensions come back

  // Record first, then turn off: a crash can never lose track of what we disabled.
  if (p.disable.length) {
    await setState({ ...state, disabledByUs: [...new Set([...state.disabledByUs, ...p.disable])] });
  }
  const disabled = [];
  for (const id of p.disable) if (await setEnabled(id, false, nameOf(id))) disabled.push(id);
  const enabled = [];
  for (const id of p.enable) if (await setEnabled(id, true, nameOf(id))) enabled.push(id);

  const nextState = disabled.length ? { ...p.nextState, cleanSince: Date.now() } : p.nextState;
  if (!sameJson(nextState, state)) await setState(nextState);

  if (disabled.length) await addLog({ type: 'disabled', names: disabled.map(nameOf), sites: nextState.activeSites });
  if (enabled.length) await addLog({ type: 'enabled', names: enabled.map(nameOf) });
  if (p.intrusion.length) {
    const intruders = p.intrusion.map(nameOf);
    await addLog({ type: 'intrusion', names: intruders });
    await notify(INTRUSION_NOTIFICATION, {
      title: t('intrusionTitle'),
      message: t('intrusionMessage', { names: intruders.join(', ') }),
      buttons: [{ title: t('reloadProtectedTabs') }],
    });
  }

  await setBadge(p.badge);
  p.scheduleCheck ? scheduleCheck() : cancelCheck();
  return p;
}

async function reloadTab(tabId, url) {
  try {
    await (url ? chrome.tabs.update(tabId, { url }) : chrome.tabs.reload(tabId));
  } catch (err) {
    await logError('errReload', {}, err);
  }
}

async function protect(opts = {}) {
  const p = await evaluate(opts);
  if (p.restartNavigation) await reloadTab(p.restartNavigation.tabId, p.restartNavigation.url);
  for (const tabId of p.reloadTabIds) await reloadTab(tabId);
}

async function reloadAllProtectedTabs() {
  const [settings, flagged, tabs] = await Promise.all([getSettings(), getFlaggedTabs(), chrome.tabs.query({})]);
  for (const tab of tabs) {
    if (siteForTab(tab.url, tab.id, settings, flagged)) await reloadTab(tab.id);
  }
}

// --- Events -------------------------------------------------------------------------------------

// As early as possible: before the page loads. Not coalesced, it carries the target URL.
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  run(() => protect({ extraUrls: [d.url], navigation: { tabId: d.tabId, url: d.url } }));
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  run(async () => {
    await recordLoad(d.tabId);
    await forgetTab(d.tabId, d.url);
  });
  requestCheck();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  run(async () => {
    await forgetTab(tabId);
    await protect({ excludeTabId: tabId });
  });
});

chrome.tabs.onReplaced.addListener((_added, removed) => {
  run(() => forgetTab(removed));
  requestCheck();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'sensitive-field' || !sender.tab) return;
  run(async () => {
    if (await flagTab(sender.tab)) await protect();
  });
});

// New or updated extensions: check permissions, then turn off if needed.
chrome.management.onInstalled.addListener((ext) => {
  if (ext.id === chrome.runtime.id) return;
  run(reconcileApprovals);
  requestCheck();
});
chrome.management.onEnabled.addListener((ext) => {
  if (ext.id === chrome.runtime.id || isEcho(ext.id)) return;
  requestCheck();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[KEYS.settings]) {
    run(async () => {
      await syncDetector(await getSettings());
      await reconcileApprovals();
    });
  }
  if (changes[KEYS.settings] || changes[KEYS.paused]) requestCheck();
});

// Website access revoked in chrome://extensions: turn detection off.
chrome.permissions.onRemoved.addListener(() => {
  run(async () => {
    if (!(await chrome.permissions.contains({ origins: DETECTOR_ORIGINS }))) {
      await actions.setOption('fieldDetection', false);
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) requestCheck();
  if (alarm.name === AUDIT_ALARM) run(reconcileApprovals);
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith('alert-')) chrome.runtime.openOptionsPage();
});
chrome.notifications.onButtonClicked.addListener((id) => {
  if (id === INTRUSION_NOTIFICATION) run(reloadAllProtectedTabs);
});

// --- Boot ----------------------------------------------------------------------------------------

// Runs once per browser session and after the extension is installed, updated or
// re-enabled (storage.session is cleared in all those cases) — unlike onStartup.
async function boot() {
  if (await isBooted()) return;
  await migrate();
  await syncDetector(await getSettings());
  await reconcileApprovals();
  await chrome.alarms.create(AUDIT_ALARM, { periodInMinutes: 360 });
  await markBooted();
  await protect();
}
run(boot);
