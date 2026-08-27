#!/usr/bin/env node
// Exercises the extension's pure logic against a stubbed chrome.* API, so the
// rule generation and the visit queue can be checked without a browser.
//
//   node tools/test-extension.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = (name) => pathToFileURL(path.join(here, '..', 'extension', 'lib', name)).href;

// --- chrome.* stub --------------------------------------------------------

const store = new Map();
let dynamicRules = [];
const badge = { text: '' };
const tabs = new Map();

globalThis.chrome = {
  runtime: {
    getURL: (p) => `chrome-extension://abcdefghijklmnop/${p}`,
    getManifest: () => ({ version: '1.0.0' }),
  },
  storage: {
    local: {
      async get(key) {
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (store.has(k)) out[k] = structuredClone(store.get(k));
        return out;
      },
      async set(items) {
        for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
      },
    },
  },
  declarativeNetRequest: {
    async getDynamicRules() {
      return dynamicRules.slice();
    },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
      dynamicRules = dynamicRules.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules);
      const ids = new Set();
      for (const rule of dynamicRules) {
        assert.ok(Number.isInteger(rule.id) && rule.id >= 1, `rule id must be a positive integer: ${rule.id}`);
        assert.ok(!ids.has(rule.id), `duplicate rule id ${rule.id}`);
        ids.add(rule.id);
        assert.ok(rule.priority >= 1, 'priority must be >= 1');
        assert.ok(['block', 'redirect'].includes(rule.action.type), 'unexpected action type');
        assert.ok(Array.isArray(rule.condition.requestDomains), 'requestDomains must be a list');
      }
    },
  },
  action: {
    async setBadgeText({ text }) {
      badge.text = text;
    },
    async setBadgeBackgroundColor() {},
  },
  tabs: {
    async get(id) {
      if (!tabs.has(id)) throw new Error('no such tab');
      return tabs.get(id);
    },
  },
};

// --- harness --------------------------------------------------------------

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

const { getSettings, setSettings, buildSocketUrl, hostOf, hostMatches } = await import(lib('config.js'));
const { applyPolicy, getBlockedHosts, isBlockedUrl, clearRules } = await import(lib('blocking.js'));
const { recordNavigation, getQueue, flush, clearQueue, isReportableUrl } = await import(lib('visits.js'));

const policyOf = (...hosts) => ({
  version: 3,
  blockingEnabled: true,
  rules: hosts.map((host) => ({ host })),
});

// --- config ---------------------------------------------------------------

await check('buildSocketUrl upgrades http, fills in the path, carries the token', () => {
  const url = new URL(buildSocketUrl({ controllerUrl: 'http://127.0.0.1:8787', token: 'abc' }));
  assert.equal(url.protocol, 'ws:');
  assert.equal(url.pathname, '/ws');
  assert.equal(url.searchParams.get('role'), 'agent');
  assert.equal(url.searchParams.get('token'), 'abc');
  assert.equal(new URL(buildSocketUrl({ controllerUrl: 'https://box.example/ws', token: 't' })).protocol, 'wss:');
});

