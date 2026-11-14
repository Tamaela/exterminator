// Minimal fake of the chrome.* APIs the lib/ modules use, for Node tests.
import { readFileSync } from 'node:fs';

const messages = JSON.parse(readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'));

function memoryArea() {
  let data = {};
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(items) { data = { ...data, ...structuredClone(items) }; },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
    reset(initial = {}) { data = structuredClone(initial); },
  };
}

globalThis.chrome = {
  runtime: { id: 'self' },
  i18n: { getMessage: (key) => messages[key]?.message ?? '' },
  storage: { local: memoryArea(), session: memoryArea() },
};

export const messageKeys = new Set(Object.keys(messages));
