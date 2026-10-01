# Operations runbook

Use this runbook for a single DSTNS server and its shared simulation. It covers
readiness, routine diagnostics, evidence capture, upgrades and recovery. Read
[Deployment security](security.md) before giving other users network access.
The commands assume the repository root and the default local port unless stated.

## Establish the operating configuration

Record the source revision or container image digest, server host and port, map
source, logs directory, run configuration and person responsible for the instance.
Prefer a pinned map for demonstrations and repeatable experiments; automatic map
selection requires network access on a cache miss.

For an explicitly local native server:

```bash
mkdir -p logs
chmod 700 logs
./build/dstns_server --host 127.0.0.1 --port 8090 --map-cache keep
```

Run this in a dedicated terminal. It starts the server without starting a run and
keeps downloaded maps instead of pruning them. `--host` restricts this process to
local clients. When using the launcher, set `api.host` in `config/defaults.json`
to `127.0.0.1`; the standalone executable takes its host from its command line.
Monitor disk use if retaining every map.

For a local Compose deployment, the host-port setting accepts a bind address:

```bash
DSTNS_HOST_PORT=127.0.0.1:8090 \
DSTNS_OSM_FILE=/app/data/fixtures/real_network.osm.xml \
docker compose up --build -d
```

Compose expands this to `127.0.0.1:8090:8090`, publishing the backend only on
loopback. The map path is inside the container. If enabling the TLS profile,
configure its host binding too (`DSTNS_TLS_PORT=127.0.0.1:8443` for local use).
Remote access requires a separately configured trusted network or authenticated
proxy. The bundled gateway does not add user authentication.

## Health is not simulation readiness

```bash
curl --fail --silent --show-error http://127.0.0.1:8090/health
curl --fail --silent --show-error http://127.0.0.1:8090/api/v1/playback/status
curl --fail --silent --show-error http://127.0.0.1:8090/api/v1/system/map-status
```

The first request checks that HTTP is responsive. The second describes the run;
the third provides map preparation progress. Do not treat an HTTP 200 or accepted
start request as proof that a simulation is running.

| Observation | Action |
|---|---|
| `IDLE`, no preparation error | Start a run through the operator CLI or authenticated API |
| `PREPARING` | Observe map progress and the server log; avoid submitting duplicate starts |
| `RUNNING` | Read status again after a short interval to verify virtual time advances |
| `PAUSED` or `READY` | The server may be healthy; confirm whether the stopped clock is intentional |
| `IDLE` with `preparation_error` | Correct the map/configuration problem before retrying |
| `COMPLETED` | Preserve results and explicitly choose the next run |
| Network error or unexpected non-JSON response | Inspect the process, port and any proxy before changing simulation settings |

A degraded backpressure state can slow a healthy engine. Diagnose browser/render
lag separately from compilation or server failure. See
[Adaptive backpressure](../concepts/backpressure.md).

## Capture a diagnostic record

Use a new directory per investigation; these files describe the active run and
should be reviewed before sharing:

```bash
mkdir -p artifacts/diagnostics
curl --fail --silent --show-error http://127.0.0.1:8090/api/v1/system/info \
  -o artifacts/diagnostics/system-info.json
curl --fail --silent --show-error http://127.0.0.1:8090/api/v1/playback/status \
  -o artifacts/diagnostics/status.json
curl --fail --silent --show-error http://127.0.0.1:8090/api/v1/view/manifest \
  -o artifacts/diagnostics/manifest.json
git rev-parse HEAD > artifacts/diagnostics/revision.txt
```

`system-info.json` identifies available capabilities, status captures the lifecycle,
and the manifest supplies scenario provenance when a world exists. The Git commit
identifies the source checkout; a stale binary may have been built from something
else. Capture the running binary's version and build provenance as well when that
is uncertain. Review logs for tokens, paths, private locations and personal data.
Never attach the complete logs directory without checking its contents.

For a frozen experiment, pause before capturing the snapshot and ensure other
clients cannot mutate the run. See the
[API walkthrough](../api/client-walkthrough.md) for explicit state checks.

## Persistence and backup

| Artifact | Why retain it | Caveat |
|---|---|---|
| Pinned OSM input and manifest | Recreate the same geographic input | A seed does not preserve upstream map bytes |
| Resolved configuration and operator-action history | Recreate the scenario and later controls | Defaults and model behavior can change between revisions |
| Source commit, toolchain versions or image digest | Identify the implementation | A floating image tag is not a stable identifier |
| Saved-seed store | Reuse named configurations and pinned-map metadata | Validate references and map availability after restoring |
| SQLite journal and system log | Diagnose events and failures | They are not a complete restart checkpoint |
| Operator token and TLS keys | Operate an existing deployment | Store separately with restricted access; rotate after exposure |

Stop the server before making a simple filesystem copy of its writable runtime
state. Copying a live SQLite database without its journaling state may produce an
inconsistent backup; use a supported SQLite backup procedure if downtime is not
possible. Secure backups to the same standard as live credentials.

Restoring logs does not resume a process at its previous in-memory clock. Start a
new run from the retained inputs, replay required controls, and seek deliberately.
Compare manifests and expected state rather than assuming backup restoration
reconstructs an active simulation automatically.

## Upgrade procedure

1. Record the active revision, configuration and required experiment artifacts.
2. Read the changelog and dependency diff. Model or map-parser fixes can change
   results even when the API stays compatible.
3. Build the candidate in a separate checkout or image and run the applicable
   [test suites](../development/testing.md). Confirm bundled-map startup and the
   observer workflow before scheduling the change.
4. Stop the old instance and back up the data needed for recovery. Retain its
   executable or image and the corresponding configuration.
5. Start the candidate with restricted network access. Verify health, lifecycle,
   clock progression, logs and expected behavior before restoring normal access.
6. Record the deployed revision and any changed hashes or limitations.

For a source checkout that has no local changes, fetch and review before updating:

```bash
git fetch origin
git log --oneline HEAD..origin/main
git diff --stat HEAD..origin/main
```

These commands inspect the available update without changing your working tree.
Do not reset or discard local work to make an upgrade succeed. Select and validate
the intended revision, then deploy it through the workflow above.

## Recovery and shutdown

| Failure | Immediate response | Recovery check |
|---|---|---|
| Map download failure | Preserve the error and use the pinned/bundled map if appropriate | Confirm the intended map and manifest, not merely successful startup |
| Port conflict | Identify the existing process; choose a separate port | Confirm every client points to the intended instance |
| Disk exhaustion | Stop new exports/downloads; inspect map and log growth | Free or extend storage while preserving required artifacts |
| Candidate regression | Restrict access and restore the previous validated binary/image and compatible inputs | Repeat readiness checks; assess security exposure before reverting a security fix |
| Suspected compromise | Isolate the instance and follow the security policy | Rotate exposed secrets and verify access boundaries before restart |

For a foreground native server, use Ctrl-C. For Compose:

```bash
docker compose stop
docker compose ps
```

Stopping retains the named volumes. `docker compose down` removes containers and
networks while retaining named volumes by default. **`docker compose down --volumes`
also deletes the stored maps and logs, including the token and journal.** Export
anything needed before using that option. The HTTP terminate endpoint exits the
process, but a service manager or Compose restart policy may start it again; use
the supervisor's stop command for a persistent shutdown.

Further references: [Docker](docker.md), [Logging](logging.md),
[Troubleshooting](../troubleshooting.md) and the
[security policy](https://github.com/varunkarthic/DSTNS/blob/main/SECURITY.md).
