import './chrome-stub.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskOf, describePermission, canManageExtensions, sortByRisk } from '../lib/risk.js';

const ext = (name, permissions = [], hostPermissions = []) => ({ name, permissions, hostPermissions });

test('risk levels', () => {
  assert.equal(riskOf(ext('a', [], ['<all_urls>'])).level, 'high');
  assert.equal(riskOf(ext('a', [], ['https://*/*'])).level, 'high');
  assert.equal(riskOf(ext('a', [], ['https://*.google.com/*'])).level, 'medium');
  assert.equal(riskOf(ext('a', ['webRequest'])).level, 'high');
  assert.equal(riskOf(ext('a', ['tabs'])).level, 'medium');
  assert.equal(riskOf(ext('a', ['storage'])).level, 'low');
  assert.equal(riskOf(ext('a', ['webRequest'])).label, 'high risk');
});

test('permissions are described in plain language', () => {
  assert.equal(describePermission('webRequest'), 'can read network traffic and submitted forms');
  assert.equal(describePermission('<all_urls>'), 'access to all websites');
  assert.equal(describePermission('https://*.bank.nl/*'), 'access to https://*.bank.nl/*');
  assert.equal(describePermission('fooBar'), 'permission "fooBar"');
});

test('management permission is recognised', () => {
  assert.ok(canManageExtensions(ext('1Password', ['management'])));
});

test('sortByRisk: highest first, then most reasons, then name', () => {
  const list = [ext('Zeta', ['storage']), ext('Beta', ['webRequest']), ext('Alpha', ['webRequest', 'cookies']), ext('Mid', ['tabs'])];
  assert.deepEqual(sortByRisk(list).map((e) => e.name), ['Alpha', 'Beta', 'Mid', 'Zeta']);
  assert.deepEqual(sortByRisk(list, -1).map((e) => e.name), ['Zeta', 'Mid', 'Beta', 'Alpha']);
});
