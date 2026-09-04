# Spatial Index Subsystem (`dstns::spatial`)

## Purpose
The Spatial Index subsystem accelerates metric 2D spatial queries, radius neighbor searches, and building/weather field evaluations across the road network graph.

## Responsibilities
- Compute Euclidean distances in metric space $(x_m, y_m)$ and great-circle distances from $(\text{lat}, \text{lon})$.
- Perform radius searches within distance $R$ for weather epicenters and building influence zones.
- Support spatial compact kernels (Wendland $C^2$ polynomial).

## Mathematical Kernels
### Compact Wendland $C^2$ Spatial Kernel
For normalized distance $r = d / R$:
$$W(d, R) = \begin{cases} (1 - r)^4 (4r + 1), & 0 \le r \le 1 \\ 0, & r > 1 \end{cases}$$
Properties:
- Strictly compact support: exactly 0 for $d \ge R$.
- $C^2$ continuous everywhere, preventing sharp boundary demand/weather cliffs.
- $W(0, R) = 1$.
