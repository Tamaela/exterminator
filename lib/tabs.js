// What Exterminator remembers per tab: detected fields, protected frames and prerenders,
// popups of protected pages, and load times. The Chrome calls it needs (notifications,
// injecting the detector, reading a tab) are passed in, so tests can run it without Chrome.
import { t } from './i18n.js';
import { hostOf, suggestDomain } from './domains.js';
import { describeTab, siteForTab } from './planner.js';
import { getSettings, getTabData, setTabData, addLog, getAsks, setAsks, openAsks } from './storage.js';
import { detectorFiles } from './detection.js';

export const ASK_NOTIFICATION = 'ask-'; // + domain
const HISTORY_MAX = 20;
// A URL without its #fragment.
const withoutHash = (url) => String(url || '').split('#')[0];

// Reads one per-tab map, lets `change` edit it in place and writes it back, unless `change`
// returns false (nothing changed).
async function edit(name, change) {
  const map = await getTabData(name);
  if (change(map) !== false) await setTabData(name, map);
}

/**
 * notify(id, options): shows a notification.
 * inject(tabId, files): runs the detector files in every frame of a tab. Must not wait for the
 *   tab: it can hang for a discarded or frozen tab.
 * getTab(tabId): the chrome.tabs.Tab, or null when it is gone.
 */
