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
  dashboard   http://127.0.0.1:8787/?token=388d8d6d…
  extension   ws://127.0.0.1:8787/ws   token 388d8d6d…
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

Two local switches (popup or options page): **report visits** and **enforce the
blocklist**. Turning enforcement off removes every rule from the browser at once.
The **never touch these sites** list in the options page is local-only — those
hosts are never reported and never blocked, whatever the controller says.

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
change, `command`, `visits-ack`, `pong`.

Controller → dashboard: `snapshot` on connect, then `agents`, `policy`, `visit`,
`stats`, `visits-cleared`.

## Tests

```bash
npm test
```

- `controller/tools/selftest.js` — 25 end-to-end checks on a throwaway port and
  data directory: auth, policy fan-out to a live agent, visit ingestion,
  dashboard push, persistence, connection resets.
- `tools/test-extension.mjs` — 23 checks of the extension's logic against a
  stubbed `chrome.*` API: rule generation, the ignore list, the switches, the
  offline visit queue.

To watch the dashboard without loading the extension:

```bash
node controller/tools/fake-agent.js --interval 2000
```

It connects as an agent, applies whatever policy arrives and reports invented
visits — including "blocked" ones once you block a host it visits.

## Scope and limitations

- Meant for **your own browser or one you are responsible for and have told**:
  the extension is visible in the toolbar, its options page says exactly what it
  sends, and anyone at the keyboard can switch it off or remove it. It is not
  built to be covert or tamper-proof.
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
  make-icons.js         regenerates extension/icons/*.png
  test-extension.mjs    extension logic tests
```
