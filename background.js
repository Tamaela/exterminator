import { t } from './lib/i18n.js';
import { hostOf, matchSite } from './lib/domains.js';
import { plan, siteForTab, describeTab, allowlistedIds } from './lib/planner.js';
import { describePermission, permissionSnapshot } from './lib/risk.js';
import {
  KEYS, migrate, getSettings, isPaused, setPaused, getState, setState,
  getAlerts, setAlerts, getApprovals, setApprovals, addLog, actions,
  getFlaggedTabs, setFlaggedTabs, getFramedTabs, setFramedTabs, getPrerenderTabs, setPrerenderTabs,
  getLoadTimes, setLoadTimes, isBooted, markBooted, getInheritedTabs, setInheritedTabs,
  getLoadHistory, setLoadHistory, isUpdatePending, markUpdatePending,
} from './lib/storage.js';

// Grace period before extensions come back or a site is cleaned up, so that
// redirects between (protected) domains don't cause on/off/on flapping.
const GRACE_MS = 3000;
const CHECK_ALARM = 'exterminator-check';
const AUDIT_ALARM = 'exterminator-audit';
const AUDIT_MINUTES = 30;
// While protected mode is active, permissions of allowed extensions are re-checked every minute
// (permissions granted at runtime fire no event).
const FAST_AUDIT_ALARM = 'exterminator-audit-active';
const DETECTOR_ID = 'field-detector';
const DETECTOR_ORIGINS = ['http://*/*', 'https://*/*'];
const NOTIFY = { intrusion: 'intrusion', frame: 'frame-', stale: 'stale-', disableFailed: 'disable-failed', clipboard: 'clipboard-failed' };
const HISTORY_MAX = 20;

// --- Task queue ---------------------------------------------------------------------------

// Rejects when a promise takes too long. Some Chrome calls never settle (e.g. injecting into a
// discarded or frozen tab); one of those must never stall protection.
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// All tasks run one after another to avoid race conditions. A task that hangs is abandoned
// after TASK_TIMEOUT_MS so the tasks behind it (turning extensions off) still run.
const TASK_TIMEOUT_MS = 15000;
let queue = Promise.resolve();
function run(task) {
  queue = queue
    .then(() => withTimeout(Promise.resolve().then(task), TASK_TIMEOUT_MS, 'task'))
    .catch((err) => logError('errInternal', {}, err));
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
    await withTimeout(chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', priority: 2, ...options }), 3000, 'notification');
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
    await withTimeout(chrome.management.setEnabled(id, enabled), 5000, 'setEnabled');
    return true;
  } catch (err) {
    expectedEnables.delete(id);
    await logError(enabled ? 'errEnable' : 'errDisable', { name }, err);
    return false;
  }
}

// --- Field detection (optional) ------------------------------------------------------------

// Set by restrictStorage(): content scripts may only be injected when they cannot reach
// the settings in storage.local.
let storageRestricted = false;

async function warnStorageUnrestricted() {
  const { [KEYS.storageWarned]: warned } = await chrome.storage.session.get(KEYS.storageWarned);
  if (warned) return;
  await chrome.storage.session.set({ [KEYS.storageWarned]: true });
  await addLog({ type: 'storageUnrestricted' });
  await notify('storage-unrestricted', { title: t('storageUnrestrictedTitle'), message: t('storageUnrestrictedMessage') });
}

// `injectOpen`: also run the detector in pages that are already open (after a restart, what we
// knew about them is gone). It always does that when it registers the detector anew.
async function syncDetector(settings, { injectOpen = false } = {}) {
  const hasPermission = await chrome.permissions.contains({ origins: DETECTOR_ORIGINS });
  if (settings.fieldDetection && hasPermission && !storageRestricted) await warnStorageUnrestricted();
  const want = settings.fieldDetection && hasPermission && storageRestricted;
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
      // Also about:blank, srcdoc, blob: and data: frames created by a web page.
      matchOriginAsFallback: true,
      // Not kept across browser restarts: boot() registers it again only after storage.local
      // has been shielded from content scripts in this session.
      persistAcrossSessions: false,
    }]);
  } else if (want && (current.js.join() !== js.join() || current.matchOriginAsFallback !== true || current.persistAcrossSessions)) {
    await chrome.scripting.updateContentScripts([{ id: DETECTOR_ID, js, matchOriginAsFallback: true, persistAcrossSessions: false }]);
  } else if (!want && current) {
    await chrome.scripting.unregisterContentScripts({ ids: [DETECTOR_ID] });
  }
  if (!want) await setFlaggedTabs({});
  // Not awaited: injecting can be slow or never finish for some tabs, and must not hold up
  // the task queue (turning extensions off).
  if (want && (injectOpen || !current)) injectDetector(js).catch(() => {});
}

