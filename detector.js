// Content script: tells the background worker as soon as the page contains a sensitive field.
// Only sends "there is a sensitive field", never any page content.
//
// Cost model: one full scan when the page starts, at DOMContentLoaded/load and a few times
// after; in between only the nodes that were actually added or changed are examined.
(() => {
  const PASSWORD = 'input[type="password" i]';
  const SENSITIVE_AUTOCOMPLETE = new Set([
    'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'one-time-code',
  ]);
  // Includes common Dutch field names (bsn, burgerservice, kaartnummer) as well.
  const SENSITIVE_NAME = /(iban|(?:^|[^a-z])ssn(?:[^a-z]|$)|social.?security|bsn|burgerservice|cvc|cvv|csc|card.?num|kaartnummer|creditcard|security.?code)/i;
  const OBSERVE = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'autocomplete', 'name', 'id'],
  };
  // Late full scans catch web components that attach a shadow root after being inserted.
  const LATE_SCANS_MS = [1000, 3000, 10000];

  let sensitive = false; // extended detection (setting)
  let reported = false;
  const watchedRoots = new WeakSet();

  function isSensitiveInput(input) {
    if (input.type?.toLowerCase() === 'password') return true;
    if (!sensitive) return false;
    const tokens = (input.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    if (tokens.some((token) => SENSITIVE_AUTOCOMPLETE.has(token))) return true;
    return SENSITIVE_NAME.test(`${input.name || ''} ${input.id || ''}`);
  }

  function report() {
    if (reported) return;
    reported = true;
    observer.disconnect();
    try {
      chrome.runtime.sendMessage({ type: 'sensitive-field' }).catch(() => {});
    } catch {
      // Extension reloaded or context invalidated: ignore.
    }
  }

  function watch(shadowRoot) {
    if (watchedRoots.has(shadowRoot)) return;
    watchedRoots.add(shadowRoot);
    observer.observe(shadowRoot, OBSERVE); // mutations inside shadow roots aren't seen otherwise
  }

  // Searches a node (element, document or shadow root) including open shadow roots inside it.
  function scan(node) {
    if (node instanceof HTMLInputElement && isSensitiveInput(node)) return true;
    if (!node.querySelectorAll) return false;
    if (node.querySelector(PASSWORD)) return true;
    if (sensitive) {
      for (const input of node.querySelectorAll('input')) if (isSensitiveInput(input)) return true;
    }
    const hosts = node.shadowRoot ? [node] : [];
    for (const child of node.querySelectorAll('*')) if (child.shadowRoot) hosts.push(child);
    for (const host of hosts) {
      watch(host.shadowRoot);
      if (scan(host.shadowRoot)) return true;
    }
    return false;
  }

  function fullScan() {
    if (!reported && scan(document)) report();
  }

  const observer = new MutationObserver((records) => {
    if (reported) return;
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof HTMLInputElement && isSensitiveInput(record.target)) return report();
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && scan(node)) return report();
      }
    }
  });
  observer.observe(document, OBSERVE);

  // Safety net: focusing a field, also inside a shadow root (composedPath reveals the real field).
  document.addEventListener('focusin', (e) => {
    const target = e.composedPath()[0];
    if (target instanceof HTMLInputElement && isSensitiveInput(target)) report();
  }, true);

  document.addEventListener('DOMContentLoaded', fullScan, { once: true });
  window.addEventListener('load', () => {
    fullScan();
    for (const delay of LATE_SCANS_MS) setTimeout(fullScan, delay);
  }, { once: true });

  // Content scripts can't import lib/storage.js; 'settings' must match KEYS.settings there.
  chrome.storage.local.get('settings').then(({ settings }) => {
    sensitive = !!settings?.sensitiveFields;
    fullScan();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      sensitive = !!changes.settings.newValue?.sensitiveFields;
      fullScan();
    }
  });

  fullScan();
})();
