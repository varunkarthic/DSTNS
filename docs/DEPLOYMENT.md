# Deployment

Local development uses `dstns_server` on port 8090 and Vite on 5173. Container deployment exposes only gateway port 8443. Engine/UI services remain on an isolated Compose network. Persist `logs/`, `data/`, immutable OSM inputs, and production certificates. Terminating the engine exits its primary process; restart policy is intentionally `no`.
