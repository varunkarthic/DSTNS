# Reports and exports

Every way to take results out of DSTNS: the PDF report from the observer, live data
from the API, the files the server writes, and the SUMO bundle. Choose by what you
need to do with the results.

| You need | Use | Format |
|---|---|---|
| A document to read, share or archive | [PDF report](#pdf-report) | PDF, 10 to 30 pages |
| Data for your own analysis, while a run is going | [API](#data-from-the-api) | JSON |
| The state of a run without a client | [`global_view.json`](#global-view-file) | JSON file, rewritten every 10 s |
| A record of what happened and when | [Runtime journal](#runtime-journal) | SQLite and text logs |
| The same network in a microscopic simulator | [SUMO bundle](#sumo-bundle) | SUMO XML files |

## PDF report

### Producing one

| Where | How |
|---|---|
| At any time during a run | **Export Report** in the observer's top bar |
| When the day completes | **Save Report** in the "The day is complete" dialog |

The observer builds the PDF locally in the browser and downloads it as
`DSTNS-report-<run_id>-<virtual second>.pdf`. Nothing is uploaded anywhere. The
report embeds its own font, so it renders identically without network access.

### Contents

The report opens with a cover and a table of contents, then:

| Section | Covers |
|---|---|
| Executive summary | Key figures and observations |
| Simulation configuration | Scenario, map, enabled systems and visible layers |
| Environment and runtime | Engine, observer and API versions, platform, observation times |
| Road network analysis | Connectivity, degree distribution, road classes, road states, places |
| Traffic analysis | Congestion across the day, congestion periods, vehicles, mean speed, most congested roads |
| Weather analysis | Rain events, durations, activity and footprint |
| Flooding analysis | Onsets by hour, flooded and closed roads, correlation with rain |
| Incident analysis | Severity and type distributions, a register of incidents with descriptions |
| Simulation event timeline | Every significant event in order |
| Performance and telemetry | Data delivered, throughput, snapshot rate, round-trip time, backpressure and interventions, operator controls |
| Determinism and integrity | Seed, run ID, graph and scenario hashes, lifecycle |
| Map at export | The map as drawn, when it is visible |
| Methodology and definitions | How every figure was obtained |

A busy day produces about 20 to 30 pages; a short observation about 10.

### How to read it

- Every statement is labelled **Observed** (measured directly), **Derived**
  (computed from observations) or **Interpretation** (a reading of the figures).
- A measure that was not recorded is reported as missing, never estimated.
- Whole-run figures (news, congestion history) come from the core and cover the entire
  day. Telemetry figures (throughput, round-trip time) cover only the time this
  browser was watching, and are labelled as such.
- If the day was replayed after seeking backwards, the latest pass replaces the
  earlier one in charts drawn against simulation time.
- Times follow the observer's 12- or 24-hour preference.

The report never includes file-system paths or the operator credential, so it can be
shared as it is.

## Data from the API

Every view the observer uses is available to any HTTP client. The most useful for
analysis:

| Route | Contents |
|---|---|
| `GET /api/v1/view/congestion` | Network congestion index, moving average and per-minute history |
| `GET /api/v1/view/snapshot` | Every node's and road's dynamic state at this instant |
| `GET /api/v1/view/traffic` | Network traffic aggregates |
| `GET /api/v1/view/places` | Every place's demand multiplier and the factors behind it |
| `GET /api/v1/view/event-queue?view=history` | Executed events, paged |
| `GET /api/v1/news` | The news record, incrementally with `since_news_id` |
| `GET /api/v1/view/topology` | The static road network and places, once per run |

```bash
# Congestion history for the whole day so far, as CSV
curl -s localhost:8090/api/v1/view/congestion \
  | python3 -c 'import json,sys
for h in json.load(sys.stdin)["data"]["history"]:
    print(h["virtual_s"], round(h["current"],2), round(h["average"],2), sep=",")'
```

Every response carries `run_id`, `seed` and `state_revision`, so samples from
different runs or instants are never confused. For a complete polling client see the
[Python client walkthrough](../api/client-walkthrough.md); for every route see the
[API reference](../api/reference.md).

## Global view file

The server writes `global_view.json` into its logs directory every 10 seconds while a
run is active. It contains the run's identity, seed, lifecycle, revisions, map bounds
and a summary of current state, and is useful for monitoring a server from a script
that cannot make HTTP requests. See [Logging](../deployment/logging.md).

## Runtime journal

| File | Contents |
|---|---|
| `logs/system.log` | One line per significant event: start-up, lifecycle changes, map downloads, errors |
| `logs/runtime.db` | SQLite tables `api_log` (every request), `event_log` (operator commands) and `lifecycle_log` (every state change) |

```bash
sqlite3 -header -csv logs/runtime.db \
  "SELECT ts, from_state, to_state FROM lifecycle_log ORDER BY id"
```

`./launcher logs` reads the same data interactively. Table schemas and further
queries are in [Logging](../deployment/logging.md).

## SUMO bundle

To study the same network microscopically, export it while a run is active:

```bash
curl -s -X POST localhost:8090/api/v1/export/sumo \
     -H "Content-Type: application/json" -d '{"directory": "data/sumo_export"}'
```

The bundle contains nodes, edges, bus stops, planned trips and a configuration file.
`POST /api/v1/system/sumo-simulate` also converts the network, runs SUMO for a time
window and returns trip statistics. See the [SUMO adapter](../components/sumo-adapter.md).

## Related

- [Observer interface: report](observer-interface.md#report): how the report is laid out
- [Reproducibility](../concepts/reproducibility.md): what to record to reproduce results
- [View API](../api/view-api.md): every view in detail
