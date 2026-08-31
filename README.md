# chrome-remote-control

Two halves that talk over one WebSocket:

- **`extension/`** — a Manifest V3 Chrome extension that reports every page the
  browser opens and enforces the blocklist the controller sends back.
- **`controller/`** — a dependency-free Node server with a live dashboard, a
  REST API and a durable visit log.

No npm install anywhere: the controller uses only Node built-ins, including a
hand-rolled WebSocket implementation.

```
 Chrome ──── visits ────▶  controller  ────▶ dashboard (live)
   ▲                          │                 │
   └──────── blocklist ───────┘◀──── block ─────┘
```

## Quick start

**1. Start the controller**

```bash
node controller/index.js
```

It prints a dashboard URL with a token baked in, and the WebSocket URL plus token
for the extension:

```
  dashboard   http://127.0.0.1:8787/?token=<48 hex characters>
  extension   ws://127.0.0.1:8787/ws   token <48 hex characters>
```

The token is generated once and kept in `controller/data/config.json`. It binds
to `127.0.0.1` only — pass `--host 0.0.0.0` to expose it, and read the warning it
prints when you do.

**2. Load the extension**

`chrome://extensions` → turn on *Developer mode* → *Load unpacked* → pick the
`extension/` directory.

**3. Pair them**

Open the extension's options (its toolbar icon → *Settings*), paste the
WebSocket URL and the token, and save. The popup's dot turns green when the link
is up.

**4. Block something**

In the dashboard, type a host into *Blocklist* (or hit **block** next to any row
in *Live visits*). The rule reaches the browser within milliseconds; the next
navigation to that host lands on the extension's "blocked" page, and the attempt
comes back to the dashboard marked red.

## What each side does

### Extension

| Concern | How |
| --- | --- |
| Capturing visits | `chrome.webNavigation` `onCommitted` / `onHistoryStateUpdated`, top frame only, `http(s)` only |
| Blocked attempts | `onBeforeNavigate` records the URL that was actually attempted, before the redirect |
| Blocking | `declarativeNetRequest` dynamic rules — two per host: top-level navigations redirect to `blocked.html`, everything else is dropped |
| Offline | Visits queue in `chrome.storage.local` (500 max) and flush on reconnect |
| Staying alive | A 20 s application ping keeps the MV3 service worker from being torn down, plus a 1-minute `chrome.alarms` backstop that reconnects |
| Restart | The last policy is cached, so blocking survives a browser restart with the controller down |
| Settings password | A PBKDF2-SHA-256 verifier arrives with the policy; the extension can check a typed password against it but has no code path to set or clear one |

Two local switches (popup or options page): **report visits** and **enforce the
blocklist**. Turning enforcement off removes every rule from the browser at once.
The **never touch these sites** list in the options page is local-only — those
hosts are never reported and never blocked, whatever the controller says.

### Locking the extension's settings

Those two switches are the obvious way to defeat the whole thing, so the
controller can put a password in front of them.

Set it in the dashboard (*Extension settings password*) or over REST. The
controller keeps the password, hashes it with PBKDF2-SHA-256, and sends only the
verifier — salt, hash, iteration count — down with the policy. From then on the
browser needs the password to open its settings, to change either switch, or to
clear the visit queue. Reconnecting and re-applying the policy stay open, since
neither can turn the extension down.

- **The browser cannot set, change or clear it.** There is no such call in the
  extension; the only writer is the controller, which overwrites the cached
  verifier on every connection.
- **It works offline.** The password is checked against the cached verifier, so
  pulling the network does not open the settings.
- **An unlock lasts five minutes**, extended while you are editing, and is kept
  in `chrome.storage.session` — closing the browser re-locks it.
- **Forgot it?** Set a new one on the controller. It reaches the browser with the
  next policy push and invalidates any open window.
- **Removing the password** in the dashboard unlocks every browser again.

### Controller

- **Dashboard** at `/` — connected browsers, live visit feed with a filter, most
  visited sites, blocklist editor, master blocking switch.
- **State** in `controller/data/`: `config.json` (token), `policy.json`
  (blocklist), `visits.jsonl` (append-only visit log, last 5000 kept in memory).
- **Policy versioning** — every change bumps a version; agents report back which
  version they applied, and the dashboard shows *syncing* until they agree.

## REST API

Every `/api/*` route except `/api/health` needs the token, as
`Authorization: Bearer <token>`, an `X-Controller-Token` header, or `?token=`.

