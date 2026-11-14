import {
  getSettings,
  updateSettings,
  getState,
  getPasswordTabs,
  hostOf,
  matchSite,
  hostInDomains,
  normalizeDomain,
  suggestDomain,
  riskOf,
  RISK_LABELS,
} from './common.js';

const warnEl = document.getElementById('warnings');
const siteEl = document.getElementById('site');
const statusEl = document.getElementById('status');
const pauseBtn = document.getElementById('pause');

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const host = hostOf(tab?.url);
const incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess();

function renderWarnings(alerts) {
  warnEl.replaceChildren();
  if (!incognitoAllowed) {
    warnEl.append(el('p', {
      className: 'banner',
      textContent: '⚠ Exterminator does not run in Incognito. Turn on "Allow in Incognito" for Exterminator in chrome://extensions.',
    }));
  }
  if (alerts.length) {
    warnEl.append(el('p', {
      className: 'banner',
      textContent: `⚠ ${alerts.length} extension(s) removed from "Always on" after a permission change. Check the settings.`,
    }));
  }
  warnEl.hidden = !warnEl.childElementCount;
}

function renderSite(settings, passwordTabs) {
  siteEl.replaceChildren();
  if (!host) {
    siteEl.append(el('p', { className: 'muted', textContent: 'This page cannot be protected.' }));
    return;
  }
  siteEl.append(el('p', { className: 'host', textContent: host }));

  const site = matchSite(host, settings.sites);
  if (!site && settings.passwordDetection) {
    const exclusion = settings.detectionExclusions.find((d) => hostInDomains(host, [d]));
    if (exclusion) {
      siteEl.append(
        el('p', { className: 'muted', textContent: `Automatic protection is off for ${exclusion}.` }),
        el('button', {
          className: 'secondary small',
          textContent: 'Turn back on',
          onclick: () => updateSettings((s) => {
            s.detectionExclusions = s.detectionExclusions.filter((d) => d !== exclusion);
          }),
        }),
      );
    } else if (passwordTabs[tab.id] === host) {
      siteEl.append(
        el('p', { className: 'ok', textContent: '🔑 Temporarily protected: sensitive field found' }),
        el('button', {
          className: 'secondary small',
          textContent: 'Never auto-protect this site',
          onclick: () => updateSettings((s) => {
            const domain = suggestDomain(host);
            if (!s.detectionExclusions.includes(domain)) s.detectionExclusions.push(domain);
          }),
        }),
      );
    }
  }
  if (site) {
    siteEl.append(
      el('p', {
        className: 'ok',
        textContent: site.domain === host ? '✓ Protected site' : `✓ Protected via ${site.domain}`,
      }),
      el('label', { className: 'toggle small-text' },
        el('input', {
          type: 'checkbox',
          checked: !!site.cleanup,
          onchange: (e) => updateSettings((s) => {
            const target = s.sites.find((x) => x.domain === site.domain);
            if (target) target.cleanup = e.target.checked;
          }),
        }),
        el('span', { textContent: 'Log out when leaving (clear cookies and site data)' }),
      ),
      el('button', {
        className: 'danger',
        textContent: 'Remove protection',
        onclick: () => updateSettings((s) => {
          s.sites = s.sites.filter((x) => x.domain !== site.domain);
        }),
      }),
    );
    return;
  }

  const input = el('input', { type: 'text', value: suggestDomain(host), spellcheck: false });
  const error = el('p', { className: 'error', hidden: true });
  const add = async () => {
    const domain = normalizeDomain(input.value);
    if (!domain) {
      error.textContent = 'Invalid domain, for example: mybank.com';
      error.hidden = false;
      return;
    }
    await updateSettings((s) => {
      if (!s.sites.some((x) => x.domain === domain)) s.sites.push({ domain, extra: [], cleanup: false });
    });
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  siteEl.append(
    el('label', { className: 'field' }, el('span', { textContent: 'Domain (includes subdomains)' }), input),
    error,
    el('button', { textContent: '🛡 Protect this site', onclick: add }),
  );
}

function allowButton(ext) {
  if (!ext) return '';
  const risk = riskOf(ext);
  const btn = el('button', { className: 'secondary small', textContent: 'Always on' });
  let armed = false;
  btn.addEventListener('click', async () => {
    if (risk.level === 'high' && !armed) {
      armed = true;
      btn.textContent = 'Sure? High risk';
      btn.className = 'danger small';
      return;
    }
    await updateSettings((s) => {
      if (!s.globalWhitelist.includes(ext.id)) s.globalWhitelist.push(ext.id);
    });
  });
  return btn;
}

function renderStatus(settings, state, byId) {
  statusEl.replaceChildren();
  if (settings.paused) {
    statusEl.append(el('p', { className: 'warn', textContent: '⏸ Paused until you leave all protected pages.' }));
  } else if (state.activeSites.length) {
    statusEl.append(el('p', { className: 'ok', textContent: `Protected mode active (${state.activeSites.join(', ')})` }));
    const ids = state.disabledByUs;
    statusEl.append(el('p', { textContent: `${ids.length} extension(s) temporarily turned off${ids.length ? ':' : '.'}` }));
    if (ids.length) {
      statusEl.append(el('ul', { className: 'disabled-list' }, ...ids.map((id) => {
        const ext = byId.get(id);
        const risk = ext ? riskOf(ext) : null;
        return el('li', {},
          el('span', { className: 'name' },
            risk ? el('span', { className: `dot risk-${risk.level}`, title: `${RISK_LABELS[risk.level]}\n${risk.reasons.join('\n')}` }) : '',
            ext?.name || id),
          allowButton(ext));
      })));
    }
  } else {
    statusEl.append(el('p', { className: 'muted', textContent: 'Protected mode not active.' }));
  }

  pauseBtn.hidden = !(settings.paused || state.activeSites.length);
  pauseBtn.textContent = settings.paused ? 'Resume protection' : 'Pause';
}

async function render() {
  const [settings, state, exts, passwordTabs, { alerts = [] }] = await Promise.all([
    getSettings(), getState(), chrome.management.getAll(), getPasswordTabs(), chrome.storage.local.get('alerts'),
  ]);
  const byId = new Map(exts.map((e) => [e.id, e]));
  renderWarnings(alerts);
  renderSite(settings, settings.passwordDetection ? passwordTabs : {});
  renderStatus(settings, state, byId);
}

pauseBtn.addEventListener('click', () => updateSettings((s) => { s.paused = !s.paused; }));
document.getElementById('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings || changes.state || changes.passwordTabs || changes.alerts) render();
});

render();
