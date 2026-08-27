// Turns the controller's policy into declarativeNetRequest dynamic rules.
// Two rules per host: top-level navigations are redirected to an explanation
// page, everything else (images, xhr, frames, …) is dropped outright.

import { hostMatches } from './config.js';

const MAX_HOSTS = 1000;
const HOSTS_KEY = 'blockedHosts';

function dedupe(list) {
  return [...new Set(list.filter(Boolean).map((h) => String(h).toLowerCase()))];
}

export async function applyPolicy(policy, settings) {
  const enforcing = Boolean(settings.enforcing && policy?.blockingEnabled);
  let controllerHost = '';
  try {
    controllerHost = new URL(settings.controllerUrl).hostname;
  } catch {
    /* an unparseable URL simply protects nothing */
  }

  const hosts = enforcing
    ? dedupe((policy.rules || []).map((r) => r.host))
        .filter((h) => h !== controllerHost)
        .filter((h) => !hostMatches(h, settings.ignoredHosts))
        .slice(0, MAX_HOSTS)
    : [];

  const blockedPage = chrome.runtime.getURL('blocked.html');
  const addRules = [];
  hosts.forEach((host, index) => {
    const id = index * 2 + 1;
    addRules.push({
      id,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: { url: `${blockedPage}?host=${encodeURIComponent(host)}` },
      },
      condition: { requestDomains: [host], resourceTypes: ['main_frame'] },
    });
    addRules.push({
      id: id + 1,
      priority: 1,
      action: { type: 'block' },
      condition: { requestDomains: [host], excludedResourceTypes: ['main_frame'] },
    });
  });

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules,
  });

  await chrome.storage.local.set({ [HOSTS_KEY]: hosts });
  await updateBadge(hosts.length, enforcing);
  return { hosts, appliedRules: addRules.length };
}

export async function getBlockedHosts() {
  const stored = await chrome.storage.local.get(HOSTS_KEY);
  return stored[HOSTS_KEY] || [];
}

export async function isBlockedUrl(url) {
  const hosts = await getBlockedHosts();
  if (!hosts.length) return false;
  try {
    return hostMatches(new URL(url).hostname.replace(/^www\./, ''), hosts);
  } catch {
    return false;
  }
}

export async function clearRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules: [],
    });
  }
  await chrome.storage.local.set({ [HOSTS_KEY]: [] });
}

async function updateBadge(count, enforcing) {
  try {
    await chrome.action.setBadgeText({ text: enforcing && count ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#d1373a' });
  } catch {
    /* badge is cosmetic */
  }
}
