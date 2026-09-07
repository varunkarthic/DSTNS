# Routing Engine & Shortest Path Computation

DSTNS integrates a high-performance $A^*$ routing engine capable of evaluating thousands of shortest path queries per second across large road networks.

---

## 1. Dynamic Travel-Time Cost Function

Rather than static geometric distance, the edge traversal cost dynamically reflects instantaneous traffic conditions, incidents, and weather:

$$c(e, t) = \begin{cases}
\infty & \text{if } e.\text{is\_closed} \lor e.\text{incident\_closed} \\
\frac{L_e}{v_{\text{eff}}(e, t)} & \text{otherwise}
\end{cases}$$

Where $v_{\text{eff}}$ accounts for:
- Base speed limit ($v_{\text{free}}$)
- BPR congestion slowdown: $(1 - C_e)^\alpha$
- Deterministic Weather Simulation (DWS) surface precipitation friction loss
- Incident speed attenuation: `incident_speed_multiplier`

---

## 2. $A^*$ Search Implementation

1. **Admissible Heuristic**: Straight-line Euclidean distance between node $u$ and destination $d$, divided by the global maximum speed limit ($v_{\text{max}}$):
   $$h(u, d) = \frac{\|\mathbf{x}_u - \mathbf{x}_d\|}{v_{\text{max}}}$$
   This satisfies the admissibility condition $h(u, d) \le c^*(u, d)$, guaranteeing optimal shortest paths.
2. **Priority Queue**: `std::priority_queue` tracking minimum estimated cost $f(u) = g(u) + h(u, d)$.
3. **Performance**: Evaluates 2,500 routing queries in under 50 milliseconds ($\sim 20\mu\text{s}$ per query).

---

## 3. Public Transit Route Verification

When an operator submits a bus route via `POST /api/v1/control/transit/route`, the engine:
1. Verifies that all nodes $[u_0, u_1, \dots, u_k]$ exist in the active graph.
2. Asserts topological adjacency: for every step $(u_i, u_{i+1})$, there exists a valid, traversable directed edge $e \in E$.
3. Checks that no intermediate edge is closed due to flooding or incidents.
4. Computes total route distance and registers the bus entity for live map rendering.
