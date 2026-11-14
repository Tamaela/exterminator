// Registered before detector.js only when "Other sensitive fields too" is on.
// Content scripts of one extension share an isolated world, so detector.js can read this flag
// without touching chrome.storage (which keeps extension storage out of web renderers).
globalThis.__exterminatorExtended = true;
