import { t } from './lib/i18n.js';
import { hostOf, matchSite } from './lib/domains.js';
import { plan, siteForTab, describeTab, allowlistedIds } from './lib/planner.js';
import { describePermission } from './lib/risk.js';
import {
  KEYS, migrate, getSettings, isPaused, setPaused, getState, setState,
  getAlerts, setAlerts, getApprovals, setApprovals, addLog, actions,
  getFlaggedTabs, setFlaggedTabs, getFramedTabs, setFramedTabs, getLoadTimes, setLoadTimes,
  isBooted, markBooted,
} from './lib/storage.js';

// Grace period before extensions come back or a site is cleaned up, so that
// redirects between (protected) domains don't cause on/off/on flapping.
const GRACE_MS = 3000;
const CHECK_ALARM = 'exterminator-check';
const AUDIT_ALARM = 'exterminator-audit';
const AUDIT_MINUTES = 30;
const DETECTOR_ID = 'field-detector';
const DETECTOR_ORIGINS = ['http://*/*', 'https://*/*'];
const NOTIFY = { intrusion: 'intrusion', frame: 'frame-', disableFailed: 'disable-failed' };

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

async function notify(id, options) {
  try {
    await chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', priority: 2, ...options });
  } catch (err) {
    await logError('errNotify', {}, err);
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
  // The extended mode is passed as a separate file instead of via chrome.storage, so the
  // content script never needs storage access (see detector-extended.js).
  const js = settings.sensitiveFields ? ['detector-extended.js', 'detector.js'] : ['detector.js'];
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const stale = registered.filter((s) => s.id !== DETECTOR_ID).map((s) => s.id); // e.g. old ids
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  const current = registered.find((s) => s.id === DETECTOR_ID);

  if (want && !current) {
    await chrome.scripting.registerContentScripts([{
      id: DETECTOR_ID,
      matches: DETECTOR_ORIGINS,
      js,
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    }]);
  } else if (want && current.js.join() !== js.join()) {
    await chrome.scripting.updateContentScripts([{ id: DETECTOR_ID, js }]);
  } else if (!want && current) {
    await chrome.scripting.unregisterContentScripts({ ids: [DETECTOR_ID] });
  }
  if (!want) await setFlaggedTabs({});
}

// A tab with a sensitive field stays protected for as long as it stays on that host.
// `reused`: the document came back from the back/forward cache or a prerender, so it may
// hold scripts of extensions that were on at the time; forget its load time to force a reload.
async function flagTab(tab, reused) {
  const settings = await getSettings();
  const flagged = await getFlaggedTabs();
  const { host, site, exclusion } = describeTab(tab?.url, tab?.id, settings, flagged);
  if (!settings.fieldDetection || !host || exclusion) return false;
  if (reused) {
    const times = await getLoadTimes();
    times[tab.id] = 0;
    await setLoadTimes(times);
  } else if (flagged[tab.id] === host) {
    return false;
  }
  flagged[tab.id] = host;
  await setFlaggedTabs(flagged);
  if (!site) await addLog({ type: 'detected', site: host });
  return true;
}

// A new top-level document (newUrl) or a closed tab (no newUrl).
async function forgetTab(tabId, newUrl) {
  const flagged = await getFlaggedTabs();
  if (tabId in flagged && (newUrl === undefined || hostOf(newUrl) !== flagged[tabId])) {
    delete flagged[tabId];
    await setFlaggedTabs(flagged);
  }
  const framed = await getFramedTabs();
  if (tabId in framed) {
    delete framed[tabId]; // the frames belonged to the previous document
    await setFramedTabs(framed);
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

async function recordFrame(tabId, host) {
  const framed = await getFramedTabs();
  const hosts = new Set(framed[tabId] || []);
  if (hosts.has(host)) return;
  framed[tabId] = [...hosts, host];
  await setFramedTabs(framed);
}

// --- Monitoring "Always on" extensions --------------------------------------------------------

function snapshot(ext) {
  return {
    version: ext.version,
    permissions: [...(ext.permissions || [])].sort(),
    hostPermissions: [...(ext.hostPermissions || [])].sort(),
  };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Compares the permissions of allowed extensions with the moment they were approved.
 * New permissions → removed from every list, plus an alert and a notification.
 * Runs before every evaluation, so drift is caught at the next navigation or tab event,
 * not only on updates (runtime-granted permissions fire no management event).
 */
async function reconcileApprovals(extensions) {
  const settings = await getSettings();
  const approvals = await getApprovals();
  const alerts = await getAlerts();
  const openAlerts = new Set(alerts.map((a) => a.id));
  const byId = new Map(extensions.map((e) => [e.id, e]));
  const ids = allowlistedIds(settings);
  const next = { ...approvals };
  const escalated = []; // [{ ext, added }]

  for (const id of ids) {
    const ext = byId.get(id);
    if (!ext) continue; // keep its approval: a reinstall with more permissions is still caught
    const current = snapshot(ext);
    const approved = approvals[id];
    if (!approved) {
      // Re-added while an alert is still open (e.g. a concurrent write): don't silently re-approve.
      if (openAlerts.has(id)) escalated.push({ ext, added: [] });
      else next[id] = current;
      continue;
    }
    const added = [
      ...current.permissions.filter((p) => !approved.permissions.includes(p)),
      ...current.hostPermissions.filter((h) => !approved.hostPermissions.includes(h)),
    ];
    if (added.length) {
      escalated.push({ ext, added });
      delete next[id];
    } else {
      next[id] = current; // fewer permissions or a new version without extra permissions
    }
  }
  for (const id of Object.keys(next)) {
    if (!ids.has(id)) delete next[id];
  }
  if (!sameJson(next, approvals)) await setApprovals(next);
  if (!escalated.length) return;

  const where = await actions.removeFromAllowlists(escalated.map((x) => x.ext.id));
  const kept = alerts.filter((a) => !where[a.id]);
  for (const { ext, added } of escalated) {
    const previous = alerts.find((a) => a.id === ext.id);
    const permissions = added.length ? added : previous?.added || [];
    const detail = t('alertDetail', { version: ext.version, permissions: permissions.map(describePermission).join('; ') });
    kept.push({ id: ext.id, name: ext.name, version: ext.version, added: permissions, where: previous?.where || where[ext.id], t: Date.now() });
    await addLog({ type: 'alert', name: ext.name, detail });
    await notify(`alert-${ext.id}`, { title: t('alertTitle', { name: ext.name }), message: t('alertMessage', { detail }) });
  }
  await setAlerts(kept);
}

// --- After leaving ---------------------------------------------------------------------------

// Clears every host of the site that was actually visited while protected, plus the
// domain itself and its www host (cookies are cleared registrable-domain wide by Chrome).
async function cleanupSite({ domain, hosts }) {
  try {
    const origins = hosts.flatMap((host) => [`https://${host}`, `http://${host}`]);
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

async function evaluate(opts = {}) {
  await reconcileApprovals(await chrome.management.getAll());
  const [settings, state, paused, flaggedTabs, framedTabs, loadTimes, tabs, extensions] = await Promise.all([
    getSettings(), getState(), isPaused(), getFlaggedTabs(), getFramedTabs(), getLoadTimes(),
    chrome.tabs.query({}), chrome.management.getAll(),
  ]);
  const p = plan({
    now: Date.now(), graceMs: GRACE_MS, settings, state, paused, tabs, flaggedTabs, framedTabs, loadTimes,
    extensions, selfId: chrome.runtime.id, ...opts,
  });
  const names = new Map(extensions.map((e) => [e.id, e.name]));
  const nameOf = (id) => names.get(id) || id;

  for (const site of p.cleanup) await cleanupSite(site);
  if (p.unpause) await setPaused(false);
  if (p.clearClipboard) await clearClipboard(); // before extensions come back

  // Record first, then turn off: a crash can never lose track of what we disabled.
  if (p.disable.length) {
    await setState({ ...state, disabledByUs: [...new Set([...state.disabledByUs, ...p.disable])] });
  }
  const disabled = [];
  const failed = [];
  for (const id of p.disable) (await setEnabled(id, false, nameOf(id)) ? disabled : failed).push(id);
  const enabled = [];
  for (const id of p.enable) if (await setEnabled(id, true, nameOf(id))) enabled.push(id);

  // Stamp the moment extensions were actually off: tabs loaded before it need a reload.
  const offAt = Date.now();
  const nextState = { ...p.nextState, disabledAt: { ...p.nextState.disabledAt } };
  for (const id of p.stamp) if (disabled.includes(id)) nextState.disabledAt[id] = offAt;
  if (!sameJson(nextState, state)) await setState(nextState);

  if (disabled.length) await addLog({ type: 'disabled', names: disabled.map(nameOf), sites: nextState.activeSites });
  if (enabled.length) await addLog({ type: 'enabled', names: enabled.map(nameOf) });
  if (failed.length) {
    // Fail loudly: an extension we could not turn off is still running on the protected page.
    await notify(NOTIFY.disableFailed, {
      title: t('disableFailedTitle'),
      message: t('disableFailedMessage', { names: failed.map(nameOf).join(', ') }),
    });
  }
  if (p.intrusion.length) {
    const intruders = p.intrusion.map(nameOf);
    await addLog({ type: 'intrusion', names: intruders });
    await notify(NOTIFY.intrusion, {
      title: t('intrusionTitle'),
      message: t('intrusionMessage', { names: intruders.join(', ') }),
      buttons: [{ title: t('reloadProtectedTabs') }],
    });
  }

  await setBadge(p.badge);
  p.scheduleCheck ? scheduleCheck() : cancelCheck();
  return { ...p, state: nextState, settings };
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
  return p;
}

async function reloadAllProtectedTabs() {
  const [settings, flagged, tabs] = await Promise.all([getSettings(), getFlaggedTabs(), chrome.tabs.query({})]);
  for (const tab of tabs) {
    if (siteForTab(tab.url, tab.id, settings, flagged)) await reloadTab(tab.id);
  }
}

// A protected site inside an iframe: extensions are turned off as soon as the frame starts
// loading. The frame itself can't be reloaded safely (it may be a payment step), so if it
// committed before extensions were off, ask the user instead.
async function protectFrame(d) {
  const host = hostOf(d.url);
  await recordFrame(d.tabId, host);
  const { state, settings } = await protect();
  const site = matchSite(host, settings.sites);
  const allowed = new Set([...settings.globalWhitelist, ...(site?.extra || [])]);
  const lateBy = Object.entries(state.disabledAt).some(([id, at]) => !allowed.has(id) && d.timeStamp <= at);
  if (lateBy) {
    await addLog({ type: 'frameRace', site: host });
    await notify(`${NOTIFY.frame}${d.tabId}`, {
      title: t('frameRaceTitle'),
      message: t('frameRaceMessage', { site: host }),
      buttons: [{ title: t('reloadTab') }],
    });
  }
}

// --- Events -------------------------------------------------------------------------------------

// Main frames are identified by frameType when Chrome provides it: prerendered pages have
// a main frame with a non-zero frameId.
const isMainFrame = (d) => (d.frameType ? d.frameType === 'outermost_frame' : d.frameId === 0);
const isPrerender = (d) => d.documentLifecycle === 'prerender';
// Read from storage on every frame event: an in-memory cache would be empty right after the
// service worker wakes up, which is exactly when the first frame event arrives.
const isSubFrame = (d) => (d.frameType ? d.frameType === 'sub_frame' : d.frameId !== 0);
async function isProtectedHost(url) {
  return !!matchSite(hostOf(url), (await getSettings()).sites);
}

// As early as possible: before the page loads.
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (isMainFrame(d)) {
    // A prerender can't be restarted, but extensions can already be turned off for it.
    const navigation = isPrerender(d) ? undefined : { tabId: d.tabId, url: d.url };
    run(() => protect({ extraUrls: [d.url], navigation }));
  } else if (isSubFrame(d)) {
    run(async () => {
      if (await isProtectedHost(d.url)) await protect({ extraUrls: [d.url] });
    });
  }
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (isMainFrame(d) && !isPrerender(d)) {
    run(async () => {
      await recordLoad(d.tabId);
      await forgetTab(d.tabId, d.url);
    });
    requestCheck();
  } else if (isSubFrame(d)) {
    run(async () => {
      if (await isProtectedHost(d.url)) await protectFrame(d);
    });
  }
});

// Fallback for URL changes without a (main-frame) navigation event, e.g. prerender activation.
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.url) requestCheck();
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
    if (await flagTab(sender.tab, msg.reused === true)) await protect();
  });
});

