# Reproducibility Contract

DSTNS guarantees bit-for-bit logical reproducibility of simulation outcomes across platforms under identical inputs:
- Master `Seed128` (128-bit integer)
- `ScenarioConfig` (resolved configuration parameters)
- OSM input snapshot / fixture
- Algorithm versions (`v1.0.0`)
- `ControlJournal` (ordered sequence of operator interactions)

## Verification
The dedicated verification CLI `dstns_replay_verify` executes dual compilations and checkpoint-seek reconstructions, asserting exact equality of `graph_hash`, `event_hash`, and `scenario_hash`.
