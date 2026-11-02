# Fabric API

The routes [applications](../development/webfabric-apps.md) use. All are additive
under `/api/v1`, and answer in the usual envelope, with `data` or `error`.

**Who may call what.** *Token* is the application's own, as
`Authorization: Bearer <token>`. *Host* is the observer or the operator: the
`X-DSTNS-Operator` credential, or an `X-DSTNS-Host` header from the observer's own
origin. *Anyone* needs nothing, like the rest of the read API.

## Registering

| Route | Who | |
|---|---|---|
| `POST /fabric/apps` | Anyone; the token to update | Register from a manifest. `201` with `app` and `token` |
| `GET /fabric/apps` | Anyone | Applications, without tokens or UI |
| `GET /fabric/apps/{id}` | Anyone | One application, with `ui` and `blocked_ui` |
| `DELETE /fabric/apps/{id}` | Token, or Host | The token unloads, keeping identity. Host forgets the application entirely |
| `POST /fabric/apps/{id}/heartbeat` | Token | Renews the lease; `registered` becomes `active` |
| `PUT /fabric/apps/{id}/state` | Token | `{"state": "initialized" \| "active" \| "failed", "detail": "..."}` |

### Manifest

| Field | Required | |
|---|---|---|
| `id` | Yes | 3 to 64 characters: lower-case letters, digits, dots, hyphens. `dstns`, `fabric` and `webfabric` prefixes are reserved |
| `name` | Yes | Up to 40 bytes. May not be `DSTNS`, `Fabric` or `WebFabric` |
| `version` | Yes | For example `1.2.0` |
| `description`, `author` | No | Up to 280 and 80 bytes |
| `capabilities` | No | See [Capabilities](../development/webfabric-apps.md#capabilities) |
| `lease_s` | No | Seconds in [1, 3600]; default 60 |
| `settings` | No | See [Settings](../development/webfabric-apps.md#settings) |
| `ui` | No | The initial elements |
| `manifest_version`, `requires_api` | No | Default `1`. Anything else answers `422 APP_INCOMPATIBLE` |

## Declaring UI

| Route | Who | |
|---|---|---|
| `PUT /fabric/apps/{id}/ui` | Token | Replace every element |
| `PUT /fabric/apps/{id}/ui/{element}` | Token | Add or update one |
| `DELETE /fabric/apps/{id}/ui/{element}` | Token | Remove one |

Every element has an `id` and a `slot`. The other fields depend on the slot:

| Slot | Fields |
|---|---|
| `status` | `label`, `value`, `tone` |
| `header` | `label`, `icon`, `tone`, `opens` |
| `map_control` | `label`, `icon`, `active`, `opens` |
| `indicator` | `edge` (`top`, `right`, `bottom`, `left`), `position` (0 to 1), `label`, `tone` |
| `panel` | `title`, and `widgets` or `frame` |
| `sidebar` | `title`, `label`, and `widgets` or `frame` |
| `deck` | `title`, and `widgets` or `frame` |
| `dialog` | `title`, `body`, `actions` (`id`, `label`, `tone`; up to 3) |
| `overlay` | `features` |

`opens` names one of the application's panels; without it, activating the element
sends an event. `icon` names an icon the observer has, such as `pin`, `gauge` or
`signal`; an unknown name draws the information icon.

**Widgets:** `text` (`text`); `stat` (`label`, `value`, `tone`); `progress` (`label`,
`value` from 0 to 1, `tone`); `button` (`id`, `label`, `tone`); `toggle` (`id`,
`label`, `value`); `select` (`id`, `label`, `value`, `options`); `slider` (`id`,
`label`, `value`, `min`, `max`, `step`); `heading` and `note` (`text`); `stats` and `chips`
(`items`: `label`, `value`, `caption`, `tone`); `list` (`id`, `rows`: `id`, `badge`, `subtitle`,
`share` from 0 to 1, `value`, `series`, `selected`); `legend` (`legend`: `id`, `label`, `series`
or `tone`, `mark` of `line`, `dash` or `dot`, and `value` to make it a switch); `tabs` (`tabs`:
`id`, `caption`, `label`, `widgets`); `input` (`id`, `label`, `input_type` of `text`, `time` or
`number`, `value`, `submit`). A `button` with `pick: true` reports the next click on the map
as an action `pick`, with `x_m`, `y_m`, `lat` and `lon`.

**Overlay features**, in the core's metres (see the [View API](view-api.md)):
`{"type": "point" | "circle", "x_m", "y_m", "radius_m", "label", "tone"}` and
`{"type": "line" | "polygon", "points": [[x_m, y_m], ...], "tone"}`, and on the road network `marker` (`node`), `entity` (`edge`, `at`), `route` (`nodes`) and the animated `path` (`id`, `nodes`), described in [WebFabric](../components/webfabric.md#on-the-road-network). A reference the loaded world does not have is refused with `422 NOT_ON_NETWORK`. Any feature may use
`series` instead of `tone`; lines take `width` and `dash`, points take `size` and `hollow`, and
a point with an `id` glides to each new position.

Any element may also set `motion`; see [Motion](../components/webfabric.md#motion).

## Bus stops

| Route | Who | |
|---|---|---|
| `PUT /fabric/apps/{id}/stops` | Token, `sim.read` | `{"nodes": [...]}`: the application's own stops, up to 4096. Answers as `GET` does |
| `GET /fabric/apps/{id}/stops` | Token | Each stop's `node`, `x_m`, `y_m`, `multiplier`, `baseline`, and `generators` nearby |

DSTNS has bus stops of its own, as places, at `GET /view/stops`. An application may add others. A stop's
demand follows the model real stops use: the hour's profile, pulled up by trip generators within 400 m
that are busy now. This is read-only: the simulation never reads these stops, so results do not change.

## Notifications and events

| Route | Who | |
|---|---|---|
| `POST /fabric/apps/{id}/notifications` | Token, `ui.notifications` | `{"title", "body", "severity": "info" \| "warning" \| "alert"}`. `202`, or `429 RATE_LIMITED` |
| `GET /fabric/apps/{id}/events?since=N` | Token | `items`, `sequence` and `dropped` |
| `POST /fabric/apps/{id}/actions` | Host | What a person did; delivered as `ui.action` |

Event types are `ui.action`, `settings.changed`, `settings.migrated`,
`capabilities.changed`, `app.suspended`, `app.resumed` and `app.failed`. Pass the last
`sequence` as `since`. The most recent 1000 are kept, and `dropped` says if your cursor
fell behind them.

## Settings and permissions

| Route | Who | |
|---|---|---|
| `GET /fabric/apps/{id}/settings` | Token, or Host | `version` and `values` |
| `PUT /fabric/apps/{id}/settings` | Token with `settings`, or Host | Change fields. All apply or none |
| `DELETE /fabric/apps/{id}/settings` | Host | Back to defaults |
| `PUT /fabric/apps/{id}/grants` | Host | `{"capabilities": [...]}`: the complete granted set |
| `POST /fabric/apps/{id}/suspend`, `/resume` | Host | Hide or restore. Only a person can resume |
| `POST /fabric/apps/{id}/failure` | Host | Report that its interface failed |

## Controlling the simulation

`POST /fabric/apps/{id}/control` with the token and the capability:
`{"action": "...", "params": {...}}`. Each is validated exactly like its public route
and recorded, whether it succeeds or not.

| Capability | `action`, and `params` |
|---|---|
| `control.playback` | `play`; `pause`; `seek` (`target_time`, `play`); `step` (`seconds`); `tick_rate` (`tick_rate`); `reset` |
| `control.events` | `weather`, `traffic`, `surge` (as [Control](control-api.md)); `edge_override` (`edge`, and the override fields); `signal_toggle` (`node`); `day` (`day`); `module` (`module`, `enabled`); `undo`, `redo` (`count`) |
| `control.world` | `regenerate` |

`GET /fabric/audit?limit=N` returns the record: application, action, parameters, run,
virtual second and outcome. It holds the most recent 2000, in memory, for this
process; each is also written to the system log.

## Directing the view

An application can ask the map to move, and hold layers and places on or off. Both need a person's grant, and
both are requests: **an application asks, and the observer decides.** Nothing here changes a person's settings,
is ever saved, or outlives the application. [Fabric security](security.md#directing-the-view) lists what is
guaranteed.

### Moving the map

`POST /fabric/apps/{id}/view` with the token and `ui.camera`. It answers `202` with the number of the request,
since the observer hasn't seen it yet.

| `action` | Fields | What it does |
|---|---|---|
| `focus` | `x_m`, `y_m`, optional `span_m` | Centres on a point. `span_m` is how many metres to show across |
| `node` | `node`, optional `span_m` | Centres on a junction |
| `edge` | `edge`, optional `span_m` | Centres on a road |
| `bounds` | `min_x_m`, `min_y_m`, `max_x_m`, `max_y_m` | Fits an area |
| `zoom` | `factor`, from 0.25 to 4 | Zooms about the centre. Above 1 is closer |
| `fit` | | Shows the whole network |

```bash
curl -X POST "$API/fabric/apps/$ID/view" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"action": "node", "node": 42, "span_m": 800}'
```

The observer moves with the map's own springs, within its own zoom limits, and jumps if reduced motion is on.
What happened arrives as an event, with the number of the request:

| Event | `reason` | Meaning |
|---|---|---|
| `view.applied` | | The map moved |
| `view.declined` | `person_moved_the_map` | A person moved the map in the last 8 seconds |
| `view.declined` | `tutorial`, `dialog`, `arriving`, `suspended` | Something on screen comes first |
| `view.declined` | `no_position` | The observer couldn't place it |

A request not seen within 5 seconds is dropped with no event, as is every request while no observer is open.
Moving the view and changing what it shows share one allowance, 2 a second with a burst of 4. Beyond that:
`429 RATE_LIMITED`.

### Holding layers and places

`PUT /fabric/apps/{id}/presentation` with the token and `ui.layers`. It replaces all that the application held.
`DELETE` lets go of it.

```json
{"layers": {"weather": false, "vehicles": true}, "places": {"school": false}}
```

Layers: `traffic`, `weather`, `flooding`, `events`, `buildings`, `signals`, `roads`, `vehicles`, `incidents`, `labels`,
`place_names` and `other_places`. Places are by their kind. Anything else, or a value that isn't `true` or `false`, is
`400 INVALID_PRESENTATION`.

What's drawn is worked out in this order, with each step overruling those above it:

1. What the person chose.
2. What applications hold, in the order they registered, so the last one wins and the result is always the same.
3. A person changing that same thing, for as long as the application doesn't ask again.
4. Reduced detail under load: nothing is turned on that the person's own state has off.

The Layers panel names the application holding a layer and offers a way back. All of it ends when the application
leaves, is suspended, stops checking in or loses the grant.

### Paths and colour

These only affect an application's own marks, so `ui.overlays` is enough.

| Field | On | Values |
|---|---|---|
| `color` | Any feature | `"auto"`, or `"#RRGGBB"` |
| `style` | `route`, `path` | `solid`, `dashed`, `dotted`, or `flow`, where dashes run along the line |
| `glow` | `route`, `path` | `true` for a soft light around the line |

Together with `draw_s`, `speed_mps`, `reveal`, `trail`, `loop`, `bounce`, `spring` and the rest, that decides how a
path is drawn and how it moves.

`"auto"` is a colour from the palette, always the same for the same application and feature ID. A named colour is
adjusted before it's drawn: it moves toward white or black, by as little as it takes, until it reaches a contrast of
3:1 with the map in the current theme. With a colour vision mode on, it becomes the nearest colour of that mode's
palette. `flow` stands still under reduced motion.

## What the simulation tells an application

An application can follow the simulation without polling the view API. Choose what arrives in `GET /api/v1/fabric/apps/{id}/events`, which needs `sim.read`:

```http
PUT /api/v1/fabric/apps/{id}/subscriptions
{"topics": ["lifecycle", "world", "news.incident"]}
```

| Topic | Event | When |
| --- | --- | --- |
| `lifecycle` | `lifecycle.changed` | The run starts, pauses, resumes or completes |
| `world` | `world.changed` | A new world replaces this one |
| `news` | `news` | Every item of the news feed |
| `news.<category>` | `news` | Items of one category, such as `news.incident` |

Timers run on the simulation's clock, not the wall's, so they mean the same at any speed:

```http
PUT /api/v1/fabric/apps/{id}/timers/morning
{"at_s": 28800, "every_s": 3600, "data": {"why": "hourly"}}
```

A `timer` event carries `id`, `at_s`, `virtual_s` and your `data`. A timer with `every_s` repeats; one without fires once. Moving back through the day, by a reset or a replay, sets timers going again from where the clock now is. Nothing runs between polls: an application is brought up to date when it asks, so one that follows nothing costs nothing.

## An application's own store

With the `storage` capability, an application has a private key and value store that survives restarts of either side: at most 256 keys and 256 KB. A value is any JSON.

```http
PUT /api/v1/fabric/apps/{id}/storage/preferences
{"theme": "plain"}
```

`GET .../storage` lists the keys and bytes used, and `GET` or `DELETE .../storage/{key}` read or remove one. Going over a limit is refused with `STORAGE_FULL`, and nothing is dropped.

## Messages between applications

With `apps.messages`, one application can send another a message of up to 16 KB. It arrives as a `message` event carrying `from`, `type` and `data`. An application that has not asked to use messages cannot be sent any (`RECIPIENT_NOT_LISTENING`), and sending shares the same rate limit as notifications.

```http
POST /api/v1/fabric/apps/{id}/messages
{"to": "org.example.planner", "type": "route.changed", "data": {"route": "R1"}}
```

## Changing several things at once

`POST /api/v1/fabric/apps/{id}/ui/batch` takes `upsert`, an array of elements, and `remove`, an array of IDs. It applies whole or not at all, so that nothing appears half-updated. Every check comes before any change.

## Health and discovery

`GET /api/v1/fabric/apps/{id}/health`, with the application's token or the operator's, reports its state, last contact, requests made and refused, rate limiting, lease lapses, events waiting and dropped, messages, interface size, stored bytes, timers and topics. The observer shows this on the application's page in Settings, and the launcher uses it to supervise.

`GET /api/v1/fabric/capabilities` needs no token and says what the server offers: slots, widgets, overlay features, capabilities and which of them need a person's permission, motions, tones, topics and limits. Find out from here rather than assuming.

## Components

As well as text, stats, charts and controls, a panel can declare:

| Widget | Shape |
| --- | --- |
| `keyvalues` | `items`: `label`, `value`, optional `tone`. One card with divider lines |
| `table` | `columns`: `label`, optional `align`; `cells`: rows of up to 8 cells. Scrolls within its card, header kept |
| `gauge` | `value` between `min` and `max` (default 0 to 1), `label`, optional `caption` and `tone`. Travels to a new value |
| `bars` | `items`: `label`, `value`, optional `caption` and `tone`. Each scaled to the largest |

## The engine

Every control of the engine is under Fabric. These replace `/api/v1/playback/*` and `/api/v1/control/*`, with the same bodies and responses:

| Route | Does |
| --- | --- |
| `GET /api/v1/fabric/engine/status` | Lifecycle and clock |
| `POST .../engine/start`, `prepare` | Start or prepare a run. Operator only |
| `POST .../engine/play`, `pause`, `stop`, `reset`, `seek`, `step` | Move through simulated time |
| `PUT .../engine/tick-rate` | Set the speed |
| `POST .../engine/day`, `undo`, `redo`; `GET .../engine/history` | Change the day; undo and redo |
| `POST .../engine/events/weather`, `traffic`, `surge` | Schedule an event |
| `PUT .../engine/edges/{id}`; `POST .../engine/signals/{id}`; `PUT .../engine/modules/{module}` | Override a road, toggle a signal, switch a subsystem |

Reading is open, as reading the view is. Changing anything needs the operator's credential (`X-DSTNS-Operator`) or to be the observer (`X-DSTNS-Host`, from its own origin), and otherwise answers `401 AUTHORIZATION_REQUIRED`. An application acts through `POST /api/v1/fabric/apps/{id}/control`, with its token and the capability it was granted, and each action is recorded.

### The legacy API

The older paths still work exactly as they did, so nothing that uses them breaks. Every answer now says it is legacy:

```http
HTTP/1.1 200 OK
Deprecation: true
Warning: 299 DSTNS "Legacy API: please switch to the Fabric API at /api/v1/fabric/engine"
X-DSTNS-Successor: /api/v1/fabric/engine/pause

{"...": "...", "legacy": {"message": "This is the legacy API. It still works, but it will not gain new features: please switch to the Fabric API.", "use": "/api/v1/fabric/engine/pause"}}
```

They will not gain new features, and do not ask for the authorization above. No date has been set for removing them.

## Security

The whole of it, with what each protection does and doesn't do, is in [Fabric and WebFabric security](security.md).

| What | How |
| --- | --- |
| **Who is asking** | An application's bearer token, which it receives once. The server keeps only its SHA-256 hash, so a copy of the store does not give up the token |
| **What it may do** | Capabilities. Some are automatic, and those that interrupt, run code in the page or change the simulation wait for a person |
| **That a request is genuine** | Optional signing with HMAC-SHA-256, below. An application can require it of itself in its manifest |
| **That a response is genuine** | `X-DSTNS-Content-SHA256` on every Fabric response, and a signature on the response to a signed request |
| **That it is private** | TLS, with a build that has it. Below |
| **That the records are true** | The audit log is a hash chain, and the store of applications is sealed |
| **Where a frame comes from** | `frame_origins` in the manifest. A frame from anywhere else is refused, and asking for more origins asks the person again |

### Signing requests

Registering returns a `signing_key` beside the token, once. Sign any request with these three headers, as well as the token:

```text
X-DSTNS-Timestamp: seconds since the epoch, within 60 seconds of the server
X-DSTNS-Nonce:     8 to 128 random characters, never used twice
X-DSTNS-Signature: hex( HMAC-SHA-256( signing_key, canonical ) )

canonical = METHOD \n TARGET \n TIMESTAMP \n NONCE \n hex( SHA-256( BODY ) )
```

`TARGET` is the path with its query, as sent. In Python:

```python
digest = hashlib.sha256(body).hexdigest()
canonical = "\n".join([method, target, timestamp, nonce, digest])
signature = hmac.new(signing_key.encode(), canonical.encode(), hashlib.sha256).hexdigest()
```

The response then carries `X-DSTNS-Response-Signature`, which is `hex(HMAC-SHA-256(signing_key, STATUS \n NONCE \n hex(SHA-256(RESPONSE_BODY))))`, so that the application knows the answer is from the server and to this request. Do not ask for gzip if you mean to check it, because the digest is of the bytes sent.

With `"security": {"require_signatures": true}` in the manifest, the server refuses this application's unsigned requests, so that a stolen token alone is not enough.

| Refusal | Means |
| --- | --- |
| `SIGNATURE_REQUIRED` | Its manifest asks for signing, and this was not signed |
| `SIGNATURE_INVALID` | It does not match this request, or a header is malformed |
| `SIGNATURE_EXPIRED` | The timestamp is over 60 seconds out |
| `SIGNATURE_REPLAYED` | This nonce has been used |

`POST /api/v1/fabric/apps/{id}/credentials/rotate` replaces the token and the key at once. The old ones stop working immediately.

### Encryption

Across a network, use TLS: traffic on `127.0.0.1` does not leave the machine, and signing proves a message is genuine but does not hide it. The server can serve HTTPS itself, from a build that has it:

```sh
cmake -S . -B build -DDSTNS_TLS=ON            # needs OpenSSL
build/dstns_server --tls-cert cert.pem --tls-key key.pem
```

A server asked for TLS that cannot provide it refuses to start, rather than serving in the clear what was meant to be private. The default build does not link OpenSSL, and a gateway in front of it does the same job. Tokens are hashed and the store is readable only by its owner, but what an application keeps in its store is not encrypted on disk: do not put secrets there.

### Integrity of the records

Each audit entry includes the hash of the one before, and its own hash covers all of it: `hash = SHA-256(entry, with previous = the last hash)`. `GET /api/v1/fabric/audit/verify` walks the chain and says where it first breaks. The log is held in memory for the life of the server, so this shows that what is served has not been altered; export it if it must outlast the server.

The store of applications is sealed with HMAC-SHA-256 under a key in a separate file, `fabric-apps.json.key`, readable only by its owner. A store that does not match is not believed: it is set aside as `fabric-apps.json.rejected`, applications register again, and `GET /api/v1/fabric/security` says so. Someone who can read the key can of course also reseal the store, so this catches a changed file, not someone who has already taken over the account.

`GET /api/v1/fabric/security` reports all of this, and the WebFabric page in Settings shows it. `./launcher fabric status` prints it, and exits with a failure if the audit log or the store do not verify.

## Starting applications with the launcher

An application or the operator can say how the launcher should start it. This is only ever a proposal: the server runs nothing, and a person reads it and approves it at the launcher before it can run.

```http
PUT /api/v1/fabric/apps/{id}/launch          # the application, for itself, with its token
PUT /api/v1/fabric/launch/{id}               # the operator, for any application
{"name": "Route planner", "commands": ["python3 planner.py --url {url}"], "cwd": ".", "ready": "fabric", "timeout_s": 60}
```

`GET /api/v1/fabric/launch` lists what is waiting. See [the launcher guide](../guide/operator-cli.md#applications).

## For the observer

`GET /fabric/state?since=R&notifications_since=N` returns `revision`,
`notification_sequence`, `notifications` newer than `N`, and `unchanged`. When
`since` differs from the current revision it also returns `apps`. With `since=0` (`full: true`)
that is everything, with `ui`. After that it is only applications that changed, each with
`ui_patch` (changed elements) and `ui_order` (the IDs now shown), or `ui` if all of it changed,
and `removed` lists applications that were forgotten.

## Errors

| Status and code | Means |
|---|---|
| `400 INVALID_MANIFEST`, `INVALID_ELEMENT`, `INVALID_SETTINGS`, `INVALID_NOTIFICATION`, `UNKNOWN_ACTION` | The request is wrong; `message` says how |
| `401 APP_TOKEN_INVALID` | Missing or wrong token |
| `403 APP_ID_RESERVED`, `APP_NAME_RESERVED` | That name belongs to DSTNS |
| `403 CAPABILITY_NOT_REQUESTED`, `CAPABILITY_NOT_GRANTED` | Add it to the manifest, or wait for a person |
| `403 HOST_REQUIRED` | Only the observer or the operator may do this |
| `403 WORLD_REGENERATION_DISABLED` | The operator turned it off |
| `404 APP_NOT_FOUND`, `ELEMENT_NOT_FOUND` | No such thing |
| `409 APP_ID_CONFLICT` | The ID is taken; present its token |
| `409 APP_NOT_ACTIVE`, `APP_SUSPENDED` | The application is suspended, failed or unloaded |
| `413 UI_TOO_LARGE` | Over 64 elements or 4 MiB |
| `422 APP_INCOMPATIBLE` | The manifest asks for a version this server does not provide |
| `429 RATE_LIMITED`, `APP_LIMIT_REACHED` | Send fewer, or the server holds its 64 applications |
