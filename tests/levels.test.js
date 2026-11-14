// The protection level controls (run in jsdom).
import './chrome-stub.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('');
globalThis.document = window.document;
const { askCard, levelPicker } = await import('../lib/levels.js');
const { getSettings, setAsks, getAsks } = await import('../lib/storage.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('"Never protect this site" needs a second click', async () => {
  chrome.storage.local.reset();
  await setAsks({ 'shop.com': 1 });
  const card = askCard('shop.com');
  const never = card.querySelector('button.danger');
  never.click();
  await settle();
  assert.deepEqual((await getSettings()).detectionExclusions, []);
  never.click();
  await settle();
  assert.deepEqual((await getSettings()).detectionExclusions, ['shop.com']);
  assert.deepEqual(await getAsks(), {});
});

test('choosing a level in the question adds the site', async () => {
  chrome.storage.local.reset();
  const card = askCard('bank.com');
  card.querySelector('button.level-choice').click(); // the first choice is Strict
  await settle();
  assert.deepEqual((await getSettings()).sites, [{ domain: 'bank.com', extra: [], cleanup: true }]);
});

test('the level picker shows the warning of the chosen level', () => {
  const chosen = [];
  const picker = levelPicker('x', 'strict', ['site', 'strict'], (level) => chosen.push(level));
  assert.equal(picker.querySelector('.level-warning'), null);
  const site = picker.querySelector('input[value="site"]');
  site.checked = true;
  site.dispatchEvent(new window.Event('change'));
  assert.deepEqual(chosen, ['site']);
  assert.ok(picker.querySelector('.level-warning'));
});
