'use strict';
// Tracks live WebSocket peers: browser extensions ("agents") and dashboards
// ("ui"), and fans messages out between them.

const crypto = require('node:crypto');

const HEARTBEAT_MS = 20000;
const AGENT_TIMEOUT_MS = 65000;

class Hub {
  constructor(store) {
    this.store = store;
    this.agents = new Map(); // connId -> agent record
    this.uis = new Set();
    this.timer = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  // --- agents -------------------------------------------------------------

  addAgent(conn, hello) {
    const connId = crypto.randomUUID();
    const agent = {
      connId,
      conn,
      agentId: String(hello.agentId || connId).slice(0, 64),
      name: String(hello.name || 'unnamed browser').slice(0, 80),
      browser: String(hello.browser || 'chrome').slice(0, 80),
      extensionVersion: String(hello.version || '?').slice(0, 20),
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      visitCount: 0,
      policyVersion: null,
      appliedRules: null,
      lastError: null,
    };
    this.agents.set(connId, agent);
    conn.send({
      type: 'welcome',
      connId,
      serverTime: Date.now(),
      policy: this.store.getPolicy(),
    });
    this.publishAgents();
    return agent;
  }

  removeAgent(connId) {
    if (this.agents.delete(connId)) this.publishAgents();
  }

  agentList() {
    return [...this.agents.values()].map((a) => ({
      connId: a.connId,
      agentId: a.agentId,
      name: a.name,
      browser: a.browser,
      extensionVersion: a.extensionVersion,
      connectedAt: a.connectedAt,
      lastSeen: a.lastSeen,
      visitCount: a.visitCount,
      policyVersion: a.policyVersion,
      appliedRules: a.appliedRules,
      lastError: a.lastError,
    }));
  }

  sendPolicyToAgents() {
    const policy = this.store.getPolicy();
    for (const agent of this.agents.values()) {
      agent.conn.send({ type: 'policy', policy });
    }
  }

  sendCommand(target, command) {
    let sent = 0;
    for (const agent of this.agents.values()) {
      if (target && target !== 'all' && agent.connId !== target && agent.agentId !== target) continue;
      agent.conn.send({ type: 'command', ...command });
      sent += 1;
    }
    return sent;
  }

  // --- dashboards ---------------------------------------------------------

  addUi(conn) {
    this.uis.add(conn);
    conn.send({
      type: 'snapshot',
      agents: this.agentList(),
      policy: this.store.getPolicyDetail(),
      visits: this.store.queryVisits({ limit: 200 }),
      stats: this.store.stats(),
    });
  }

  removeUi(conn) {
    this.uis.delete(conn);
  }

  publish(message) {
    for (const ui of this.uis) ui.send(message);
  }

  publishAgents() {
    this.publish({ type: 'agents', agents: this.agentList() });
  }

  publishPolicy() {
    this.publish({ type: 'policy', policy: this.store.getPolicyDetail() });
  }

  // Policy changed on the controller: push to every browser, tell every dashboard.
  policyChanged() {
    this.sendPolicyToAgents();
    this.publishPolicy();
  }

  _heartbeat() {
    const now = Date.now();
    for (const agent of this.agents.values()) {
      if (now - agent.lastSeen > AGENT_TIMEOUT_MS) {
        agent.conn.close(1001, 'heartbeat timeout');
        this.agents.delete(agent.connId);
        continue;
      }
      agent.conn.ping();
    }
    for (const ui of this.uis) ui.ping();
    this.publishAgents();
  }
}

module.exports = { Hub };
