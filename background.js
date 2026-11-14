import {
  getSettings,
  saveSettings,
  getState,
  getPasswordTabs,
  addLog,
  hostOf,
  matchSite,
  hostInDomains,
  isManageable,
  computeAllowed,
  allowlistedIds,
  removeFromAllowlists,
  describePermission,
  DETECTOR_ORIGINS,
} from './common.js';

// Grace period before extensions come back or a site is cleaned up, so that
// redirects between (protected) domains don't cause on/off/on flapping.
const LEAVE_GRACE_MS = 3000;
const CHECK_ALARM = 'exterminator-check';
const AUDIT_ALARM = 'exterminator-audit';
const DETECTOR_ID = 'password-detector';

// Run all tasks one after another to avoid race conditions.
let queue = Promise.resolve();
function run(task) {
  queue = queue.then(task).catch((err) => console.error('[Exterminator]', err));
  return queue;
}

async function setState(state) {
  await chrome.storage.local.set({ state });
}

async function setPasswordTabs(passwordTabs) {
  await chrome.storage.session.set({ passwordTabs });
}

const nameMap = (all) => new Map(all.map((e) => [e.id, e.name]));

// --- Sensitive field detection (optional) --------------------------------------

async function syncDetector(settings) {
  const hasPermission = await chrome.permissions.contains({ origins: DETECTOR_ORIGINS });
  const want = settings.passwordDetection && hasPermission;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DETECTOR_ID] });

  if (want && !existing.length) {
    await chrome.scripting.registerContentScripts([{
      id: DETECTOR_ID,
      matches: DETECTOR_ORIGINS,
      js: ['detector.js'],
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    }]);
  } else if (!want && existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [DETECTOR_ID] });
  }
  if (!want) await setPasswordTabs({});
}

// A tab with a sensitive field stays protected for as long as it stays on that host.
async function markPasswordTab(tab) {
  const settings = await getSettings();
  const host = hostOf(tab?.url);
  if (!settings.passwordDetection || !host) return false;
  if (hostInDomains(host, settings.detectionExclusions)) return false;
  const tabs = await getPasswordTabs();
  if (tabs[tab.id] === host) return false;
  tabs[tab.id] = host;
  await setPasswordTabs(tabs);
  if (!matchSite(host, settings.sites)) await addLog({ type: 'detected', site: host });
  return true;
}

async function clearPasswordTab(tabId, newUrl) {
  const tabs = await getPasswordTabs();
  if (!(tabId in tabs)) return;
  if (newUrl !== undefined && hostOf(newUrl) === tabs[tabId]) return; // same host: stays protected
  delete tabs[tabId];
  await setPasswordTabs(tabs);
}

// --- Monitoring "Always on" extensions ------------------------------------------

function snapshot(ext) {
  return {
    version: ext.version,
    permissions: [...(ext.permissions || [])].sort(),
    hostPermissions: [...(ext.hostPermissions || [])].sort(),
  };
}

