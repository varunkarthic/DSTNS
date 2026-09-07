# Dynamic Weather (`dstns::ScenarioCompiler`, `dstns::SimulationEngine`)

## Purpose
The Dynamic Weather Simulation generates deterministic localized rainfall storms centered on road nodes and calculates spatial-temporal precipitation intensity fields across the road network.

## Weather Event Model
Each DWS event $k$ is characterized by:
- `id`: Unique event strong identifier.
- `epicenter`: Canonical `NodeId` center point.
- `start_ppm`, `end_ppm`: Parts-per-million virtual day timestamps $[t_{\text{start}}, t_{\text{end}}]$.
- `intensity` $I_{\text{peak}} \in [0, 1]$: Maximum precipitation rate.
- `radius_m` $R$: Maximum spatial extent in meters.
- `flood_gain`, `recovery`: Deterministically generated event metadata. The current node flood integrator uses fixed gain/drain coefficients and does not consume these two fields.

## Spatiotemporal Kernel
At distance $d$ from the epicenter and time $t \in [t_{\text{start}}, t_{\text{end}}]$:
$$\text{Rain}(u, t) = I_{\text{peak}} \cdot W(d(u, \text{epicenter}), R) \cdot K_{\text{temporal}}(t)$$
where $W(d, R)$ is the compact Wendland $C^2$ polynomial and $K(t)$ is the symmetric temporal profile.
Precipitation strictly vanishes outside $R$ and outside $[t_{\text{start}}, t_{\text{end}}]$.

## 5-Second Real-Time Spacing Invariant
Scheduled base DWS events are spaced such that their start times are separated by at least 5.0 seconds of real playback duration $T_P$.
