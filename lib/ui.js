// Small DOM helpers shared by the popup and the options page.
import { t } from './i18n.js';
import { normalizeDomain } from './domains.js';

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

// Validates a domain input; shows or hides the error element. Returns the domain or null.
export function readDomain(input, errorEl) {
  const domain = normalizeDomain(input.value);
  errorEl.hidden = !!domain;
  if (!domain) errorEl.textContent = t('invalidDomain');
  return domain;
}

export function onStorageChange(keys, callback) {
  chrome.storage.onChanged.addListener((changes) => {
    if (keys.some((key) => key in changes)) callback();
  });
}
