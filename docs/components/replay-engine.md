# Replay

Replay is not a separate class. It is the combination of three properties of
`SimulationEngine` and `ScenarioCompiler`:

1. **Deterministic compilation**: the same seed, configuration and bytes give
   the same scenario and hashes.
2. **Fixed-step physics**: one virtual second per step, whatever the speed.
3. **Checkpoint restore**: `restore_to` reloads a checkpoint and `step_to`
   replays forward.

## Hashes

`ScenarioCompiler::calculate_hashes`:

| Hash | Over |
|---|---|
| `graph_hash` | Canonical node IDs, OSM node IDs, positions rounded to the millimetre, and edge identity and topology fields |
| `event_hash` | Scheduled weather and planned-trip fields (signal plans are not included) |
| `scenario_hash` | The seed, `map_hash`, `graph_hash`, `event_hash` and the resolved day |

## What a checkpoint holds

Node and edge dynamic state, the event runtime (heap, history, demand), the
congestion tracker, and the news cursor. Operator controls are deliberately
**not** part of a checkpoint: signal overrides, surges and manual rain live
beside it, and edge overrides are carried across a restore, so an operator's
action stands until undone.

## Verifying

```bash
./build/dstns_replay_verify 382923
```

compiles twice and runs two independent engines to 12,345 s on a grid and on
the bundled real district, comparing every hash and the full snapshot. The
`dstns_replay_reproducibility` CTest does the same in CI. See
[Reproducibility](../concepts/reproducibility.md).

There is no replay file format: a run is reproduced from its seed and
configuration (a [saved seed](../guide/seeds-and-places.md#saving-and-sharing-configurations)),
not from a recorded journal of operator actions.
