import {
  getSettings,
  updateSettings,
  normalizeDomain,
  isManageable,
  iconUrl,
  riskOf,
  canManageExtensions,
  logText,
  describePermission,
  RISK_LABELS,
  DETECTOR_ORIGINS,
} from './common.js';

const $ = (id) => document.getElementById(id);
const sitesEl = $('sites');
const globalEl = $('global');
const input = $('new-domain');
const addError = $('add-error');
const detectionBox = $('password-detection');
const detectionError = $('detection-error');
const sensitiveBox = $('sensitive-fields');
const clipboardBox = $('clear-clipboard');
const sortSelect = $('sort');
const exclusionInput = $('new-exclusion');
const exclusionError = $('exclusion-error');

// Remember the sort preference per user (convenience only, so localStorage).
const RISK_ORDER = { high: 2, medium: 1, low: 0 };
let sortMode = 'risk';
try {
  sortMode = localStorage.getItem('exterminator-sort') || 'risk';
} catch {
  // No storage available: use the default.
}
sortSelect.value = sortMode;

function sortExtensions(exts) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (sortMode === 'name') return [...exts].sort(byName);
  const dir = sortMode === 'risk-asc' ? -1 : 1;
  const scored = exts.map((ext) => {
    const risk = riskOf(ext);
    return { ext, level: RISK_ORDER[risk.level], count: risk.reasons.length };
  });
  scored.sort((a, b) => dir * (b.level - a.level) || dir * (b.count - a.count) || byName(a.ext, b.ext));
  return scored.map((s) => s.ext);
}

// Remember which <details> are open between renders.
const openDetails = new Set();

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function toggleId(list, id, on) {
  const set = new Set(list);
  on ? set.add(id) : set.delete(id);
  return [...set];
}

function riskBadge(ext) {
  const risk = riskOf(ext);
  return el('span', {
    className: `risk risk-${risk.level}`,
    textContent: RISK_LABELS[risk.level],
    title: risk.reasons.join('\n') || 'No sensitive permissions',
  });
}

function baseLock(ext) {
  if (!ext.mayDisable) return { checked: true, note: 'managed by policy, cannot be turned off' };
  return null;
}

function confirmRisk(ext) {
  const risk = riskOf(ext);
  if (risk.level !== 'high') return true;
  const manageNote = canManageExtensions(ext)
    ? 'Note: this extension can turn other extensions on. Exterminator turns those off again right away during '
      + 'protected mode, but only trust this extension if you are sure it is reliable.\n\n'
    : '';
  return confirm(`"${ext.name}" is high risk:\n\n• ${risk.reasons.join('\n• ')}\n\n${manageNote}`
    + 'This extension will be able to read along on your protected pages. Keep it on anyway?');
}

/**
 * List of extensions as checkboxes.
 * lock(ext) → null or { checked, note } to pin a row.
 */
function extList(exts, { isChecked, onToggle, lock }) {
  return exts.map((ext) => {
    const locked = lock(ext);
    const box = el('input', {
      type: 'checkbox',
      checked: locked ? locked.checked : isChecked(ext.id),
      disabled: !!locked,
      onchange: (e) => {
        const on = e.target.checked;
        if (on && !confirmRisk(ext)) {
          e.target.checked = false;
          return;
        }
        onToggle(ext.id, on);
      },
    });
    const icon = iconUrl(ext);
    const img = icon ? el('img', { src: icon, alt: '', onerror: (e) => e.target.remove() }) : '';
    const risk = riskOf(ext);
    const notes = [];
    if (locked?.note) notes.push(locked.note);
    if (!ext.enabled) notes.push('turned off');
    return el('li', {},
      el('label', {}, box, img,
        el('span', { className: 'ext-info' },
          el('span', {}, ext.name, ' ', riskBadge(ext)),
          risk.reasons.length && risk.level !== 'low'
            ? el('span', { className: 'reasons', textContent: risk.reasons.join(' · ') }) : '',
        ),
      ),
      notes.length ? el('span', { className: 'note', textContent: notes.join(' · ') }) : '',
    );
  });
}

