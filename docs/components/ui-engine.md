# UI Engine (`ui-engine`)

## Purpose
The UI Engine is an independent React 19 + TypeScript + Vite web application utilizing MapLibre GL JS for hardware-accelerated WebGL rendering of the canonical road network, dynamic traffic congestion, weather storm overlays, and interactive playback controls.

## Responsibilities
- Render the exact canonical road graph from `/api/v1/view/topology` using MapLibre GL GeoJSON layers.
- Poll bulk dynamic state from `/api/v1/view/snapshot`; the engine also exposes one-shot SSE-formatted snapshot and news responses for external clients.
- Render dynamic edge colors based on selectable modes: `Composite`, `Traffic`, `Weather`, `Flood`, `Speed`, `Capacity`.
- Provide interactive controls: Playback Start modal, Pause/Resume, Seek slider, Tick Rate slider, and Module toggles.
- Display detailed Node and Edge inspector sidebars upon map feature click.
- Expose an independent **UI Overlay API** (`/ui-api/v1/*`) via a dedicated Node.js/Fastify gateway in `ui-engine/server/` for third-party decision agent visualization.

## Visual Color Scales
- **Free**: `#4caf50` (Neutral green)
- **Low Congestion**: `#ffeb3b` (Yellow)
- **Medium Congestion**: `#ff9800` (Orange)
- **High Congestion**: `#f44336` (Red)
- **Critical / Blocked**: `#b71c1c` (Dark red)
- **Flood Layer**: `#00e5ff` (Cyan) with alpha blending.
- **Weather Storm**: `#2979ff` translucent circular radial gradient.
