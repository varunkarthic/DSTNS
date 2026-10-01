---
title: Deterministic traffic simulation on real maps
hide:
  - navigation
  - toc
---

<div class="dstns-hero" markdown>

# Simulate a full day of real traffic. Reproduce it exactly.

<p class="dstns-lede">
DSTNS turns a number into a real city district from OpenStreetMap and simulates
a day of traffic on it: signals, demand, weather, flooding and incidents, on one
virtual clock. The same seed gives the same world and the same day, on any machine.
</p>

<div class="dstns-actions" markdown>

[Get started](getting-started/quick-start.md){ .md-button .md-button--primary }
[Run with Docker](getting-started/docker.md){ .md-button }
[API reference](api/index.md){ .md-button }

</div>

</div>

<div class="dstns-stats" markdown>
<div markdown><strong>181</strong><span>cities in the catalogue</span></div>
<div markdown><strong>3,000</strong><span>junctions per district</span></div>
<div markdown><strong>1 s</strong><span>fixed physics step</span></div>
<div markdown><strong>96</strong><span>checkpoints per day</span></div>
<div markdown><strong>0.25 to 5x</strong><span>playback speed</span></div>
</div>

![The DSTNS observer showing a district of Dar es Salaam, with the road network coloured by congestion, a telemetry panel and playback controls](assets/screenshots/observer.png){ .screenshot }

## Choose your path

<div class="grid cards" markdown>

-   **Run a simulation**

    ---

    Start from nothing and have a day running in minutes, with Docker or from
    source, then tour the interface.

    [Quick start](getting-started/quick-start.md)
    · [Docker](getting-started/docker.md)
    · [First simulation](getting-started/first-simulation.md)

-   **Build on the API**

    ---

    Drive and read a run over HTTP: playback, controls, views and a streaming
    feed, with an OpenAPI description and a runnable client.

    [API guide](api/index.md)
    · [Client walkthrough](api/client-walkthrough.md)
    · [OpenAPI explorer](api/openapi.md)

-   **Understand the model**

    ---

    How a seed becomes a world, what happens every virtual second, and why a run
    is reproducible, with the equations behind each step.

    [Architecture](concepts/architecture.md)
    · [Mathematical model](concepts/mathematical-model.md)
    · [Reproducibility](concepts/reproducibility.md)

-   **Deploy and operate**

    ---

    Run it for other people: containers, TLS, security, logging, backups and a
    troubleshooting runbook.

    [Deployment](deployment/index.md)
    · [Security](deployment/security.md)
    · [Operations](deployment/operations.md)

</div>

## Start in one minute

=== "Docker"

    ```bash
    git clone https://github.com/varunkarthic/DSTNS.git && cd DSTNS
    docker compose up --build
    ```

    Open <http://localhost:8090>. The container picks a seed, downloads that city's
    map the first time, and starts the day.

=== "From source"

    ```bash
    git clone https://github.com/varunkarthic/DSTNS.git && cd DSTNS
    ./launcher start --seed 382923
    ```

    The launcher builds what changed, starts the server, opens the observer
    and starts a run from seed `382923`.

=== "API only"

    ```bash
    curl -s http://127.0.0.1:8090/api/v1/playback/status
    curl -s -X POST http://127.0.0.1:8090/api/v1/playback/seek \
         -d '{"target_time": "08:00:00"}'
    ```

    The first command reads the run's state; the second jumps to the morning
    peak. Seeking is exact: the engine restores a checkpoint and replays.

## How it works

```mermaid
flowchart LR
    Seed(["Seed"]) --> Place["City and district<br/>181-city catalogue"]
    Place --> OSM[("OpenStreetMap")]
    OSM --> Graph["Road graph<br/>true metres, canonical IDs"]
    Seed --> Sched["Signals, demand,<br/>weather, incidents"]
    Graph --> Engine["Simulation engine<br/>1-second physics"]
    Sched --> Engine
    Engine --> API["HTTP API"]
    API --> Observer["Observer<br/>browser"]
    API --> Client["Your code"]
    CLI["Operator CLI"] -- "starts runs" --> API
```

Every random choice is derived from the seed through SHA-256, one stream per
subsystem. With \( s \) the seed and \( \ell \) a subsystem label, the sub-seed is the
first 128 bits of

\[
s_\ell = \operatorname{SHA\text{-}256}\big(\operatorname{hex}(s) \,\Vert\, \texttt{":"} \,\Vert\, \ell\big)
\]

so changing how one subsystem draws numbers never moves another's. Physics then
advances in fixed one-second steps, so playing to a time and seeking to it reach
identical state. [Deterministic seeding](concepts/deterministic-seeding.md) works the
whole path through for a real seed, and [Reproducibility](concepts/reproducibility.md) states exactly what
is guaranteed.

## What is in the box

| Component | What it is | Documentation |
|---|---|---|
| **Core** (`dstns_server`) | C++20 engine and HTTP server. Compiles a scenario from a seed, runs the virtual day, serves the API and the observer on one port | [Architecture](concepts/architecture.md), [Simulation engine](concepts/simulation-engine.md) |
| **Operator CLI** (`./launcher`) | Builds what changed, starts and supervises the server, starts runs, saved seeds, logs, tests | [Operator CLI](guide/operator-cli.md) |
| **Observer** (`ui-engine/`) | React application: map, telemetry, playback, notifications, PDF report | [Observer interface](guide/observer-interface.md) |
| **Container image** | One 234 MB multi-architecture image with a TLS gateway profile | [Docker deployment](deployment/docker.md) |
| **SUMO adapter** | Exports a world to Eclipse SUMO as a microscopic cross-check | [SUMO adapter](components/sumo-adapter.md) |

!!! info "Model scope"
    The live model is **aggregate**: flows and queues per directed road segment,
    not individual vehicles. That is what makes a whole day of a 3,000-junction
    district cheap enough to scrub back and forth interactively. The moving dots
    in the observer show modelled flow. SUMO is a separate batch job and never
    writes back into a live run.

## Find what you need

| If you want to | Read |
|---|---|
| Install on macOS, Linux or WSL | [Installation](getting-started/installation.md) |
| Choose a seed, understand the map cache | [Seeds and places](guide/seeds-and-places.md) |
| See every command and flag | [Operator CLI](guide/operator-cli.md), [Configuration](guide/configuration.md) |
| Look up a formula | [Mathematical model](concepts/mathematical-model.md) |
| Handle an error response | [API errors](api/errors.md) |
| Fix a problem | [Troubleshooting](troubleshooting.md), [FAQ](faq.md) |
| Report a vulnerability | [Security policy](https://github.com/varunkarthic/DSTNS/blob/main/SECURITY.md) |
| Contribute | [Contributing](development/contributing.md) |
