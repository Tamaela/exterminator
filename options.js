import { t, localizePage } from './lib/i18n.js';
import { riskOf, describePermission, canManageExtensions, sortByRisk, permissionSnapshot } from './lib/risk.js';
import {
  KEYS, getSettings, getState, getAlerts, getLog, clearLog, logText, actions, getAsks, openAsks, exportSettings, importSettings,
} from './lib/storage.js';
import { el, readDomain, onStorageChange } from './lib/ui.js';
import { levelPicker, askCards, levelsFor } from './lib/levels.js';
import { DETECTOR_ORIGINS } from './lib/detection.js';

localizePage();

const $ = (id) => document.getElementById(id);
const SORT_KEY = 'tab-chaperone-sort';

// Sort preference is a per-viewer convenience, so localStorage is fine.
let sortMode = 'risk';
try {
  sortMode = localStorage.getItem(SORT_KEY) || 'risk';
} catch {
  // No storage available: use the default.
}
$('sort').value = sortMode;

// Sorts by the chosen order: risk, reverse risk or name.
function sortExtensions(exts) {
  if (sortMode === 'name') return [...exts].sort((a, b) => a.name.localeCompare(b.name));
  return sortByRisk(exts, sortMode === 'risk-asc' ? -1 : 1);
}

// Remember which <details> are open between renders.
const openDetails = new Set();

// Extensions Tab Chaperone turned off right now, to explain why they are off.
let offByUs = new Set();

// A small high, medium or low label.
function riskBadge(risk) {
  return el('span', {
    className: `risk risk-${risk.level}`,
    textContent: risk.label,
    title: risk.reasons.join('\n') || t('riskNone'),
  });
}

// Inline confirmation for high-risk extensions (no blocking dialogs).
function confirmPanel(ext, risk, onConfirm, onCancel) {
  const text = [t('confirmHighRisk', { name: ext.name, reasons: risk.reasons.join('; ') })];
  if (canManageExtensions(ext)) text.push(t('confirmManageNote'));
  return el('div', { className: 'confirm' },
    el('p', { textContent: text.join(' ') }),
    el('div', { className: 'row' },
      el('button', { className: 'danger small', textContent: t('keepOnAnyway'), onclick: onConfirm }),
      el('button', { className: 'secondary small', textContent: t('cancel'), onclick: onCancel })));
}

/**
 * List of extensions as checkboxes.
 * lock(ext) → null or { checked, note } to pin a row.
 */
function extList(exts, { isChecked, onToggle, lock }) {
  return exts.map((ext) => {
    const locked = lock(ext);
    const risk = riskOf(ext);
    const row = el('li', {});
    const box = el('input', {
      type: 'checkbox',
      checked: locked ? locked.checked : isChecked(ext.id),
      disabled: !!locked,
      onchange: (e) => {
        const on = e.target.checked;
        if (on && risk.level === 'high') {
          e.target.checked = false;
          row.querySelector('.confirm')?.remove();
          const panel = confirmPanel(ext, risk, () => onToggle(ext.id, true, ext), () => panel.remove());
          row.append(panel);
          return;
        }
        onToggle(ext.id, on, ext);
      },
    });
    const icon = ext.icons?.length ? [...ext.icons].sort((a, b) => a.size - b.size).find((i) => i.size >= 16) || ext.icons[0] : null;
    const off = !ext.enabled && (offByUs.has(ext.id) ? t('offWhileProtected') : t('turnedOff'));
    const notes = [locked?.note, off].filter(Boolean);
    row.append(
      el('label', {}, box,
        icon && el('img', { src: icon.url, alt: '', onerror: (e) => e.target.remove() }),
        el('span', { className: 'ext-info' },
          el('span', {}, ext.name, ' ', riskBadge(risk)),
          risk.level !== 'low' && el('span', { className: 'reasons', textContent: risk.reasons.join(' · ') }))),
      notes.length > 0 ? el('span', { className: 'note', textContent: notes.join(' · ') }) : '', // append() would show `false`
    );
    return row;
  });
}

