// Risk analysis of extensions, based on their permissions.
import { t } from './i18n.js';

const HIGH = ['debugger', 'webRequest', 'webRequestBlocking', 'cookies', 'management', 'nativeMessaging', 'proxy'];
const MEDIUM = ['scripting', 'tabs', 'clipboardRead', 'history', 'webNavigation', 'desktopCapture', 'tabCapture',
  'declarativeNetRequestWithHostAccess'];
const DESCRIBED = new Set([...HIGH, ...MEDIUM, 'storage', 'alarms', 'notifications', 'contextMenus', 'activeTab',
  'downloads', 'bookmarks', 'identity', 'offscreen', 'sidePanel', 'unlimitedStorage', 'clipboardWrite',
  'declarativeNetRequest', 'privacy', 'geolocation', 'idle', 'topSites']);

export const RISK_ORDER = { high: 2, medium: 1, low: 0 };

const isBroadHost = (h) => h === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(h);

export function riskOf(ext) {
  let level = 0;
  const reasons = [];
  const hosts = ext.hostPermissions || [];
  if (hosts.some(isBroadHost)) {
    level = 2;
    reasons.push(t('riskAllSites'));
  } else if (hosts.length) {
    level = 1;
    reasons.push(t('riskSomeSites', { count: hosts.length }));
  }
  for (const perm of ext.permissions || []) {
    if (HIGH.includes(perm)) {
      level = 2;
      reasons.push(t(`perm_${perm}`));
    } else if (MEDIUM.includes(perm)) {
      level = Math.max(level, 1);
      reasons.push(t(`perm_${perm}`));
    }
  }
  const name = ['low', 'medium', 'high'][level];
  return { level: name, label: t(`risk_${name}`), reasons };
}

// Human-readable description of a permission or host pattern.
export function describePermission(perm) {
  if (isBroadHost(perm)) return t('permAllSites');
  if (perm.includes('://')) return t('permHost', { pattern: perm });
  return DESCRIBED.has(perm) ? t(`perm_${perm}`) : t('permUnknown', { name: perm });
}

// Extensions that can manage other extensions (e.g. 1Password) could turn disabled
// extensions back on. Allowed, but with an extra warning.
export function canManageExtensions(ext) {
  return (ext.permissions || []).includes('management');
}

// Highest risk first, then most reasons, then name. direction -1 reverses the risk order.
export function sortByRisk(exts, direction = 1) {
  return exts
    .map((ext) => ({ ext, risk: riskOf(ext) }))
    .sort((a, b) => direction * (RISK_ORDER[b.risk.level] - RISK_ORDER[a.risk.level])
      || direction * (b.risk.reasons.length - a.risk.reasons.length)
      || a.ext.name.localeCompare(b.ext.name))
    .map((x) => x.ext);
}
