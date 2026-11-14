// Guards against UI text that has no translation (it would show up as a raw key).
import { messageKeys } from './chrome-stub.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const files = [
  ...readdirSync(root).filter((f) => /\.(js|html)$/.test(f)),
  ...readdirSync(new URL('lib/', root)).map((f) => `lib/${f}`),
];

test('every message key used in the code exists', () => {
  const used = new Set();
  for (const file of files) {
    const src = readFileSync(new URL(file, root), 'utf8');
    for (const m of src.matchAll(/\bt\('([A-Za-z_]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-i18n(?:-html|-placeholder|-title)?="([A-Za-z_]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/__MSG_([A-Za-z_]+)__/g)) used.add(m[1]);
  }
  for (const m of readFileSync(new URL('manifest.json', root), 'utf8').matchAll(/__MSG_([A-Za-z_]+)__/g)) used.add(m[1]);
  const missing = [...used].filter((key) => !messageKeys.has(key));
  assert.deepEqual(missing, []);
});

test('dynamic keys (risk levels, permissions) exist', () => {
  for (const level of ['high', 'medium', 'low']) assert.ok(messageKeys.has(`risk_${level}`));
  for (const perm of ['debugger', 'webRequest', 'cookies', 'management', 'tabs', 'storage']) assert.ok(messageKeys.has(`perm_${perm}`));
});
