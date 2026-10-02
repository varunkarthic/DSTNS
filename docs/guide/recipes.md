# Recipes

Short, task-oriented answers. Each recipe links to the page that explains the
details.

## Run the same world again

```bash
./launcher start --seed 382923
```

The seed shown in the observer's command rail is the whole recipe: the same seed
gives the same city, district, signals, demand, weather and incidents, on any
machine. Check it yourself with `./build/dstns_replay_verify 382923`. See
[Reproducibility](../concepts/reproducibility.md).

## Keep a run you like

```bash
./launcher start --seed 382923 --save-seed morning-peak --description "Dense CBD, weekday"
./launcher seeds list
./launcher start --saved-seed morning-peak
```

## Work offline

1. Run the city once while online so its extract is cached in `data/maps/`.
2. Start the server with `--map-cache keep` so the start-up sweep does not remove it.
3. Or pin the bundled district: `./launcher start --osm-file data/fixtures/real_network.osm.xml`.

## Use a map you supply

```bash
./launcher start --osm-file /path/to/extract.osm.xml --max-nodes 20000
```

The file must be OpenStreetMap XML containing road ways. See
[OSM map generation](../concepts/osm-map-generation.md).

## Make a day shorter

```bash
./launcher start --seed 382923 --duration 600
```

`--duration` is the wall-clock time one virtual day takes at 1x, from 60 to 3600
seconds. A shorter day does not change what happens, only how fast.

## Jump to the morning peak

In the observer, drag the clock or use the speed controls. Over HTTP:

```bash
curl -s -X POST http://127.0.0.1:8090/api/v1/playback/seek \
     -H "Content-Type: application/json" -d '{"target_time": "08:00:00"}'
```

Seeking is exact: the engine restores the nearest checkpoint and replays forward.

## Switch a subsystem off

```bash
curl -s -X PUT http://127.0.0.1:8090/api/v1/control/modules/dws \
     -H "Content-Type: application/json" -d '{"enabled": false}'
```

Modules are `traffic`, `signals`, `buildings`, `dws`, `flooding` and `news`. See
[Control API](../api/control-api.md).

## Read the state from a script

```bash
curl -s http://127.0.0.1:8090/api/v1/playback/status | python3 -m json.tool
```

For a complete client with polling and error handling see the
[Python walkthrough](../api/client-walkthrough.md).

## Export a world to SUMO

With a run in progress, export the live scenario, or export it and run SUMO on it,
through the API:

```bash
curl -s -X POST http://127.0.0.1:8090/api/v1/export/sumo \
     -H "Content-Type: application/json" -d '{"directory": "data/sumo_export"}'
curl -s -X POST http://127.0.0.1:8090/api/v1/system/sumo-simulate \
     -H "Content-Type: application/json" \
     -d '{"directory": "data/sumo_run", "begin_s": 25200, "end_s": 32400}'
```

The second call simulates 07:00 to 09:00 microscopically and returns trip statistics.
`./launcher sumo` and `dstns_scenario_export` check the SUMO toolchain on a synthetic
grid without a server; they do not export the city you are watching. See
[SUMO adapter](../components/sumo-adapter.md).

## Run on another port

```bash
DSTNS_API_PORT=9000 ./launcher start
./build/dstns_server --port 9000
docker compose up   # then set DSTNS_HOST_PORT=9000 to publish a different host port
```

## Let other machines reach it

Read [Deployment security](../deployment/security.md) first. The short version:
put a TLS-terminating reverse proxy in front, keep the server on loopback, and
add the public name to `DSTNS_ALLOWED_HOSTS`.

## Update to a newer copy

```bash
git pull
./launcher start      # rebuilds only what changed
```

In Docker: `git pull && docker compose up --pull always`. Cached maps and logs live in
volumes and survive a rebuild. Read the [changelog](../changelog.md) first.

## Remove everything

```bash
./launcher reset            # logs, journal, checkpoints, temporary files
docker compose down -v      # container and its volumes
rm -rf build ui-engine/dist ui-engine/node_modules data/maps
```

## Check an installation

```bash
./build/dstns_server --version
./launcher test unit
ctest --test-dir build --output-on-failure
```

See [Testing](../development/testing.md) for every suite and what it proves.
