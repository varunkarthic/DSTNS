# Reproducibility Contract

DSTNS guarantees bit-for-bit logical reproducibility of simulation outcomes across platforms under identical inputs:
- Master `Seed128` (128-bit integer)
- `ScenarioConfig` (resolved configuration parameters)
- OSM input snapshot / fixture
- Algorithm versions (`v1.0.0`)
- `ControlJournal` (ordered sequence of operator interactions)

`map_hash` is the SHA-256 digest of the complete OSM input byte stream. Any source-byte change therefore changes `map_hash` and the derived `scenario_hash`, even when it does not alter the selected road topology or `graph_hash`.

## Verification
The dedicated verification CLI `dstns_replay_verify` executes dual compilations and checkpoint-seek reconstructions, asserting exact equality of `graph_hash`, `event_hash`, and `scenario_hash`.