// Runs the detector in pages that are already open (it ignores a second injection).
async function injectDetector(js) {
  const tabs = await chrome.tabs.query({ url: DETECTOR_ORIGINS, discarded: false });
  await Promise.all(tabs.filter((tab) => !tab.frozen).map((tab) => withTimeout(chrome.scripting
    .executeScript({ target: { tabId: tab.id, allFrames: true }, files: js }), 5000, 'inject')
    .catch(() => {}))); // e.g. an error page, the Web Store, or a tab that doesn't respond
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
  for (const [get, set] of [[getFramedTabs, setFramedTabs], [getPrerenderTabs, setPrerenderTabs]]) {
    const map = await get();
    if (tabId in map) {
      delete map[tabId]; // frames and prerenders belonged to the previous document
      await set(map);
    }
  }
  const inherited = await getInheritedTabs();
  // A popup keeps its opener's site until it shows a real web page of its own.
  if (tabId in inherited && (newUrl === undefined || /^https?:/i.test(newUrl))) {
    delete inherited[tabId];
    await setInheritedTabs(inherited);
  }
  if (newUrl === undefined) {
    for (const [get, set] of [[getLoadTimes, setLoadTimes], [getLoadHistory, setLoadHistory]]) {
      const map = await get();
      delete map[tabId];
      await set(map);
    }
  }
}

// The commit time Chrome reports, not the moment this queued task runs: an earlier queued
// task may have turned extensions off in between, after the page already got their scripts.
// Back/forward (`restored`): the document may come from the back/forward cache, loaded long
// ago; use the time this URL was first loaded in this tab, or 0 (unknown) if we never saw it.
async function recordLoad(tabId, committedAt, url, restored) {
  const history = await getLoadHistory();
  const entries = history[tabId] || [];
  const at = Math.min(committedAt ?? Infinity, Date.now());
  const earlier = restored ? entries.findLast((e) => e.url === url) : null;
  const loadedAt = restored ? earlier?.at ?? 0 : at;
  history[tabId] = [...entries.filter((e) => e.url !== url), { url, at: loadedAt }].slice(-HISTORY_MAX);
  await setLoadHistory(history);
  const times = await getLoadTimes();
  times[tabId] = loadedAt;
  await setLoadTimes(times);
}

// A popup or new tab opened by a protected page (window.open, target=_blank). An about:blank
// popup has no origin of its own: it stays protected as part of the opener's site, even if the
// opener later navigates away.
async function recordOpener(d) {
  const [settings, flagged, inherited] = await Promise.all([getSettings(), getFlaggedTabs(), getInheritedTabs()]);
  let source;
  try {
    source = await chrome.tabs.get(d.sourceTabId);
  } catch {
    return;
  }
  const site = siteForTab(source.url, source.id, settings, flagged);
  const entry = site
    ? { host: site.auto ? site.domain : hostOf(source.url), auto: !!site.auto }
    : inherited[d.sourceTabId]; // a popup opened by such a popup
  if (!entry) return;
  inherited[d.tabId] = entry;
  await setInheritedTabs(inherited);
}

async function addHost(get, set, tabId, host) {
  const map = await get();
  const hosts = new Set(map[tabId] || []);
  if (hosts.has(host)) return;
  map[tabId] = [...hosts, host];
  await set(map);
}
const recordFrame = (tabId, host) => addHost(getFramedTabs, setFramedTabs, tabId, host);
const recordPrerender = (tabId, host) => addHost(getPrerenderTabs, setPrerenderTabs, tabId, host);

// Protected hosts in the sub-frames a tab has right now. Needed when frames exist without a
// new commit: a page restored from the back/forward cache, or after Exterminator restarted.
async function rescanFrames(tabId) {
  const found = await protectedFrameHosts(tabId);
  for (const host of found) await recordFrame(tabId, host);
  return found;
}

