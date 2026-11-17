import { t, localizePage } from './lib/i18n.js';
import { suggestDomain, matchSite } from './lib/domains.js';
import { describeTab, siteForTab, wholeSites } from './lib/planner.js';
import { riskOf, permissionSnapshot } from './lib/risk.js';
import {
  KEYS, getSettings, getState, isPaused, setPaused, pauseFor, getAlerts, getFlaggedTabs, getFramedTabs, actions,
  getAsks, openAsks, hasConsent, getTabData,
} from './lib/storage.js';
import { el, readDomain, onStorageChange } from './lib/ui.js';
import { levelPicker, askCard, foldedAsk, clearAsksButton, levelsFor } from './lib/levels.js';

localizePage();

const warnEl = document.getElementById('warnings');
const askEl = document.getElementById('asks');
const siteEl = document.getElementById('site');
const statusEl = document.getElementById('status');
const pauseBtn = document.getElementById('pause');

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess();
// An unpacked extension reads its pages from disk on every open, but the service worker keeps
// the code Chrome loaded. A newer manifest on disk means the extension was not reloaded.
const onDisk = await fetch(chrome.runtime.getURL('manifest.json')).then((r) => r.json()).catch(() => null);
const stale = onDisk && onDisk.version !== chrome.runtime.getManifest().version;

// Banners at the top: setup not finished, an old version still loaded, no incognito access,
// open permission alerts.
function renderWarnings(alerts, consent) {
  const setup = !consent && el('p', { className: 'banner' }, t('popupSetup'), ' ',
    el('button', { className: 'secondary small', textContent: t('popupSetupButton'), onclick: () => chrome.tabs.create({ url: 'welcome.html' }) }));
  // replaceChildren() would show `false` as text, so the conditions are filtered out first.
  warnEl.replaceChildren(...[setup].filter(Boolean), ...[
    stale && t('popupReload', { version: onDisk.version }),
    !incognitoAllowed && t('popupIncognito'),
    alerts.length > 0 && t('popupAlerts', { count: alerts.length }),
  ].filter(Boolean).map((text) => el('p', { className: 'banner', textContent: text })));
  warnEl.hidden = !warnEl.childElementCount;
}

// The question about the current tab's site comes first and unfolded. Questions about other
// sites are folded into one line with their number, so the popup does not fill up.
let othersOpen = false;
function renderAsks(asks, settings) {
  const current = suggestDomain(describeTab(tab?.url, tab?.id, settings, {}).host || '');
  const open = openAsks(asks, settings);
  const others = open.filter((domain) => domain !== current);
  const group = others.length > 0 && el('details', { className: 'ask-group', open: othersOpen },
    el('summary', { textContent: t('asksOther', { count: others.length }) }),
    el('p', {}, clearAsksButton(others)),
    ...others.map(foldedAsk));
  if (group) group.addEventListener('toggle', () => { othersOpen = group.open; });
  askEl.replaceChildren(...[open.includes(current) && askCard(current), group].filter(Boolean));
  askEl.hidden = !askEl.childElementCount;
}

// The tab was reloaded because of a detected field and stays protected until you have logged in.
function guardCard(guard) {
  const answer = (choice) => chrome.runtime.sendMessage({ type: 'guard-answer', tabId: tab.id, choice });
  return el('div', { className: 'ask-card' },
    el('p', { textContent: t(guard.seen ? 'guardStatusLogin' : 'guardStatus', { site: guard.domain }) }),
    el('div', { className: 'ask-actions' },
      el('button', { textContent: t('guardProtectSite'), onclick: () => answer('site') }),
      el('button', { className: 'secondary', textContent: t('guardRelease'), onclick: () => answer('release') })),
    el('p', { className: 'muted', textContent: t('guardReleaseHelp') }));
}

