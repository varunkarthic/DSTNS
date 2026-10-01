# Design specifications

The three documents in this section are the **original design
specifications** DSTNS was built from. They are kept for their reasoning and
their mathematics, and remain the reference for intent.

!!! warning "Specifications, not a description of the code"
    Parts of these documents describe features that were designed but are not
    implemented, or were implemented differently: for example an in-process
    SUMO coupling, MapLibre rendering or a transit dispatcher. Where they
    disagree with the rest of this documentation, the rest of this
    documentation describes what the code does.

| Document | Covers |
|---|---|
| [Mathematical foundation](mathematical-foundation.md) | The formal model: graphs, kernels, demand, weather, flooding, signals, congestion, determinism |
| [System architecture](system-architecture-spec.md) | Components, data flow, threading, storage, deployment as designed |
| [API, runtime and events](api-runtime-event-spec.md) | API classes, event scheduling, news templates, playback semantics, overlays, undo |

For the implemented system, start with [Architecture](../concepts/architecture.md). The
reasoning behind the most significant choices, as implemented, is recorded in
[Design decisions](decisions.md).
