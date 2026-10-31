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
| `dialog` | `title`, `body`, `actions` (`id`, `label`, `tone`; up to 3) |
| `overlay` | `features` |

`opens` names one of the application's panels; without it, activating the element
sends an event. `icon` names an icon the observer has, such as `pin`, `gauge` or
`signal`; an unknown name draws the information icon.

**Widgets:** `text` (`text`); `stat` (`label`, `value`, `tone`); `progress` (`label`,
`value` from 0 to 1, `tone`); `button` (`id`, `label`, `tone`); `toggle` (`id`,
`label`, `value`); `select` (`id`, `label`, `value`, `options`); `slider` (`id`,
`label`, `value`, `min`, `max`, `step`).

**Overlay features**, in the core's metres (see the [View API](view-api.md)):
`{"type": "point" | "circle", "x_m", "y_m", "radius_m", "label", "tone"}` and
`{"type": "line" | "polygon", "points": [[x_m, y_m], ...], "tone"}`.

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

## For the observer

`GET /fabric/state?since=R&notifications_since=N` returns `revision`,
`notification_sequence`, `notifications` newer than `N`, and `unchanged`. When
`since` differs from the current revision it also returns `apps`, including declared
UI that is currently shown.

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
| `413 UI_TOO_LARGE` | Over 64 elements or 512 KiB |
| `422 APP_INCOMPATIBLE` | The manifest asks for a version this server does not provide |
| `429 RATE_LIMITED`, `APP_LIMIT_REACHED` | Send fewer, or the server holds its 64 applications |