async function raiseAlert(ext, where, added) {
  const detail = `new permissions after update to ${ext.version}: ${added.map(describePermission).join('; ')}`;
  const { alerts = [] } = await chrome.storage.local.get('alerts');
  const next = alerts.filter((a) => a.id !== ext.id);
  next.push({ id: ext.id, name: ext.name, version: ext.version, reason: 'permissions', added, where, t: Date.now() });
  await chrome.storage.local.set({ alerts: next });
  await addLog({ type: 'alert', name: ext.name, detail });
  try {
    await chrome.notifications.create(`alert-${ext.id}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `${ext.name} is no longer "Always on"`,
      message: `Reason: ${detail}. Review this in the Exterminator settings.`,
      priority: 2,
    });
  } catch (err) {
    console.warn('[Exterminator] notification failed:', err);
  }
}

/**
 * Compares the permissions of all allowed extensions with the moment they were
 * approved. New permissions → removed from the list + notification.
 */
async function reconcileApprovals() {
  const settings = await getSettings();
  const { approvals = {} } = await chrome.storage.local.get('approvals');
  const all = await chrome.management.getAll();
  const byId = new Map(all.map((e) => [e.id, e]));
  const ids = allowlistedIds(settings);
  let settingsChanged = false;
  let approvalsChanged = false;

  for (const id of ids) {
    const ext = byId.get(id);
    if (!ext) continue;
    const current = snapshot(ext);

    const approved = approvals[id];
    if (!approved) {
      approvals[id] = current;
      approvalsChanged = true;
      continue;
    }

    const added = [
      ...current.permissions.filter((p) => !approved.permissions.includes(p)),
      ...current.hostPermissions.filter((h) => !approved.hostPermissions.includes(h)),
    ];
    if (added.length) {
      const where = removeFromAllowlists(settings, id);
      settingsChanged = true;
      delete approvals[id];
      approvalsChanged = true;
      await raiseAlert(ext, where, added);
    } else if (JSON.stringify(approved) !== JSON.stringify(current)) {
      approvals[id] = current; // fewer permissions, or a new version without extra permissions
      approvalsChanged = true;
    }
  }

  for (const id of Object.keys(approvals)) {
    if (!ids.has(id) || !byId.has(id)) {
      delete approvals[id];
      approvalsChanged = true;
    }
  }

  if (approvalsChanged) await chrome.storage.local.set({ approvals });
  if (settingsChanged) await saveSettings(settings);
}

// --- Cleaning up after leaving -------------------------------------------------

async function cleanupSite(domain) {
  try {
    const origins = [`https://${domain}`, `https://www.${domain}`, `http://${domain}`, `http://www.${domain}`];
    await chrome.browsingData.remove(
      { origins },
      { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true, fileSystems: true },
    );
    await addLog({ type: 'cleanup', site: domain });
  } catch (err) {
    console.warn(`[Exterminator] cleaning up ${domain} failed:`, err);
  }
}

async function clearClipboard() {
  try {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'Clear the clipboard after leaving a protected page',
      });
    } catch {
      // Already exists.
    }
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'clear-clipboard' });
    await chrome.offscreen.closeDocument();
    await addLog({ type: 'clipboard' });
  } catch (err) {
    console.warn('[Exterminator] clearing the clipboard failed:', err);
  }
}

// --- Determining which tabs are protected --------------------------------------

function siteForTab(url, tabId, settings, passwordTabs) {
  const host = hostOf(url);
  const site = matchSite(host, settings.sites);
  if (site) return site;
  const excluded = hostInDomains(host, settings.detectionExclusions);
  if (host && tabId != null && passwordTabs[tabId] === host && !excluded) {
    // Not a configured site: only "Always on" applies.
    return { domain: host, extra: [], auto: true };
  }
  return null;
}

async function findActiveSites(settings, { extraUrls = [], excludeTabId } = {}) {
  const tabs = await chrome.tabs.query({});
  const passwordTabs = settings.passwordDetection ? await getPasswordTabs() : {};
  const active = new Map();
  const add = (url, tabId) => {
    const site = siteForTab(url, tabId, settings, passwordTabs);
    if (site) active.set(site.domain, site);
  };
  for (const url of extraUrls) add(url, null);
  for (const tab of tabs) {
    if (tab.id === excludeTabId) continue;
    if (tab.url) add(tab.url, tab.id);
    if (tab.pendingUrl) add(tab.pendingUrl, tab.id);
  }
  return [...active.values()];
}

// Deferred check (restore / clean up after the grace period).
let checkTimer = null;
function scheduleCheck() {
  if (checkTimer) return;
  checkTimer = setTimeout(() => {
    checkTimer = null;
    run(() => protect());
  }, LEAVE_GRACE_MS + 100);
  // Safety net in case the service worker stops in the meantime.
  chrome.alarms.create(CHECK_ALARM, { delayInMinutes: 0.5 });
}
function cancelCheck() {
  if (checkTimer) {
    clearTimeout(checkTimer);
    checkTimer = null;
  }
  chrome.alarms.clear(CHECK_ALARM);
}

