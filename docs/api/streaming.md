# Streaming Architecture (`/api/v1/view/stream`)

## Protocol & Delivery
- DSTNS streams full dynamic simulation state snapshots via **Server-Sent Events (SSE)** at `Content-Type: text/event-stream`.
- Update cadence: Approximately 1 frame per real-world second.
- Transport: Encrypted via HTTPS / TLS in production.

## Two-Layer Topology & State Decoupling
1. **Layer 1 (Static Topology)**: Client fetches immutable road geometry once via `GET /api/v1/view/topology`.
2. **Layer 2 (Dynamic Snapshot Stream)**: Stream sends compact indexed dynamic vectors matching the static node and edge arrays. This eliminates resending coordinates and unchanging road shapes every second.

## Reconnection & State Recovery
Each frame includes `state_revision` and `run_id`. If a client disconnects:
1. Re-open SSE stream.
2. If `run_id` matches, continue rendering.
3. If `run_id` changed, fetch fresh `GET /api/v1/view/topology`.