export function createTabTracker({ notify, inject, getTab }) {
  // In memory only: after a service worker restart, the worst case is one extra log entry
  // or one needless rescan.
  // Tabs whose flag was dropped because they showed another page, with the host they had.
  // When the new page reports a field on that same host, the activity log gets no new entry.
  const recheckedTabs = new Map();
  // The address (without #fragment) each flagged tab had when it was flagged.
  const flaggedPages = new Map();

  // A tab with a sensitive field stays protected for as long as it shows that page.
  // `reused`: the document came back from the back/forward cache or a prerender, so it may
  // hold scripts of extensions that were on at the time; forget its load time to force a reload.
  async function flagTab(tab, reused) {
    const settings = await getSettings();
    const flagged = await getTabData('flagged');
    const { host, site, exclusion } = describeTab(tab?.url, tab?.id, settings, flagged);
    if (!settings.fieldDetection || !host || exclusion) return false;
    if (reused) {
      await edit('loadTimes', (times) => { times[tab.id] = 0; });
    } else if (flagged[tab.id] === host) {
      return false;
    }
    flagged[tab.id] = host;
    await setTabData('flagged', flagged);
    flaggedPages.set(tab.id, withoutHash(tab.url));
    const again = recheckedTabs.get(tab.id) === host;
    recheckedTabs.delete(tab.id);
    if (site && site.level !== 'login') return true; // protected as a whole: nothing to log or ask
    if (!again) await addLog({ type: 'detected', site: host });
    if (!site) await askLevel(suggestDomain(host), settings);
    return true;
  }

  // The first detection on a site you haven't classified: ask once how to protect it.
  // The question itself is shown only in Exterminator's own popup and settings page, never in
  // the web page, so the page can't fake it or trick you into lowering protection.
  async function askLevel(domain, settings) {
    const asks = await getAsks();
    if (domain in asks || !openAsks({ [domain]: 0 }, settings).length) return;
    asks[domain] = Date.now();
    await setAsks(asks);
    await notify(`${ASK_NOTIFICATION}${domain}`, { title: t('askNotifyTitle', { domain }), message: t('askNotifyMessage') });
  }

  // The tab shows another page: drop its flag. The detector of the new page flags it again if
  // that page also has a sensitive field. The grace period keeps extensions off in the meantime.
  async function unflag(tabId, flagged) {
    recheckedTabs.set(tabId, flagged[tabId]);
    flaggedPages.delete(tabId);
    delete flagged[tabId];
    await setTabData('flagged', flagged);
  }

  // True when a single-page app's new address is the page that was flagged (a replaceState to
  // the same address, or a change of only the #fragment).
  const isFlaggedPage = (tabId, url) => flaggedPages.get(tabId) === withoutHash(url);

  // A page that changed its address without loading a new document (a single-page app).
  // Its detector already reported once, so ask it to scan again.
  async function recheckTab(tabId) {
    const flagged = await getTabData('flagged');
    if (!(tabId in flagged)) return false;
    await unflag(tabId, flagged);
    inject(tabId, detectorFiles(await getSettings()));
    return true;
  }

  // A new top-level document (newUrl) or a closed tab (no newUrl).
  async function forgetTab(tabId, newUrl) {
    const closed = newUrl === undefined;
    const flagged = await getTabData('flagged');
    if (tabId in flagged) {
      if (closed) {
        delete flagged[tabId];
        await setTabData('flagged', flagged);
      } else {
        await unflag(tabId, flagged);
      }
    }
    if (closed) {
      recheckedTabs.delete(tabId);
      flaggedPages.delete(tabId);
    }
    // Frames and prerenders belonged to the previous document.
    for (const name of ['framed', 'prerender']) await edit(name, (map) => tabId in map && delete map[tabId]);
    // A popup keeps its opener's site until it shows a real web page of its own.
    await edit('inherited', (map) => tabId in map && (closed || /^https?:/i.test(newUrl)) && delete map[tabId]);
    if (closed) for (const name of ['loadTimes', 'loadHistory']) await edit(name, (map) => tabId in map && delete map[tabId]);
  }

  // The commit time Chrome reports, not the moment this queued task runs: an earlier queued
  // task may have turned extensions off in between, after the page already got their scripts.
  // Back/forward (`restored`): the document may come from the back/forward cache, loaded long
  // ago; use the time this URL was first loaded in this tab, or 0 (unknown) if we never saw it.
  async function recordLoad(tabId, committedAt, url, restored) {
    let loadedAt;
    await edit('loadHistory', (history) => {
      const entries = history[tabId] || [];
      const at = Math.min(committedAt ?? Infinity, Date.now());
      loadedAt = restored ? entries.findLast((e) => e.url === url)?.at ?? 0 : at;
      history[tabId] = [...entries.filter((e) => e.url !== url), { url, at: loadedAt }].slice(-HISTORY_MAX);
    });
    await edit('loadTimes', (times) => { times[tabId] = loadedAt; });
  }

  // A popup or new tab opened by a protected page (window.open, target=_blank). An about:blank
  // popup has no origin of its own: it stays protected as part of the opener's site, even if the
  // opener later navigates away.
  async function recordOpener({ sourceTabId, tabId }) {
    const source = await getTab(sourceTabId);
    if (!source) return;
    const [settings, flagged] = await Promise.all([getSettings(), getTabData('flagged')]);
    const site = siteForTab(source.url, source.id, settings, flagged);
    await edit('inherited', (inherited) => {
      const entry = site
        ? { host: site.auto ? site.domain : hostOf(source.url), auto: !!site.auto }
        : inherited[sourceTabId]; // a popup opened by such a popup
      if (!entry) return false;
      inherited[tabId] = entry;
    });
  }

  // Adds a host to a per-tab list, once.
  async function addHost(name, tabId, host) {
    await edit(name, (map) => {
      const hosts = new Set(map[tabId] || []);
      if (hosts.has(host)) return false;
      map[tabId] = [...hosts, host];
    });
  }
  // A protected site loaded in a frame, or prerendered, in this tab.
  const recordFrame = (tabId, host) => addHost('framed', tabId, host);
  const recordPrerender = (tabId, host) => addHost('prerender', tabId, host);

  // A tab was swapped for another one (e.g. a discarded tab coming back): keep what we know.
  async function replaceTab(added, removed) {
    for (const name of ['flagged', 'framed', 'prerender', 'inherited']) {
      await edit(name, (map) => {
        if (!(removed in map)) return false;
        const [mine, theirs] = [map[added], map[removed]];
        // Merge, never drop: the new tab may already have recorded something itself.
        map[added] = Array.isArray(theirs) ? [...new Set([...(mine || []), ...theirs])] : mine ?? theirs;
        delete map[removed];
      });
    }
    // The new tab's load time is unknown: that forces a reload when needed.
    for (const name of ['loadTimes', 'loadHistory']) await edit(name, (map) => removed in map && delete map[removed]);
    for (const memory of [recheckedTabs, flaggedPages]) {
      if (memory.has(removed) && !memory.has(added)) memory.set(added, memory.get(removed));
      memory.delete(removed);
    }
  }

  return { flagTab, recheckTab, isFlaggedPage, forgetTab, recordLoad, recordOpener, recordFrame, recordPrerender, replaceTab };
}
