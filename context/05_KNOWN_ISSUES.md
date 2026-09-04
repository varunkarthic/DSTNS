# Known Issues & Technical Debt (05)

- Live microscopic vehicle kinematics are exported and verified via `netconvert` and `sumo`, but runtime in-process stepping currently leverages the analytical traffic model within `SimulationEngine`.
- OSM parser currently handles XML format; binary PBF files should be converted to XML or synthetic grids for large-scale ingestion.
- Development TLS uses a self-signed certificate in the Caddy gateway container, which displays browser warnings until accepted.
