// Runs the real content script in a simulated page (jsdom).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const code = readFileSync(new URL('../detector.js', import.meta.url), 'utf8');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function detect(html, { act, settings = {}, before } = {}) {
  const { window } = new JSDOM(html, { runScripts: 'outside-only' });
  let reports = 0;
  window.chrome = {
    runtime: { sendMessage: () => { reports++; return Promise.resolve(); } },
    storage: { local: { get: () => Promise.resolve({ settings }) }, onChanged: { addListener() {} } },
  };
  before?.(window);
  window.eval(code);
  await wait(20);
  if (act) {
    act(window);
    await wait(50);
  }
  window.close();
  return reports;
}

const addPassword = (parent, doc) => {
  const input = doc.createElement('input');
  input.type = 'password';
  parent.append(input);
  return input;
};

test('hidden password field present on load', async () => {
  assert.equal(await detect('<form style="display:none"><input type="password"></form>'), 1);
});

test('password field added later (login click)', async () => {
  assert.equal(await detect('<button>Log in</button>', { act: (w) => addPassword(w.document.body, w.document) }), 1);
});

test('text field switched to password', async () => {
  assert.equal(await detect('<input id="p">', { act: (w) => { w.document.getElementById('p').type = 'password'; } }), 1);
});

test('password inside an existing open shadow root', async () => {
  const before = (w) => addPassword(w.document.getElementById('h').attachShadow({ mode: 'open' }), w.document);
  assert.equal(await detect('<div id="h"></div>', { before }), 1);
});

test('component with shadow root inserted later (nested)', async () => {
  const act = (w) => {
    const host = w.document.createElement('div');
    const inner = w.document.createElement('div');
    host.attachShadow({ mode: 'open' }).append(inner);
    addPassword(inner.attachShadow({ mode: 'open' }), w.document);
    w.document.body.append(host);
  };
  assert.equal(await detect('<main></main>', { act }), 1);
});

test('password added later inside an already-watched shadow root', async () => {
  let root;
  const before = (w) => { root = w.document.getElementById('h').attachShadow({ mode: 'open' }); };
  assert.equal(await detect('<div id="h"></div>', { before, act: (w) => addPassword(root, w.document) }), 1);
});

test('focus inside a shadow root is the safety net', async () => {
  let input;
  // A shadow root attached without any DOM mutation and never scanned: only focus can reveal it.
  const act = (w) => {
    input = addPassword(w.document.getElementById('h').attachShadow({ mode: 'open' }), w.document);
    input.focus();
  };
  assert.equal(await detect('<div id="h"></div>', { act }), 1);
});

test('credit card field only counts with extended detection', async () => {
  assert.equal(await detect('<input autocomplete="cc-number">', { settings: { sensitiveFields: true } }), 1);
  assert.equal(await detect('<input autocomplete="cc-number">'), 0);
});

test('address forms never trigger', async () => {
  assert.equal(await detect('<input name="street"><input name="city"><input type="email" name="classname">', { settings: { sensitiveFields: true } }), 0);
});

test('reports only once', async () => {
  const act = (w) => { addPassword(w.document.body, w.document); addPassword(w.document.body, w.document); };
  assert.equal(await detect('<input type="password">', { act }), 1);
});
