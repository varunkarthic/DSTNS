# API Examples & Curl Commands

## 1. Check Server Health & SUMO Engine Status
```bash
curl -s http://127.0.0.1:8090/health | jq
curl -s http://127.0.0.1:8090/api/v1/system/info | jq
```

## 2. Start a 20-Minute (1200s) Weekday Simulation
```bash
curl -s -X POST http://127.0.0.1:8090/api/v1/playback/start \
  -H "Content-Type: application/json" \
  -d '{
    "seed": "0x123456789ABCDEF0",
    "playback_duration_seconds": 1200,
    "day": 0,
    "tick_rate": 1.0,
    "modules": {"traffic": true, "signals": true, "buildings": true, "dws": true},
    "dws": {"frequency": 4}
  }' | jq
```

## 3. Pause Simulation
```bash
curl -s -X POST http://127.0.0.1:8090/api/v1/playback/pause | jq
```

## 4. Seek to 15:30:00 (55,800 virtual seconds)
```bash
curl -s -X POST http://127.0.0.1:8090/api/v1/playback/seek \
  -H "Content-Type: application/json" \
  -d '{"target_time": "15:30:00"}' | jq
```

## 5. Adjust Tick Rate to 0.5x
```bash
curl -s -X PUT http://127.0.0.1:8090/api/v1/control/tick-rate \
  -H "Content-Type: application/json" \
  -d '{"tick_rate": 0.5}' | jq
```

## 6. Inject Manual Weather Event
```bash
curl -s -X POST http://127.0.0.1:8090/api/v1/control/events/weather \
  -H "Content-Type: application/json" \
  -d '{
    "epicenter_node": 10,
    "intensity": 0.8,
    "radius_m": 750,
    "duration_virtual_minutes": 30,
    "flood_gain": 0.6
  }' | jq
```

## 7. Export SUMO Scenario XML Bundle
```bash
curl -s -X POST http://127.0.0.1:8090/api/v1/export/sumo \
  -H "Content-Type: application/json" \
  -d '{"directory": "data/sumo_export"}' | jq
```

## 8. Run SUMO Microscopic Physics Simulation
```bash
curl -s -X POST http://127.0.0.1:8090/api/v1/system/sumo-simulate \
  -H "Content-Type: application/json" \
  -d '{"directory": "data/sumo_run", "begin_s": 0, "end_s": 3600}' | jq
```

## 9. Graceful Termination
```bash
curl -s -X POST http://127.0.0.1:8090/api/v1/system/terminate | jq
```
