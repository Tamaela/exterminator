// Small DOM helpers shared by the popup and the options page.
import { t } from './i18n.js';
import { normalizeDomain } from './domains.js';

const MARKUP_PROPS = ['innerHTML', 'outerHTML', 'srcdoc'];

const URL_PROPS = ['href', 'src', 'action', 'formAction'];

// Creates an element. Strings in `children` become text nodes; markup properties, string
// event handlers and javascript: URLs are refused so data can never become code.
export function el(tag, props = {}, ...children) {
  const unsafe = Object.keys(props).find((key) => MARKUP_PROPS.includes(key)
    || (/^on/i.test(key) && typeof props[key] !== 'function')
    || (URL_PROPS.includes(key) && /^\s*javascript:/i.test(String(props[key]))));
  if (unsafe) throw new Error(`el(): "${unsafe}" is not allowed`);
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

// Calls back when one of these storage keys changes.
export function onStorageChange(keys, callback) {
  chrome.storage.onChanged.addListener((changes) => {
    if (keys.some((key) => key in changes)) callback();
  });
}