// Extensions your administrator forces on cannot be turned off.
const policyLock = (ext) => (!ext.mayDisable ? { checked: true, note: t('managedByPolicy') } : null);

// Extensions that gained permissions and wait for your review.
function renderAlerts(alerts) {
  $('alerts-card').hidden = !alerts.length;
  $('alerts').replaceChildren(...alerts.map((a) => el('li', {},
    el('div', {},
      el('strong', { textContent: `${a.name} ${a.version}` }),
      el('div', { className: 'muted', textContent: t('newPermissions', { list: (a.added || []).map(describePermission).join('; ') }) })),
    el('div', { className: 'row' },
      a.approved
        ? el('button', { className: 'secondary small', textContent: t('allowAgain'), onclick: () => actions.allowAgain(a.id) })
        : el('span', { className: 'note', textContent: t('allowAgainUnavailable') }),
      el('button', { className: 'secondary small', textContent: t('dismiss'), onclick: () => actions.dismissAlert(a.id) })))));
}

// Sites where automatic protection never triggers.
function renderExclusions(settings) {
  const list = [...settings.detectionExclusions].sort();
  $('exclusions').replaceChildren(...(list.length
    ? list.map((domain) => el('li', {},
      el('span', { className: 'domain', textContent: domain }),
      el('button', { className: 'danger small', textContent: t('remove'), onclick: () => actions.removeExclusion(domain) })))
    : [el('li', { className: 'muted', textContent: t('noExceptions') })]));
}

// Questions about detected sites that still wait for a level.
function renderAsks(asks, settings) {
  const open = openAsks(asks, settings);
  $('asks').replaceChildren(...askCards(asks, settings));
  $('asks-dismiss-all').onclick = () => actions.dismissAsks(open);
  $('asks-clear').onclick = () => actions.clearAsks(open);
  $('asks-card').hidden = !open.length;
}

// The newest activity log entries.
function renderLog(log) {
  $('log').replaceChildren(...(log.length
    ? log.map((entry) => el('li', { className: entry.type === 'error' ? 'error' : '' },
      el('time', { textContent: new Date(entry.t).toLocaleString() }),
      el('span', { textContent: logText(entry) })))
    : [el('li', { className: 'muted', textContent: t('logEmpty') })]));
}

// The protected sites with their level and extra extensions.
function renderSites(settings, exts) {
  const globalSet = new Set(settings.globalWhitelist);
  const sites = [...settings.sites].sort((a, b) => a.domain.localeCompare(b.domain));
  $('sites').replaceChildren(...(sites.length ? sites.map((site) => {
    const details = el('details', { open: openDetails.has(site.domain) },
      el('summary', { textContent: t('alsoOnForSite', { count: site.extra.length }) }),
      el('ul', { className: 'ext-list' }, ...extList(exts, {
        isChecked: (id) => site.extra.includes(id),
        onToggle: (id, on, ext) => actions.setSiteExtra(site.domain, id, on, permissionSnapshot(ext)),
        lock: (ext) => policyLock(ext) || (globalSet.has(ext.id) ? { checked: true, note: t('alwaysOnNote') } : null),
      })));
    details.addEventListener('toggle', () => {
      details.open ? openDetails.add(site.domain) : openDetails.delete(site.domain);
    });
    return el('div', { className: 'site' },
      el('div', { className: 'site-head' },
        el('span', { className: 'domain', textContent: site.domain }),
        el('button', { className: 'danger', textContent: t('remove'), onclick: () => actions.removeSite(site.domain) })),
      levelPicker(`level-${site.domain}`, site.level, levelsFor(settings, site.level), (level) => actions.setSiteLevel(site.domain, level)),
      details);
  }) : [el('p', { className: 'muted', textContent: t('noSites') })]));
}