async function setEnabledSafe(id, enabled) {
  try {
    await chrome.management.setEnabled(id, enabled);
    return true;
  } catch (err) {
    console.warn(`[Exterminator] setEnabled(${id}, ${enabled}) failed:`, err);
    return false;
  }
}

async function updateBadge(mode, count = 0) {
  const cfg = {
    on: { text: 'ON', color: '#1a7f37', title: `Exterminator: protected mode active (${count} extension(s) turned off)` },
    pause: { text: 'II', color: '#9a6700', title: 'Exterminator: paused' },
    off: { text: '', color: '#1a7f37', title: 'Exterminator' },
  }[mode];
  await chrome.action.setBadgeText({ text: cfg.text });
  await chrome.action.setBadgeBackgroundColor({ color: cfg.color });
  await chrome.action.setTitle({ title: cfg.title });
}

/**
 * Brings the state of all extensions in line with the open tabs.
 * Returns the IDs of extensions that were newly turned off in this round.
 */
async function evaluate(opts = {}) {
  const now = Date.now();
  const settings = await getSettings();
  const state = await getState();
  const sites = await findActiveSites(settings, opts);
  const openDomains = sites.map((s) => s.domain);

  // Clean up sites with "Log out when leaving" once the grace period has passed.
  const leftSites = { ...state.leftSites };
  for (const domain of state.seenSites) {
    const wantsCleanup = settings.sites.some((s) => s.domain === domain && s.cleanup);
    if (!openDomains.includes(domain) && wantsCleanup) leftSites[domain] ??= now;
  }
  for (const domain of openDomains) delete leftSites[domain];
  for (const [domain, since] of Object.entries(leftSites)) {
    if (now - since >= LEAVE_GRACE_MS) {
      await cleanupSite(domain);
      delete leftSites[domain];
    }
  }
  const base = { seenSites: openDomains, leftSites };
  const cleanupPending = Object.keys(leftSites).length > 0;

  // Pausing only lasts while you're on protected pages.
  const paused = settings.paused && sites.length > 0;
  if (settings.paused && !sites.length) {
    await saveSettings({ ...settings, paused: false });
  }

  if (paused || !sites.length) {
    const wasProtected = state.disabledByUs.length > 0 || state.activeSites.length > 0;
    const inactiveSince = state.inactiveSince ?? now;
    if (!paused && state.disabledByUs.length && now - inactiveSince < LEAVE_GRACE_MS) {
      await setState({ ...state, ...base, inactiveSince });
      scheduleCheck();
      return [];
    }

    // Clear the clipboard first, only then bring extensions back.
    if (!paused && wasProtected && settings.clearClipboard) await clearClipboard();

    if (state.disabledByUs.length) {
      const names = nameMap(await chrome.management.getAll());
      const restored = [];
      for (const id of state.disabledByUs) {
        if (await setEnabledSafe(id, true)) restored.push(names.get(id) || id);
      }
      if (restored.length) await addLog({ type: 'enabled', names: restored });
    }
    await setState({ disabledByUs: [], activeSites: [], autoSites: [], inactiveSince: null, ...base });
    await updateBadge(paused ? 'pause' : 'off');
    cleanupPending ? scheduleCheck() : cancelCheck();
    return [];
  }

  const allowed = computeAllowed(sites, settings.globalWhitelist);
  const all = await chrome.management.getAll();
  const names = nameMap(all);
  const installed = new Set(all.map((e) => e.id));

  // Allowlist model: everything not explicitly allowed is turned off,
  // including newly installed extensions.
  const toDisable = all
    .filter((e) => isManageable(e) && e.enabled && e.mayDisable && !allowed.has(e.id))
    .map((e) => e.id);
  const toEnable = state.disabledByUs.filter((id) => allowed.has(id) && installed.has(id));

  const disabledByUs = new Set(state.disabledByUs.filter((id) => installed.has(id) && !allowed.has(id)));
  toDisable.forEach((id) => disabledByUs.add(id));

  // Record first, then disable: that way nothing is lost after a crash.
  await setState({
    disabledByUs: [...disabledByUs],
    activeSites: openDomains,
    autoSites: sites.filter((s) => s.auto).map((s) => s.domain),
    inactiveSince: null,
    ...base,
  });

  const newlyDisabled = [];
  for (const id of toDisable) {
    if (await setEnabledSafe(id, false)) newlyDisabled.push(id);
  }
  const reEnabled = [];
  for (const id of toEnable) {
    if (await setEnabledSafe(id, true)) reEnabled.push(names.get(id) || id);
  }
  if (newlyDisabled.length) {
    await addLog({ type: 'disabled', names: newlyDisabled.map((id) => names.get(id) || id), sites: openDomains });
  }
  if (reEnabled.length) await addLog({ type: 'enabled', names: reEnabled });

  await updateBadge('on', disabledByUs.size);
  cleanupPending ? scheduleCheck() : cancelCheck();
  return newlyDisabled;
}

