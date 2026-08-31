#!/usr/bin/env node
'use strict';
// End-to-end check of the controller: REST auth, policy fan-out to agents,
// visit ingestion, and live dashboard updates. Runs against a throwaway data
// directory on an ephemeral port.
//
//   node tools/selftest.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { normalizeHost } = require('../src/store');
const { Client } = require('./wsclient');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-selftest-'));
let failures = 0;
let passes = 0;

function check(name, fn) {
  try {
    fn();
    passes += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves once `predicate` sees a matching message, or rejects on timeout.
function waitFor(bus, predicate, label, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const found = bus.messages.find(predicate);
    if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeout);
    bus.waiters.push((msg) => {
      if (!predicate(msg)) return false;
      clearTimeout(timer);
      resolve(msg);
      return true;
    });
  });
}

function busFor(client) {
  const bus = { messages: [], waiters: [] };
  client.on('message', (raw) => {
    const msg = JSON.parse(raw);
    bus.messages.push(msg);
    bus.waiters = bus.waiters.filter((waiter) => !waiter(msg));
  });
  return bus;
}

function connect(url) {
  const client = new Client(url);
  const bus = busFor(client);
  const opened = new Promise((resolve, reject) => {
    client.on('open', resolve);
    client.on('error', reject);
  });
  client.connect();
  return opened.then(() => ({ client, bus }));
}

