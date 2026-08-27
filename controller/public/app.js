'use strict';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'crc.token';

const state = {
  token: '',
  socket: null,
  retry: 0,
  agents: [],
  policy: { rules: [], blockingEnabled: true, version: 0 },
  visits: [],
  stats: { total: 0, blocked: 0, uniqueHosts: 0, topHosts: [] },
  filter: '',
};

// --- token ----------------------------------------------------------------

function bootToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete('token');
    history.replaceState({}, '', url.pathname + url.search);
  }
  state.token = localStorage.getItem(TOKEN_KEY) || '';
  if (state.token) {
    $('token-gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    connect();
  } else {
    $('token-gate').classList.remove('hidden');
    $('app').classList.add('hidden');
  }
}

$('token-save').addEventListener('click', () => {
  const value = $('token-input').value.trim();
  if (!value) return;
  localStorage.setItem(TOKEN_KEY, value);
  location.reload();
});
$('token-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('token-save').click();
});
$('forget-token-btn').addEventListener('click', () => {
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
});

// --- transport ------------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?role=ui&token=${encodeURIComponent(state.token)}`;
  const socket = new WebSocket(url);
  state.socket = socket;
  setLink('connecting…', '');

  socket.addEventListener('open', () => {
    state.retry = 0;
    setLink('connected', 'on');
  });
  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    onMessage(msg);
  });
  socket.addEventListener('close', () => {
    setLink('disconnected — retrying', 'off');
    state.retry = Math.min(state.retry + 1, 6);
    setTimeout(connect, 500 * 2 ** (state.retry - 1));
  });
  socket.addEventListener('error', () => socket.close());
}

function onMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      state.agents = msg.agents || [];
      state.policy = msg.policy || state.policy;
      state.visits = msg.visits || [];
      state.stats = msg.stats || state.stats;
      renderAll();
      break;
    case 'agents':
      state.agents = msg.agents || [];
      renderAgents();
      renderStats();
      break;
    case 'policy':
      state.policy = msg.policy;
      renderPolicy();
      break;
    case 'visit':
      state.visits.unshift(msg.visit);
      if (state.visits.length > 500) state.visits.pop();
      renderFeed();
      break;
    case 'visits-cleared':
      state.visits = [];
      renderFeed();
      break;
    case 'stats':
      state.stats = msg.stats;
      renderStats();
      renderTops();
      break;
    default:
      break;
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${state.token}`,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

function setLink(text, cls) {
  $('link-text').textContent = text;
  $('link-dot').className = `dot ${cls}`;
}

// --- rendering ------------------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function renderAll() {
  renderAgents();
  renderPolicy();
  renderStats();
  renderTops();
  renderFeed();
}

function renderAgents() {
  const list = $('agents');
  list.replaceChildren();
  $('agents-count').textContent = String(state.agents.length);
  $('agents-empty').classList.toggle('hidden', state.agents.length > 0);
  for (const agent of state.agents) {
    const synced = agent.policyVersion === state.policy.version;
    list.append(
      el('li', {}, [
        el('span', { class: 'dot on' }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'ellipsis', text: agent.name }),
          el('div', {
            class: 'sub ellipsis',
            text: `${agent.browser} · v${agent.extensionVersion} · ${plural(agent.visitCount, 'visit')} · up ${ago(agent.connectedAt).replace(' ago', '')}`,
          }),
        ]),
        agent.lastError
          ? el('span', { class: 'pill bad', title: agent.lastError, text: 'error' })
          : el('span', {
              class: `pill ${synced ? 'ok' : 'warn'}`,
              title: `policy version ${agent.policyVersion ?? '?'} (controller is at ${state.policy.version})`,
              text: synced ? plural(agent.appliedRules ?? 0, 'rule') : 'syncing',
            }),
      ])
    );
  }
}

function renderPolicy() {
  $('blocking-toggle').checked = Boolean(state.policy.blockingEnabled);
  const rules = state.policy.rules || [];
  $('rules-count').textContent = String(rules.filter((r) => r.enabled).length);
  $('rules-empty').classList.toggle('hidden', rules.length > 0);
  const list = $('rules');
  list.replaceChildren();
  for (const rule of rules) {
    list.append(
      el('li', { class: rule.enabled ? '' : 'off' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'host ellipsis', text: rule.host }),
          rule.note ? el('div', { class: 'sub ellipsis', text: rule.note }) : null,
        ]),
        el('button', {
          class: 'iconbtn',
          title: rule.enabled ? 'Pause this rule' : 'Enable this rule',
          text: rule.enabled ? 'pause' : 'enable',
          onclick: () =>
            guard(
              api(`/api/blocklist/${encodeURIComponent(rule.id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ enabled: !rule.enabled }),
              })
            ),
        }),
        el('button', {
          class: 'iconbtn danger',
          title: 'Remove this rule',
          text: 'remove',
          onclick: () =>
            guard(api(`/api/blocklist/${encodeURIComponent(rule.id)}`, { method: 'DELETE' })),
        }),
      ])
    );
  }
  renderTops();
  renderFeed();
}

