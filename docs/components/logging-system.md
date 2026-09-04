# Logging Subsystem (`dstns::logging`)

## Purpose
The Logging Subsystem provides dual persistence: structured SQLite database journaling (`logs/runtime.db`) with Write-Ahead Logging (WAL) and text logs (`logs/system.log`).

## Ephemeral Epoch Reset
When a new simulation session is launched or tests/resets are performed:
- `logs/system.log` is truncated and initialized with the new run header.
- `logs/runtime.db` tables are initialized or reset.
- Source configuration (`config/defaults.json`) and cached OSM files are preserved.

## SQLite Database Tables
1. `runtime_metadata`: Stores `run_id`, `seed`, `scenario_hash`, `graph_hash`, start times, and resolved config JSON.
2. `api_log`: Stores incoming HTTP request/response metrics, method, path, status, and execution duration.
3. `event_log`: Records scheduled and manual events, virtual timestamp, entity IDs, news message, and undo status.
4. `control_log`: Tracks all runtime control overrides and module toggles.
5. `playback_log`: Logs all lifecycle state transitions (`IDLE -> PREPARING -> RUNNING -> PAUSED`).
