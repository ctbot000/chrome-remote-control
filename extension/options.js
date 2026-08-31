const $ = (id) => document.getElementById(id);

function ask(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then((res) => {
    if (!res?.ok) throw new Error(res?.error || 'the extension worker did not answer');
    return res.result;
  });
}

let locked = false;

function render({ settings, status, lock, open }) {
  const connected = open && status.connected;
  $('dot').className = `dot ${connected ? 'on' : status.connecting ? 'wait' : 'off'}`;
  $('link').textContent = connected
    ? `connected — policy version ${status.policyVersion ?? '?'}`
    : status.lastError || (status.connecting ? 'connecting…' : 'not connected');
  $('rules').textContent = `${status.appliedRules ?? 0} blocked · ${status.queued ?? 0} queued`;

  locked = Boolean(lock?.passwordSet && !lock.unlocked);
  $('lock-gate').classList.toggle('hidden', !locked);
  $('settings-body').classList.toggle('hidden', locked);
  $('unlocked-note').classList.toggle('hidden', !(lock?.passwordSet && lock.unlocked));
  renderCountdown(lock);
  if (locked) {
    $('unlock-password').focus();
    return;
  }

  if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
    $('controllerUrl').value = settings.controllerUrl;
    $('token').value = settings.token;
    $('deviceName').value = settings.deviceName;
    $('ignoredHosts').value = (settings.ignoredHosts || []).join('\n');
  }
  $('reporting').checked = Boolean(settings.reporting);
  $('enforcing').checked = Boolean(settings.enforcing);
}

function renderCountdown(lock) {
  if (!lock?.passwordSet || !lock.unlocked) return;
  const left = Math.max(0, lock.until - Date.now());
  const minutes = Math.floor(left / 60000);
  const seconds = Math.floor((left % 60000) / 1000);
  $('lock-countdown').textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function collect() {
  return {
    controllerUrl: $('controllerUrl').value.trim(),
    token: $('token').value.trim(),
    deviceName: $('deviceName').value.trim(),
    reporting: $('reporting').checked,
    enforcing: $('enforcing').checked,
    ignoredHosts: $('ignoredHosts')
      .value.split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean),
  };
}

async function save({ reconnect = false } = {}) {
  $('error').textContent = '';
  $('saved').textContent = '';
  try {
    const summary = await ask('save-settings', { patch: collect() });
    render(summary);
    if (reconnect) render(await ask('reconnect'));
    $('saved').textContent = 'saved';
    setTimeout(() => ($('saved').textContent = ''), 2500);
    setTimeout(refresh, 900);
  } catch (err) {
    $('error').textContent = err.message;
    refresh(); // the window may have expired mid-edit
  }
}

async function refresh() {
  try {
    render(await ask('get-summary'));
  } catch (err) {
    $('error').textContent = err.message;
  }
}

$('unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('unlock-error').textContent = '';
  try {
    render(await ask('unlock', { password: $('unlock-password').value }));
    $('unlock-password').value = '';
  } catch (err) {
    $('unlock-error').textContent = err.message;
  }
});

$('lock-now').addEventListener('click', async () => {
  render(await ask('lock'));
});

$('save').addEventListener('click', () => save());
$('test').addEventListener('click', () => save({ reconnect: true }));
$('reporting').addEventListener('change', () => save());
$('enforcing').addEventListener('change', () => save());

refresh();
setInterval(refresh, 3000);
setInterval(() => ask('get-summary').then(({ lock }) => renderCountdown(lock)).catch(() => {}), 1000);
