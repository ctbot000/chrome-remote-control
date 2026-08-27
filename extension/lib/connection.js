// The link to the controller: one WebSocket, reconnected with backoff, kept
// alive with an application-level ping (WebSocket traffic also keeps the MV3
// service worker from being torn down between navigations).

import { getSettings, getStatus, buildSocketUrl, patchStatus } from './config.js';
import { applyPolicy, clearRules } from './blocking.js';
import { flush, getQueue } from './visits.js';

const POLICY_KEY = 'policy';
const KEEPALIVE_MS = 20000;
const MAX_BACKOFF_MS = 30000;

let socket = null;
let keepalive = null;
let reconnectTimer = null;
let attempt = 0;
let inflight = null;

export function isOpen() {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

export async function getCachedPolicy() {
  const stored = await chrome.storage.local.get(POLICY_KEY);
  return stored[POLICY_KEY] || { version: 0, blockingEnabled: false, rules: [] };
}

// Serialized: several events can wake the worker at once, and each one wants
// the link up. Without this they would race and open duplicate sockets.
export function connect(options = {}) {
  if (inflight) return inflight;
  inflight = openSocket(options).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function openSocket({ force = false } = {}) {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) && !force) return;
  if (socket) teardown();

  const settings = await getSettings();
  if (!settings.token) {
    await patchStatus({ connected: false, connecting: false, lastError: 'no controller token set' });
    return;
  }

  let url;
  try {
    url = buildSocketUrl(settings);
  } catch (err) {
    await patchStatus({ connected: false, connecting: false, lastError: err.message });
    return;
  }

  await patchStatus({ connecting: true, lastError: '' });

  let ws;
  try {
    ws = new WebSocket(url);
    socket = ws;
  } catch (err) {
    await patchStatus({ connecting: false, lastError: String(err.message || err) });
    scheduleReconnect();
    return;
  }

  const current = () => socket === ws; // ignore events from a socket we replaced

  ws.addEventListener('open', async () => {
    if (!current()) return;
    attempt = 0;
    const live = await getSettings();
    send({
      type: 'hello',
      agentId: live.agentId,
      name: live.deviceName,
      browser: navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome',
      version: chrome.runtime.getManifest().version,
    });
    await patchStatus({ connected: true, connecting: false, lastConnectedAt: Date.now(), lastError: '' });
    startKeepalive();
    await pushQueue();
  });

  ws.addEventListener('message', (event) => {
    if (!current()) return;
    handleMessage(event.data).catch((err) => patchStatus({ lastError: String(err.message || err) }));
  });

  ws.addEventListener('close', async (event) => {
    if (!current()) return;
    teardown();
    await patchStatus({
      connected: false,
      connecting: false,
      lastError: event.code === 1000 || event.code === 1005 ? '' : `disconnected (${event.code})`,
    });
    scheduleReconnect();
  });

  ws.addEventListener('error', async () => {
    if (!current()) return;
    await patchStatus({ lastError: 'could not reach the controller' });
  });
}

export function disconnect() {
  if (socket) {
    try {
      socket.close(1000, 'client disconnect');
    } catch {
      /* already gone */
    }
  }
  teardown();
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  return patchStatus({ connected: false, connecting: false });
}

function teardown() {
  clearInterval(keepalive);
  keepalive = null;
  const dying = socket;
  socket = null;
  if (dying && dying.readyState <= WebSocket.OPEN) {
    try {
      dying.close(1000, 'replaced');
    } catch {
      /* already closing */
    }
  }
}

function startKeepalive() {
  clearInterval(keepalive);
  keepalive = setInterval(() => {
    if (!isOpen()) {
      clearInterval(keepalive);
      return;
    }
    send({ type: 'ping' });
  }, KEEPALIVE_MS);
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  attempt = Math.min(attempt + 1, 6);
  const delay = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  reconnectTimer = setTimeout(() => connect(), delay);
}

function send(message) {
  if (!isOpen()) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'welcome':
    case 'policy':
      await adoptPolicy(msg.policy);
      break;
    case 'command':
      if (msg.name === 'resync') await adoptPolicy(await getCachedPolicy());
      if (msg.name === 'flush') await pushQueue();
      break;
    case 'visits-ack':
    case 'pong':
      break;
    default:
      break;
  }
}

// Store the policy, turn it into blocking rules, and report the result back.
export async function adoptPolicy(policy) {
  if (!policy) return;
  await chrome.storage.local.set({ [POLICY_KEY]: policy });
  const settings = await getSettings();
  try {
    const { appliedRules, hosts } = await applyPolicy(policy, settings);
    await patchStatus({
      policyVersion: policy.version,
      appliedRules: hosts.length,
      blockingEnabled: Boolean(policy.blockingEnabled && settings.enforcing),
      lastError: '',
    });
    send({
      type: 'status',
      policyVersion: policy.version,
      appliedRules: hosts.length,
      name: settings.deviceName,
      rulesInEngine: appliedRules,
    });
  } catch (err) {
    const message = String(err.message || err);
    await patchStatus({ lastError: message });
    send({ type: 'status', policyVersion: policy.version, error: message });
  }
}

// Re-apply whatever policy we last saw. Used on browser start and on settings
// changes, so enforcement does not depend on the controller being up.
export async function reapplyCachedPolicy() {
  const settings = await getSettings();
  const policy = await getCachedPolicy();
  if (!settings.enforcing) {
    await clearRules();
    await patchStatus({ appliedRules: 0, blockingEnabled: false });
    return;
  }
  const { hosts } = await applyPolicy(policy, settings);
  await patchStatus({
    appliedRules: hosts.length,
    policyVersion: policy.version,
    blockingEnabled: Boolean(policy.blockingEnabled && settings.enforcing),
  });
}

export async function pushQueue() {
  if (!isOpen()) return 0;
  return flush(async (items) => send({ type: 'visits', items }));
}

export async function connectionSummary() {
  const [settings, status, queue] = await Promise.all([getSettings(), getStatus(), getQueue()]);
  return { settings, status: { ...status, queued: queue.length }, open: isOpen() };
}
