'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./store');
const { Hub } = require('./hub');
const ws = require('./wsserver');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function tokenFrom(req, url) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-controller-token'];
  if (header) return String(header);
  return url.searchParams.get('token') || '';
}

function createServer({ dataDir, name = 'chrome-remote-control' }) {
  const store = new Store(dataDir);
  const hub = new Hub(store);

  const authed = (req, url) => tokenFrom(req, url) === store.token;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type,x-controller-token',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    try {
      if (route === '/api/health') {
        json(res, 200, { ok: true, name, agents: hub.agents.size, time: Date.now() });
        return;
      }

      if (route.startsWith('/api/')) {
        if (!authed(req, url)) {
          json(res, 401, { error: 'bad or missing token' });
          return;
        }
        await handleApi(req, res, url, route, { store, hub });
        return;
      }

      serveStatic(res, route);
    } catch (err) {
      json(res, err.status || 500, { error: err.message || 'internal error' });
    }
  });

  ws.attach(server, {
    verify: (req) => {
      const url = new URL(req.url, 'http://localhost');
      return url.pathname === '/ws' && tokenFrom(req, url) === store.token;
    },
    onConnection: (conn, req) => {
      const url = new URL(req.url, 'http://localhost');
      const role = url.searchParams.get('role') === 'agent' ? 'agent' : 'ui';
      if (role === 'ui') {
        hub.addUi(conn);
        conn.on('close', () => hub.removeUi(conn));
        conn.on('error', () => hub.removeUi(conn));
        return;
      }
      wireAgent(conn, { hub, store });
    },
  });

  return { server, store, hub };
}

function wireAgent(conn, { hub, store }) {
  let agent = null;
  conn.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!agent) {
      if (msg.type !== 'hello') return; // first word must be hello
      agent = hub.addAgent(conn, msg);
      return;
    }
    agent.lastSeen = Date.now();

    switch (msg.type) {
      case 'visits': {
        const items = Array.isArray(msg.items) ? msg.items.slice(0, 500) : [];
        for (const item of items) {
          const record = store.recordVisit(agent.agentId, {
            // The browser reports what it actually did; only decide for it when
            // the agent left the field out.
            ...item,
            blocked: item.blocked ?? store.isBlocked(item.url),
          });
          if (!record) continue;
          agent.visitCount += 1;
          hub.publish({ type: 'visit', visit: record });
        }
        if (items.length) hub.publish({ type: 'stats', stats: store.stats() });
        conn.send({ type: 'visits-ack', count: items.length });
        break;
      }
      case 'status':
        agent.policyVersion = msg.policyVersion ?? agent.policyVersion;
        agent.appliedRules = msg.appliedRules ?? agent.appliedRules;
        agent.lastError = msg.error || null;
        if (msg.name) agent.name = String(msg.name).slice(0, 80);
        hub.publishAgents();
        break;
      case 'ping':
        conn.send({ type: 'pong', time: Date.now() });
        break;
      default:
        break;
    }
  });
  conn.on('pong', () => {
    if (agent) agent.lastSeen = Date.now();
  });
  conn.on('close', () => {
    if (agent) hub.removeAgent(agent.connId);
  });
  conn.on('error', () => {});
}

async function handleApi(req, res, url, route, { store, hub }) {
  const method = req.method;

  if (route === '/api/state' && method === 'GET') {
    json(res, 200, {
      agents: hub.agentList(),
      policy: store.getPolicyDetail(),
      visits: store.queryVisits({ limit: Number(url.searchParams.get('limit')) || 200 }),
      stats: store.stats(),
    });
    return;
  }

  if (route === '/api/agents' && method === 'GET') {
    json(res, 200, { agents: hub.agentList() });
    return;
  }

  if (route === '/api/visits' && method === 'GET') {
    json(res, 200, {
      visits: store.queryVisits({
        limit: Math.min(Number(url.searchParams.get('limit')) || 200, 2000),
        agentId: url.searchParams.get('agentId'),
        q: url.searchParams.get('q') || '',
        since: Number(url.searchParams.get('since')) || 0,
      }),
    });
    return;
  }

  if (route === '/api/visits' && method === 'DELETE') {
    store.clearVisits();
    hub.publish({ type: 'visits-cleared' });
    hub.publish({ type: 'stats', stats: store.stats() });
    json(res, 200, { ok: true });
    return;
  }

  if (route === '/api/stats' && method === 'GET') {
    json(res, 200, { stats: store.stats({ since: Number(url.searchParams.get('since')) || 0 }) });
    return;
  }

  if (route === '/api/blocklist' && method === 'GET') {
    json(res, 200, { policy: store.getPolicyDetail() });
    return;
  }

  if (route === '/api/blocklist' && method === 'POST') {
    const body = await readBody(req);
    const hosts = Array.isArray(body.hosts) ? body.hosts : [body.host];
    const added = [];
    const skipped = [];
    for (const host of hosts) {
      try {
        store.addRule(host, body.note);
        added.push(host);
      } catch (err) {
        skipped.push({ host, reason: err.message });
      }
    }
    if (added.length) hub.policyChanged();
    json(res, added.length ? 200 : 400, { added, skipped, policy: store.getPolicyDetail() });
    return;
  }

  if (route.startsWith('/api/blocklist/')) {
    const id = decodeURIComponent(route.slice('/api/blocklist/'.length));
    if (method === 'DELETE') {
      store.removeRule(id);
      hub.policyChanged();
      json(res, 200, { policy: store.getPolicyDetail() });
      return;
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      store.setRuleEnabled(id, body.enabled);
      hub.policyChanged();
      json(res, 200, { policy: store.getPolicyDetail() });
      return;
    }
  }

  if (route === '/api/blocking' && method === 'POST') {
    const body = await readBody(req);
    store.setBlockingEnabled(body.enabled);
    hub.policyChanged();
    json(res, 200, { policy: store.getPolicyDetail() });
    return;
  }

  if (route === '/api/commands' && method === 'POST') {
    const body = await readBody(req);
    const sent = hub.sendCommand(body.target || 'all', {
      name: String(body.name || 'resync'),
      at: Date.now(),
    });
    json(res, 200, { sent });
    return;
  }

  json(res, 404, { error: `no route for ${method} ${route}` });
}

function serveStatic(res, route) {
  const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

module.exports = { createServer };
