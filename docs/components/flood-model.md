# Flood Reservoir Dynamics (`dstns::SimulationEngine::physics_step`)

## Purpose
Simulates normalized water accumulation and drainage across road nodes and directed edges as a dynamic reservoir system driven by rainfall and local susceptibility.

## Reservoir Equations
Let $F(u, t)$ denote the normalized flood level at node $u$.
Differential evolution over timestep $\Delta t$:
$$\frac{dF(u, t)}{dt} = 0.018 \cdot \text{Rain}(u, t) \cdot S_{\text{flood}}(u) - 0.004 \cdot D_{\text{drainage}}(u) \cdot F(u, t)$$
Discrete integration:
$$F(u, t + \Delta t) = \operatorname{clamp}\left( F(u, t) + \Delta t \left( G \cdot \text{Rain} \cdot S - D \cdot F \right), 0, 1 \right)$$
where:
- $S_{\text{flood}}(u) \in [0, 1]$: Topographic flood susceptibility.
- $D_{\text{drainage}}(u) > 0$: Drainage rate coefficient.

## Edge Flooding & Traffic Attenuation
Edge flood is the mean of its endpoint levels:
$$F(e, t) = \frac{F(\text{from}, t)+F(\text{to}, t)}{2}$$
The current linear attenuation factors are $\max(0.35,1-0.55F)$ for speed and $\max(0.30,1-0.60F)$ for capacity. An edge is closed when its flood value reaches `0.98`, or when a manual closure is active.
