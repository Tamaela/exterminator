// Content script: tells the background worker as soon as the page contains a sensitive field.
// Only sends "there is a sensitive field", never any page content. It does not use
// chrome.storage: the extended mode arrives via detector-extended.js (see background.js).
//
// Cost model: one full scan when the page starts, at DOMContentLoaded/load and a few times
// after; in between only the nodes that were actually added or changed are examined.
(() => {
  // Injected again into already-open pages after Exterminator restarts: run only once.
  if (globalThis.__exterminatorDetector === true) return;
  globalThis.__exterminatorDetector = true;

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

  // Strict check: a page element named "__exterminatorExtended" must not count as true.
  const sensitive = globalThis.__exterminatorExtended === true;
  // Content scripts can open closed shadow roots too; other extensions can, so we must look.
  const openOrClosed = globalThis.chrome?.dom?.openOrClosedShadowRoot;
  const shadowOf = (el) => {
    if (el.shadowRoot) return el.shadowRoot;
    try {
      return openOrClosed ? openOrClosed(el) || null : null;
    } catch {
      return null;
    }
  };
  // Text fields shown as dots via CSS (-webkit-text-security), e.g. PIN fields.
  const MASKABLE = 'input:not([type]), input[type="text" i], input[type="tel" i], input[type="number" i]';
  const isMasked = (input) => {
    try {
      const style = getComputedStyle(input);
      const mask = style.webkitTextSecurity || style.getPropertyValue('-webkit-text-security');
      return !!mask && mask !== 'none';
    } catch {
      return false;
    }
  };
  let reported = false;
  let found = false;
  // True for a document that is shown again (back/forward cache) or was prerendered:
  // it may hold scripts from extensions that were on at the time, so the tab must reload.
  let reused = false;
  let watchedRoots = new WeakSet();

  function isSensitiveInput(input) {
    if (input.type?.toLowerCase() === 'password') return true;
    if (input.matches(MASKABLE) && isMasked(input)) return true;
    if (!sensitive) return false;
    const tokens = (input.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    if (tokens.some((token) => SENSITIVE_AUTOCOMPLETE.has(token))) return true;
    return SENSITIVE_NAME.test(`${input.name || ''} ${input.id || ''}`);
  }

  function report() {
    found = true;
    // A prerendered page is not visible yet and belongs to no tab the user sees: wait.
    if (reported || document.prerendering) return;
    reported = true;
    observer.disconnect();
    try {
      chrome.runtime.sendMessage({ type: 'sensitive-field', reused }).catch(() => {});
    } catch {
      // Extension reloaded or context invalidated: ignore.
    }
  }

  function watch(shadowRoot) {
    if (watchedRoots.has(shadowRoot)) return;
    watchedRoots.add(shadowRoot);
    observer.observe(shadowRoot, OBSERVE); // mutations inside shadow roots aren't seen otherwise
  }

  // Searches a node (element, document or shadow root) including open and closed shadow roots.
  function scan(node) {
    if (node instanceof HTMLInputElement && isSensitiveInput(node)) return true;
    if (!node.querySelectorAll) return false;
    if (node.querySelector(PASSWORD)) return true;
    for (const input of node.querySelectorAll(sensitive ? 'input' : MASKABLE)) {
      if (isSensitiveInput(input)) return true;
    }
    const roots = [];
    const own = node instanceof Element ? shadowOf(node) : null;
    if (own) roots.push(own);
    for (const child of node.querySelectorAll('*')) {
      const root = shadowOf(child);
      if (root) roots.push(root);
    }
    for (const root of roots) {
      watch(root);
      if (scan(root)) return true;
    }
    return false;
  }

  function fullScan() {
    if (!reported && (found || scan(document))) report();
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

  // Re-arm when the same document becomes current again.
  function rearm() {
    reported = false;
    found = false;
    reused = true;
    watchedRoots = new WeakSet();
    observer.observe(document, OBSERVE);
    fullScan();
  }
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) rearm(); // restored from the back/forward cache
  });
  document.addEventListener('prerenderingchange', rearm, { once: true }); // prerender activated

  // Safety net: focusing a field, also inside a shadow root. composedPath reveals the real
  // field in an open root; for a closed root it stops at the host, so scan that host.
  document.addEventListener('focusin', (e) => {
    const target = e.composedPath()[0];
    if (target instanceof HTMLInputElement) {
      if (isSensitiveInput(target)) report();
    } else if (target instanceof Element) {
      const root = shadowOf(target);
      if (root && scan(root)) report();
    }
  }, true);

  document.addEventListener('DOMContentLoaded', fullScan, { once: true });
  window.addEventListener('load', () => {
    fullScan();
    for (const delay of LATE_SCANS_MS) setTimeout(fullScan, delay);
  }, { once: true });

  fullScan();
})();
