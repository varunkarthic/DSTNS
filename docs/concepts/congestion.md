# Congestion and road state

How DSTNS measures congestion on each road and across the network, how the moving
average is smoothed, and how the observer decides which colour to draw each road. The
equations are in the [Mathematical model](mathematical-model.md#congestion).

## Per-road congestion

Every directed road segment \(e\) has a congestion value \(c_e\) between 0 and 1,
recomputed every virtual second. It combines three observable symptoms of
congestion, weighted by how strongly each indicates it:

\[
c_e =
\begin{cases}
1 & \text{if the road is closed} \\
\operatorname{clamp}\big(0.60\,\ell_e + 0.25\,\eta_e + 0.15\,o_e,\; 0,\; 1\big) & \text{otherwise}
\end{cases}
\]

| Term | Weight | Meaning | Computed as |
|---|---|---|---|
| \(\ell_e\), speed loss | 0.60 | How much slower than free flow the traffic moves | \(1 - \bar v_e / v^{\text{free}}_e\), or 0 on an empty road |
| \(\eta_e\), queue ratio | 0.25 | The share of vehicles that are stopped | halting vehicles ÷ \(\max(1, \text{vehicles})\) |
| \(o_e\), occupancy | 0.15 | How full the road is | \(5N_e / (L_e n_e)\), clamped to [0, 1] |

Speed loss carries the most weight because it is what a driver experiences. An
empty road has no congestion, however slow its free-flow speed, and a closed road is
fully congested by definition, whether or not anything is on it.

## The network index

The network's **congestion index** is the weighted mean of road congestion, as a
percentage:

\[
C(t) = 100 \cdot \frac{\sum_e w_e\, c_e}{\sum_e w_e}, \qquad w_e = L_e \times n_e
\]

Each road is weighted by its length times its number of lanes, so a long multi-lane
arterial counts for more than a short alley. Only directions that traffic may legally
use are counted: the synthetic reverse direction of a one-way road never contributes.

## The moving average

The index moves second by second, so DSTNS also reports an exponential moving
average with a time constant of 900 virtual seconds (15 minutes):

\[
\bar C \leftarrow \alpha\,C + (1 - \alpha)\,\bar C, \qquad \alpha = 1 - e^{-\Delta t / 900}
\]

The first observation initialises the average. Physics always advances in steps of
one virtual second, so the average does not depend on playback speed. Writing the
weight in terms of the elapsed time \(\Delta t\) keeps the 15-minute time constant
meaningful if the step size ever changes. Both values stay within 0 to 100%.

| Reported value | Meaning |
|---|---|
| `current` | \(C(t)\) now |
| `average` | \(\bar C\), the 15-minute moving average |
| `delta` | `current − average`, in percentage points: positive means congestion is building |
| `history` | One sample per virtual minute of `current` and `average` |

The observer's telemetry deck shows the current value, the average and the
difference, labelled in percentage points (`pp`), and the report charts the history.

```bash
curl -s localhost:8090/api/v1/view/congestion | python3 -m json.tool | head -20
```

## Road colours

The observer gives every road one primary state, in this order of precedence:

| Precedence | State | Condition | Colour |
|---|---|---|---|
| 1 | Flooded | Flood level above 0.01 | Blue |
| 2 | Blocked | Closed by an incident or an operator | Red |
| 3 | Severe | \(c_e \ge 0.70\) | Red |
| 4 | Moderate | \(0.35 \le c_e < 0.70\) | Amber |
| 5 | Clear | \(c_e < 0.35\) | Green |

Flooding is shown first because it explains the congestion that usually accompanies
it; a road closed by deep water therefore shows as flooded rather than blocked. Rain on its own never turns a road red; it slows traffic, and the slowdown shows
through congestion. Rain cells are drawn as their own layer with their actual radius
and intensity. Hovering over a road lists every effect acting on it at once: flood,
rain, incident, signal and place demand.

## Related

- [Mathematical model: congestion](mathematical-model.md#congestion): the full equations
- [Simulation engine: congestion](simulation-engine.md#congestion): where it is computed in the physics step
- [View API](../api/view-api.md): reading per-road state and the index
