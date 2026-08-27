'use strict';
// Durable state for the controller: auth token, block policy, visit log.
// Everything lives in plain files under data/ so it survives a restart and
// stays readable without the UI.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MEMORY_VISITS = 5000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// "https://www.Example.com/a?b" -> "example.com"; "*.example.com" -> "example.com".
// Returns null when nothing host-shaped can be recovered.
function normalizeHost(input) {
  let value = String(input || '').trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split('/')[0].split('?')[0].split('#')[0];
  value = value.replace(/^\*\./, '').replace(/^www\./, '');
  value = value.split('@').pop();
  value = value.replace(/:\d+$/, '');
  if (!value || !/^[a-z0-9.-]+$/.test(value)) return null;
  if (!value.includes('.') && value !== 'localhost') return null;
  if (value.startsWith('.') || value.endsWith('.')) return null;
  return value;
}

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.configFile = path.join(this.dir, 'config.json');
    this.policyFile = path.join(this.dir, 'policy.json');
    this.visitsFile = path.join(this.dir, 'visits.jsonl');

    this.config = readJson(this.configFile, null);
    if (!this.config || !this.config.token) {
      this.config = { token: crypto.randomBytes(24).toString('hex'), createdAt: Date.now() };
      writeJson(this.configFile, this.config);
    }

    this.policy = readJson(this.policyFile, null);
    if (!this.policy) {
      this.policy = { version: 1, blockingEnabled: true, rules: [], updatedAt: Date.now() };
      writeJson(this.policyFile, this.policy);
    }

    this.visits = this._loadRecentVisits();
  }

  get token() {
    return this.config.token;
  }

  _loadRecentVisits() {
    try {
      const lines = fs.readFileSync(this.visitsFile, 'utf8').split('\n');
      const tail = lines.slice(-MEMORY_VISITS);
      const out = [];
      for (const line of tail) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          /* skip a torn line */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  // --- policy -------------------------------------------------------------

  getPolicy() {
    return {
      version: this.policy.version,
      blockingEnabled: this.policy.blockingEnabled,
      rules: this.policy.rules.filter((r) => r.enabled).map((r) => ({ host: r.host })),
    };
  }

  getPolicyDetail() {
    return { ...this.policy, rules: this.policy.rules.slice() };
  }

  _bumpPolicy() {
    this.policy.version += 1;
    this.policy.updatedAt = Date.now();
    writeJson(this.policyFile, this.policy);
    return this.getPolicyDetail();
  }

  setBlockingEnabled(enabled) {
    this.policy.blockingEnabled = Boolean(enabled);
    return this._bumpPolicy();
  }

  addRule(pattern, note = '') {
    const host = normalizeHost(pattern);
    if (!host) throw Object.assign(new Error(`not a usable host: ${pattern}`), { status: 400 });
    if (this.policy.rules.some((r) => r.host === host)) {
      throw Object.assign(new Error(`${host} is already blocked`), { status: 409 });
    }
    this.policy.rules.push({
      id: crypto.randomUUID(),
      host,
      note: String(note || '').slice(0, 200),
      enabled: true,
      createdAt: Date.now(),
    });
    this.policy.rules.sort((a, b) => a.host.localeCompare(b.host));
    return this._bumpPolicy();
  }

  removeRule(id) {
    const before = this.policy.rules.length;
    this.policy.rules = this.policy.rules.filter((r) => r.id !== id && r.host !== id);
    if (this.policy.rules.length === before) {
      throw Object.assign(new Error(`no such rule: ${id}`), { status: 404 });
    }
    return this._bumpPolicy();
  }

  setRuleEnabled(id, enabled) {
    const rule = this.policy.rules.find((r) => r.id === id || r.host === id);
    if (!rule) throw Object.assign(new Error(`no such rule: ${id}`), { status: 404 });
    rule.enabled = Boolean(enabled);
    return this._bumpPolicy();
  }

  isBlocked(host) {
    if (!this.policy.blockingEnabled) return false;
    const target = normalizeHost(host);
    if (!target) return false;
    return this.policy.rules.some(
      (r) => r.enabled && (target === r.host || target.endsWith(`.${r.host}`))
    );
  }

  // --- visits -------------------------------------------------------------

  recordVisit(agentId, item) {
    const url = String(item.url || '').slice(0, 2000);
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
    const record = {
      id: crypto.randomUUID(),
      agentId,
      url,
      host,
      title: String(item.title || '').slice(0, 300),
      transition: String(item.transition || '').slice(0, 40),
      blocked: Boolean(item.blocked),
      visitedAt: Number(item.ts) || Date.now(),
      receivedAt: Date.now(),
    };
    this.visits.push(record);
    if (this.visits.length > MEMORY_VISITS) this.visits.splice(0, this.visits.length - MEMORY_VISITS);
    fs.appendFile(this.visitsFile, `${JSON.stringify(record)}\n`, () => {});
    return record;
  }

  queryVisits({ limit = 200, agentId = null, q = '', since = 0 } = {}) {
    const needle = String(q || '').toLowerCase();
    const out = [];
    for (let i = this.visits.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const v = this.visits[i];
      if (agentId && v.agentId !== agentId) continue;
      if (since && v.visitedAt < since) continue;
      if (needle && !`${v.host} ${v.title} ${v.url}`.toLowerCase().includes(needle)) continue;
      out.push(v);
    }
    return out;
  }

  stats({ since = 0 } = {}) {
    const byHost = new Map();
    let total = 0;
    let blocked = 0;
    for (const v of this.visits) {
      if (since && v.visitedAt < since) continue;
      total += 1;
      if (v.blocked) blocked += 1;
      const entry = byHost.get(v.host) || { host: v.host, count: 0, blocked: 0, lastAt: 0 };
      entry.count += 1;
      if (v.blocked) entry.blocked += 1;
      entry.lastAt = Math.max(entry.lastAt, v.visitedAt);
      byHost.set(v.host, entry);
    }
    const topHosts = [...byHost.values()].sort((a, b) => b.count - a.count).slice(0, 25);
    return { total, blocked, uniqueHosts: byHost.size, topHosts };
  }

  clearVisits() {
    this.visits = [];
    try {
      fs.writeFileSync(this.visitsFile, '');
    } catch {
      /* nothing to truncate */
    }
  }
}

module.exports = { Store, normalizeHost };