function renderWarnings(incognitoAllowed) {
  const box = $('warnings');
  box.replaceChildren();
  if (!incognitoAllowed) {
    box.append(el('p', { className: 'banner' },
      el('strong', { textContent: '⚠ Not protected in Incognito. ' }),
      'If other extensions are allowed in Incognito, they simply stay on on your bank there. Go to ',
      el('code', { textContent: 'chrome://extensions' }),
      ', click "Details" for Exterminator and turn on "Allow in Incognito".'));
  }
}

function renderAlerts(alerts) {
  $('alerts-card').hidden = !alerts.length;
  const dismiss = (id) => chrome.storage.local.set({ alerts: alerts.filter((a) => a.id !== id) });
  $('alerts').replaceChildren(...alerts.map((a) => el('li', {},
    el('div', {},
      el('strong', { textContent: `${a.name} ${a.version}` }),
      el('div', {
        className: 'muted',
        textContent: `New permissions: ${(a.added || []).map(describePermission).join('; ')}`,
      }),
    ),
    el('div', { className: 'row' },
      el('button', {
        className: 'secondary small',
        textContent: 'Allow again',
        onclick: async () => {
          await dismiss(a.id);
          await updateSettings((s) => {
            if (a.where?.global && !s.globalWhitelist.includes(a.id)) s.globalWhitelist.push(a.id);
            for (const domain of a.where?.sites || []) {
              const site = s.sites.find((x) => x.domain === domain);
              if (site && !site.extra.includes(a.id)) site.extra.push(a.id);
            }
          });
        },
      }),
      el('button', { className: 'secondary small', textContent: 'Dismiss', onclick: () => dismiss(a.id) }),
    ),
  )));
}

function renderExclusions(settings) {
  const list = [...settings.detectionExclusions].sort();
  $('exclusions').replaceChildren(...(list.length
    ? list.map((domain) => el('li', {},
      el('span', { className: 'domain', textContent: domain }),
      el('button', {
        className: 'danger small',
        textContent: 'Remove',
        onclick: () => updateSettings((s) => {
          s.detectionExclusions = s.detectionExclusions.filter((d) => d !== domain);
        }),
      })))
    : [el('li', { className: 'muted', textContent: 'No exceptions.' })]));
}

function renderLog(log) {
  $('log').replaceChildren(...(log.length
    ? log.slice(0, 100).map((entry) => el('li', {},
      el('time', { textContent: new Date(entry.t).toLocaleString('en-GB') }),
      el('span', { textContent: logText(entry) })))
    : [el('li', { className: 'muted', textContent: 'Nothing has happened yet.' })]));
}

