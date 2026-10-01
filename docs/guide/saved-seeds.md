# Saved seeds

A **saved seed** is a named, complete run configuration: the seed, the day type, the
duration, the speed, the module switches, the map choice and, for a pinned map, a
verified copy of the map itself. Save a configuration once and start exactly the same
run again later by name, on the same machine or after copying the store to another.

## When to use one

| Situation | Use |
|---|---|
| You want to see a world again | The seed alone: `./launcher start --seed 382923` |
| You want the same world with the same day type, duration, speed and modules | A saved seed |
| You ran a map file you supplied and want to protect the experiment against the file changing | A saved seed, which keeps a checksummed copy of the file |
| You want to give a run a memorable name, with a note on why it matters | A saved seed, with `--description` |

## Commands

| Command | Does |
|---|---|
| `./launcher start … --save-seed ID [--description TEXT]` | Saves the configuration of this run, then starts it |
| `./launcher seeds save ID [run flags] [--description TEXT]` | Saves a configuration without starting anything |
| `./launcher seeds list` | Lists saved seeds: ID, seed, creation time, description, map selection version |
| `./launcher seeds inspect ID` | Prints one saved seed in full, including its resolved configuration |
| `./launcher start --saved-seed ID` | Starts a run from a saved seed |
| `./launcher seeds delete ID` | Deletes a saved seed |

`seeds save` accepts the same run flags as `start`: `--seed`, `--day-type`,
`--duration`, `--speed`, `--max-nodes` and `--osm-file`. The `seeds` commands print
JSON, so they can be used from scripts.

### Save and start

```bash
./launcher start --seed 382923 --day-type weekend --save-seed harbour-weekend \
                 --description "Weekend baseline for the signal study"
```

### Save without starting

```bash
./launcher seeds save morning-peak --seed 2026 --speed 2 --description "Dense centre, weekday"
./launcher seeds save campus --osm-file data/maps/campus.osm.xml --seed 42
```

### Inspect

```bash
./launcher seeds list
./launcher seeds inspect harbour-weekend
```

```json
{
  "id": "harbour-weekend",
  "seed": "382923",
  "created_at": "2026-10-01T12:00:00+00:00",
  "description": "Weekend baseline for the signal study",
  "map_version": "urban-crfg-v3",
  "map_sha256": "auto",
  "config": { "seed": "382923", "day": 1, "playback_duration_seconds": 3600,
              "tick_rate": 1, "map": { "osm_file": "auto", "max_nodes": 50000 },
              "modules": { "traffic": true, "signals": true, "...": "..." },
              "map_selection_version": "urban-crfg-v3", "saved_seed_id": "harbour-weekend" }
}
```

### Replay

```bash
./launcher start --saved-seed harbour-weekend
```

`--saved-seed` cannot be combined with `--seed`. Any other run flag given with it,
such as `--speed 3`, overrides the saved value for that run only, and the run is then
no longer an exact replay of the saved configuration.

## What is stored

| Field | Contents |
|---|---|
| `id` | The name, unique within the store |
| `seed` | The seed exactly as typed, in decimal |
| `created_at` | When it was saved, in UTC |
| `description` | Your note, up to 1,000 characters |
| `map_version` | The seed-to-place algorithm, `urban-crfg-v3` |
| `map_sha256` | The SHA-256 of the pinned map file, or `auto` when the seed chooses the city |
| `config` | The complete resolved start request that the CLI sends to the server |

### Seed-selected and pinned maps

| Map | What is saved | What replay checks |
|---|---|---|
| Chosen by the seed (the default) | The seed and the selection version | That the version is still `urban-crfg-v3` |
| Pinned with `--osm-file` | A copy of the file, named by its SHA-256 | That the version matches and the copy's checksum is unchanged |

For a seed-selected map, the city's extract is downloaded or taken from the map cache
when the run starts, exactly as for an ordinary seed. OpenStreetMap is edited over
time, so a saved seed reproduces the same *place* indefinitely, but the same *graph*
only while the cached extract is kept. To freeze the graph too, pin the cached extract
when saving:

```bash
./launcher seeds save harbour-frozen --seed 382923 \
    --osm-file data/maps/dar-es-salaam_x5000.osm.xml
```

## Where saved seeds live

```text
data/seed-store/
├── seeds.sqlite3                  the registry (SQLite, WAL mode)
└── maps/
    └── <sha256>.osm.xml           copies of pinned maps, shared between saved seeds
```

Set `DSTNS_SEED_DB` to use a registry elsewhere; its `maps/` directory is created next
to it. Deleting a saved seed removes its registry entry but keeps the map copy, which
another saved seed may share. Copies no saved seed refers to can be deleted by hand.

To move saved seeds to another machine, copy the whole `data/seed-store/` directory
with the CLI stopped.

## Rules and safeguards

| Rule | Why |
|---|---|
| IDs are 1 to 64 characters: letters, digits, `_` and `-`, starting with a letter or digit | IDs are database keys and are never used as file paths |
| Saving an ID that already exists fails | A saved configuration is never silently overwritten; delete it first |
| A saved seed from another map selection version is refused | The same seed would mean a different place |
| A pinned map whose copy has changed is refused | The run would not be the run that was saved |
| All database access uses bound parameters | Names cannot inject SQL |

## Errors

| Message | Cause | Fix |
|---|---|---|
| `Seed ID must be 1-64 letters, digits, underscores or hyphens` | The ID has other characters or is too long | Choose a valid ID |
| `Saved seed already exists: ID` | The ID is taken | `./launcher seeds delete ID`, or choose another |
| `Unknown saved seed: ID` | No such ID in this registry | Check `./launcher seeds list` and `DSTNS_SEED_DB` |
| `Unsupported map selection version` | The configuration was built for another version | Save it again under the current version |
| `Saved map content changed; refusing a non-reproducible run` | The stored map copy was modified | Restore the file, or save the configuration again |
| `--seed and --saved-seed are mutually exclusive` | Both were given | Use one |

## Related

- [Seeds and places](seeds-and-places.md): what a seed decides
- [Reproducibility](../concepts/reproducibility.md): the exact guarantee
- [Operator CLI](operator-cli.md): every command and flag
