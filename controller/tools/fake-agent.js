#!/usr/bin/env node
'use strict';
// A stand-in for the Chrome extension: connects as an agent, applies whatever
// policy arrives, and reports made-up visits. Handy for driving the dashboard
// without loading the extension.
//
//   node tools/fake-agent.js [--url ws://127.0.0.1:8787/ws] [--token X] [--interval 4000]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('./wsclient');

const SITES = [
  ['news.ycombinator.com', '/', 'Hacker News'],
  ['github.com', '/anthropics', 'anthropics · GitHub'],
  ['developer.chrome.com', '/docs/extensions/reference/api/declarativeNetRequest', 'chrome.declarativeNetRequest'],
  ['stackoverflow.com', '/questions/tagged/chrome-extension', 'Newest questions'],
  ['www.youtube.com', '/watch?v=dQw4w9WgXcQ', 'YouTube'],
  ['reddit.com', '/r/programming', 'r/programming'],
  ['en.wikipedia.org', '/wiki/WebSocket', 'WebSocket - Wikipedia'],
  ['mail.google.com', '/mail/u/0/', 'Inbox'],
];

function parseArgs(argv) {
  const opts = { url: 'ws://127.0.0.1:8787/ws', token: '', interval: 4000, name: 'Fake Chrome (test agent)' };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--url') { opts.url = value; i += 1; }
    else if (flag === '--token') { opts.token = value; i += 1; }
    else if (flag === '--interval') { opts.interval = Number(value); i += 1; }
    else if (flag === '--name') { opts.name = value; i += 1; }
  }
  if (!opts.token) {
    const configFile = path.join(__dirname, '..', 'data', 'config.json');
    try {
      opts.token = JSON.parse(fs.readFileSync(configFile, 'utf8')).token;
    } catch {
      console.error(`no --token given and ${configFile} is unreadable`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const url = new URL(opts.url);
url.searchParams.set('role', 'agent');
url.searchParams.set('token', opts.token);

let blockedHosts = [];
const client = new Client(url.toString());

client.on('open', () => {
  console.log(`connected to ${url.origin}${url.pathname}`);
  client.send({
    type: 'hello',
    agentId: crypto.randomUUID(),
    name: opts.name,
    browser: 'chrome (simulated)',
    version: '1.0.0',
  });
  setInterval(sendVisit, opts.interval).unref?.();
  setTimeout(sendVisit, 500);
});

client.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'welcome' || msg.type === 'policy') {
    blockedHosts = (msg.policy.rules || []).map((r) => r.host);
    const on = msg.policy.blockingEnabled;
    const lock = msg.policy.lock ? `settings password set (${msg.policy.lock.iterations} rounds)` : 'no settings password';
    console.log(
      `policy v${msg.policy.version}: blocking ${on ? 'on' : 'off'}, ` +
        `${blockedHosts.length} host(s), ${lock}`
    );
    client.send({
      type: 'status',
      policyVersion: msg.policy.version,
      appliedRules: on ? blockedHosts.length : 0,
      name: opts.name,
    });
  }
  if (msg.type === 'command') console.log(`command: ${msg.name}`);
});

client.on('error', (err) => {
  console.error(`socket error: ${err.message}`);
  process.exit(1);
});
client.on('close', () => {
  console.log('disconnected');
  process.exit(0);
});

function sendVisit() {
  const [host, pathPart, title] = SITES[Math.floor(Math.random() * SITES.length)];
  const blocked = blockedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  const visit = {
    url: `https://${host}${pathPart}`,
    title,
    ts: Date.now(),
    transition: blocked ? 'blocked' : 'link',
    blocked,
  };
  client.send({ type: 'visits', items: [visit] });
  console.log(`${blocked ? 'BLOCKED' : 'visit  '} ${visit.url}`);
}

process.on('SIGINT', () => {
  client.close();
  process.exit(0);
});

client.connect();
