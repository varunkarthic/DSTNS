# Troubleshooting Guide

## 1. Port 8090 or 8443 already in use
Check if an existing DSTNS instance or gateway is running:
```bash
lsof -i :8090
kill -9 <PID>
```

## 2. Health check timeout during startup
Ensure SQLite permissions and directory write access in `logs/`:
```bash
./scripts/reset.sh
```

## 3. Self-signed certificate warnings in Browser
The development gateway creates a local self-signed TLS cert for HTTPS. Click "Advanced -> Proceed to localhost" in Chrome/Firefox or mount trusted production certificates into `docker/certificates/`.