// Read-only, so it can run for many tabs at once.
async function protectedFrameHosts(tabId) {
  let frames;
  try {
    frames = await withTimeout(chrome.webNavigation.getAllFrames({ tabId }), 2000, 'getAllFrames');
  } catch {
    return [];
  }
  const { sites } = await getSettings();
  const found = new Set();
  for (const frame of frames || []) {
    if (frame.parentFrameId === -1) continue; // a main frame
    const host = hostOf(frame.url);
    if (host && matchSite(host, sites)) found.add(host);
  }
  return [...found];
}

// A tab was swapped for another one (e.g. a discarded tab coming back): keep what we know.
async function replaceTab(added, removed) {
  const pairs = [[getFlaggedTabs, setFlaggedTabs], [getFramedTabs, setFramedTabs], [getPrerenderTabs, setPrerenderTabs],
    [getInheritedTabs, setInheritedTabs]];
  for (const [get, set] of pairs) {
    const map = await get();
    if (!(removed in map)) continue;
    const [mine, theirs] = [map[added], map[removed]];
    // Merge, never drop: the new tab may already have recorded something itself.
    map[added] = Array.isArray(theirs) ? [...new Set([...(mine || []), ...theirs])] : mine ?? theirs;
    delete map[removed];
    await set(map);
  }
  for (const [get, set] of [[getLoadTimes, setLoadTimes], [getLoadHistory, setLoadHistory]]) {
    const map = await get();
    if (!(removed in map)) continue;
    delete map[removed]; // the new tab's load time is unknown: that forces a reload when needed
    await set(map);
  }
}

// --- Monitoring "Always on" extensions --------------------------------------------------------

const snapshot = permissionSnapshot;
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
  if (!sameJson(next, approvals)) {
    // Keep approvals written meanwhile by the options page or popup (e.g. "Allow again").
    const latest = await getApprovals();
    for (const [id, value] of Object.entries(latest)) {
      if (!sameJson(value, approvals[id]) && ids.has(id) && !escalated.some((x) => x.ext.id === id)) next[id] = value;
    }
    await setApprovals(next);
  }
  if (!escalated.length) return;

  const where = await actions.removeFromAllowlists(escalated.map((x) => x.ext.id));
  const latest = await getAlerts(); // re-read: the options page may have changed them meanwhile
  const kept = latest.filter((a) => !where[a.id]);
  for (const { ext, added } of escalated) {
    const previous = latest.find((a) => a.id === ext.id);
    const permissions = added.length ? added : previous?.added || [];
    const detail = t('alertDetail', { version: ext.version, permissions: permissions.map(describePermission).join('; ') });
    kept.push({
      id: ext.id, name: ext.name, version: ext.version, added: permissions,
      // "Allow again" approves exactly this; anything added after the alert raises a new one.
      approved: snapshot(ext),
      where: previous?.where || where[ext.id],
      t: Date.now(),
    });
    await addLog({ type: 'alert', name: ext.name, detail });
    await notify(`alert-${ext.id}`, { title: t('alertTitle', { name: ext.name }), message: t('alertMessage', { detail }) });
  }
  await setAlerts(kept);
}

// --- After leaving ---------------------------------------------------------------------------