// The current tab: its protection, its level, or a form to protect it.
function renderSite(settings, flaggedTabs, guard) {
  const { host, site, exclusion, detected } = describeTab(tab?.url, tab?.id, settings, flaggedTabs);
  siteEl.replaceChildren();
  if (!host) {
    siteEl.append(el('p', { className: 'muted', textContent: t('cannotProtect') }));
    return;
  }
  siteEl.append(el('p', { className: 'host', textContent: host }));
  if (guard) siteEl.append(guardCard(guard));

  if (site) {
    const status = site.level !== 'login'
      ? el('p', { className: 'ok', textContent: site.domain === host ? t('protectedSite') : t('protectedVia', { domain: site.domain }) })
      : detected
        ? el('p', { className: 'ok', textContent: t('detectedProtected') })
        : el('p', { className: 'muted', textContent: t('loginOnlyStatus') });
    siteEl.append(
      status,
      levelPicker('level', site.level, levelsFor(settings, site.level), (level) => actions.setSiteLevel(site.domain, level)),
      el('button', { className: 'danger', textContent: t('removeProtection'), onclick: () => actions.removeSite(site.domain) }),
    );
    return;
  }

  if (settings.fieldDetection && exclusion) {
    siteEl.append(
      el('p', { className: 'muted', textContent: t('autoOffFor', { domain: exclusion }) }),
      el('button', { className: 'secondary', textContent: t('turnBackOn'), onclick: () => actions.removeExclusion(exclusion) }),
    );
  } else if (detected) {
    siteEl.append(
      el('p', { className: 'ok', textContent: t('detectedProtected') }),
      el('button', { className: 'secondary', textContent: t('neverAutoProtect'), onclick: () => actions.addExclusion(suggestDomain(host)) }),
    );
  }

  const input = el('input', { type: 'text', value: suggestDomain(host), spellcheck: false });
  const error = el('p', { className: 'error', hidden: true });
  let level = 'strict';
  // Adds the site with the chosen level.
  const add = () => {
    const domain = readDomain(input, error);
    if (domain) actions.chooseLevel(domain, level);
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  siteEl.append(
    el('label', { className: 'field' }, el('span', { textContent: t('domainLabel') }), input),
    error,
    levelPicker('new-level', level, levelsFor(settings, level), (chosen) => { level = chosen; }),
    el('button', { textContent: t('protectThisSite'), onclick: add }),
  );
}

// "Always on" button; high-risk extensions need a second click.
function allowButton(ext) {
  if (!ext) return null;
  const risk = riskOf(ext);
  const btn = el('button', { className: 'secondary small', textContent: t('alwaysOn') });
  btn.addEventListener('click', () => {
    if (risk.level === 'high' && !btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = t('sureHighRisk');
      btn.className = 'danger small';
      return;
    }
    actions.setAlwaysOn(ext.id, true, permissionSnapshot(ext));
  });
  return btn;
}

// Switches to a tab that shows this protected site (in any window). With several tabs of the
// same site, each click goes to the next one. Tabs where it is only an iframe come last.
async function goToSite(domain) {
  const [settings, flagged, framed, tabs] = await Promise.all([
    getSettings(), getFlaggedTabs(), getFramedTabs(), chrome.tabs.query({}),
  ]);
  const own = tabs.filter((x) => siteForTab(x.url, x.id, settings, flagged)?.domain === domain);
  const viaFrame = tabs.filter((x) => !own.includes(x)
    && (framed[x.id] || []).some((host) => matchSite(host, wholeSites(settings))?.domain === domain));
  const candidates = [...own, ...viaFrame];
  if (!candidates.length) return;
  const current = candidates.findIndex((x) => x.id === tab?.id);
  const target = candidates[(current + 1) % candidates.length];
  await chrome.tabs.update(target.id, { active: true });
  await chrome.windows.update(target.windowId, { focused: true });
  window.close();
}

// The open protected sites as buttons that switch to their tab.
function siteLinks(domains) {
  return domains.flatMap((domain, i) => [
    i > 0 && ', ',
    el('button', { className: 'site-link', textContent: domain, title: t('goToSite'), onclick: () => goToSite(domain) }),
  ]).filter(Boolean);
}

// Protected mode: active sites and the extensions that are off.
function renderStatus(paused, state, byId, guard) {
  statusEl.replaceChildren();
  if (paused) {
    statusEl.append(el('p', { className: 'warn', textContent: t('pausedStatus', { sites: paused.sites.join(', ') }) }));
  } else if (state.activeSites.length) {
    const ids = state.disabledByUs;
    statusEl.append(
      el('p', { className: 'ok' }, t('activeStatusLabel'), ' ', ...siteLinks(state.activeSites)),
      el('p', { textContent: ids.length ? t('disabledCount', { count: ids.length }) : t('disabledNone') }),
    );
    if (ids.length) {
      statusEl.append(el('ul', { className: 'disabled-list' }, ...ids.map((id) => {
        const ext = byId.get(id);
        const risk = ext ? riskOf(ext) : null;
        return el('li', {},
          el('span', { className: 'name' },
            risk && el('span', { className: `dot risk-${risk.level}`, title: [risk.label, ...risk.reasons].join('\n') }),
            ext?.name || id),
          allowButton(ext));
      })));
    }
  } else {
    statusEl.append(el('p', { className: 'muted', textContent: t('notActive') }));
  }
  // While the tab waits for you to log in, its card has "Turn extensions on for now" instead.
  pauseBtn.hidden = !(paused || (state.activeSites.length && !guard));
  pauseBtn.textContent = paused ? t('resume') : t('pause');
  pauseBtn.title = paused ? t('resumeHelp') : t('pauseHelp');
}

// Draws the whole popup from storage.
async function render() {
  const [settings, state, paused, exts, flaggedTabs, alerts, asks, consent] = await Promise.all([
    getSettings(), getState(), isPaused(), chrome.management.getAll(), getFlaggedTabs(), getAlerts(), getAsks(), hasConsent(),
  ]);
  const guard = (await getTabData('guarded'))[tab?.id];
  renderWarnings(alerts, consent);
  renderAsks(asks, settings);
  renderSite(settings, flaggedTabs, guard);
  renderStatus(paused, state, new Map(exts.map((e) => [e.id, e])), guard);
}

pauseBtn.addEventListener('click', async () => {
  if (await isPaused()) await setPaused(false);
  else await pauseFor((await getState()).activeSites);
});
document.getElementById('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
onStorageChange([KEYS.settings, KEYS.state, KEYS.paused, KEYS.flaggedTabs, KEYS.guardedTabs, KEYS.alerts, KEYS.asks, KEYS.consent], render);

render();
