# Replay & Reproducibility Verification (`dstns::replay`)

## Purpose
The Replay subsystem verifies byte-for-byte and logical state reproduction across simulation runs given the same master seed, configuration, and control history.

## Invariants & Hashes
Every simulation scenario is fingerprinted by three cryptographic digests:
1. `graph_hash` = $\text{SHA-256}(\text{Nodes}_{\text{canonical}} \parallel \text{Edges}_{\text{canonical}})$
2. `event_hash` = $\text{SHA-256}(\text{DwsEvents} \parallel \text{PlannedTrips} \parallel \text{Signals})$
3. `scenario_hash` = $\text{SHA-256}(\text{graph\_hash} \parallel \text{event\_hash} \parallel \text{config\_json})$

## Replay Invariant
Given identical `(Seed128, ScenarioConfig, ControlJournal)`:
- `graph_hash(Run 1) == graph_hash(Run 2)`
- `scenario_hash(Run 1) == scenario_hash(Run 2)`
- Dynamic state snapshots at simulated time $t$ match with 0 divergence.
