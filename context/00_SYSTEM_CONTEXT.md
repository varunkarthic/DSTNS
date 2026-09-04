# System Context (00)

**DSTNS — Deterministic Spatiotemporal Transport Network Simulator** is a high-performance C++20 simulation framework for urban transport networks with an independent React/MapLibre GL visualization engine and SUMO microscopic physics coupling.

## Core Conceptual Model
- **Spatiotemporal Dynamic Graph**: $G(t) = (V, E, \mathbf{X}_V(t), \mathbf{X}_E(t))$.
- **Deterministic Precompilation**: Master 128-bit seed seeds isolated RNG domains for topology, bus stops, buildings, signals, traffic hotspots, and weather events.
- **Three-Clock Model**: Playback clock $t_P \in [0, T_P]$, virtual day clock $t_D \in [0, 86399]$, and SUMO physics clock $t_{\text{SUMO}}$.
- **Decoupled Delivery**: Immutable static topology is transferred once; lightweight indexed dynamic state vectors stream every second.