// New, updated or re-enabled extensions: every check re-verifies permissions first.
chrome.management.onInstalled.addListener((ext) => {
  if (ext.id !== chrome.runtime.id) requestCheck();
});
chrome.management.onEnabled.addListener((ext) => {
  if (ext.id === chrome.runtime.id || isEcho(ext.id)) return;
  requestCheck();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[KEYS.settings]) {
    run(async () => syncDetector(await getSettings()));
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
  if (alarm.name === CHECK_ALARM || alarm.name === AUDIT_ALARM) requestCheck();
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith('alert-')) chrome.runtime.openOptionsPage();
});
chrome.notifications.onButtonClicked.addListener((id) => {
  if (id === NOTIFY.intrusion) run(reloadAllProtectedTabs);
  if (id.startsWith(NOTIFY.frame)) run(() => reloadTab(Number(id.slice(NOTIFY.frame.length))));
});

// Content scripts don't need extension storage (the detector gets its mode from a file), so
// keep settings, the site list and the log out of reach of web renderers where Chrome allows it.
async function restrictStorage() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch (err) {
    console.info('[Exterminator] storage.local access level not adjustable here:', err?.message);
  }
}

// --- Boot ----------------------------------------------------------------------------------------

// Runs once per browser session and after the extension is installed, updated or
// re-enabled (storage.session is cleared in all those cases) — unlike onStartup.
async function boot() {
  await restrictStorage();
  if (await isBooted()) return;
  await migrate();
  await syncDetector(await getSettings());
  await chrome.alarms.create(AUDIT_ALARM, { periodInMinutes: AUDIT_MINUTES });
  await markBooted();
  await protect();
}
run(boot);