| Method | Route | Does |
| --- | --- | --- |
| `GET` | `/api/health` | liveness, no token needed |
| `GET` | `/api/state` | agents + policy + recent visits + stats |
| `GET` | `/api/agents` | connected browsers |
| `GET` | `/api/visits?limit&q&agentId&since` | visit log, newest first |
| `DELETE` | `/api/visits` | wipe the visit log |
| `GET` | `/api/stats` | totals and the busiest hosts |
| `GET` | `/api/blocklist` | full policy, including paused rules |
| `POST` | `/api/blocklist` | `{host}` or `{hosts:[…]}`, plus optional `note` |
| `PATCH` | `/api/blocklist/<id\|host>` | `{enabled}` — pause or resume a rule |
| `DELETE` | `/api/blocklist/<id\|host>` | drop a rule |
| `POST` | `/api/blocking` | `{enabled}` — the master switch |
| `POST` | `/api/settings-password` | `{password}` — lock the extension's settings (6+ characters) |
| `DELETE` | `/api/settings-password` | unlock them again |
| `POST` | `/api/commands` | `{target:"all", name:"resync"\|"flush"}` |

```bash
TOKEN=$(node -e "console.log(require('./controller/data/config.json').token)")
curl -s -X POST localhost:8787/api/blocklist \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"hosts":["reddit.com","news.ycombinator.com"],"note":"deadline week"}'
```

Hosts are normalised on the way in: `https://www.Example.com/path`, `*.example.com`
and `example.com:8443` all become `example.com`, which then matches that host and
every subdomain.

## Wire protocol

One WebSocket at `/ws?role=agent|ui&token=…`, JSON text frames.

Extension → controller: `hello` (identity, first message), `visits`
(`{items:[{url,title,ts,transition,blocked}]}`), `status` (applied policy
version), `ping`.

Controller → extension: `welcome` (with the current policy), `policy` on every
change, `command`, `visits-ack`, `pong`. The policy carries `rules`,
`blockingEnabled` and `lock` — the settings-password verifier, or `null`.

The dashboard is never sent the verifier: its view of the policy carries only
`lock: {passwordSet, setAt}`.

Controller → dashboard: `snapshot` on connect, then `agents`, `policy`, `visit`,
`stats`, `visits-cleared`.

## Tests

```bash
npm test
```

- `controller/tools/selftest.js` — 33 end-to-end checks on a throwaway port and
  data directory: auth, policy fan-out to a live agent, visit ingestion,
  dashboard push, persistence, connection resets, the settings password and its
  redaction.
- `tools/test-extension.mjs` — 32 checks of the extension's logic against a
  stubbed `chrome.*` API: rule generation, the ignore list, the switches, the
  offline visit queue, and the lock. The lock tests build their verifier with the
  controller's own store, so they also prove the two PBKDF2 implementations
  (`node:crypto` and WebCrypto) agree.

To watch the dashboard without loading the extension:

```bash
node controller/tools/fake-agent.js --interval 2000
```

It connects as an agent, applies whatever policy arrives and reports invented
visits — including "blocked" ones once you block a host it visits.

## Scope and limitations

- Meant for **your own browser or one you are responsible for and have told**:
  the extension is visible in the toolbar, its options page says exactly what it
  sends, and anyone at the keyboard can remove it from `chrome://extensions`. It
  is not built to be covert.
- **The settings password is friction, not enforcement.** It stops the casual
  "just turn it off" click and takes the password out of the browser's hands. It
  does not stop someone who removes the extension, edits its storage from the
  service worker's devtools, or points it at a controller of their own. Nothing
  running inside the browser can.
- The visit log holds full URLs. It sits in `controller/data/visits.jsonl` in the
  clear; keep the controller on loopback unless you have a reason not to.
- Incognito windows are excluded unless you allow the extension there explicitly
  in `chrome://extensions`.
- One shared token, no user accounts. Anyone with the token can read the log and
  change the blocklist.
- `ws://` is plaintext. Over anything but loopback, terminate `wss://` in front
  of the controller.
- Dynamic rules are capped at 1000 hosts (2000 rules), well inside Chrome's
  budget.

## Layout

```
extension/
  manifest.json         MV3 manifest
  background.js         service worker: navigation capture, RPC, boot
  lib/config.js         settings + status in chrome.storage
  lib/connection.js     WebSocket link, backoff, keepalive, policy adoption
  lib/blocking.js       policy → declarativeNetRequest dynamic rules
  lib/visits.js         visit capture, dedupe, offline queue
  lib/lock.js           settings password: adopt the verifier, unlock, gate
  popup.*  options.*  blocked.*  ui.css
controller/
  index.js              CLI entry point
  src/server.js         HTTP, REST, static files, WebSocket wiring
  src/store.js          token, policy, visit log on disk
  src/hub.js            connected agents and dashboards
  src/wsserver.js       RFC 6455 server, no dependencies
  public/               dashboard
  tools/                fake-agent.js, selftest.js, wsclient.js
tools/
  make-icons.cjs        regenerates extension/icons/*.png
  test-extension.mjs    extension logic tests
```
