// Settings and runtime status, both kept in chrome.storage.local so the popup,
// the options page and the (restartable) service worker all see the same thing.

const SETTINGS_KEY = 'settings';
const STATUS_KEY = 'status';

export const DEFAULT_SETTINGS = {
  controllerUrl: 'ws://127.0.0.1:8787/ws',
  token: '',
  deviceName: '',
  reporting: true, // send visits to the controller
  enforcing: true, // apply the controller's blocklist
  ignoredHosts: [], // never reported, never blocked — set locally, e.g. your bank
  agentId: '',
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  if (!settings.agentId) {
    settings.agentId = crypto.randomUUID();
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }
  if (!settings.deviceName) settings.deviceName = defaultDeviceName();
  return settings;
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export const DEFAULT_STATUS = {
  connected: false,
  connecting: false,
  lastConnectedAt: 0,
  lastError: '',
  policyVersion: null,
  appliedRules: 0,
  blockingEnabled: false,
  queued: 0,
  sentVisits: 0,
  blockedHits: 0,
};

export async function getStatus() {
  const stored = await chrome.storage.local.get(STATUS_KEY);
  return { ...DEFAULT_STATUS, ...(stored[STATUS_KEY] || {}) };
}

export async function patchStatus(patch) {
  const next = { ...(await getStatus()), ...patch };
  await chrome.storage.local.set({ [STATUS_KEY]: next });
  return next;
}

function defaultDeviceName() {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const platform = nav?.userAgentData?.platform || nav?.platform || 'unknown';
  return `Chrome on ${platform}`;
}

// A ws:// or wss:// endpoint with the role and token attached.
export function buildSocketUrl(settings) {
  const url = new URL(settings.controllerUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (!/^wss?:$/.test(url.protocol)) throw new Error(`controller URL must be ws:// or wss:// (got ${url.protocol})`);
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  url.searchParams.set('role', 'agent');
  url.searchParams.set('token', settings.token);
  return url.toString();
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function hostMatches(host, patterns) {
  if (!host) return false;
  return patterns.some((raw) => {
    const pattern = String(raw || '').trim().toLowerCase().replace(/^\*\./, '').replace(/^www\./, '');
    if (!pattern) return false;
    return host === pattern || host.endsWith(`.${pattern}`);
  });
}
