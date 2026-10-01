# Playback controls

The observer's command rail controls playback. Every control maps to a core
operation:

| Control | Endpoint | Behaviour |
|---|---|---|
| Play / Pause | `POST /api/v1/playback/play`, `/pause` | Start or stop virtual time |
| Back | `POST /api/v1/playback/seek` | Move back by the skip interval (default 15 minutes); restores the nearest checkpoint and replays deterministically |
| Forward | `POST /api/v1/playback/seek` | Move forward by the skip interval |
| Step | `POST /api/v1/playback/step` | Advance by the step interval (default 1 minute) and hold paused |
| Reset | `POST /api/v1/playback/seek` to 0, after confirmation | Replay the same scenario from 00:00:00 |
| Speed | `PUT /api/v1/control/tick-rate` | 0.25×, 0.5×, 1×, 2×, 3× or 5× the configured pace |
| Generate New World | `POST /api/v1/world/regenerate`, after confirmation | Replace the world with one from a fresh seed; it starts paused |
| Terminate | `POST /api/v1/system/terminate`, after confirmation | Stop the run and the server |

Checkpoints are captured every 15 virtual minutes. Speed changes pacing only,
never physics: stepping, seeking and playing to the same time give identical
state. Adaptive Simulation Backpressure can hold the applied speed below the
request; the request is restored automatically once the interface is in sync.

Starting a run with a chosen configuration remains a CLI operation.

See the [observer interface guide](observer-interface.md#command-rail), the
[API reference](../api/reference.md), and the [modernization guide](../history/modernization.md) for
the aggregate model, saved configurations and checkpoint replay.
