# Mathematical Model of DSTNS

## Spatiotemporal Road Graph
$$G(t) = (V, E, \mathbf{X}_V(t), \mathbf{X}_E(t))$$
- $V$: Set of canonical road nodes.
- $E$: Set of directed road edges ($2M$ edges for $M$ physical segments).
- $\mathbf{X}_V(t)$: Node dynamic state (Rainfall, Flood Level, Building Demand Effect).
- $\mathbf{X}_E(t)$: Edge dynamic state (Demand, Effective Capacity, Effective Speed, Congestion).

## Key Governing Equations

### 1. Spatial Kernel (Wendland $C^2$)
For distance $d$ and radius $R$:
$$W(d, R) = \begin{cases} (1 - r)^4(4r + 1), & r = \frac{d}{R} \le 1 \\ 0, & r > 1 \end{cases}$$

### 2. Temporal Activity Windows (Smooth Beta Curve)
For activity interval $[t_{\text{start}}, t_{\text{end}}]$:
$$K(t) = \left(\frac{t - t_{\text{start}}}{t_{\text{end}} - t_{\text{start}}}\right)^p \left(\frac{t_{\text{end}} - t}{t_{\text{end}} - t_{\text{start}}}\right)^q \cdot \frac{(p+q)^{p+q}}{p^p q^q}$$

### 3. Dynamic Weather Precipitation Field
$$\text{Rain}(u, t) = I_{\text{peak}} \cdot W(d(u, \text{epicenter}), R) \cdot K(t)$$

### 4. Flood Reservoir Dynamics
$$\frac{dF(u, t)}{dt} = G_{\text{flood}} \cdot \text{Rain}(u, t) \cdot S_{\text{flood}}(u) - D_{\text{drainage}}(u) \cdot F(u, t)$$

### 5. Multiplicative Speed & Capacity Attenuation
$$C_{\text{eff}}(e, t) = C_{\text{base}}(e) \cdot \exp(-\beta_{\text{rain}} \cdot \text{Rain}) \cdot \exp(-\beta_{\text{flood}} \cdot \text{Flood})$$
$$V_{\text{eff}}(e, t) = V_{\text{free}}(e) \cdot \left[ 1 - \left(\frac{D(e, t)}{C_{\text{eff}}(e, t)}\right)^\alpha \right] \cdot \exp(-\gamma_{\text{rain}} \cdot \text{Rain}) \cdot \exp(-\gamma_{\text{flood}} \cdot \text{Flood})$$
