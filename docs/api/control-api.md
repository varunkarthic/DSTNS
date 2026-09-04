# Control API (`/api/v1/control/*`)

The Control API manages runtime simulation parameters, manual overlays, road closures, module toggles, and undo/redo operations.

## Endpoints

### 1. Tick Rate Control (`PUT /api/v1/control/tick-rate`)
- **Request Body**:
```json
{
  "tick_rate": 0.5
}
```
- **Validation**: Rejects values $\le 0$ or $> 10$.
- **Response**:
```json
{
  "ok": true,
  "tick_rate": 0.5,
  "target_virtual_rate": 36.0,
  "state_revision": 1421
}
```

### 2. Module Toggles (`PUT /api/v1/control/modules/{module}`)
- Supported modules: `traffic`, `dws`, `signals`, `buildings`, `flooding`, `news`.
- **Request Body**:
```json
{
  "enabled": false
}
```

### 3. Manual Weather Overlay (`POST /api/v1/control/events/weather`)
- **Request Body**:
```json
{
  "epicenter_node": 12,
  "intensity": 0.85,
  "radius_m": 800.0,
  "duration_virtual_minutes": 30.0,
  "flood_gain": 0.6
}
```

### 4. Road Edge Override (`PUT /api/v1/control/edges/{edge_id}`)
- **Request Body**:
```json
{
  "speed_multiplier": 0.5,
  "capacity_multiplier": 0.5,
  "closed": false
}
```

### 5. Undo / Redo (`POST /api/v1/control/undo`, `POST /api/v1/control/redo`)
- **Request Body**:
```json
{
  "count": 1
}
```
Reverses or reapplies dynamic control overlays in the journal.
