# API Context (08)

- All canonical API endpoints reside under `/api/v1/`.
- Lifecycle starts in `IDLE`. `POST /api/v1/playback/start` returns `202` as soon as preparation is accepted; compilation and map download run in the background while status remains `PREPARING`.
- Poll `/api/v1/playback/status` for the terminal lifecycle and `/api/v1/system/map-status` for map-fetch progress; the observer remains available throughout.
- Bulk continuous state delivery is achieved by fetching the immutable topology once via `GET /api/v1/view/topology`, then listening to the SSE dynamic snapshot stream at `GET /api/v1/view/stream`.
- Third-party decision agents interact independently via the UI Overlay API at `/ui-api/v1/*`.