async function render() {
  const [settings, all, stored, incognitoAllowed] = await Promise.all([
    getSettings(),
    chrome.management.getAll(),
    chrome.storage.local.get(['alerts', 'log']),
    chrome.extension.isAllowedIncognitoAccess(),
  ]);
  const exts = sortExtensions(all.filter(isManageable));
  const globalSet = new Set(settings.globalWhitelist);

  renderWarnings(incognitoAllowed);
  renderAlerts(stored.alerts || []);
  renderLog(stored.log || []);

  detectionBox.checked = settings.passwordDetection;
  sensitiveBox.checked = settings.sensitiveFields;
  sensitiveBox.disabled = !settings.passwordDetection;
  clipboardBox.checked = settings.clearClipboard;
  renderExclusions(settings);

  // Always on
  globalEl.replaceChildren(
    ...(exts.length
      ? extList(exts, {
          isChecked: (id) => globalSet.has(id),
          onToggle: (id, on) => updateSettings((s) => { s.globalWhitelist = toggleId(s.globalWhitelist, id, on); }),
          lock: baseLock,
        })
      : [el('li', { className: 'muted', textContent: 'No other extensions installed.' })]),
  );

  // Sites
  sitesEl.replaceChildren();
  if (!settings.sites.length) {
    sitesEl.append(el('p', { className: 'muted', textContent: 'No sites yet. Add one above, or click the Exterminator icon while on a site.' }));
  }
  for (const site of [...settings.sites].sort((a, b) => a.domain.localeCompare(b.domain))) {
    const extra = new Set(site.extra || []);
    const mutateSite = (fn) => updateSettings((s) => {
      const target = s.sites.find((x) => x.domain === site.domain);
      if (target) fn(target);
    });

    const details = el('details', { open: openDetails.has(site.domain) },
      el('summary', { textContent: `Also on for this site (${extra.size})` }),
      el('ul', { className: 'ext-list' },
        ...extList(exts, {
          isChecked: (id) => extra.has(id),
          onToggle: (id, on) => mutateSite((t) => { t.extra = toggleId(t.extra || [], id, on); }),
          lock: (ext) => baseLock(ext) || (globalSet.has(ext.id) ? { checked: true, note: 'always on' } : null),
        }),
      ),
    );
    details.addEventListener('toggle', () => {
      details.open ? openDetails.add(site.domain) : openDetails.delete(site.domain);
    });

    sitesEl.append(el('div', { className: 'site' },
      el('div', { className: 'site-head' },
        el('span', { className: 'domain', textContent: site.domain }),
        el('button', {
          className: 'danger',
          textContent: 'Remove',
          onclick: () => updateSettings((s) => { s.sites = s.sites.filter((x) => x.domain !== site.domain); }),
        }),
      ),
      el('label', { className: 'toggle small-text' },
        el('input', {
          type: 'checkbox',
          checked: !!site.cleanup,
          onchange: (e) => mutateSite((t) => { t.cleanup = e.target.checked; }),
        }),
        el('span', { textContent: 'Log out when leaving (clear cookies and site data)' }),
      ),
      details,
    ));
  }
}

$('add-site').addEventListener('submit', async (e) => {
  e.preventDefault();
  const domain = normalizeDomain(input.value);
  if (!domain) {
    addError.textContent = 'Invalid domain, for example: mybank.com';
    addError.hidden = false;
    return;
  }
  addError.hidden = true;
  input.value = '';
  await updateSettings((s) => {
    if (!s.sites.some((x) => x.domain === domain)) s.sites.push({ domain, extra: [], cleanup: false });
  });
});

$('add-exclusion').addEventListener('submit', async (e) => {
  e.preventDefault();
  const domain = normalizeDomain(exclusionInput.value);
  if (!domain) {
    exclusionError.textContent = 'Invalid domain, for example: example.com';
    exclusionError.hidden = false;
    return;
  }
  exclusionError.hidden = true;
  exclusionInput.value = '';
  await updateSettings((s) => {
    if (!s.detectionExclusions.includes(domain)) s.detectionExclusions.push(domain);
  });
});

detectionBox.addEventListener('change', async () => {
  detectionError.hidden = true;
  const on = detectionBox.checked;
  if (on) {
    // Must happen directly from the click, otherwise Chrome refuses the request.
    const granted = await chrome.permissions.request({ origins: DETECTOR_ORIGINS });
    if (!granted) {
      detectionBox.checked = false;
      detectionError.textContent = 'Without access to websites, Exterminator cannot detect sensitive fields.';
      detectionError.hidden = false;
      return;
    }
  }
  await updateSettings((s) => { s.passwordDetection = on; });
  if (!on) await chrome.permissions.remove({ origins: DETECTOR_ORIGINS });
});

sortSelect.addEventListener('change', () => {
  sortMode = sortSelect.value;
  try {
    localStorage.setItem('exterminator-sort', sortMode);
  } catch {
    // Ignore.
  }
  render();
});
sensitiveBox.addEventListener('change', () => updateSettings((s) => { s.sensitiveFields = sensitiveBox.checked; }));
clipboardBox.addEventListener('change', () => updateSettings((s) => { s.clearClipboard = clipboardBox.checked; }));
$('clear-log').addEventListener('click', () => chrome.storage.local.set({ log: [] }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.settings || changes.alerts || changes.log)) render();
});
chrome.management.onInstalled.addListener(render);
chrome.management.onUninstalled.addListener(render);
chrome.management.onEnabled.addListener(render);
chrome.management.onDisabled.addListener(render);

render();
