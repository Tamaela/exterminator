// Thin wrapper around chrome.i18n with named {placeholders}.
// (We substitute ourselves so messages never need Chrome's $-escaping rules.)
export function t(key, params = {}) {
  const raw = chrome.i18n.getMessage(key);
  if (!raw) return key; // missing translation: show the key so it's easy to spot
  return raw.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

// Fills elements marked with data-i18n (text), data-i18n-html (markup from our own
// message file only), data-i18n-placeholder and data-i18n-title.
export function localizePage(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of root.querySelectorAll('[data-i18n-html]')) node.innerHTML = t(node.dataset.i18nHtml);
  for (const node of root.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  for (const node of root.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
}
