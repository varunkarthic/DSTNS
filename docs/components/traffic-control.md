# Traffic Control Engine (`dstns::engine`)

## Purpose
The Traffic Control Engine evaluates macroscopic traffic demand, origin-destination vehicle trips, recurrent congestion hotspots, and speed-density relationships across the 24-hour virtual day.

## Mathematical Traffic Model
1. **Demand Generation**: Background baseline traffic demand $D_{\text{base}}(t)$ is modulated by hour-of-day diurnal waves, weekend/weekday switches, synthetic building attraction/production, and recurrent hotspots.
2. **Effective Capacity**:
   $$C_{\text{eff}}(e, t) = C_{\text{base}}(e) \cdot M_{\text{rain\_cap}}(e, t) \cdot M_{\text{flood\_cap}}(e, t) \cdot M_{\text{manual\_cap}}(e)$$
3. **Effective Speed & Congestion**:
   $$V_{\text{eff}}(e, t) = V_{\text{free}}(e) \cdot \left[ 1 - \left( \frac{D(e, t)}{C_{\text{eff}}(e, t)} \right)^\alpha \right] \cdot M_{\text{rain\_spd}}(e, t) \cdot M_{\text{flood\_spd}}(e, t)$$
   Normalized edge congestion:
   $$c(e, t) = \operatorname{clamp}\left( 1 - \frac{V_{\text{eff}}(e, t)}{V_{\text{free}}(e)}, 0, 1 \right)$$
