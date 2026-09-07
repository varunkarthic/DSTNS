# DWS: Deterministic Weather Simulation

> **CRITICAL TERMINOLOGY SPECIFICATION**: 
> The acronym **DWS** stands exclusively for **Deterministic Weather Simulation**.
> It does **NOT** mean Dynamic Weather Simulation.

---

## 1. Overview & Mathematical Model

DSTNS models localized atmospheric disturbances (rain storms, flash floods, convective cells) as continuous, compact-support radial kernels moving over the road network graph.

A storm cell $k$ is parameterized at simulation time $t$ by:
- Center coordinates: $\mathbf{x}_k(t) = \mathbf{x}_{k,0} + \mathbf{v}_k \cdot t$
- Radius of influence: $R_k$ (typically $200\text{m} - 800\text{m}$)
- Peak intensity: $I_{k,0}$ ($\text{mm/hr}$)
- Kinematic drift velocity: $\mathbf{v}_k$ ($\text{m/s}$)

### Wendland $C^2$ Compact Spatial Kernel
To avoid discontinuous edge steps and infinite tails, spatial precipitation is evaluated using the Wendland $C^2$ radial basis function:

$$r = \|\mathbf{x} - \mathbf{x}_k(t)\|$$
$$q = \frac{r}{R_k}$$

$$W(q) = \begin{cases}
(1 - q)^4 (4q + 1) & \text{for } 0 \le q \le 1 \\
0 & \text{for } q > 1
\end{cases}$$

Precipitation at geographic point $\mathbf{x}$ is the superposition of all active storm cells:
$$P(\mathbf{x}, t) = \sum_{k \in \mathcal{K}_{\text{active}}} I_{k,0} \cdot W\left(\frac{\|\mathbf{x} - \mathbf{x}_k(t)\|}{R_k}\right)$$

---

## 2. Impact on Road Network Dynamics

Precipitation affects edge dynamics through two coupled physical mechanisms:

### 1. Speed Attenuation (Friction & Visibility Loss)
Road surface water depth and heavy precipitation degrade braking distances and driver speeds:
$$f_{\text{weather}}(e, t) = 1.0 - \beta_{\text{rain}} \cdot \min\left(1.0, \frac{P(\mathbf{x}_e, t)}{P_{\text{max}}}\right)$$
where $\beta_{\text{rain}} \approx 0.35$ (up to 35% speed reduction in torrential rain).

### 2. Runoff Accumulation & Flooding
Low-lying road segments accumulate water according to surface runoff and drainage thresholds:
$$h_{\text{flood}}(e, t) = \max\left(0, \int P(\mathbf{x}_e, \tau)\, d\tau - \text{drainage} \times t\right)$$
When water depth exceeds $h_{\text{critical}} \approx 0.30\text{m}$, the edge is marked impassable (`is_closed = true`), prompting traffic rerouting.

---

## 3. Strict Determinism Guarantee

All storm cell origins, radii, velocities, and rainfall intensities are derived exclusively from the domain-separated `dws_rng` initialized with `Seed128::derive("dws")`.

1. **Independent RNG Stream**: Weather dynamics remain completely invariant to changes in incident schedules, traffic routing algorithms, or transit bus dispatching.
2. **Zero System Clock Dependency**: Weather progression is strictly indexed to the virtual day clock $t_D$ in seconds.
3. **Reproducibility Test**: Verified by `DWS_Determinism` in `test_main.cpp`, guaranteeing identical precipitation vectors across runs.
