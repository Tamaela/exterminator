// DOM helpers and i18n guards (run in jsdom).
import './chrome-stub.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<p data-i18n-html="cleanupHelpHtml"></p><p data-i18n="add"></p>');
globalThis.document = window.document;
const { el } = await import('../lib/ui.js');
const { localizePage } = await import('../lib/i18n.js');

test('el() turns strings into text, never markup', () => {
  const node = el('p', {}, '<img src=x onerror=alert(1)>');
  assert.equal(node.children.length, 0);
  assert.equal(node.textContent, '<img src=x onerror=alert(1)>');
});

test('el() refuses markup properties', () => {
  assert.throws(() => el('p', { innerHTML: '<b>x</b>' }), /not allowed/);
  assert.throws(() => el('iframe', { srcdoc: 'x' }), /not allowed/);
});

test('localizePage renders packaged markup and refuses non-Html keys for markup', () => {
  localizePage(window.document);
  assert.match(window.document.querySelector('[data-i18n-html]').innerHTML, /<strong>/);
  const bad = new JSDOM('<p data-i18n-html="add"></p>').window.document;
  assert.throws(() => localizePage(bad), /must end in "Html"/);
});
