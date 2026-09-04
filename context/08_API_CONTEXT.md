# API Context (08)

- All canonical API endpoints reside under `/api/v1/`.
- Lifecycle starts in `IDLE`. A simulation session is initiated via `POST /api/v1/playback/start`.
- Bulk continuous state delivery is achieved by fetching the immutable topology once via `GET /api/v1/view/topology`, then listening to the SSE dynamic snapshot stream at `GET /api/v1/view/stream`.
- Third-party decision agents interact independently via the UI Overlay API at `/ui-api/v1/*`.
