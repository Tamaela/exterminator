// Fake chrome.* API for previewing the popup and the settings page. Scenarios (?s=):
//   detected: a login page with an open question and 16 extensions turned off
//   strict:   a Strict site with 16 extensions turned off
//   idle:     an unprotected page
//   setup:    before you agreed on the welcome page
(() => {
  const read = (path) => {
    const request = new XMLHttpRequest();
    request.open('GET', path, false);
    request.send();
    return JSON.parse(request.responseText);
  };
  const messages = read('../../_locales/en/messages.json');
  const { version } = read('../../manifest.json');
  const scenario = new URLSearchParams(location.search).get('s') || 'detected';

  // Made-up names: the previews also feed the Chrome Web Store screenshots.
  const names = ['Coupon Finder', 'Grammar Helper', 'Video Downloader', 'Price Tracker', 'Dark Mode', 'Translate Helper',
    'Screenshot Tool', 'Cookie Banner Blocker', 'Tab Organizer', 'Color Picker', 'Weather Now', 'Notes Sidebar',
    'Shopping Assistant', 'Recipe Saver', 'Page Ruler', 'Font Finder'];
  const perms = ['cookies', 'webRequest', 'tabs', 'storage', 'management'];
  // Every third extension is on, to show rows without a "turned off" note.
  const exts = names.map((name, i) => ({
    id: `ext${i}`, name, type: 'extension', enabled: i % 3 === 0, mayDisable: true, version: '1',
    permissions: [perms[i % perms.length]], hostPermissions: i % 2 ? ['<all_urls>'] : [],
  }));
  const ids = exts.map((e) => e.id);
  const base = { globalWhitelist: [], fieldDetection: true, sensitiveFields: true, detectionExclusions: [], clearClipboard: false };
  const data = {
    detected: {
      url: 'https://forum.example/login',
      local: { consent: true, settings: { ...base, sites: [] }, state: { activeSites: ['forum.example'], disabledByUs: ids }, asks: { 'forum.example': 1 } },
      session: { flaggedTabs: { 1: 'forum.example' } },
    },
    strict: {
      url: 'https://bank.example/',
      local: { consent: true, settings: { ...base, sites: [{ domain: 'bank.example', extra: [], level: 'strict' }] }, state: { activeSites: ['bank.example'], disabledByUs: ids } },
      session: {},
    },
    idle: {
      url: 'https://news.example/',
      local: { consent: true, settings: { ...base, sites: [] }, state: { activeSites: [], disabledByUs: [] } },
      session: {},
    },
    setup: {
      url: 'https://news.example/',
      local: { settings: { ...base, sites: [] }, state: { activeSites: [], disabledByUs: [] } },
      session: {},
    },
  }[scenario];

  const area = (store) => ({
    get: async (keys) => {
      if (keys == null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
    },
    set: async (items) => { Object.assign(store, items); },
  });
  const noEvents = { addListener() {} };
  window.chrome = {
    i18n: { getMessage: (key) => messages[key]?.message || '' },
    tabs: { query: async () => [{ id: 1, url: data.url, windowId: 1 }], update: async () => {}, create: async () => {} },
    windows: { update: async () => {} },
    extension: { isAllowedIncognitoAccess: async () => true },
    runtime: { id: 'self', getURL: (path) => path, getManifest: () => ({ version }), openOptionsPage() {} },
    management: { getAll: async () => exts, onInstalled: noEvents, onUninstalled: noEvents, onEnabled: noEvents, onDisabled: noEvents },
    permissions: { request: async () => true, remove: async () => true, contains: async () => true },
    storage: { local: area(data.local), session: area(data.session), onChanged: noEvents },
  };
})();
