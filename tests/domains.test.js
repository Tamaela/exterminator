import './chrome-stub.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, normalizeDomain, matchSite, findDomain } from '../lib/domains.js';

const sites = [{ domain: 'mybank.com' }, { domain: 'login.mybank.com' }, { domain: 'tax.gov' }];

test('hostOf ignores non-web URLs', () => {
  assert.equal(hostOf('chrome://extensions'), null);
  assert.equal(hostOf('not a url'), null);
});

test('audit fix: blob: and filesystem: URLs belong to their web origin', () => {
  assert.equal(hostOf('blob:https://MyBank.com/1f2e'), 'mybank.com');
  assert.equal(hostOf('filesystem:https://mybank.com/temporary/x'), 'mybank.com');
  assert.equal(hostOf('blob:null/1f2e'), null);
  assert.equal(hostOf('about:blank'), null);
});

test('trailing dot cannot bypass matching', () => {
  assert.equal(hostOf('https://mybank.com./x'), 'mybank.com');
  assert.equal(matchSite(hostOf('https://mybank.com./'), sites)?.domain, 'mybank.com');
});

test('matchSite matches subdomains, most specific wins, no lookalikes', () => {
  assert.equal(matchSite('www.mybank.com', sites).domain, 'mybank.com');
  assert.equal(matchSite('a.login.mybank.com', sites).domain, 'login.mybank.com');
  assert.equal(matchSite('fake-mybank.com', sites), null);
  assert.equal(matchSite('mybank.com.evil.io', sites), null);
});

test('normalizeDomain cleans up URLs and converts international domains', () => {
  assert.equal(normalizeDomain('https://www.MyBank.com/personal?x=1'), 'mybank.com');
  assert.equal(normalizeDomain('*.mybank.com'), 'mybank.com');
  assert.equal(normalizeDomain('mybank.com.'), 'mybank.com');
  assert.equal(normalizeDomain('bücher.de'), 'xn--bcher-kva.de');
  assert.equal(normalizeDomain('localhost'), null);
  assert.equal(normalizeDomain(''), null);
});

test('findDomain returns the covering domain', () => {
  assert.equal(findDomain('a.example.com', ['example.com']), 'example.com');
  assert.equal(findDomain('notexample.com', ['example.com']), null);
  assert.equal(findDomain('example.com', undefined), null);
});
