# System API (`/api/v1/system/*`)

The System API manages server diagnostics, process health, and graceful container termination.

## Endpoints

### 1. Health Status
- **Endpoint**: `GET /api/v1/system/health` (Alias: `GET /health`)
- **Response**: `200 OK`
```json
{
  "ok": true,
  "service": "dstns",
  "version": "1.0.0",
  "status": "healthy"
}
```

### 2. Graceful Process Termination
- **Endpoint**: `POST /api/v1/system/terminate` (Alias: `POST /terminate`)
- **Purpose**: Flushes SQLite WAL logs, closes active streams and SUMO sockets, and terminates the C++ process with exit code 0.
- **Response**: `200 OK`
```json
{
  "ok": true,
  "message": "server terminating gracefully"
}
```
In Docker environments, this halts the engine container.