/**
 * Reloads protected tabs. Needed because disabling an extension does NOT
 * remove content scripts it has already injected.
 */
async function reloadProtectedTabs(navigation) {
  const settings = await getSettings();
  const passwordTabs = settings.passwordDetection ? await getPasswordTabs() : {};
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      if (navigation && tab.id === navigation.tabId) {
        // Restart the ongoing navigation, now without extensions.
        if (siteForTab(navigation.url, tab.id, settings, passwordTabs)) {
          await chrome.tabs.update(tab.id, { url: navigation.url });
        }
      } else if (siteForTab(tab.url, tab.id, settings, passwordTabs)) {
        await chrome.tabs.reload(tab.id);
      }
    } catch (err) {
      console.warn('[Exterminator] reloading tab failed:', err);
    }
  }
}

async function protect(opts = {}) {
  const newlyDisabled = await evaluate(opts);
  if (newlyDisabled.length) await reloadProtectedTabs(opts.navigation);
}

// --- Events ----------------------------------------------------------------------

// As early as possible: before the page loads.
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  run(() => protect({ extraUrls: [d.url], navigation: { tabId: d.tabId, url: d.url } }));
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  run(async () => {
    await clearPasswordTab(d.tabId, d.url);
    await protect();
  });
});

chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.url) run(() => protect());
});

chrome.tabs.onRemoved.addListener((tabId) => {
  run(async () => {
    await clearPasswordTab(tabId);
    await protect({ excludeTabId: tabId });
  });
});

chrome.tabs.onReplaced.addListener((_added, removed) => {
  run(async () => {
    await clearPasswordTab(removed);
    await protect();
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'sensitive-field' && msg?.type !== 'password-field') return;
  if (!sender.tab) return;
  run(async () => {
    if (await markPasswordTab(sender.tab)) await protect();
  });
});

// New or updated extensions: check permissions and turn off if needed.
chrome.management.onInstalled.addListener((ext) => {
  if (ext.id === chrome.runtime.id) return;
  run(async () => {
    await reconcileApprovals();
    await protect();
  });
});
chrome.management.onEnabled.addListener((ext) => {
  if (ext.id !== chrome.runtime.id) run(() => protect());
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  run(async () => {
    await syncDetector(await getSettings());
    await reconcileApprovals();
    await protect();
  });
});

// If the user revokes website access in chrome://extensions, turn detection off.
chrome.permissions.onRemoved.addListener(() => {
  run(async () => {
    const settings = await getSettings();
    const hasPermission = await chrome.permissions.contains({ origins: DETECTOR_ORIGINS });
    if (settings.passwordDetection && !hasPermission) {
      await saveSettings({ ...settings, passwordDetection: false });
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) run(() => protect());
  if (alarm.name === AUDIT_ALARM) run(() => reconcileApprovals());
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith('alert-')) chrome.runtime.openOptionsPage();
});

// Recover after a Chrome restart or crash.
async function init() {
  await syncDetector(await getSettings());
  await reconcileApprovals();
  await chrome.alarms.create(AUDIT_ALARM, { periodInMinutes: 360 });
  await protect();
}
chrome.runtime.onStartup.addListener(() => run(init));
chrome.runtime.onInstalled.addListener(() => run(init));
