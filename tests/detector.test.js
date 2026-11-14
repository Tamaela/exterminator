// Runs the real content script in a simulated page (jsdom).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const code = readFileSync(new URL('../detector.js', import.meta.url), 'utf8');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function detect(html, { act, extended = false, before } = {}) {
  const { window } = new JSDOM(html, { runScripts: 'outside-only' });
  const messages = [];
  window.chrome = { runtime: { sendMessage: (msg) => { messages.push(JSON.parse(JSON.stringify(msg))); return Promise.resolve(); } } };
  if (extended) window.__exterminatorExtended = true; // what detector-extended.js does
  before?.(window);
  window.eval(code);
  await wait(20);
  if (act) {
    await act(window);
    await wait(50);
  }
  window.close();
  return messages;
}
const count = async (...args) => (await detect(...args)).length;

const addPassword = (parent, doc) => {
  const input = doc.createElement('input');
  input.type = 'password';
  parent.append(input);
  return input;
};

test('hidden password field present on load', async () => {
  assert.equal(await count('<form style="display:none"><input type="password"></form>'), 1);
});

test('password field added later (login click)', async () => {
  assert.equal(await count('<button>Log in</button>', { act: (w) => addPassword(w.document.body, w.document) }), 1);
});

test('text field switched to password', async () => {
  assert.equal(await count('<input id="p">', { act: (w) => { w.document.getElementById('p').type = 'password'; } }), 1);
});

test('password inside an existing open shadow root', async () => {
  const before = (w) => addPassword(w.document.getElementById('h').attachShadow({ mode: 'open' }), w.document);
  assert.equal(await count('<div id="h"></div>', { before }), 1);
});

test('component with nested shadow roots inserted later', async () => {
  const act = (w) => {
    const host = w.document.createElement('div');
    const inner = w.document.createElement('div');
    host.attachShadow({ mode: 'open' }).append(inner);
    addPassword(inner.attachShadow({ mode: 'open' }), w.document);
    w.document.body.append(host);
  };
  assert.equal(await count('<main></main>', { act }), 1);
});

test('password added later inside an already-watched shadow root', async () => {
  let root;
  const before = (w) => { root = w.document.getElementById('h').attachShadow({ mode: 'open' }); };
  assert.equal(await count('<div id="h"></div>', { before, act: (w) => addPassword(root, w.document) }), 1);
});

test('focus inside a shadow root is the safety net', async () => {
  const act = (w) => addPassword(w.document.getElementById('h').attachShadow({ mode: 'open' }), w.document).focus();
  assert.equal(await count('<div id="h"></div>', { act }), 1);
});

test('extended mode comes from detector-extended.js, not from storage', async () => {
  assert.equal(await count('<input autocomplete="cc-number">', { extended: true }), 1);
  assert.equal(await count('<input autocomplete="cc-number">'), 0);
});

test('address forms never trigger', async () => {
  assert.equal(await count('<input name="street"><input name="city"><input type="email" name="classname">', { extended: true }), 0);
});

test('reports only once per showing', async () => {
  const act = (w) => { addPassword(w.document.body, w.document); addPassword(w.document.body, w.document); };
  assert.equal(await count('<input type="password">', { act }), 1);
});

test('audit fix: a page restored from the back/forward cache reports again, marked as reused', async () => {
  const act = (w) => {
    const event = new w.Event('pageshow');
    event.persisted = true;
    w.dispatchEvent(event);
  };
  const messages = await detect('<input type="password">', { act });
  assert.deepEqual(messages, [{ type: 'sensitive-field', reused: false }, { type: 'sensitive-field', reused: true }]);
});

test('audit fix: a prerendered page waits until it is shown, then reports as reused', async () => {
  let w;
  const before = (win) => { w = win; Object.defineProperty(win.document, 'prerendering', { configurable: true, value: true }); };
  const act = () => {
    Object.defineProperty(w.document, 'prerendering', { configurable: true, value: false });
    w.document.dispatchEvent(new w.Event('prerenderingchange'));
  };
  const messages = await detect('<input type="password">', { before, act });
  assert.deepEqual(messages, [{ type: 'sensitive-field', reused: true }]);
});

test('the detector no longer touches chrome.storage', () => {
  assert.equal(/chrome\.storage\./.test(code), false);
});
