# Upgrading and data management

How to identify the version you run, upgrade safely, protect experiment data across
upgrades, back it up, clean up disk space, and remove DSTNS completely. For a shared
instance, follow the validation steps in the
[Operations runbook](operations.md#upgrade-procedure) as well.

## Identify the version

| What | Command |
|---|---|
| Engine | `./build/dstns_server --version`, or `version` in `curl -s localhost:8090/health` |
| Engine version, compiler and SUMO availability | `curl -s localhost:8090/api/v1/system/info` |
| Observer | **About** in the observer |
| Source revision | `git rev-parse --short HEAD` |
| Container image | `docker image inspect dstns:latest --format '{{.Id}}'` |

Record the engine version and the source revision with any results you intend to
reproduce. The three versioned parts of DSTNS are explained in
[Versioning](../api/versioning.md).

## Before upgrading

1. **Read the [release notes](../changelog.md)** for every version between yours and
   the new one. Entries that change simulation results for existing seeds or maps are
   called out explicitly.
2. **Decide whether you need old results to stay reproducible.** The
   [reproducibility guarantee](../concepts/reproducibility.md) holds within one
   version. If you must re-run an experiment exactly, keep a build of the version it
   was produced with (a git tag or commit, or a saved container image).
3. **Back up** the data listed under [What to back up](#what-to-back-up).
4. **Stop the server** cleanly: `curl -X POST localhost:8090/api/v1/system/terminate`,
   Ctrl-C in the CLI, or `docker compose stop`.

## Upgrade a source installation

```bash
git pull
./launcher            # rebuilds only what changed, then starts a run
```

The launcher fingerprints the core's and the observer's sources and rebuilds each
only when it has changed. If a build fails after an upgrade, or after a system library
upgrade, configure afresh:

```bash
cmake --fresh -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=ON
cmake --build build -j
```

Then confirm the installation:

```bash
./build/dstns_server --version
ctest --test-dir build --output-on-failure
```

## Upgrade a container installation

```bash
git pull
docker compose up --build -d
docker compose logs -f
```

The `dstns-maps` and `dstns-logs` volumes survive the rebuild, so cached cities and
logs are kept. To keep the previous image for reproducing old results, tag it before
rebuilding:

```bash
docker tag dstns:latest dstns:before-upgrade
```

## What an upgrade keeps

| Data | Kept | Notes |
|---|---|---|
| Cached city extracts (`data/maps/`, `dstns-maps`) | Yes | Re-used by the new version; maps are data, not code |
| Saved seeds (`data/seed-store/`) | Yes | Refused only if the map selection version changes, never reinterpreted |
| Configuration (`config/*.json`) | Yes, unless you edited a file the upgrade also changes | `git pull` reports a conflict instead of overwriting your changes |
| Logs and journal (`logs/`, `dstns-logs`) | Yes | |
| Observer preferences | Yes | Stored in each browser, as differences from the operator's defaults |
| A run in progress | No | Runs live in memory; stopping the server ends them |

## What to back up

| Path | Why | How |
|---|---|---|
| `data/seed-store/` | Your named configurations and copies of pinned maps | Copy the directory with the CLI stopped |
| Pinned map files you supplied | The run depends on their exact bytes | Copy them, or save a seed that pins them |
| `data/maps/` | Avoids re-downloading, and preserves the exact graph a seed produced | Copy, or set `--map-cache keep` |
| `config/defaults.json`, `config/ui-config.json` | Your defaults | Commit them to your own fork, or copy them |
| `logs/runtime.db` | The request, event and lifecycle journal, if you need it as a record | Copy with the server stopped, or use `sqlite3 logs/runtime.db ".backup copy.db"` |

Never back up `logs/operator.token` to a shared location: it is a credential. The
server writes a new one at every start unless `DSTNS_OPERATOR_TOKEN` is set, in which
case store that value as you would any other secret.

### In Docker

```bash
docker run --rm -v dstns_dstns-maps:/data -v "$PWD":/backup alpine \
    tar czf /backup/dstns-maps.tgz -C /data .
```

The volume name is prefixed with the Compose project name; `docker volume ls` shows
it.

## Managing disk space

| Grows | Control |
|---|---|
| The map cache | The start-up sweep: `--map-cache prune` with `--map-cache-keep N` keeps the newest N extracts (1 by default, 3 in the container); `clear` removes all; `keep` never deletes |
| `logs/runtime.db` | `./launcher reset` deletes it with the other runtime files |
| `data/checkpoints/`, `data/scenarios/`, `data/sumo_live_run/` | `./launcher reset` |
| `data/sumo_export/`, `data/sumo_run/` | Delete by hand when no longer needed |
| `data/seed-store/maps/` | Delete copies that no saved seed refers to |
| Build outputs | `rm -rf build ui-engine/dist` |

`./launcher reset` asks for confirmation (or takes `--yes`) and never deletes the map
cache, saved seeds or configuration.

## Rolling back

```bash
git log --oneline              # find the revision you want
git checkout <revision>
./launcher                     # rebuilds that revision
```

In Docker, start the image you tagged before upgrading, or check out the revision and
rebuild. Cached maps and saved seeds work with either version, subject to the map
selection version.

## Uninstalling

=== "From source"

    ```bash
    ./launcher reset --yes
    cd .. && rm -rf DSTNS
    ```

    Everything DSTNS creates lives inside the repository, so deleting the directory
    removes it completely.

=== "Docker"

    ```bash
    docker compose down --volumes
    cd .. && rm -rf DSTNS
    ```

    `--volumes` deletes the cached maps and logs. Then remove the image with
    `docker image rm dstns:latest`.

## Related

- [Operations runbook](operations.md): day-to-day operation and recovery
- [Files and directories](../reference/files-and-directories.md): what each path holds
- [Release notes](../changelog.md): what changed in each version
