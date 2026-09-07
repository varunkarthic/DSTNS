# Glossary of Terms (12)

- **CRFG**: Connected Radial Frontier Growth — the deterministic algorithm that expands a connected road subgraph from an anchor node up to `max_nodes`.
- **DRNCP**: Deterministic Road-Network Canonicalization Pipeline — assigns stable 0-indexed `NodeId` and `EdgeId` identifiers based on geometric sorting.
- **DWS**: Deterministic Weather Simulation — deterministic localized storms governed by compact Wendland kernels.
- **Reverse Twin**: The reciprocal opposing directed edge for a bidirectional road segment.
- **Three-Clock Model**: Decoupled playback time $t_P$, virtual day clock $t_D$, and microscopic physics time $t_{\text{SUMO}}$.
- **Tick Rate**: Real-time multiplier applied to base playback rate in $(0, 10]$.
- **State Revision**: Monotonically increasing counter for published immutable dynamic snapshots.