function renderStats() {
  $('stat-visits').textContent = String(state.stats.total ?? 0);
  $('stat-blocked').textContent = String(state.stats.blocked ?? 0);
  $('stat-hosts').textContent = String(state.stats.uniqueHosts ?? 0);
  $('stat-agents').textContent = String(state.agents.length);
}

function renderTops() {
  const list = $('tops');
  list.replaceChildren();
  const tops = (state.stats.topHosts || []).slice(0, 12);
  $('tops-empty').classList.toggle('hidden', tops.length > 0);
  const blockedHosts = new Set((state.policy.rules || []).filter((r) => r.enabled).map((r) => r.host));
  for (const top of tops) {
    const isBlocked = blockedHosts.has(top.host);
    list.append(
      el('li', {}, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'host ellipsis', text: top.host }),
          el('div', { class: 'sub', text: `${plural(top.count, 'visit')} · last ${ago(top.lastAt)}` }),
        ]),
        isBlocked
          ? el('span', { class: 'pill bad', text: 'blocked' })
          : el('button', {
              class: 'iconbtn',
              text: 'block',
              title: `Block ${top.host}`,
              onclick: () =>
                guard(api('/api/blocklist', { method: 'POST', body: JSON.stringify({ host: top.host }) })),
            }),
      ])
    );
  }
}

function renderFeed() {
  const list = $('feed');
  const blockedHosts = new Set((state.policy.rules || []).filter((r) => r.enabled).map((r) => r.host));
  const isBlocked = (host) =>
    [...blockedHosts].some((h) => host === h || host.endsWith(`.${h}`));
  const needle = state.filter.toLowerCase();
  const rows = state.visits.filter(
    (v) => !needle || `${v.host} ${v.title} ${v.url}`.toLowerCase().includes(needle)
  );
  list.replaceChildren();
  $('feed-empty').classList.toggle('hidden', rows.length > 0);
  for (const visit of rows.slice(0, 300)) {
    list.append(
      el('li', { class: visit.blocked ? 'blocked' : '' }, [
        el('span', { class: 'time', text: new Date(visit.visitedAt).toLocaleTimeString() }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'ellipsis' }, [
            el('span', { class: 'host', text: visit.host }),
            el('span', { class: 'muted', text: visit.title ? ` — ${visit.title}` : '' }),
          ]),
          el('div', { class: 'sub ellipsis', text: visit.url }),
        ]),
        visit.blocked ? el('span', { class: 'pill bad', text: 'blocked' }) : null,
        isBlocked(visit.host)
          ? null
          : el('button', {
              class: 'iconbtn',
              text: 'block',
              title: `Block ${visit.host}`,
              onclick: () =>
                guard(api('/api/blocklist', { method: 'POST', body: JSON.stringify({ host: visit.host }) })),
            }),
      ])
    );
  }
}

function guard(promise) {
  $('rule-error').textContent = '';
  return promise.catch((err) => {
    $('rule-error').textContent = err.message;
  });
}

// --- actions --------------------------------------------------------------

$('add-rule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const host = $('rule-host').value.trim();
  const note = $('rule-note').value.trim();
  if (!host) return;
  $('rule-error').textContent = '';
  try {
    const body = await api('/api/blocklist', { method: 'POST', body: JSON.stringify({ host, note }) });
    if (body.skipped?.length) $('rule-error').textContent = body.skipped[0].reason;
    if (body.added?.length) {
      $('rule-host').value = '';
      $('rule-note').value = '';
    }
  } catch (err) {
    $('rule-error').textContent = err.message;
  }
});

$('blocking-toggle').addEventListener('change', (event) => {
  guard(api('/api/blocking', { method: 'POST', body: JSON.stringify({ enabled: event.target.checked }) }));
});

$('resync-btn').addEventListener('click', () => {
  guard(api('/api/commands', { method: 'POST', body: JSON.stringify({ target: 'all', name: 'resync' }) }));
});

$('clear-visits').addEventListener('click', () => {
  if (!confirm('Delete the recorded visit log? This cannot be undone.')) return;
  guard(api('/api/visits', { method: 'DELETE' }));
});

$('feed-filter').addEventListener('input', (event) => {
  state.filter = event.target.value;
  renderFeed();
});

setInterval(() => {
  if (state.agents.length) renderAgents();
}, 15000);

bootToken();
