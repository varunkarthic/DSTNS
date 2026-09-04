# Flood Reservoir Dynamics (`dstns::engine`)

## Purpose
Simulates water accumulation, ponding depth, and natural drainage across road nodes and directed edges as a dynamic reservoir system driven by rainfall and local susceptibility.

## Reservoir Equations
Let $F(u, t)$ denote the normalized flood level at node $u$.
Differential evolution over timestep $\Delta t$:
$$\frac{dF(u, t)}{dt} = G_{\text{flood}} \cdot \text{Rain}(u, t) \cdot S_{\text{flood}}(u) - D_{\text{drainage}}(u) \cdot F(u, t)$$
Discrete integration:
$$F(u, t + \Delta t) = \operatorname{clamp}\left( F(u, t) + \Delta t \left( G \cdot \text{Rain} \cdot S - D \cdot F \right), 0, 1 \right)$$
where:
- $S_{\text{flood}}(u) \in [0, 1]$: Topographic flood susceptibility.
- $D_{\text{drainage}}(u) > 0$: Drainage rate coefficient.

## Edge Flooding & Traffic Attenuation
Edge flood depth is the maximum of incident node flood levels:
$$F(e, t) = \max(F(\text{from}, t), F(\text{to}, t))$$
Flood modifies road speed and capacity via exponential reduction factors:
$$M_{\text{flood\_spd}}(e, t) = \exp(-\gamma_{\text{spd}} \cdot F(e, t))$$
$$M_{\text{flood\_cap}}(e, t) = \exp(-\gamma_{\text{cap}} \cdot F(e, t))$$
When $F(e, t) \ge 0.95$, the road segment is treated as fully impassable (`closed = true`).
