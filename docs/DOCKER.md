# Docker operation

Compose selects Linux amd64 because the upstream SUMO image is amd64; ARM hosts use Docker emulation. The image packages the C++ core, compiled observer UI, Node operator CLI, Python SQLite seed store and SUMO batch adapter. It starts an idle HTTP server on port 8090; create a run through the container CLI:

```
docker compose up --build -d
docker compose exec dstns node dstns-operator-cli/dstns.mjs start --seed 382923 --day-type weekend --save-seed demo
docker compose exec dstns node dstns-operator-cli/dstns.mjs seeds list
docker compose ps
```

Open `http://127.0.0.1:8090`. Logs/operator credential persist in `dstns_logs`; saved seeds and pinned maps persist in `dstns_data`. The image includes a real OSM fixture. Existing data volumes created before this release may need the fixture copied into `/app/data/fixtures`; alternatively mount a source and pass its container path with `--osm-file`. A large local source is deliberately not baked into the image:

```
docker cp data/maps/berlin-urban.osm.xml dstns_simulation_engine:/app/data/berlin.osm.xml
docker compose exec dstns node dstns-operator-cli/dstns.mjs start --osm-file /app/data/berlin.osm.xml --seed 42
```

Start requires the private operator credential read locally by the CLI. No browser start key is embedded. The health check uses Python urllib against loopback `/health`; container health and HTTP availability are separate from simulation lifecycle. SUMO remains a batch adapter, not the authoritative live traffic model.

For a registry mirror, build with `--build-arg NPM_REGISTRY=https://registry.yarnpkg.com`; TLS verification remains enabled. `docker compose down` stops the service while preserving data volumes.
