# HTTP API (`dstns::ApiServer`)

## Purpose
The API Server exposes HTTP/REST and one-shot Server-Sent Events-formatted responses for simulation control, topology retrieval, bulk state delivery, news events, and system administration.

## API Namespaces
- `/api/v1/playback/*`: Primary simulation lifecycle endpoints (`/start`, `/pause`, `/play`, `/seek`, `/stop`, `/reset`, `/status`).
- `/api/v1/view/*`: Read-only queries for topology, snapshots, static sub-entities, and runtime logs.
- `/api/v1/control/*`: Runtime modifiers for tick rate, module toggles, manual weather/traffic overlays, road closures, and undo/redo.
- `/api/v1/news/*`: Structured live news events and historical timeline.
- `/api/v1/system/*`: Health status and graceful shutdown termination.

## Concurrency Model
`ApiServer` handlers call `SimulationEngine` methods directly. The engine serializes reads, controls, and its background playback loop with a recursive mutex; there is no separate API command queue. Undoable controls are recorded as `AppliedCommand` entries after the mutation is accepted.
