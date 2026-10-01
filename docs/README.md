# DSTNS engineering documentation

Read in this order if you are new: [Architecture](ARCHITECTURE.md), then
[Simulation engine](simulation-engine.md), then the [API guide](api/README.md).
The [project README](../README.md) has the full documentation map.

| Area | Documents |
|---|---|
| System | [Architecture](ARCHITECTURE.md), [Configuration](CONFIGURATION.md), [Security](SECURITY.md), [Logging](LOGGING.md), [Docker](DOCKER.md), [Deployment](DEPLOYMENT.md), [Troubleshooting](TROUBLESHOOTING.md) |
| Model | [Simulation engine](simulation-engine.md), [Mathematical model](MATHEMATICAL_MODEL.md), [Graph model](graph-model.md), [OSM map generation](osm-map-generation.md), [Deterministic seeding](deterministic-seeding.md), [Events](events.md), [Weather](dws.md), [Incidents](incidents.md), [Routing](routing.md), [ASB](asb.md), [Reproducibility](REPRODUCIBILITY.md) |
| Interfaces | [API guide](api/README.md), [API reference](api.md), [Operator CLI](operator-cli.md), [Observer interface](observer-interface.md), [Observer configuration](ui-configuration.md), [Playback control](playback-control.md) |
| Quality | [Testing](TESTING.md), [Performance](PERFORMANCE.md), [Code evaluation, October 2026](AUDIT-2026-10.md) |
| Components | [Component notes](components/README.md): one page per core class |
| History | [Modernization](modernization.md), [Legacy audit](LEGACY_AUDIT.md), [Implementation notes](IMPLEMENTATION_NOTES.md) |

Component notes map design contracts to implementation files. The `context/`
directory records verification and hand-off state; the numbered source
documents there remain the design authority.
