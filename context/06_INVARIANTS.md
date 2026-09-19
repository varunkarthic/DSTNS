# System Invariants (06)

1. **Seed & Manifest Determinism**: Same `(Seed128, ScenarioConfig, ControlJournal)` $\implies$ exact identical `scenario_hash`, `graph_hash`, and state snapshots.
2. **RNG Module Isolation**: Varying random draws in module $A$ (e.g. DWS) never changes random values in module $B$ (e.g. bus stops or topology).
3. **Canonical Identifier Stability**: `NodeId` and `EdgeId` are 0-indexed contiguous integers assigned after spatial/topological sorting, independent of hash-table memory layout.
4. **Reverse Twin Reciprocity**: `edges[edges[i].reverse_twin].reverse_twin == i`.
5. **Single Authoritative Writer**: Only the simulation engine thread mutates `GraphStore` state; API threads submit commands.
6. **Bounded Physical Quantities**: All normalized dynamic fields (congestion, weather intensity, flood level, simulation percentage) are strictly clamped in $[0, 1]$.
7. **Non-Destructive Overlays**: Manual control events are layered overlays; undoing them restores the exact base deterministic state.
8. **True Metric Scale**: Node positions and edge `length_m` are real metres from the projection origin — two junctions one kilometre apart differ by 1000 in `x_m`/`y_m`, within the 1% tolerance of the local equirectangular approximation. Client rendering scale never feeds back into stored geometry.
9. **Seed-to-Place Correspondence**: One seed denotes exactly one city and anchor, and therefore exactly one cached tile filename. A map that cannot be obtained raises `MapFetchError`; no other map is ever substituted, so a graph's geography always matches the seed that produced it.
10. **Display Layers Are Inert**: UI layer, clock-format, motion and viewport state never reach the core and never alter computed state.
11. **Backpressure Never Touches the Model**: ASB changes only the rate at which virtual time is advanced and what the observer displays. It never alters computed state, so a run throttled to 1x and the same run at 20x reach identical state at the same virtual second.
12. **The Operator's Request Survives Governance**: while ASB caps the multiplier, the requested value is retained and restored on recovery; the operator never has to re-enter it.
13. **Signals Sit at Intersections**: every controller is placed at a node where at least three ways meet, and offsets follow travel time so adjacent junctions turn over in sequence rather than independently.
14. **Configuration Is Presentation Only**: nothing in `config/ui-config.json`, and nothing a viewer overrides, is transmitted to the core or changes what it computes.