// Draws the whole settings page from storage.
async function render() {
  const [settings, all, alerts, log, incognitoAllowed, asks, state] = await Promise.all([
    getSettings(), chrome.management.getAll(), getAlerts(), getLog(), chrome.extension.isAllowedIncognitoAccess(), getAsks(), getState(),
  ]);
  offByUs = new Set(state.disabledByUs);
  const exts = sortExtensions(all.filter((e) => e.id !== chrome.runtime.id && e.type !== 'theme'));

  $('incognito-warning').hidden = incognitoAllowed;
  renderAlerts(alerts);
  renderLog(log);
  renderExclusions(settings);
  renderAsks(asks, settings);
  renderSites(settings, exts);

  $('field-detection').checked = settings.fieldDetection;
  $('sensitive-fields').checked = settings.sensitiveFields;
  $('sensitive-fields').disabled = !settings.fieldDetection;
  $('clear-clipboard').checked = settings.clearClipboard;

  const globalSet = new Set(settings.globalWhitelist);
  $('global').replaceChildren(...(exts.length
    ? extList(exts, { isChecked: (id) => globalSet.has(id), onToggle: (id, on, ext) => actions.setAlwaysOn(id, on, permissionSnapshot(ext)), lock: policyLock })
    : [el('li', { className: 'muted', textContent: t('noOtherExtensions') })]));
}

// --- Inputs ----------------------------------------------------------------------------------

$('add-site').addEventListener('submit', (e) => {
  e.preventDefault();
  const domain = readDomain($('new-domain'), $('add-error'));
  if (!domain) return;
  $('new-domain').value = '';
  actions.addSite(domain, $('new-level').value);
});

$('add-exclusion').addEventListener('submit', (e) => {
  e.preventDefault();
  const domain = readDomain($('new-exclusion'), $('exclusion-error'));
  if (!domain) return;
  $('new-exclusion').value = '';
  actions.addExclusion(domain);
});

$('field-detection').addEventListener('change', async (e) => {
  const on = e.target.checked;
  $('detection-error').hidden = true;
  // Must be requested directly from the click, otherwise Chrome refuses.
  if (on && !(await chrome.permissions.request({ origins: DETECTOR_ORIGINS }))) {
    e.target.checked = false;
    $('detection-error').textContent = t('detectionDenied');
    $('detection-error').hidden = false;
    return;
  }
  await actions.setOption('fieldDetection', on);
  if (!on) await chrome.permissions.remove({ origins: DETECTOR_ORIGINS });
});

$('sensitive-fields').addEventListener('change', (e) => actions.setOption('sensitiveFields', e.target.checked));
$('clear-clipboard').addEventListener('change', (e) => actions.setOption('clearClipboard', e.target.checked));
$('clear-log').addEventListener('click', clearLog);

// Export: the settings as a JSON file in your downloads.
$('export').addEventListener('click', async () => {
  const blob = new Blob([JSON.stringify(await exportSettings(), null, 2)], { type: 'application/json' });
  const link = el('a', { href: URL.createObjectURL(blob), download: 'tab-chaperone-settings.json' });
  link.click();
  URL.revokeObjectURL(link.href);
});

// Import: replaces the settings. Extensions you never approved in this profile stay off the
// lists; the result names them so you can review and add them yourself.
$('import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const result = $('import-result');
  result.hidden = false;
  result.className = 'muted';
  try {
    const skipped = await importSettings(JSON.parse(await file.text()), await chrome.permissions.contains({ origins: DETECTOR_ORIGINS }));
    const names = new Map((await chrome.management.getAll()).map((x) => [x.id, x.name]));
    result.textContent = skipped.length
      ? t('importSkipped', { names: skipped.map((id) => names.get(id) || id).join(', ') })
      : t('importDone');
  } catch {
    result.className = 'error';
    result.textContent = t('importFailed');
  }
});
$('sort').addEventListener('change', (e) => {
  sortMode = e.target.value;
  try {
    localStorage.setItem(SORT_KEY, sortMode);
  } catch {
    // Ignore.
  }
  render();
});

onStorageChange([KEYS.settings, KEYS.alerts, KEYS.log, KEYS.asks, KEYS.state], render);
// Redraw when extensions are installed, removed, turned on or off.
for (const event of ['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled']) chrome.management[event].addListener(render);

render();
