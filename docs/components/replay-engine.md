# Replay Behavior (`dstns::SimulationEngine`)

## Purpose
Replay is not a separate namespace, class, or runtime service. `SimulationEngine::restore_to` restores a retained checkpoint and `SimulationEngine::step_to` deterministically advances physics to the requested time. The standalone `dstns_replay_verify` tool and replay CTest compare independent runs.

## Invariants & Hashes
Every simulation scenario is fingerprinted by three implementation-defined cryptographic digests:

1. `graph_hash` hashes canonical node IDs, source node IDs, millimetre-rounded positions, and selected edge identity/topology fields.
2. `event_hash` hashes selected DWS-event and planned-trip fields. Signal plans are not currently included.
3. `scenario_hash` hashes the seed, `map_hash`, `graph_hash`, `event_hash`, and resolved day value.

These descriptions intentionally match `ScenarioCompiler::calculate_hashes`; they are not a promise that every field in each object is covered.

## Replay Invariant
For identical `Seed128` and `ScenarioConfig`, with equivalent supported control state:
- `graph_hash(Run 1) == graph_hash(Run 2)`
- `scenario_hash(Run 1) == scenario_hash(Run 2)`
- Dynamic state snapshots at simulated time $t$ match with 0 divergence.

Checkpoints contain node state, edge state, news-log length, and the next news identifier. They do not serialize a general `ControlJournal`; callers must not treat arbitrary external control histories as an implemented replay-file format.