async function main() {
  const { server, store } = createServer({ dataDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const token = store.token;

  const api = async (route, options = {}, withToken = true) => {
    const res = await fetch(base + route, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(withToken ? { authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  console.log(`controller on ${base}, data in ${dataDir}\n`);

  // --- host normalisation -------------------------------------------------
  check('normalizeHost strips scheme, path, www and wildcard', () => {
    assert.equal(normalizeHost('https://www.Example.com/some/path?q=1'), 'example.com');
    assert.equal(normalizeHost('*.ads.example.co.uk'), 'ads.example.co.uk');
    assert.equal(normalizeHost('example.com:8443'), 'example.com');
  });
  check('normalizeHost rejects junk', () => {
    assert.equal(normalizeHost('not a host'), null);
    assert.equal(normalizeHost(''), null);
    assert.equal(normalizeHost('bare'), null);
  });

  // --- auth ---------------------------------------------------------------
  const health = await api('/api/health', {}, false);
  check('health needs no token', () => assert.equal(health.status, 200));
  const unauth = await api('/api/state', {}, false);
  check('state rejects a missing token', () => assert.equal(unauth.status, 401));
  const authed = await api('/api/state');
  check('state accepts the token', () => assert.equal(authed.status, 200));

  const rejected = await connect(`ws://127.0.0.1:${port}/ws?role=agent&token=wrong`).then(
    () => 'connected',
    () => 'rejected'
  );
  check('websocket rejects a bad token', () => assert.equal(rejected, 'rejected'));

  // --- agent + dashboard --------------------------------------------------
  const ui = await connect(`ws://127.0.0.1:${port}/ws?role=ui&token=${token}`);
  const snapshot = await waitFor(ui.bus, (m) => m.type === 'snapshot', 'ui snapshot');
  check('dashboard gets a snapshot on connect', () => {
    assert.equal(Array.isArray(snapshot.agents), true);
    assert.equal(snapshot.policy.rules.length, 0);
  });

  const agent = await connect(`ws://127.0.0.1:${port}/ws?role=agent&token=${token}`);
  agent.client.send({ type: 'hello', agentId: 'test-agent', name: 'Test Chrome', version: '1.0.0' });
  const welcome = await waitFor(agent.bus, (m) => m.type === 'welcome', 'agent welcome');
  check('agent is welcomed with the current policy', () => {
    assert.equal(welcome.policy.blockingEnabled, true);
    assert.deepEqual(welcome.policy.rules, []);
  });
  await waitFor(ui.bus, (m) => m.type === 'agents' && m.agents.length === 1, 'agent list update');
  check('dashboard sees the agent connect', () => {
    const agents = ui.bus.messages.filter((m) => m.type === 'agents').pop().agents;
    assert.equal(agents[0].name, 'Test Chrome');
  });

  // --- blocklist push -----------------------------------------------------
  const added = await api('/api/blocklist', {
    method: 'POST',
    body: JSON.stringify({ host: 'https://www.Example.com/path', note: 'from the test' }),
  });
  check('adding a rule normalises the host', () => {
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.policy.rules.map((r) => r.host), ['example.com']);
  });
  const pushed = await waitFor(agent.bus, (m) => m.type === 'policy', 'policy push');
  check('the agent is pushed the new policy', () => {
    assert.deepEqual(pushed.policy.rules.map((r) => r.host), ['example.com']);
    assert.equal(pushed.policy.version, added.body.policy.version);
  });

  const duplicate = await api('/api/blocklist', { method: 'POST', body: JSON.stringify({ host: 'example.com' }) });
  check('a duplicate host is refused', () => {
    assert.equal(duplicate.body.skipped.length, 1);
    assert.match(duplicate.body.skipped[0].reason, /already blocked/);
  });

  // --- visits -------------------------------------------------------------
  agent.client.send({
    type: 'visits',
    items: [
      { url: 'https://news.ycombinator.com/', title: 'Hacker News', ts: Date.now() },
      { url: 'https://sub.example.com/tracker', title: 'nope', ts: Date.now() },
      { url: 'not-a-url', title: 'garbage', ts: Date.now() },
    ],
  });
  await waitFor(agent.bus, (m) => m.type === 'visits-ack', 'visit ack');
  await wait(60);

  const visits = await api('/api/visits?limit=50');
  check('visits are stored, junk URLs dropped', () => {
    assert.equal(visits.body.visits.length, 2);
    assert.equal(visits.body.visits.some((v) => v.url === 'not-a-url'), false);
  });
  check('a visit to a blocked subdomain is marked blocked', () => {
    const hit = visits.body.visits.find((v) => v.host === 'sub.example.com');
    assert.equal(hit.blocked, true);
    const clean = visits.body.visits.find((v) => v.host === 'news.ycombinator.com');
    assert.equal(clean.blocked, false);
  });
  check('the dashboard received the visits live', () => {
    const live = ui.bus.messages.filter((m) => m.type === 'visit');
    assert.equal(live.length, 2);
  });

  const stats = await api('/api/stats');
  check('stats count hosts and blocks', () => {
    assert.equal(stats.body.stats.total, 2);
    assert.equal(stats.body.stats.blocked, 1);
    assert.equal(stats.body.stats.uniqueHosts, 2);
  });

  const search = await api('/api/visits?q=ycombinator');
  check('visits can be searched', () => assert.equal(search.body.visits.length, 1));

  // --- toggles ------------------------------------------------------------
  await api('/api/blocking', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  const off = await waitFor(agent.bus, (m) => m.type === 'policy' && !m.policy.blockingEnabled, 'blocking off');
  check('the master switch reaches the agent', () => assert.equal(off.policy.blockingEnabled, false));

  const ruleId = added.body.policy.rules[0].id;
  await api(`/api/blocklist/${ruleId}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
  const paused = await waitFor(
    agent.bus,
    (m) => m.type === 'policy' && m.policy.rules.length === 0,
    'paused rule removed from the pushed policy'
  );
  check('a paused rule is not pushed to agents', () => assert.equal(paused.policy.rules.length, 0));

  const removed = await api(`/api/blocklist/${ruleId}`, { method: 'DELETE' });
  check('a rule can be deleted', () => assert.equal(removed.body.policy.rules.length, 0));
  const missing = await api('/api/blocklist/nope', { method: 'DELETE' });
  check('deleting an unknown rule is a 404', () => assert.equal(missing.status, 404));

  // --- commands + persistence --------------------------------------------
  const command = await api('/api/commands', { method: 'POST', body: JSON.stringify({ target: 'all', name: 'resync' }) });
  check('commands reach connected agents', () => assert.equal(command.body.sent, 1));
  await waitFor(agent.bus, (m) => m.type === 'command' && m.name === 'resync', 'resync command');

  check('the visit log is on disk', () => {
    const lines = fs.readFileSync(path.join(dataDir, 'visits.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).host, 'news.ycombinator.com');
  });

  // --- settings password --------------------------------------------------
  const shortPassword = await api('/api/settings-password', {
    method: 'POST',
    body: JSON.stringify({ password: 'abc' }),
  });
  check('a too-short settings password is refused', () => {
    assert.equal(shortPassword.status, 400);
    assert.match(shortPassword.body.error, /at least 6/);
  });

  const noPassword = await api('/api/settings-password', { method: 'DELETE' });
  check('clearing an unset settings password is a 404', () => assert.equal(noPassword.status, 404));

  const setPassword = await api('/api/settings-password', {
    method: 'POST',
    body: JSON.stringify({ password: 'let me in please' }),
  });
  check('setting the password reports it set, without the verifier', () => {
    assert.equal(setPassword.status, 200);
    assert.equal(setPassword.body.policy.lock.passwordSet, true);
    assert.equal(setPassword.body.policy.lock.hash, undefined);
    assert.equal(setPassword.body.policy.lock.salt, undefined);
  });

  const withLock = await waitFor(agent.bus, (m) => m.type === 'policy' && m.policy.lock, 'lock push');
  check('the agent is pushed a verifier it can check offline', () => {
    assert.match(withLock.policy.lock.salt, /^[0-9a-f]{32}$/);
    assert.match(withLock.policy.lock.hash, /^[0-9a-f]{64}$/);
    assert.ok(withLock.policy.lock.iterations >= 100000);
  });

  const uiPolicy = ui.bus.messages.filter((m) => m.type === 'policy').pop();
  check('the dashboard is never sent the verifier', () => {
    assert.equal(uiPolicy.policy.lock.passwordSet, true);
    assert.equal(uiPolicy.policy.lock.hash, undefined);
  });
  const stateWithLock = await api('/api/state');
  check('the REST view is never sent the verifier', () => {
    assert.equal(stateWithLock.body.policy.lock.passwordSet, true);
    assert.equal(JSON.stringify(stateWithLock.body).includes('"hash"'), false);
  });

  const cleared = await api('/api/settings-password', { method: 'DELETE' });
  check('clearing the password removes it', () => assert.equal(cleared.body.policy.lock.passwordSet, false));
  const withoutLock = await waitFor(
    agent.bus,
    (m) => m.type === 'policy' && m.policy.lock === null,
    'lock removal push'
  );
  check('agents are told the password is gone', () => assert.equal(withoutLock.policy.lock, null));

  // --- rude clients -------------------------------------------------------
  const rude = await connect(`ws://127.0.0.1:${port}/ws?role=ui&token=${token}`);
  await waitFor(rude.bus, (m) => m.type === 'snapshot', 'snapshot for the rude client');
  // A reload or a killed tab resets the connection without a close frame.
  if (rude.client.socket.resetAndDestroy) rude.client.socket.resetAndDestroy();
  else rude.client.socket.destroy();
  await wait(150);
  const alive = await api('/api/health', {}, false);
  check('a connection reset does not take the controller down', () => assert.equal(alive.status, 200));

  // --- disconnect ---------------------------------------------------------
  agent.client.close();
  await waitFor(ui.bus, (m) => m.type === 'agents' && m.agents.length === 0, 'agent removal');
  check('a disconnected agent leaves the list', () => {
    const list = ui.bus.messages.filter((m) => m.type === 'agents').pop();
    assert.equal(list.agents.length, 0);
  });

  ui.client.close();
  server.close();
  await wait(50);

  console.log(`\n${passes} passed, ${failures} failed`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
});
