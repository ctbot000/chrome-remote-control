const $ = (id) => document.getElementById(id);

function ask(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then((res) => {
    if (!res?.ok) throw new Error(res?.error || 'the extension worker did not answer');
    return res.result;
  });
}

function render({ settings, status, open }) {
  const connected = open && status.connected;
  $('dot').className = `dot ${connected ? 'on' : status.connecting ? 'wait' : 'off'}`;
  $('link').textContent = connected ? 'connected' : status.connecting ? 'connecting' : 'offline';
  $('controller').textContent = settings.controllerUrl;
  $('error').textContent = connected ? '' : status.lastError || '';
  $('s-sent').textContent = status.sentVisits ?? 0;
  $('s-queued').textContent = status.queued ?? 0;
  $('s-rules').textContent = status.appliedRules ?? 0;
  $('s-hits').textContent = status.blockedHits ?? 0;
  $('reporting').checked = Boolean(settings.reporting);
  $('enforcing').checked = Boolean(settings.enforcing);
  $('dashboard').dataset.url = dashboardUrl(settings);
}

function dashboardUrl(settings) {
  try {
    const url = new URL(settings.controllerUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/';
    url.search = settings.token ? `?token=${encodeURIComponent(settings.token)}` : '';
    return url.toString();
  } catch {
    return '';
  }
}

async function refresh() {
  try {
    render(await ask('get-summary'));
  } catch (err) {
    $('error').textContent = err.message;
  }
}

$('reporting').addEventListener('change', (e) =>
  ask('save-settings', { patch: { reporting: e.target.checked } }).then(render)
);
$('enforcing').addEventListener('change', (e) =>
  ask('save-settings', { patch: { enforcing: e.target.checked } }).then(render)
);
$('reconnect').addEventListener('click', () => {
  $('error').textContent = '';
  ask('reconnect').then(render).then(() => setTimeout(refresh, 800));
});
$('dashboard').addEventListener('click', (e) => {
  const url = e.currentTarget.dataset.url;
  if (url) chrome.tabs.create({ url });
});
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

refresh();
setInterval(refresh, 2000);
