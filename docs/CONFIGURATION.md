# Configuration Guide

DSTNS configuration is stored in `config/defaults.json` and validated strictly on startup:

```json
{
  "playback": {
    "duration_seconds": 60,
    "tick_rate": 1.0,
    "day": -1
  },
  "network": {
    "max_nodes": 50000,
    "grid_width": 12,
    "grid_height": 10
  },
  "modules": {
    "traffic": true,
    "signals": true,
    "buildings": true,
    "dws": true,
    "flooding": true,
    "news": true
  },
  "dws": {
    "frequency": 3
  },
  "api": {
    "host": "0.0.0.0",
    "port": 8090
  }
}
```

## Validation Constraints
- `playback.duration_seconds`: Integer in $[60, 3600]$.
- `playback.tick_rate`: Floating-point in $(0, 100]$.
- `dws.frequency`: Non-negative integer (e.g. 0 to 8).
