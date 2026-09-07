# Traffic Dynamics (`dstns::SimulationEngine::physics_step`)

## Purpose
The Traffic Control Engine evaluates macroscopic traffic demand, origin-destination vehicle trips, recurrent congestion hotspots, and speed-density relationships across the 24-hour virtual day.

## Mathematical Traffic Model
1. **Demand Generation**: Background baseline traffic demand $D_{\text{base}}(t)$ is modulated by hour-of-day diurnal waves, weekend/weekday switches, synthetic building attraction/production, and recurrent hotspots.
2. **Effective Capacity**: Base capacity is multiplied by signal, rain, flood, and manual-capacity factors.
3. **Effective Speed**: A target speed multiplies free speed by signal, rain, flood, and manual-speed factors. The current value approaches that target using bounded acceleration/deceleration steps.
4. **Queues and Congestion**: Vehicle count approaches a demand-derived queue target. Model congestion, observed speed/halting/occupancy congestion, and the final weighted congestion value are clamped to $[0,1]$.

This is a deterministic macroscopic model inside `physics_step`; it is separate from the optional external SUMO process run.
