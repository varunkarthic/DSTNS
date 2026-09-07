# Spatial Kernels and Linear Scans (`dstns::point_distance`, `dstns::wendland_c2`)

## Purpose
There is no spatial-index class or `dstns::spatial` namespace. The current graph sizes use free metric-kernel functions plus direct linear scans in scenario generation and simulation physics.

## Responsibilities
- `point_distance` computes Euclidean distance in projected metric coordinates $(x_m, y_m)$; it does not compute great-circle distance.
- `ScenarioCompiler::place_buildings` scans all nodes for candidates in its distance band.
- `SimulationEngine::physics_step` scans nodes or edges when evaluating storms, building effects, and surge zones.
- Support spatial compact kernels (Wendland $C^2$ polynomial).

These searches are $O(|V|)$ or $O(|E|)$ per evaluated feature. An R-tree or other spatial index remains future optimization work, not an implemented subsystem.

## Mathematical Kernels
### Compact Wendland $C^2$ Spatial Kernel
For normalized distance $r = d / R$:
$$W(d, R) = \begin{cases} (1 - r)^4 (4r + 1), & 0 \le r \le 1 \\ 0, & r > 1 \end{cases}$$
Properties:
- Strictly compact support: exactly 0 for $d \ge R$.
- $C^2$ continuous everywhere, preventing sharp boundary demand/weather cliffs.
- $W(0, R) = 1$.
