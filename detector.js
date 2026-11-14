// Content script: tells the background worker as soon as the page contains a sensitive field.
// Only sends "there is a sensitive field", never any page content.
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
  const SCAN_DELAY_MS = 250;

  let sensitive = false; // extended detection (setting)
  let reported = false;
  let timer = null;
  const observedRoots = new WeakSet();

  function isSensitiveInput(input) {
    if (input.type?.toLowerCase() === 'password') return true;
    if (!sensitive) return false;
    const tokens = (input.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    if (tokens.some((t) => SENSITIVE_AUTOCOMPLETE.has(t))) return true;
    return SENSITIVE_NAME.test(`${input.name || ''} ${input.id || ''}`);
  }

  function report() {
    if (reported) return;
    reported = true;
    clearTimeout(timer);
    observer.disconnect();
    try {
      chrome.runtime.sendMessage({ type: 'sensitive-field' }).catch(() => {});
    } catch {
      // Extension reloaded or context invalidated: ignore.
    }
  }

  // Searches a document or (open) shadow root, including nested shadow roots.
  // New shadow roots are observed as well, because mutations inside them are
  // not visible to the observer on the document.
  function scanRoot(root) {
    if (root.querySelector(PASSWORD)) return true;
    if (sensitive) {
      for (const input of root.querySelectorAll('input')) {
        if (isSensitiveInput(input)) return true;
      }
    }
    for (const el of root.querySelectorAll('*')) {
      const shadow = el.shadowRoot; // only open shadow roots are visible
      if (!shadow) continue;
      if (!observedRoots.has(shadow)) {
        observedRoots.add(shadow);
        observer.observe(shadow, OBSERVE);
      }
      if (scanRoot(shadow)) return true;
    }
    return false;
  }

  function fullScan() {
    timer = null;
    if (!reported && scanRoot(document)) report();
  }

  function onMutation() {
    if (reported) return;
    if (document.querySelector(PASSWORD)) return report(); // fast path
    if (!timer) timer = setTimeout(fullScan, SCAN_DELAY_MS); // throttled full scan
  }

  const observer = new MutationObserver(onMutation);
  observer.observe(document, OBSERVE);

  // Safety net: focusing a field, also inside a shadow root (composedPath reveals the real field).
  document.addEventListener('focusin', (e) => {
    const target = e.composedPath()[0];
    if (target instanceof HTMLInputElement && isSensitiveInput(target)) report();
  }, true);

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

  onMutation();
})();
