# Python API walkthrough

This tutorial starts a reproducible offline run, waits for preparation, pauses the
clock, seeks to 06:00:00 and saves a manifest and snapshot. It uses Python's standard
library, so no third-party Python client is required. The script controls a shared
run; use a dedicated local server and keep other observers disconnected.

## Prerequisites and server startup

Build the native server as described in [Building from source](../development/building.md).
Run all commands from the repository root. In terminal A:

```bash
mkdir -p artifacts/api-tutorial/logs artifacts/api-tutorial/maps
chmod 700 artifacts/api-tutorial artifacts/api-tutorial/logs
./build/dstns_server --host 127.0.0.1 --port 18090 \
  --logs artifacts/api-tutorial/logs --maps artifacts/api-tutorial/maps \
  --map-cache keep
```

This starts an idle server on a dedicated loopback port. Its credential is stored
in the tutorial's restricted logs directory, rather than the default `logs/`
directory. The map cache is separate from normal runs. Keep this terminal running.
Do not commit the tutorial artifacts: they include a live operator credential.

## Client implementation

Save the following as `artifacts/api-tutorial/run_scenario.py`, then run it in
terminal B with `python3 artifacts/api-tutorial/run_scenario.py`.

```python
import json
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE_URL = "http://127.0.0.1:18090"
ARTIFACTS = Path("artifacts/api-tutorial")
TOKEN = (ARTIFACTS / "logs/operator.token").read_text().strip()


def request(path, method="GET", payload=None, *, operator=False):
    headers = {"Accept": "application/json"}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if operator:
        headers["X-DSTNS-Operator"] = TOKEN
    req = Request(BASE_URL + path, data=body, headers=headers, method=method)
    try:
        with urlopen(req, timeout=30) as response:
            result = json.load(response)
    except HTTPError as exc:
        # Keep server details local; sanitize them before sharing diagnostics.
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path}: HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Server unavailable: {exc.reason}") from exc
    if result.get("ok") is not True:
        raise RuntimeError(f"Unsuccessful API response: {result.get('error')}")
    return result


status = request("/api/v1/playback/status")
if status["data"]["lifecycle"] != "IDLE":
    raise RuntimeError("Use a dedicated idle server; this script will not reset a run.")

request(
    "/api/v1/playback/start",
    "POST",
    {
        "seed": "382923",
        "day": 0,
        "playback_duration_seconds": 3600,
        "tick_rate": 1,
        "map": {"osm_file": "data/fixtures/real_network.osm.xml"},
    },
    operator=True,
)

# A 202 response accepts work; readiness must be observed separately.
deadline = time.monotonic() + 120
while time.monotonic() < deadline:
    status = request("/api/v1/playback/status")
    state = status["data"]["lifecycle"]
    if state == "RUNNING":
        break
    if state != "PREPARING":
        detail = status["data"].get("preparation_error")
        raise RuntimeError(f"Preparation ended in {state}: {detail}")
    time.sleep(0.25)
else:
    raise TimeoutError("Preparation exceeded 120 seconds; inspect the server log.")

run_id = status["run_id"]
request(
    "/api/v1/playback/pause",
    "POST",
    {
        "expected_run_id": run_id,
        "expected_playback_revision": status["data"]["playback_revision"],
    },
)
request("/api/v1/playback/seek", "POST", {"target_time": "06:00:00", "play": False})
status = request("/api/v1/playback/status")
if (
    status["run_id"] != run_id
    or status["data"]["lifecycle"] != "PAUSED"
    or status["clock"]["virtual_day_seconds"] != 21600
):
    raise RuntimeError("The run changed or did not reach the requested paused time.")

for name in ("manifest", "snapshot"):
    result = request(f"/api/v1/view/{name}")
    if result["run_id"] != run_id:
        raise RuntimeError("Run changed while collecting artifacts.")
    (ARTIFACTS / f"{name}.json").write_text(json.dumps(result, indent=2) + "\n")

print(f"Saved manifest and snapshot for {run_id} at 06:00:00 (PAUSED).")
```

## How the client works

| Step | Reason |
|---|---|
| Read the local token | Start requires the credential created by this server; it is never printed |
| Refuse an existing run | Prevents a tutorial from silently replacing someone else's simulation |
| Send a string seed and pinned map | Preserves the seed's exact value and removes the map-download dependency |
| Check HTTP status and `ok` | Distinguishes transport failures from successful API envelopes |
| Poll with a monotonic deadline | Handles asynchronous compilation without waiting indefinitely |
| Guard pause with run and playback revision | Rejects a stale decision if another client changed the lifecycle |
| Pause before seeking | A seek may resume an already running simulation; pausing makes the target stable |
| Re-read state and compare run IDs | Verifies the operation's observable effect before saving results |

The 30-second request timeout bounds individual network operations; the 120-second
preparation budget is checked between polls, so an in-flight request can extend
it by up to a request timeout. The script intentionally performs no automatic write
retries: after a timeout the server might already have applied the request.
Re-read state before deciding what to do next.

This is a single-operator tutorial, not a transaction across multiple API calls.
Run-ID checks detect replacement, but cannot prevent a concurrent operator from
changing the same run between reads. Use an isolated server for experiment capture.

## Expected result and cleanup

The script prints a run ID and creates `manifest.json` and `snapshot.json` under
`artifacts/api-tutorial/`. The snapshot's clock is at 21,600 virtual seconds and
the server remains paused. Hashes depend on the checked-out code and map bytes;
do not paste an arbitrary reference hash into a test.

After inspecting the files, stop the tutorial server with Ctrl-C in terminal A.
Keep only the artifacts needed for the experiment, excluding `operator.token`.
For repeat runs, restart the tutorial server so its lifecycle is `IDLE`.

## Troubleshooting

| Symptom | Interpretation and next step |
|---|---|
| Token file missing | Terminal A has not started, startup failed, or the working directory differs |
| Connection refused | Check terminal A and port 18090; the script does not start the server |
| `CLI_START_REQUIRED` | The token belongs to another server or the server restarted; rerun the script to read the new token |
| `LIFECYCLE_CONFLICT` | Another client changed state, or the server was already active; inspect status before acting |
| `IDLE` after start | Read `preparation_error` and the private server log; check the server-side map path |
| Timeout | Inspect status before retrying; the accepted operation may still be running |

See [API examples](examples.md) for individual curl commands and
[Lifecycle](lifecycle.md) for allowed transitions.
