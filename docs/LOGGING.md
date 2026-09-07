# Logging & Diagnostics

DSTNS logs are located in `logs/`:
- `logs/system.log`: Real-time formatted event and debugging log.
- `logs/runtime.db`: SQLite database recording API requests, scheduled/manual events, and lifecycle changes.

## Inspecting Logs via Operator Console
```bash
./launcher logs [system|api|event|playback]
# or
python3 launcher.py logs
# or
node dstns-operator-cli/dstns.mjs logs
```
Options:
- `system`: Print last 100 lines of system.log.
- `api`: Query recent API interactions from SQLite.
- `event`: Query executed event log from SQLite.
- `playback`: Query lifecycle transition log.
