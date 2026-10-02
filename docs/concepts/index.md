# Concepts

How DSTNS works inside. Read [Architecture](architecture.md) first; the other
pages each take one part of it in depth.

```mermaid
flowchart TD
    Seed["Seed"] --> Seeding["Deterministic seeding"]
    Seeding --> Map["OSM map generation"]
    Map --> Graph["Graph model"]
    Seeding --> Events["Events"]
    Events --> Signals["Traffic signals"]
    Events --> Demand["Demand and places"]
    Seeding --> Weather["Weather and flooding"]
    Seeding --> Incidents["Incidents"]
    Graph --> Engine["Simulation engine"]
    Signals --> Engine
    Demand --> Engine
    Weather --> Engine
    Incidents --> Engine
    Engine --> Congestion["Congestion and road state"]
    Engine --> Routing["Routing"]
    Engine --> ASB["Adaptive backpressure"]
    Engine --> Repro["Reproducibility"]
```

| Page | Question it answers |
|---|---|
| **System** | |
| [Architecture](architecture.md) | What are the parts, threads and data flows? |
| [Simulation engine](simulation-engine.md) | What happens every virtual second, and how do seeking and undo work? |
| [Model scope and assumptions](model-scope.md) | What is simulated, what is not, and what is DSTNS suitable for? |
| **World generation** | |
| [Deterministic seeding](deterministic-seeding.md) | How does one number drive every random choice independently? |
| [OSM map generation](osm-map-generation.md) | How does a seed become a road network? |
| [Graph model](graph-model.md) | What is a node, an edge, a place? |
| **Traffic model** | |
| [Mathematical model](mathematical-model.md) | What are the formulas? |
| [Demand and places](demand.md) | Where does traffic come from, and how do places respond to conditions? |
| [Traffic signals](signals.md) | Where are signals, how are they timed and coordinated? |
| [Congestion and road state](congestion.md) | How is congestion measured, and why is a road drawn in its colour? |
| [Routing](routing.md) | How are shortest paths found? |
| **Events and environment** | |
| [Events](events.md) | How are signal changes, demand and storms scheduled and executed? |
| [Weather and flooding](weather.md) | How do storms move and roads flood? |
| [Incidents](incidents.md) | How are accidents and closures planned and applied? |
| **Runtime guarantees** | |
| [Adaptive backpressure](backpressure.md) | How does the simulation slow down for a slow browser? |
| [Reproducibility](reproducibility.md) | What exactly is guaranteed to repeat, and how is it checked? |
| [Compute architecture](compute.md) | How does the physics run on a CPU or a GPU and give the same result on both? |