await check('buildSocketUrl refuses a scheme it cannot dial', () => {
  assert.throws(() => buildSocketUrl({ controllerUrl: 'ftp://example.com', token: 't' }), /ws:\/\//);
});

await check('hostOf and hostMatches cover subdomains and www', () => {
  assert.equal(hostOf('https://www.Example.com/x'), 'example.com');
  assert.equal(hostMatches('sub.example.com', ['example.com']), true);
  assert.equal(hostMatches('example.com', ['*.example.com']), true);
  assert.equal(hostMatches('notexample.com', ['example.com']), false);
  assert.equal(hostMatches('', ['example.com']), false);
});

await check('settings get an agent id once and keep it', async () => {
  const first = await getSettings();
  assert.match(first.agentId, /^[0-9a-f-]{36}$/);
  const second = await getSettings();
  assert.equal(second.agentId, first.agentId);
});

// --- blocking -------------------------------------------------------------

const baseSettings = {
  enforcing: true,
  ignoredHosts: [],
  controllerUrl: 'ws://127.0.0.1:8787/ws',
};

await check('each blocked host becomes a redirect rule and a block rule', async () => {
  const { appliedRules, hosts } = await applyPolicy(policyOf('example.com', 'ads.test'), baseSettings);
  assert.equal(hosts.length, 2);
  assert.equal(appliedRules, 4);
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const redirect = rules.find((r) => r.action.type === 'redirect');
  assert.deepEqual(redirect.condition.resourceTypes, ['main_frame']);
  assert.match(redirect.action.redirect.url, /^chrome-extension:\/\/\w+\/blocked\.html\?host=/);
  const block = rules.find((r) => r.action.type === 'block');
  assert.deepEqual(block.condition.excludedResourceTypes, ['main_frame']);
});

await check('the badge shows how many sites are blocked', () => {
  assert.equal(badge.text, '2');
});

await check('a policy replaces the previous rules instead of stacking', async () => {
  await applyPolicy(policyOf('only.example'), baseSettings);
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  assert.equal(rules.length, 2);
  assert.deepEqual(await getBlockedHosts(), ['only.example']);
});

await check('locally ignored hosts are never blocked', async () => {
  const { hosts } = await applyPolicy(policyOf('example.com', 'mybank.example'), {
    ...baseSettings,
    ignoredHosts: ['mybank.example'],
  });
  assert.deepEqual(hosts, ['example.com']);
});

await check('the controller host is never blocked', async () => {
  const { hosts } = await applyPolicy(policyOf('127.0.0.1', 'example.com'), baseSettings);
  assert.deepEqual(hosts, ['example.com']);
});

await check('duplicate hosts collapse to one pair of rules', async () => {
  const { appliedRules } = await applyPolicy(policyOf('dup.example', 'DUP.example'), baseSettings);
  assert.equal(appliedRules, 2);
});

await check('the master switch off means no rules at all', async () => {
  const { hosts } = await applyPolicy({ ...policyOf('example.com'), blockingEnabled: false }, baseSettings);
  assert.deepEqual(hosts, []);
  assert.equal((await chrome.declarativeNetRequest.getDynamicRules()).length, 0);
  assert.equal(badge.text, '');
});

await check('the local enforcement switch off means no rules either', async () => {
  const { hosts } = await applyPolicy(policyOf('example.com'), { ...baseSettings, enforcing: false });
  assert.deepEqual(hosts, []);
});

await check('a thousand-host policy stays inside the dynamic rule budget', async () => {
  const many = Array.from({ length: 1500 }, (_, i) => `site${i}.example`);
  const { appliedRules } = await applyPolicy(policyOf(...many), baseSettings);
  assert.equal(appliedRules, 2000);
});

await check('isBlockedUrl matches subdomains of a blocked host', async () => {
  await applyPolicy(policyOf('example.com'), baseSettings);
  assert.equal(await isBlockedUrl('https://deep.sub.example.com/page'), true);
  assert.equal(await isBlockedUrl('https://example.com.evil.test/'), false);
  assert.equal(await isBlockedUrl('not a url'), false);
});

// --- visits ---------------------------------------------------------------

await check('only http(s) navigations are reportable', () => {
  assert.equal(isReportableUrl('https://a.test/'), true);
  assert.equal(isReportableUrl('chrome-extension://x/blocked.html'), false);
  assert.equal(isReportableUrl('about:blank'), false);
});

await check('a navigation is queued with the tab title', async () => {
  await clearQueue();
  await setSettings({ reporting: true, ignoredHosts: ['mybank.example'] });
  tabs.set(6, { id: 6, title: 'Some Page', url: 'https://allowed.test/' });
  const visit = await recordNavigation({ tabId: 6, url: 'https://allowed.test/', transitionType: 'link' });
  assert.equal(visit.host, 'allowed.test');
  assert.equal(visit.title, 'Some Page');
  assert.equal(visit.blocked, false);
  assert.equal((await getQueue()).length, 1);
});

await check('a blocked navigation is flagged, without the stale tab title', async () => {
  tabs.set(7, { id: 7, title: 'Whatever was open before', url: 'https://previous.test/' });
  const visit = await recordNavigation({ tabId: 7, url: 'https://example.com/', transitionType: 'link' });
  assert.equal(visit.blocked, true); // example.com is still in the policy above
  assert.equal(visit.title, '');
  assert.equal((await getQueue()).length, 2);
});

await check('the same URL in the same tab is not queued twice in a row', async () => {
  await recordNavigation({ tabId: 7, url: 'https://example.com/', transitionType: 'reload' });
  assert.equal((await getQueue()).length, 2);
});

await check('an ignored host is never queued', async () => {
  tabs.set(8, { id: 8, title: 'Bank', url: 'https://mybank.example/' });
  const visit = await recordNavigation({ tabId: 8, url: 'https://mybank.example/accounts', transitionType: 'typed' });
  assert.equal(visit, null);
  assert.equal((await getQueue()).length, 2);
});

await check('reporting off queues nothing', async () => {
  await setSettings({ reporting: false });
  const visit = await recordNavigation({ tabId: 7, url: 'https://other.test/', transitionType: 'link' });
  assert.equal(visit, null);
  await setSettings({ reporting: true });
});

await check('a successful flush drains the queue', async () => {
  let seen = null;
  const sent = await flush(async (items) => {
    seen = items;
    return true;
  });
  assert.equal(sent, 2);
  assert.equal(seen.length, 2);
  assert.equal((await getQueue()).length, 0);
});

await check('a failed flush keeps the visits for the next attempt', async () => {
  tabs.set(9, { id: 9, title: 'Later', url: 'https://later.test/' });
  await recordNavigation({ tabId: 9, url: 'https://later.test/', transitionType: 'link' });
  const sent = await flush(async () => false);
  assert.equal(sent, 0);
  assert.equal((await getQueue()).length, 1);
});

await check('clearRules empties both the engine and the cached host list', async () => {
  await clearRules();
  assert.equal((await chrome.declarativeNetRequest.getDynamicRules()).length, 0);
  assert.deepEqual(await getBlockedHosts(), []);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
