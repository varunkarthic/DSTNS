# Legacy audit

The neighboring `group-08-public-bus-route-planner` checkout was audited before DSTNS implementation. It remains a separate legacy repository and was not copied wholesale.

## Reusable concepts

- Small C++ graph/pathfinding primitives and a SUMO adapter boundary were useful reference points.
- Existing SUMO plain-file and smoke-test patterns informed the new exporter/integration gate.
- Prior control validation and append-only event logging highlighted useful failure cases.

## Rejected architecture

- The legacy namespace/product model (`sumo_control`) conflicts with the required `dstns` identity.
- It had no separate production browser UI and no MapLibre canonical topology renderer.
- Stateful or sequential seed draws could couple modules; DSTNS uses addressable counter RNG domains.
- Map “fixture” behavior was advertised inconsistently and map geometry/provenance was incomplete.
- Mock traffic did not originally supply a complete runtime contract, playback/checkpoint seek, revisioned snapshots, or the required API classes.
- Bus stops were junction approximations rather than stable logical anchors with edge positions.
- Weather/traffic display channels could mask one another instead of composing independently.
- The old API, logs, launcher, naming and deployment layout do not satisfy the master specification.

## Reuse decision

DSTNS is implemented in the dedicated `dstns/` tree. Algorithms were re-derived from the authoritative documents; no legacy source file or namespace is linked into the product. The legacy checkout is source material only and can be removed independently without affecting DSTNS.
