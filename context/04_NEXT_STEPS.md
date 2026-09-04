# Next Steps (04)

1. **In-Process libsumo C++ Binding**: Connect runtime vehicle telemetry directly through `libsumo` in dynamic physics runs where shared libraries are linked.
2. **PBF OSM Parser**: Add binary Protobuf OSM parser (`libosmpbf` / `protozero`) for ingesting gigabyte-scale planet extracts directly.
3. **Advanced R-Tree Spatial Index**: Implement Boost.Geometry R-tree for sub-microsecond radius lookups on 50,000+ node networks.
4. **WebSocket Bidirectional Protocol**: Add native WebSocket streaming in `api.cpp` alongside the existing Server-Sent Events stream.
