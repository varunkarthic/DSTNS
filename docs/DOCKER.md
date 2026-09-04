# Docker & Container Deployment

DSTNS is fully containerized into 3 orchestrated services defined in `docker/docker-compose.yml`:

```
                 [ Client Browser ]
                         |
                 (HTTPS Port 8443)
                         |
                         v
             +-----------------------+
             |     dstns-gateway     |  (Caddy / Reverse Proxy)
             +-----------------------+
                |                 |
         (HTTP /api/v1)    (HTTP /ui-api/v1 & Static Assets)
                |                 |
                v                 v
      +-----------------+   +---------------+
      |  dstns-engine   |   |   dstns-ui    |
      | (C++ / SUMO API)|   | (Node/Fastify)|
      +-----------------+   +---------------+
```

## Quick Start
```bash
docker compose -f docker/docker-compose.yml up --build
```
Access UI at `https://localhost:8443/`.
Access API at `https://localhost:8443/api/v1/`.
