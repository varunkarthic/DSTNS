# Routing

The canonical RoutePlanner in `src/graph.cpp` remains the deterministic shortest-path authority used for planned trips and SUMO export. It excludes synthetic reverse edges that violate source OSM directionality. The former browser Transit dispatcher is retired; no public Transit route API is supported.

See [API reference](api.md) and [modernization](modernization.md).
