// Content script: tells the background worker as soon as the page contains a sensitive field,
// and keeps a connection open for as long as it does. Only sends "there is a sensitive field",
// never any page content. It does not use
// chrome.storage: the extended mode arrives via detector-extended.js (see background.js).
//
// Cost model: one full scan when the page starts, at DOMContentLoaded/load and a few times
// after; in between only the nodes that were actually added or changed are examined.
(() => {
  // Injected again into a page that already has a detector (after field detection was turned
  // back on, or after Tab Chaperone restarted): if that detector still belongs to a live
  // Tab Chaperone, make it scan again and report anew; if it is orphaned (its extension context
  // is gone), take over. A page element with this name is not a detector (no `rescan`).
  const previous = globalThis.__tabChaperoneDetector;
  if (previous && typeof previous.rescan === 'function' && previous.alive()) {
    previous.rescan();
    return;
  }
  previous?.stop?.();

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

  // Strict check: a page element named "__tabChaperoneExtended" must not count as true.
  let sensitive = globalThis.__tabChaperoneExtended === true;
  // Content scripts can open closed shadow roots too; other extensions can, so we must look.
  const openOrClosed = globalThis.chrome?.dom?.openOrClosedShadowRoot;
  // The shadow root of an element, open or closed.
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
  // True when a text field hides its characters with CSS, like a password field.
  const isMasked = (input) => {
    try {
      const style = getComputedStyle(input);
      const mask = style.webkitTextSecurity || style.getPropertyValue('-webkit-text-security');
      return !!mask && mask !== 'none';
    } catch {
      return false;
    }
  };
  const PORT_NAME = 'tab-chaperone-field';
  // Messages on the connection keep the background worker running while the field is there.
  const PING_MS = 20000;
  // Removals are checked in a batch: a script often replaces a form in several steps.
  const GONE_CHECK_MS = 500;
  let reported = false;
  let found = false;
  // The sensitive fields found so far. A field that turns into a plain text field (a "show
  // password" button) still counts while it is on the page.
  let fields = [];
  let port = null;
  let pinger = null;
  let goneTimer = null;
  let stopped = false;
  // True for a document that is shown again (back/forward cache) or was prerendered:
  // it may hold scripts from extensions that were on at the time, so the tab must reload.
  let reused = false;
  let watchedRoots = new WeakSet();

  // True for a password field, or in extended mode for card, code, IBAN and ID fields.
  function isSensitiveInput(input) {
    if (input.type?.toLowerCase() === 'password') return true;
    if (input.matches(MASKABLE) && isMasked(input)) return true;
    if (!sensitive) return false;
    const tokens = (input.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    if (tokens.some((token) => SENSITIVE_AUTOCOMPLETE.has(token))) return true;
    return SENSITIVE_NAME.test(`${input.name || ''} ${input.id || ''}`);
  }

  // Tells the background worker once that this page has a sensitive field, and opens the
  // connection that stays open while it has one.
  function report(field) {
    found = true;
    if (field && !fields.includes(field)) fields.push(field);
    // A prerendered page is not visible yet and belongs to no tab the user sees: wait.
    if (reported || document.prerendering) return;
    reported = true;
    try {
      chrome.runtime.sendMessage({ type: 'sensitive-field', reused }).catch(() => {});
    } catch {
      // Extension reloaded or context invalidated: ignore.
    }
    connect();
  }

  // Opens the connection. When the background worker restarts, it closes: open it again.
  function connect() {
    if (port || stopped) return;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      return; // extension reloaded or context invalidated
    }
    pinger = setInterval(() => port?.postMessage('ping'), PING_MS);
    port.onDisconnect.addListener(() => {
      clearInterval(pinger);
      port = null;
      if (reported) setTimeout(connect, 1000);
    });
  }

  // Closes the connection: the page has no sensitive field any more.
  function disconnect() {
    clearInterval(pinger);
    const open = port;
    port = null;
    open?.disconnect();
  }

  // True while a field found earlier is still on the page, or the page has another one.
  const hasField = () => fields.some((field) => field.isConnected) || !!scan(document);

  // After nodes were removed: when no sensitive field is left, close the connection and watch
  // for the next one.
  function checkGone() {
    clearTimeout(goneTimer);
    goneTimer = setTimeout(() => {
      if (!reported || hasField()) return;
      reported = false;
      found = false;
      fields = [];
      disconnect();
    }, GONE_CHECK_MS);
  }

  // Watches a shadow root for new fields.
  function watch(shadowRoot) {
    if (watchedRoots.has(shadowRoot)) return;
    watchedRoots.add(shadowRoot);
    observer.observe(shadowRoot, OBSERVE); // mutations inside shadow roots aren't seen otherwise
  }

  // Searches a node (element, document or shadow root) including open and closed shadow roots.
  // Returns the first sensitive field, or null.
  function scan(node) {
    if (node instanceof HTMLInputElement && isSensitiveInput(node)) return node;
    if (!node.querySelectorAll) return null;
    const password = node.querySelector(PASSWORD);
    if (password) return password;
    for (const input of node.querySelectorAll(sensitive ? 'input' : MASKABLE)) {
      if (isSensitiveInput(input)) return input;
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
      const field = scan(root);
      if (field) return field;
    }
    return null;
  }

  // Scans the whole document, unless a field was already reported.
  function fullScan() {
    if (reported) return;
    if (found) return report();
    const field = scan(document);
    if (field) report(field);
  }

  const observer = new MutationObserver((records) => {
    if (reported) {
      if (records.some((record) => record.removedNodes.length)) checkGone();
      return;
    }
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof HTMLInputElement && isSensitiveInput(record.target)) return report(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        const field = node.nodeType === Node.ELEMENT_NODE ? scan(node) : null;
        if (field) return report(field);
      }
    }
  });
  observer.observe(document, OBSERVE);

  // Forgets the earlier report and scans again.
  function restart() {
    reported = false;
    found = false;
    fields = [];
    disconnect();
    watchedRoots = new WeakSet();
    observer.observe(document, OBSERVE);
    fullScan();
  }
  // Re-arm when the same document becomes current again.
  function rearm() {
    reused = true;
    restart();
  }

  globalThis.__tabChaperoneDetector = {
    alive: () => {
      try {
        return !!chrome.runtime?.id;
      } catch {
        return false;
      }
    },
    rescan: () => {
      sensitive = globalThis.__tabChaperoneExtended === true; // the mode may have changed
      restart();
    },
    stop: () => {
      reported = true; // never reports again
      observer.disconnect();
      stopped = true;
      disconnect();
    },
  };
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) rearm(); // restored from the back/forward cache
  });
  document.addEventListener('prerenderingchange', rearm, { once: true }); // prerender activated

  // Safety net: focusing a field, also inside a shadow root. composedPath reveals the real
  // field in an open root; for a closed root it stops at the host, so scan that host.
  document.addEventListener('focusin', (e) => {
    const target = e.composedPath()[0];
    if (target instanceof HTMLInputElement) {
      if (isSensitiveInput(target)) report(target);
    } else if (target instanceof Element) {
      const root = shadowOf(target);
      const field = root && scan(root);
      if (field) report(field);
    }
  }, true);

  document.addEventListener('DOMContentLoaded', fullScan, { once: true });
  window.addEventListener('load', () => {
    fullScan();
    for (const delay of LATE_SCANS_MS) setTimeout(fullScan, delay);
  }, { once: true });

  fullScan();
})();
