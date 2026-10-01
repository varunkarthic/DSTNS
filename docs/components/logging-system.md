# Runtime logging (`dstns::RuntimeLogger`)

## Purpose
`RuntimeLogger` provides dual persistence in its caller-supplied directory: structured SQLite journaling (`runtime.db`) with Write-Ahead Logging (WAL) and text logs (`system.log`).

## Initialization
Constructing `RuntimeLogger(directory)` creates the directory, opens or creates `runtime.db`, enables SQLite WAL mode, creates missing tables, and appends an initialization line to `system.log`. Existing logs and rows are not truncated by the constructor or by an engine reset.

## SQLite Database Tables
1. `runtime_metadata`: Schema for run ID, seed, scenario hash, timestamps, and status. The current logger exposes the table but does not populate it.
2. `api_log`: Stores incoming HTTP request/response metrics, method, path, status, and execution duration.
3. `event_schedule`: Schema for scheduled events; the current logger does not populate it.
4. `event_log`: Records control journal entries with virtual timestamp and JSON payload.
5. `lifecycle_log`: Records lifecycle transitions and state revisions.

The query API intentionally exposes only `api_log`, `event_log`, and `lifecycle_log`.
