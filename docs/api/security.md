# Fabric and WebFabric security

This page describes how the Fabric API and WebFabric protect the simulation, the person using the
observer, and each application from the others. It states what each mechanism does, what it does not do,
and how to check it. To report a vulnerability, see the
[security policy](https://github.com/varunkarthic/DSTNS/blob/main/SECURITY.md).

!!! warning "Read this first"
    DSTNS is designed for one operator on one machine, bound to loopback. The protections below are
    strong against other applications and against web pages in the operator's browser. They are **not**
    a substitute for a gateway when the server is exposed to a network. See
    [what is not protected](#what-is-not-protected).

## Who can do what

There are four kinds of caller. Everything else on this page follows from the difference between them.

| Caller | How it is recognised | What it can do |
|---|---|---|
| Anyone who can reach the port | Nothing | Read: the run, the map, the list of applications, the audit log |
| The observer, or the operator | `X-DSTNS-Host` from the observer's origin, or `X-DSTNS-Operator` with the operator credential | Control the engine, grant and revoke capabilities, suspend and forget applications, read launch proposals |
| An application | Its bearer token, and its signature if it requires one | Its own surfaces, and whatever it has been granted |
| A frame | Nothing. It has an opaque origin | Post messages to the observer, each checked against its application's grants |

## What is being protected, and from whom

| Threat | Protection |
|---|---|
| A web page in the operator's browser reads or drives the run | Host check, origin check, CORS only for the observer's origin |
| A page rebinding its DNS name to the local server | `Host` allow-list on every request, reads included |
| An application acts beyond what a person allowed | Capabilities, checked on the server for every request |
| An application takes over another's identity | Tokens, and an ID that holds grants can't be claimed without its token |
| An application's page reaches the observer | `sandbox="allow-scripts"` with no same-origin, and a content security policy |
| An application changes what a person chose | Applications have no route to user settings. See [directing the view](#directing-the-view) |
| An application floods the server or the page | Limits on everything, refused with a code rather than dropped silently |
| A request is altered or replayed on the way | Signed requests, a time window and single-use nonces |
| A response is altered on the way | Response digest and signature |
| The saved store is edited while the server is stopped | A seal kept apart from it |
| Someone rewrites the record of what happened | A hash chain over the audit log |
| An application starts a program on the machine | It can't. It can only propose, and only the operator's launcher runs anything |

## Identity

### Application tokens

`POST /api/v1/fabric/apps` registers an application and returns a token and a signing key, once.

- A token is two 128-bit values from the operating system's secure generator, in hex: 256 bits.
- Only `SHA-256(token)` is stored. The token exists on the server for the length of the request that
  created it, and so it can't be recovered from the store.
- Comparison is in constant time.
- An application's own routes under `/api/v1/fabric/apps/{id}/` require
  `Authorization: Bearer <token>`. The rest of that path that changes anything, such as grants, answers only
  to the observer and the operator.

The token never appears in an event, a log line, the audit log or a public view of the application.

### Claiming an ID

An ID that exists can't be taken by someone who doesn't hold its token:

```text
exists, token presented and correct      update it
exists, not unloaded, no valid token     409 APP_ID_CONFLICT
exists, unloaded, holds explicit grants  409 APP_ID_CONFLICT
exists, unloaded, no explicit grants     may be taken up, with none of what it kept or was sent
does not exist                           new, while under the limit of 64
```

The third line matters: otherwise an application that had been granted control could be impersonated the
moment it left. A person can release such an ID with **Forget** in Settings.

Taking up an ID without its token keeps what a person chose for its settings, and nothing else: storage, queued
events, timers, subscriptions and stops all start empty. **Keep your token if you want to keep your storage.**

When all 64 places are taken, the oldest application that has gone and holds no explicit grant makes way, so
that programs registering under new names can't use them up for good.

### Rotating credentials

`POST /api/v1/fabric/apps/{id}/credentials/rotate` replaces both the token and the signing key, clears the
nonce cache and queues `credentials.rotated`. The old ones stop working in that same moment. The response
is the only place the new ones appear.

### The observer and the operator

`is_host` in `Fabric/src/support.cpp` decides this:

1. A request with the correct `X-DSTNS-Operator` value is the operator. Comparison is in constant time.
2. Otherwise it must carry `X-DSTNS-Host`, and if it has an `Origin`, that origin must be the server's own or
   one in `DSTNS_ALLOWED_ORIGINS`.

A custom header forces a browser to send a preflight, which a page elsewhere fails. A sandboxed frame has the
origin `null`, which is always refused.

The check stops browsers. A program that can reach the port can send the header. That is why
[exposing the server](#what-is-not-protected) needs a gateway.

## Capabilities

An application lists what it wants in its manifest. Some are given at once, because they only add to the
application's own surfaces. The rest wait for a person, because they interrupt the viewer, direct what the
person sees, run the application's code in the page, or change the simulation.

| Capability | Allows | Granted |
|---|---|---|
| `ui.header`, `ui.status`, `ui.panels`, `ui.sidebar`, `ui.deck`, `ui.overlays`, `ui.map-controls`, `ui.indicators` | Its own elements in that slot | At once |
| `ui.notifications` | Notifications, rate limited | At once |
| `settings` | Its own settings, never the person's | At once |
| `sim.read` | Subscriptions and simulation-clock timers | At once |
| `storage` | Its own storage | At once |
| `apps.messages` | Messages to other applications | At once |
| `ui.dialogs` | Dialogs, which interrupt | By a person |
| `ui.frames` | Its own page, in a sandbox | By a person |
| `ui.camera` | Asking the map to move | By a person |
| `ui.layers` | Holding layers and places on or off | By a person |
| `control.playback` | Pause, resume, speed | By a person |
| `control.events` | Injecting incidents and weather | By a person |
| `control.world` | Replacing the world | By a person |

Properties worth relying on:

- **Checked on the server.** The observer shows grants, but it isn't what enforces them.
- **Asked for, then granted.** An application can't be granted what its manifest doesn't request.
- **Revocation is immediate.** The next request is refused, with `403 CAPABILITY_NOT_GRANTED`.
- **Grants survive a restart** in the sealed store, and an application coming back with its token keeps them.
- **Widening asks again.** An update that adds a frame origin drops `ui.frames` until a person grants it again.
- **Refusals are counted** and visible in the application's health.

## Signed requests

Bearer tokens over plain HTTP can be read and replayed by anything on the path. Signing adds proof that a
request is whole and new, without sending the secret. It's optional, and an application makes it mandatory for
itself with `manifest.security.require_signatures: true`. After that, an unsigned request is refused with
`401 SIGNATURE_REQUIRED`, even with the right token.

Each request adds three headers:

```text
X-DSTNS-Timestamp: seconds since the epoch
X-DSTNS-Nonce:     8 to 128 characters, unique per request
X-DSTNS-Signature: HMAC-SHA-256(signing_key, canonical), in hex

canonical = METHOD + "\n" + TARGET + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + SHA-256(BODY)
```

`TARGET` is the path with its query string, exactly as sent.

The server checks them in this order, and the order is deliberate:

```text
1. |now - timestamp| <= 60 s          else 401 SIGNATURE_EXPIRED
2. nonce is 8 to 128 characters       else 401 SIGNATURE_INVALID
3. signature matches, constant time   else 401 SIGNATURE_INVALID
4. nonce not seen                     else 401 SIGNATURE_REPLAYED
```

The nonce is recorded last, so a forgery can't use up a real nonce. Nonces are kept for twice the window, which
is longer than any timestamp that would still pass step 1.

An application that requires signatures needs them everywhere it uses its token, including registering again. A
stolen token therefore can't be used to turn signing off.

### Integrity of responses

Every response under `/api/v1/fabric/` carries:

```text
X-DSTNS-Content-SHA256: SHA-256(body)
```

The body is the response as it reads once any gzip is undone, which is what a client that decodes it, such as a
browser's `fetch`, can check.

A signed request to an application's route also gets:

```text
X-DSTNS-Response-Signature: HMAC-SHA-256(signing_key, STATUS + "\n" + NONCE + "\n" + DIGEST)
```

Including the nonce ties the response to that one request, so an old response can't be replayed in its place. It's
given only for a request whose own signature checks out, so nobody without the key can get a signature over a nonce
of their choosing.
A digest alone only detects accidents, since anyone who can change the body can change the digest. The signature
is what proves the response came from this server.

## Encryption

With `-DDSTNS_TLS=ON` the server speaks TLS, using `--tls-cert` and `--tls-key` or `DSTNS_TLS_CERT` and
`DSTNS_TLS_KEY`. `GET /api/v1/fabric/security` reports whether it's on.

Without it, requests travel in plain text. On loopback that's normally acceptable. Signing still protects
integrity, but it doesn't hide the content. A token on a network needs TLS.

The launcher talks to its own server over loopback HTTP.

## The store

Applications, grants and launch proposals are saved to `fabric-apps.json`.

- The file is written to a temporary file with mode `0600`, then renamed, so a crash can't leave half a file.
- It's sealed: `integrity = HMAC-SHA-256(key, contents)`.
- Tokens are stored only as hashes. Signing keys are stored as they are, because checking a signature needs them, so
  this file's permissions matter.
- The key is in `fabric-apps.json.key`, mode `0600`, beside it and not inside it.
- A store that doesn't match is **not trusted**. It's renamed to `fabric-apps.json.rejected`, the server starts
  empty, applications register again, and `GET /api/v1/fabric/security` reports `store.rejected: true`.

The seal detects changes by anyone who can write the store but can't read the key: a stray tool, a restored
backup, a mistaken edit. Someone running as the same user can read the key, so it isn't a defence against that.

Application storage is **not encrypted at rest**. Don't put secrets in it.

## The audit log

Every action through a control capability, and every request to direct the view, is recorded with who, what,
in which run, at what simulated time, and the outcome. Entries form a chain:

```text
entry.previous = hash of the entry before it
entry.hash     = SHA-256(entry without its hash)
```

`GET /api/v1/fabric/audit/verify` walks the chain and answers `{"intact": true, "checked": n, "head": "..."}`, or
gives the first bad sequence number. To keep a stronger record, save the `head` somewhere else now and then: a
later rewrite of anything before it then shows.

The log holds the latest 2,000 entries, in memory. It doesn't survive a restart. Parameters over 2 KiB are recorded as
`{"truncated": true}`, so the record says what was asked without holding everything that was sent.

The chain starts from the oldest entry still held, so entries that have aged out don't count against it, and `verify`
can't tell you they existed. An application with a control capability that sends thousands of actions can push older
entries out. If that matters, read the log regularly and keep it elsewhere.

## Web protections

### Browsers

| Mechanism | What it stops |
|---|---|
| `Host` allow-list while bound to loopback | DNS rebinding, for reads too. `421 HOST_NOT_ALLOWED`. Extra names through `DSTNS_ALLOWED_HOSTS` |
| `Origin` check on anything that changes state | Cross-site request forgery. `403 CROSS_ORIGIN_FORBIDDEN` |
| CORS granted per request, never `*` | Other pages reading a response |
| `Cache-Control: no-store` | Responses left in a cache |
| `frame-ancestors 'none'`, `X-Frame-Options: DENY` | Another site putting the observer in a frame, and tricking a person into clicking Terminate |
| `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` | A response read as something it isn't, and addresses leaking to other sites |

### Application pages

A frame is the riskiest thing an application can do, because it's code from elsewhere inside the observer's page.

```html
<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="...">
```

- With no `allow-same-origin`, the frame has an opaque origin. It can't reach the observer's DOM, storage or
  cookies, and the server refuses it as cross-origin. This boundary is enforced by the browser.
- Only `http:` and `https:` can be framed. An application can limit itself further with `frame_origins`.
- Its messages are checked by window identity, rate limited, and compared against its grants.
- A frame that doesn't respond is reported as failed, and nothing else is affected.

### The observer's own page

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
frame-src http: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

`script-src 'self'` means injected markup can't run a script even if it got in. It doesn't get in: application
text is rendered as text, and there's no route for HTML from an application to reach the page.

## Applications can't change the design

Declared interface elements are data, and the observer draws them with its own components. An application
chooses from a closed list of slots, tones and shapes. It can't supply styles, fonts or markup.

Colours are the one thing it can name, and only on its own marks. They're adjusted before they're drawn:

- `"auto"` gives a stable colour from the palette, based on the application and element IDs.
- `"#RRGGBB"` is moved in lightness until it has a contrast of at least 3:1 with the map in the current theme.
- Under a colour-vision mode, it's replaced with the nearest palette colour, so that a person's accessibility
  choice still holds.

## Directing the view

`ui.camera` and `ui.layers` let an application direct what's on screen. They were designed around one rule:
**an application asks, and the observer decides.** What it asks for is a temporary overlay on the person's
choices, never a change to them.

| Guarantee | How it's enforced |
|---|---|
| A person's settings never change | Requests are held apart from settings, in memory. Only the person's own controls write to settings, and they write the person's values |
| It doesn't survive | Never saved in the store. Cleared when the application leaves, is suspended, lapses or loses the grant |
| A person always wins | A gesture on the map stops camera requests for 8 seconds. Changing a held layer releases it |
| Performance always wins | When the system has reduced detail under load, an application can't turn it back on |
| It can't hide anything by surprise | The Layers panel names the application holding a layer, and offers a way back |
| It can't jerk the view around | 2 requests a second with a burst of 4, `429 RATE_LIMITED` beyond that. Only the map's own springs and zoom limits. Reduced motion is respected |
| It can't interrupt | Requests are declined during the tutorial, a dialog or the arrival |
| It knows what happened | `view.applied` or `view.declined`, as an event |
| It's on the record | Every request is in the audit log |
| Only real things | Layer names are a closed list, values must be true or false, and numbers must be finite and in range |

## What the operator can turn off

Each of these is read once, when the server starts. The launcher sets them from its settings, and
`GET /api/v1/system/features` says what they are.

| Variable | Default | Turned off |
|---|---|---|
| `DSTNS_FABRIC_APPS` | on | Applications can't register, and nothing under `/api/v1/fabric/apps` changes: `403 APPLICATIONS_DISABLED` |
| `DSTNS_LEGACY_API` | on | `/api/v1/playback/*`, `/api/v1/control/*` and `/stop` answer `410 LEGACY_API_DISABLED`. This closes the routes [without a credential](#what-is-not-protected) |
| `DSTNS_LAUNCH_PROPOSALS` | on | An application can't propose how to start it: `403 LAUNCH_PROPOSALS_DISABLED`. The operator still can |
| `DSTNS_REQUIRE_SIGNATURES` | off | When on, every application must sign every request |
| `DSTNS_DISABLED_CAPABILITIES` | none | A comma-separated list of capabilities nobody may be granted: `403 CAPABILITY_DISABLED` |

## Reloading an application

A person can reload an application from the observer. Its link ends at once: the token and the signing
key stop working, and what it declared, queued, timed and held is cleared.

What happens next depends on whether anyone can prove to be it:

- **The launcher started it.** Before starting a process, the launcher gives the server the SHA-256 hash of a
  random one-time key, and gives the process the key itself in `DSTNS_FABRIC_LAUNCH_KEY`. On reload the launcher
  starts it again with a new key. The process registers presenting the key in `X-DSTNS-Launch-Key`, gets a new
  token, and keeps what a person granted it, its settings and its storage. A key works once, and only the
  observer or the operator can set one.
- **Anything else.** Nobody can prove to be it. Its explicit grants are dropped, it registers again as new, and a
  person grants again whatever needs a person. Nobody can take over its grants in between.

## Writing files

Exporting to SUMO writes files on the server. Unless a request has the operator's credential, the directory must be
under `data/`, with no `..`. Anything else is `403 DIRECTORY_NOT_ALLOWED`. Controlling a simulation doesn't come with
writing anywhere this user can.

## Starting programs

The launcher can start applications along with the simulation, and that runs commands on the operator's
machine. The API deliberately doesn't get that power:

```text
Fabric API     PUT /api/v1/fabric/apps/{id}/launch     records a proposal, and runs nothing
Operator       ./launcher apps proposals               reads it
Operator       ./launcher apps approve {id}            copies it to config/apps.json
Launcher       runs what is in config/apps.json        never what is in a proposal
```

An application asking to run something gets a line in a list, which a person reads. The launcher then runs each
command without a shell, in its own process group, and stops the group with the session.

## Limits

An application can't exhaust the server or the page. A request over a limit is refused with a code.

| Limit | Value |
|---|---|
| Any request body | 16 MiB, or `413` |
| JSON nesting | 64 levels, or `400`, since a very deep document could otherwise overflow the stack |
| Moving the view and holding layers | 2 a second, burst of 4, and a refused request also counts |
| Applications | 64 |
| Elements per application | 64 |
| Interface data per application | 4 MiB |
| Queued events | 1,000 |
| Notifications kept | 1,000 |
| Notifications | 20 a second, burst of 40 |
| Fields in a settings schema | 128 |
| Timers | 32 |
| Subscription topics | 32 |
| Storage | 256 keys, 256 KiB |
| Message | 16 KiB |
| Path | 4,096 nodes, 12 vehicles |
| Launch proposal | 8 commands, 1 KiB each, 16 KiB in all, 64 waiting |
| Frame messages | 120 a second, per frame |

## What is not protected

These are limitations, stated plainly.

- **Reading is open.** Anyone who can reach the port can read the run, the map and the audit log.
- **The older routes have no credential.** `/api/v1/playback/*` and `/api/v1/control/*` stay open for compatibility, as do
  `/terminate`, `/api/v1/world/regenerate` and `/api/v1/system/backpressure`. A browser page from elsewhere is still
  refused, but a local program can use them, without going through capabilities.
- **The host check stops browsers, not programs.** A program that can reach the port can send `X-DSTNS-Host`. On a
  shared machine, or a server bound beyond loopback, it can act as the observer. Put an authenticating gateway in
  front, as [the deployment security guide](../deployment/security.md) describes, and set `DSTNS_OPERATOR_TOKEN`.
- **Plain HTTP by default.** TLS needs a build flag.
- **Same-user attackers.** Someone running as the same user can read the store's key, the operator token and
  the process's memory.
- **Storage isn't encrypted.**
- **The audit log is in memory.** It's lost on restart, and the oldest entries fall off after 2,000.
- **The chain proves consistency, not truth.** Someone controlling the server could rebuild it. Saving the head
  elsewhere is what guards against that.
- **Approved commands run as the operator.** Reading a proposal before approving it is the protection.
- **Frames can do what any web page can.** They can load things from the internet, and show the person anything
  inside their own rectangle, including a convincing form.
- **A granted capability is used at the application's discretion.** The audit log says what it did, but a grant
  is trust.

## Checking it yourself

```bash
OPERATOR="X-DSTNS-Operator: $(cat logs/operator.token)"

# The current posture
curl -s -H "$OPERATOR" http://127.0.0.1:8090/api/v1/fabric/security | jq .data

# Is the audit chain intact?
curl -s -H "$OPERATOR" http://127.0.0.1:8090/api/v1/fabric/audit/verify | jq .data

# A forged origin is refused
curl -si -X POST -H 'Origin: https://evil.example' http://127.0.0.1:8090/api/v1/fabric/engine/pause | head -1

# So is a rebinding name (421)
curl -si -H 'Host: evil.example' http://127.0.0.1:8090/health | head -1

# An application's own view of what it holds
curl -s http://127.0.0.1:8090/api/v1/fabric/apps/com.example.app | jq .data.capabilities
```

The same checks run in `tests/api/hardening_smoke.py`, `tests/api/fabric_apps_smoke.py`,
`tests/api/fabric_platform_smoke.py` and `tests/api/fabric_direction_smoke.py`. `tests/api/robustness_smoke.py` sends hostile
values to every route that takes any, and fails on a `500` or a crash.
