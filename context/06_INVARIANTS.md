# System Invariants (06)

1. **Seed & Manifest Determinism**: Same `(Seed128, ScenarioConfig, ControlJournal)` $\implies$ exact identical `scenario_hash`, `graph_hash`, and state snapshots.
2. **RNG Module Isolation**: Varying random draws in module $A$ (e.g. DWS) never changes random values in module $B$ (e.g. bus stops or topology).
3. **Canonical Identifier Stability**: `NodeId` and `EdgeId` are 0-indexed contiguous integers assigned after spatial/topological sorting, independent of hash-table memory layout.
4. **Reverse Twin Reciprocity**: `edges[edges[i].reverse_twin].reverse_twin == i`.
5. **Single Authoritative Writer**: Only the simulation engine thread mutates `GraphStore` state; API threads submit commands.
6. **Bounded Physical Quantities**: All normalized dynamic fields (congestion, weather intensity, flood level, simulation percentage) are strictly clamped in $[0, 1]$.
7. **Non-Destructive Overlays**: Manual control events are layered overlays; undoing them restores the exact base deterministic state.
