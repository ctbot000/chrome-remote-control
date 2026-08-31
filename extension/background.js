// Service worker: watches navigation, keeps the controller link up, and answers
// the popup / options page. MV3 tears this worker down when idle, so every
// entry point re-establishes state instead of assuming it survived.

import { getSettings, setSettings, patchStatus } from './lib/config.js';
import { connect, disconnect, pushQueue, reapplyCachedPolicy, connectionSummary, isOpen } from './lib/connection.js';
import { recordNavigation, isReportableUrl, clearQueue } from './lib/visits.js';
import { isBlockedUrl } from './lib/blocking.js';
import { unlock, lockNow, requireUnlocked } from './lib/lock.js';

const ALARM = 'crc-heartbeat';

async function boot(reason) {
  await reapplyCachedPolicy();
  await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  await connect();
  console.log(`[crc] booted (${reason})`);
}

chrome.runtime.onInstalled.addListener(() => boot('installed'));
chrome.runtime.onStartup.addListener(() => boot('browser start'));

// A cold start of the worker (any event can trigger it) still needs the link.
boot('worker start').catch((err) => patchStatus({ lastError: String(err.message || err) }));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  if (!isOpen()) await connect();
  else await pushQueue();
});

// --- navigation capture ---------------------------------------------------

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0 || !isReportableUrl(details.url)) return;
  // Recorded here (rather than after the redirect) so the controller sees the
  // URL that was actually attempted.
  if (await isBlockedUrl(details.url)) {
    await recordNavigation({ ...details, transitionType: 'blocked', blocked: true });
    await pushQueue();
  }
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0 || !isReportableUrl(details.url)) return;
  await recordNavigation(details);
  await pushQueue();
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0 || !isReportableUrl(details.url)) return;
  await recordNavigation(details);
  await pushQueue();
});

// --- popup / options RPC --------------------------------------------------

// Anything that could weaken reporting or blocking goes through the lock the
// controller set. Reconnecting and re-applying the policy stay open: neither
// can turn the extension down.
const gated = (handler) => async (message) => {
  await requireUnlocked();
  return handler(message);
};

const handlers = {
  'get-summary': () => connectionSummary(),
  unlock: async ({ password }) => {
    await unlock(password);
    return connectionSummary();
  },
  lock: async () => {
    await lockNow();
    return connectionSummary();
  },
  'save-settings': gated(async ({ patch }) => {
    const before = await getSettings();
    const after = await setSettings(patch);
    await reapplyCachedPolicy();
    const linkChanged =
      before.controllerUrl !== after.controllerUrl || before.token !== after.token;
    if (linkChanged) {
      disconnect();
      await connect({ force: true });
    } else if (!isOpen()) {
      await connect();
    }
    return connectionSummary();
  }),
  reconnect: async () => {
    disconnect();
    await connect({ force: true });
    return connectionSummary();
  },
  disconnect: gated(async () => {
    await disconnect();
    return connectionSummary();
  }),
  'clear-queue': gated(async () => {
    await clearQueue();
    return connectionSummary();
  }),
  resync: async () => {
    await reapplyCachedPolicy();
    return connectionSummary();
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true; // response is async
});