// Clears every host of the site that was actually visited while protected, plus the
// domain itself and its www host (cookies are cleared registrable-domain wide by Chrome).
async function cleanupSite({ domain, hosts, incognito }) {
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
  // browsingData only reaches the normal profile; incognito data lives until its windows close.
  if (incognito) await addLog({ type: 'cleanupIncognito', site: domain });
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
    const response = await withTimeout(chrome.runtime.sendMessage({ target: 'offscreen', type: 'clear-clipboard' }), 5000, 'clipboard');
    await chrome.offscreen.closeDocument().catch(() => {});
    if (!response?.ok) throw new Error('copy command was rejected');
    await addLog({ type: 'clipboard' });
  } catch (err) {
    await logError('errClipboard', {}, err);
    await notify(NOTIFY.clipboard, { title: t('clipboardFailedTitle'), message: t('clipboardFailedMessage') });
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

let fastAudit = null;
async function syncFastAudit(active) {
  if (fastAudit === active) return;
  fastAudit = active;
  await (active ? chrome.alarms.create(FAST_AUDIT_ALARM, { periodInMinutes: 1 }) : chrome.alarms.clear(FAST_AUDIT_ALARM));
}

// Set when Chrome has an update for Exterminator: applied once protection is off, because
// restarting clears what we know about open tabs (detected fields, frames).
let updatePending = false;

async function evaluate(opts = {}) {
  try {
    await reconcileApprovals(await chrome.management.getAll());
  } catch (err) {
    await logError('errInternal', {}, err); // never skip turning extensions off because of this
  }
  const [settings, state, paused, flaggedTabs, framedTabs, prerenderTabs, inheritedTabs, loadTimes, tabs, extensions] = await Promise.all([
    getSettings(), getState(), isPaused(), getFlaggedTabs(), getFramedTabs(), getPrerenderTabs(), getInheritedTabs(),
    getLoadTimes(), chrome.tabs.query({}), chrome.management.getAll(),
  ]);
  const p = plan({
    now: Date.now(), graceMs: GRACE_MS, settings, state, paused, tabs, flaggedTabs, framedTabs, prerenderTabs,
    inheritedTabs, loadTimes, extensions, selfId: chrome.runtime.id, ...opts,
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
  for (const id of failed) { // still on: no "off since" moment
    if (id in state.disabledAt) nextState.disabledAt[id] = state.disabledAt[id];
    else delete nextState.disabledAt[id];
  }
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

  for (const { tabId, domain } of p.frameRace) {
    await addLog({ type: 'frameRace', site: domain });
    await notify(`${NOTIFY.frame}${tabId}`, {
      title: t('frameRaceTitle'),
      message: t('frameRaceMessage', { site: domain }),
      buttons: [{ title: t('reloadTab') }],
    });
  }

  for (const { tabId, domain } of p.staleTabs) {
    await addLog({ type: 'frameRace', site: domain });
    await notify(`${NOTIFY.stale}${tabId}`, { title: t('staleTabTitle'), message: t('staleTabMessage', { site: domain }) });
  }

  await setBadge(p.badge);
  p.scheduleCheck ? scheduleCheck() : cancelCheck();
  const active = nextState.activeSites.length > 0;
  await syncFastAudit(active);
  if (!active && !nextState.disabledByUs.length && (updatePending || await isUpdatePending())) chrome.runtime.reload();
  return { ...p, state: nextState, settings };
}

async function reloadTab(tabId, url) {
  try {
    await withTimeout(url ? chrome.tabs.update(tabId, { url }) : chrome.tabs.reload(tabId), 5000, 'reload');
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

// Every web page that is protected, by its own URL or through a protected iframe.
async function reloadAllProtectedTabs() {
  const [settings, flagged, framed, tabs] = await Promise.all([
    getSettings(), getFlaggedTabs(), getFramedTabs(), chrome.tabs.query({}),
  ]);
  for (const tab of tabs) {
    if (!/^https?:/i.test(tab.url || '')) continue; // about:blank or blob: pages would be lost
    const viaFrame = (framed[tab.id] || []).some((host) => matchSite(host, settings.sites));
    if (viaFrame || siteForTab(tab.url, tab.id, settings, flagged)) await reloadTab(tab.id);
  }
}

// A protected site inside an iframe: extensions are turned off as soon as the frame starts
// loading. The frame itself can't be reloaded safely (it may be a payment step), so if it
// committed before extensions were off, ask the user instead.
async function protectFrame(d) {
  const host = hostOf(d.url);
  await recordFrame(d.tabId, host);
  const { state, settings, frameRace } = await protect();
  if (frameRace.some((f) => f.tabId === d.tabId)) return; // already warned by this check
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
// Everything else is a sub-frame, fenced frames included.
const isSubFrame = (d) => (d.frameType ? d.frameType !== 'outermost_frame' : d.frameId !== 0);
async function isProtectedHost(url) {
  return !!matchSite(hostOf(url), (await getSettings()).sites);
}

// As early as possible: before the page loads.
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (isMainFrame(d)) {
    // A prerender can't be restarted, but extensions can already be turned off for it.
    const navigation = isPrerender(d) ? undefined : { tabId: d.tabId, url: d.url };
    run(async () => {
      // Keep protection on for as long as the prerendered page exists, not just this once.
      if (isPrerender(d) && await isProtectedHost(d.url)) await recordPrerender(d.tabId, hostOf(d.url));
      await protect({ extraUrls: [d.url], navigation });
    });
  } else if (isSubFrame(d)) {
    run(async () => {
      if (await isProtectedHost(d.url)) await protect({ frameUrls: [d.url] });
    });
  }
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  run(async () => {
    await recordOpener(d);
    await protect();
  });
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (isMainFrame(d) && isPrerender(d)) {
    // The prerender may have been redirected into a protected site after onBeforeNavigate.
    run(async () => {
      if (!(await isProtectedHost(d.url))) return;
      await recordPrerender(d.tabId, hostOf(d.url));
      await protect({ frameUrls: [d.url] });
    });
  } else if (isMainFrame(d)) {
    run(async () => {
      const restored = !!d.transitionQualifiers?.includes('forward_back');
      await recordLoad(d.tabId, d.timeStamp, d.url, restored);
      await forgetTab(d.tabId, d.url);
      // Frames that already exist belong to a document that was loaded before (a back/forward
      // cache restore or a prerender activation): record them again. After back/forward they
      // may have loaded while other extensions were on, so warn about those.
      const found = await rescanFrames(d.tabId);
      if (restored) for (const host of found) await protectFrame({ tabId: d.tabId, url: `https://${host}/`, timeStamp: 0 });
      await protect({ extraUrls: [d.url] }); // also records this host for "log out when leaving"
    });
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

chrome.tabs.onReplaced.addListener((added, removed) => {
  run(async () => {
    await replaceTab(added, removed);
    await protect();
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'sensitive-field' || !sender.tab) return;
  // Only the document the tab currently shows (not a prerender or a cached page) can flag it,
  // and only its main frame can claim to be a reused document (which forces a reload).
  if (sender.documentLifecycle && sender.documentLifecycle !== 'active') return;
  const reused = msg.reused === true && sender.frameId === 0;
  run(async () => {
    if (await flagTab(sender.tab, reused)) await protect();
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
  if ([CHECK_ALARM, AUDIT_ALARM, FAST_AUDIT_ALARM].includes(alarm.name)) requestCheck();
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith('alert-')) chrome.runtime.openOptionsPage();
});
chrome.notifications.onButtonClicked.addListener((id) => {
  if (id === NOTIFY.intrusion) run(reloadAllProtectedTabs);
  if (id.startsWith(NOTIFY.frame)) run(() => reloadTab(Number(id.slice(NOTIFY.frame.length))));
});

chrome.runtime.onUpdateAvailable.addListener(() => {
  updatePending = true;
  run(async () => {
    await markUpdatePending(); // survives the service worker stopping
    await protect();
  });
});

// Content scripts don't need extension storage (the detector gets its mode from a file), so
// keep settings, the site list and the log out of reach of web renderers. If Chrome refuses,
// the detector is not injected at all (see syncDetector).
async function restrictStorage() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    storageRestricted = true;
  } catch (err) {
    storageRestricted = false;
    console.warn('[Exterminator] storage.local could not be restricted:', err?.message);
  }
}

// --- Boot ----------------------------------------------------------------------------------------

// Runs once per browser session and after the extension is installed, updated or
// re-enabled, because storage.session is cleared in all those cases. onStartup covers only the first case.
async function boot() {
  await restrictStorage();
  if (await isBooted()) return;
  await migrate();
  // Marked first: if a later step hangs or fails, the next worker start must not repeat it.
  await markBooted();
  await chrome.alarms.create(AUDIT_ALARM, { periodInMinutes: AUDIT_MINUTES });
  try {
    // After an update or restart, what we knew about open pages is gone: rebuild it before the
    // first check, so tabs protected by a frame or a detected field don't lose protection.
    await syncDetector(await getSettings(), { injectOpen: true });
    const tabs = await chrome.tabs.query({ discarded: false });
    const hosts = await Promise.all(tabs.map((tab) => protectedFrameHosts(tab.id)));
    for (const [i, tab] of tabs.entries()) for (const host of hosts[i]) await recordFrame(tab.id, host);
  } catch (err) {
    await logError('errInternal', {}, err);
  }
  await protect();
}
run(boot);
