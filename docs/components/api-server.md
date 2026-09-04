# API Server Subsystem (`dstns::api`)

## Purpose
The API Server exposes HTTP/REST and streaming (Server-Sent Events) interfaces for simulation control, topology retrieval, bulk state delivery, news events, and system administration.

## API Namespaces
- `/api/v1/playback/*`: Primary simulation lifecycle endpoints (`/start`, `/pause`, `/play`, `/seek`, `/stop`, `/reset`, `/status`).
- `/api/v1/view/*`: Read-only queries for topology, snapshots, static sub-entities, and runtime logs.
- `/api/v1/control/*`: Runtime modifiers for tick rate, module toggles, manual weather/traffic overlays, road closures, and undo/redo.
- `/api/v1/news/*`: Structured live news events and historical timeline.
- `/api/v1/system/*`: Health status and graceful shutdown termination.

## Single-Writer Architecture
API worker threads do not directly mutate simulation state. Mutating requests enqueue commands onto a synchronized thread-safe queue. The single simulation engine loop consumes commands, applies state changes, commits a new `state_revision`, and updates the shared immutable snapshot.
