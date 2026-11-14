import { t, localizePage } from './lib/i18n.js';
import { suggestDomain } from './lib/domains.js';
import { describeTab } from './lib/planner.js';
import { riskOf, permissionSnapshot } from './lib/risk.js';
import { KEYS, getSettings, getState, isPaused, setPaused, pauseFor, getAlerts, getFlaggedTabs, actions } from './lib/storage.js';
import { el, readDomain, onStorageChange } from './lib/ui.js';

localizePage();

const warnEl = document.getElementById('warnings');
const siteEl = document.getElementById('site');
const statusEl = document.getElementById('status');
const pauseBtn = document.getElementById('pause');

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess();

function renderWarnings(alerts) {
  warnEl.replaceChildren(
    !incognitoAllowed && el('p', { className: 'banner', textContent: t('popupIncognito') }),
    alerts.length > 0 && el('p', { className: 'banner', textContent: t('popupAlerts', { count: alerts.length }) }),
  );
  warnEl.hidden = !warnEl.childElementCount;
}

function renderSite(settings, flaggedTabs) {
  const { host, site, exclusion, detected } = describeTab(tab?.url, tab?.id, settings, flaggedTabs);
  siteEl.replaceChildren();
  if (!host) {
    siteEl.append(el('p', { className: 'muted', textContent: t('cannotProtect') }));
    return;
  }
  siteEl.append(el('p', { className: 'host', textContent: host }));

  if (site) {
    siteEl.append(
      el('p', { className: 'ok', textContent: site.domain === host ? t('protectedSite') : t('protectedVia', { domain: site.domain }) }),
      el('label', { className: 'toggle small-text' },
        el('input', { type: 'checkbox', checked: site.cleanup, onchange: (e) => actions.setSiteCleanup(site.domain, e.target.checked) }),
        el('span', { textContent: t('logOutWhenLeaving') })),
      el('button', { className: 'danger', textContent: t('removeProtection'), onclick: () => actions.removeSite(site.domain) }),
    );
    return;
  }

  if (settings.fieldDetection && exclusion) {
    siteEl.append(
      el('p', { className: 'muted', textContent: t('autoOffFor', { domain: exclusion }) }),
      el('button', { className: 'secondary small', textContent: t('turnBackOn'), onclick: () => actions.removeExclusion(exclusion) }),
    );
  } else if (detected) {
    siteEl.append(
      el('p', { className: 'ok', textContent: t('detectedProtected') }),
      el('button', { className: 'secondary small', textContent: t('neverAutoProtect'), onclick: () => actions.addExclusion(suggestDomain(host)) }),
    );
  }

  const input = el('input', { type: 'text', value: suggestDomain(host), spellcheck: false });
  const error = el('p', { className: 'error', hidden: true });
  const add = () => {
    const domain = readDomain(input, error);
    if (domain) actions.addSite(domain);
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  siteEl.append(
    el('label', { className: 'field' }, el('span', { textContent: t('domainLabel') }), input),
    error,
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

function renderStatus(paused, state, byId) {
  statusEl.replaceChildren();
  if (paused) {
    statusEl.append(el('p', { className: 'warn', textContent: t('pausedStatus', { sites: paused.sites.join(', ') }) }));
  } else if (state.activeSites.length) {
    const ids = state.disabledByUs;
    statusEl.append(
      el('p', { className: 'ok', textContent: t('activeStatus', { sites: state.activeSites.join(', ') }) }),
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
  pauseBtn.hidden = !(paused || state.activeSites.length);
  pauseBtn.textContent = paused ? t('resume') : t('pause');
}

async function render() {
  const [settings, state, paused, exts, flaggedTabs, alerts] = await Promise.all([
    getSettings(), getState(), isPaused(), chrome.management.getAll(), getFlaggedTabs(), getAlerts(),
  ]);
  renderWarnings(alerts);
  renderSite(settings, flaggedTabs);
  renderStatus(paused, state, new Map(exts.map((e) => [e.id, e])));
}

pauseBtn.addEventListener('click', async () => {
  if (await isPaused()) await setPaused(false);
  else await pauseFor((await getState()).activeSites);
});
document.getElementById('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
onStorageChange([KEYS.settings, KEYS.state, KEYS.paused, KEYS.flaggedTabs, KEYS.alerts], render);

render();
