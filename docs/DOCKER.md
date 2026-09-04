# Docker & Container Deployment Guide

DSTNS provides a unified, self-contained multi-stage Docker container packaging the C++ Simulation Engine (with Eclipse SUMO microscopic physics integration) and the compiled React Web UI.

---

## 1. Quick Start with Docker Compose

The simplest way to build and run DSTNS is using the root `docker-compose.yml`:

```bash
# Build and launch DSTNS in detached mode
docker compose up --build -d

# Follow live container logs
docker compose logs -f

# Check container health status
docker compose ps
```

### Access Points
* **Web UI Dashboard**: [http://127.0.0.1:8090/](http://127.0.0.1:8090/)
* **REST API Endpoint**: [http://127.0.0.1:8090/api/v1/playback/status](http://127.0.0.1:8090/api/v1/playback/status)
* **Health Check**: [http://127.0.0.1:8090/health](http://127.0.0.1:8090/health)

---

## 2. Port & Network Interface Mapping

In `docker-compose.yml`, the engine binds to port `8090`:
```yaml
ports:
  - "0.0.0.0:8090:8090"
```
* Binds to `0.0.0.0` inside the container and maps host port `8090` to container port `8090`.
* Accessible from both `http://127.0.0.1:8090/` and `http://localhost:8090/`, as well as over the local network IP.

---

## 3. Persistent Volumes

The container mounts two named volumes:
* `dstns_logs`: Stores SQLite runtime logs (`runtime.db`) and human-readable logs (`system.log`).
* `dstns_data`: Stores scenario exports, SUMO tripinfo outputs, and simulation checkpoints.

```yaml
volumes:
  - dstns_logs:/app/logs
  - dstns_data:/app/data
```

---

## 4. Standalone Docker Build & Run

To build and run directly with Docker CLI without compose:

```bash
# 1. Build the multi-stage image
docker build -t dstns-simulation:latest .

# 2. Run container with port mapping and volume mounts
docker run -d \
  --name dstns_engine \
  -p 0.0.0.0:8090:8090 \
  -v dstns_logs:/app/logs \
  -v dstns_data:/app/data \
  --restart unless-stopped \
  dstns-simulation:latest

# 3. Verify health
curl -s http://127.0.0.1:8090/health | jq .
```

---

## 5. Stopping the Container

```bash
# Using Docker Compose
docker compose down

# Using Docker CLI
docker stop dstns_engine && docker rm dstns_engine
```
