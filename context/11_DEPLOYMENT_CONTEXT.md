# Deployment Context (11)

- **Docker Compose**: `docker/docker-compose.yml` runs `dstns-engine`, `dstns-ui`, and `dstns-gateway`.
- **Ports**:
  - `8443`: Public HTTPS gateway (serves UI, reverse-proxies `/api/v1/*` and `/ui-api/v1/*`).
  - `8090`: Internal C++ API server.
  - `3000`: Internal UI / Fastify server.
- **TLS Configuration**: Caddy container generates an automatic 7-day development self-signed certificate if no custom certificates are mounted in `docker/certificates/`.
