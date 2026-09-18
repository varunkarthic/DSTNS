# UI engine

React/TypeScript/Vite implements the alpha design with reusable frosted surfaces and locally bundled fonts. `useSimulation` polls revisioned status/snapshots without overlap, caches topology per run and bounds news/toasts. `NetworkMap` preprocesses projected geometry once and uses separate static/dynamic canvases, viewport culling and zoom-dependent labels. The implementation uses Canvas 2D.

The observer exposes pause/resume/speed and display-layer controls. Delayed custom tooltips inspect actual edge/signal/POI/weather state. A persistent Reduce Motion button respects the OS preference initially. `EventPanel` separates activity, scheduled events and retained execution history; `report.ts` creates the matching PDF locally.

See [modernization](../modernization.md) for formulas, data contracts, rendering semantics and model limits. The optional external annotation service in `ui-engine/server/` retains its existing API independently; neither the previous nor current production map consumes that service automatically.
