// The detector's scope and files, shared by the background worker and the settings page.
export const DETECTOR_ORIGINS = ['http://*/*', 'https://*/*'];

// The extended mode is passed as a separate file instead of via chrome.storage, so the
// content script never needs storage access (see detector-extended.js).
export const detectorFiles = (settings) => (settings.sensitiveFields ? ['detector-extended.js', 'detector.js'] : ['detector.js']);
