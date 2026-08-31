// An optional password on the extension's own settings, so the switches that
// stop reporting or drop the blocking rules are not one click away.
//
// The controller owns it. It sends a PBKDF2-SHA-256 verifier down with the
// policy; the extension can check a typed password against that verifier but
// has no way to set, change or clear it. A successful unlock opens a short
// window kept in chrome.storage.session, which browser shutdown discards and
// content scripts cannot read.

const LOCK_KEY = 'lock';
const SESSION_KEY = 'unlockedUntil';
const GRACE_MS = 5 * 60 * 1000;
const WRONG_PASSWORD_DELAY_MS = 500;

const encoder = new TextEncoder();
const fromHex = (hex) => new Uint8Array((String(hex).match(/../g) || []).map((pair) => parseInt(pair, 16)));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usable(lock) {
  return Boolean(lock && lock.salt && lock.hash && lock.iterations);
}

export async function getLock() {
  const stored = await chrome.storage.local.get(LOCK_KEY);
  return usable(stored[LOCK_KEY]) ? stored[LOCK_KEY] : null;
}

// Called whenever a policy arrives. The controller is the only writer, so a
// verifier edited locally is replaced on the next connection.
export async function adoptLock(lock) {
  if (usable(lock)) {
    const previous = await getLock();
    await chrome.storage.local.set({ [LOCK_KEY]: lock });
    // A new password ends any window opened against the old one.
    if (previous && previous.hash !== lock.hash) await setUnlockedUntil(0);
    return;
  }
  // The controller cleared the password: nothing to protect any more.
  await chrome.storage.local.remove(LOCK_KEY);
  await setUnlockedUntil(0);
}

async function unlockedUntil() {
  try {
    const stored = await chrome.storage.session.get(SESSION_KEY);
    return Number(stored[SESSION_KEY]) || 0;
  } catch {
    return 0; // no session storage: stay locked rather than fall open
  }
}

async function setUnlockedUntil(value) {
  try {
    if (value) await chrome.storage.session.set({ [SESSION_KEY]: value });
    else await chrome.storage.session.remove(SESSION_KEY);
  } catch {
    /* nothing to do: the caller stays locked */
  }
}

export async function lockState() {
  const lock = await getLock();
  if (!lock) return { passwordSet: false, unlocked: true, until: 0 };
  const until = await unlockedUntil();
  return { passwordSet: true, unlocked: until > Date.now(), until };
}

// Opens the window. Throws on a wrong password, after a deliberate pause.
export async function unlock(password) {
  const lock = await getLock();
  if (!lock) return { passwordSet: false, unlocked: true, until: 0 };
  const hash = await derive(String(password || ''), fromHex(lock.salt), lock.iterations);
  if (!sameBytes(hash, fromHex(lock.hash))) {
    await sleep(WRONG_PASSWORD_DELAY_MS);
    throw new Error('wrong password');
  }
  const until = Date.now() + GRACE_MS;
  await setUnlockedUntil(until);
  return { passwordSet: true, unlocked: true, until };
}

export async function lockNow() {
  await setUnlockedUntil(0);
  return lockState();
}

// Guard for anything that changes what the extension does. Also extends the
// window, so editing settings does not lock up mid-edit.
export async function requireUnlocked() {
  const state = await lockState();
  if (!state.passwordSet) return state;
  if (!state.unlocked) {
    throw Object.assign(new Error('the extension settings are locked'), { locked: true });
  }
  const until = Date.now() + GRACE_MS;
  await setUnlockedUntil(until);
  return { ...state, until };
}
