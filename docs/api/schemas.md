# API Schemas & Data Types

## Data Type Standards
- `NodeId`: Strong unsigned 32-bit integer identifier.
- `EdgeId`: Strong unsigned 32-bit integer identifier.
- `Seed128`: 128-bit hexadecimal string (e.g. `0x123456789ABCDEF0123456789ABCDEF0`).
- `SimulationPercentage`: Normalized float in range $[0.0, 1.0]$.
- `SpeedMps`: Metric speed in meters per second ($1.0\text{ m/s} = 3.6\text{ km/h}$).
- `CapacityVph`: Vehicles per hour.
- `StateRevision`: Monotonically increasing unsigned 64-bit integer tracking committed dynamic state updates.
