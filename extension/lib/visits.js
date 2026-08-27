// Captures top-level navigations and buffers them until the controller is
// reachable. The queue lives in storage so a service-worker restart or an
// offline controller never loses what the browser did in the meantime.

import { getSettings, getStatus, hostOf, hostMatches, patchStatus } from './config.js';
import { isBlockedUrl } from './blocking.js';

const QUEUE_KEY = 'visitQueue';
const MAX_QUEUE = 500;
const DEDUPE_MS = 3000;

const recent = new Map(); // `${tabId}|${url}` -> timestamp

export function isReportableUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

function seenRecently(key) {
  const now = Date.now();
  for (const [k, ts] of recent) if (now - ts > DEDUPE_MS * 4) recent.delete(k);
  const last = recent.get(key);
  recent.set(key, now);
  return last !== undefined && now - last < DEDUPE_MS;
}

async function titleFor(tabId, url) {
  const pick = (tab) => (tab && tab.title && tab.title !== tab.url ? tab.title : '');
  try {
    const first = pick(await chrome.tabs.get(tabId));
    if (first) return first;
  } catch {
    return '';
  }
  // Right after commit the tab often still carries the old document's title.
  await new Promise((resolve) => setTimeout(resolve, 700));
  try {
    return pick(await chrome.tabs.get(tabId));
  } catch {
    return '';
  }
}

// Build a visit record and queue it. Returns the record, or null if skipped.
export async function recordNavigation({ tabId, url, transitionType, blocked = false }) {
  if (!isReportableUrl(url)) return null;
  const settings = await getSettings();
  if (!settings.reporting) return null;

  const host = hostOf(url);
  if (hostMatches(host, settings.ignoredHosts)) return null;
  if (seenRecently(`${tabId}|${url}`)) return null;

  const isBlocked = blocked || (await isBlockedUrl(url));
  const visit = {
    url,
    host,
    ts: Date.now(),
    transition: transitionType || '',
    blocked: isBlocked,
    // A blocked navigation never renders, so the tab still shows the previous
    // page's title — reporting it would be wrong.
    title: !isBlocked && tabId >= 0 ? await titleFor(tabId, url) : '',
  };
  await enqueue(visit);
  if (isBlocked) {
    const status = await getStatus();
    await patchStatus({ blockedHits: (status.blockedHits || 0) + 1 });
  }
  return visit;
}

export async function enqueue(visit) {
  const queue = await getQueue();
  queue.push(visit);
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
  await patchStatus({ queued: queue.length });
}

export async function getQueue() {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  return stored[QUEUE_KEY] || [];
}

// send(items) must return true when the controller accepted the batch.
export async function flush(send) {
  const queue = await getQueue();
  if (!queue.length) return 0;
  const batch = queue.slice(0, 200);
  const ok = await send(batch);
  if (!ok) return 0;
  const rest = (await getQueue()).slice(batch.length);
  await chrome.storage.local.set({ [QUEUE_KEY]: rest });
  const status = await getStatus();
  await patchStatus({ queued: rest.length, sentVisits: (status.sentVisits || 0) + batch.length });
  return batch.length;
}

export async function clearQueue() {
  await chrome.storage.local.set({ [QUEUE_KEY]: [] });
  await patchStatus({ queued: 0 });
}
