# Synthetic Building Subsystem (`dstns::scenario`)

## Purpose
Generates synthetic points of interest (Schools, Offices, Malls, Stores) around bus stop nodes and computes continuous temporal demand influence functions.

## Building Categories & Profiles
1. **School**:
   - Weekday peak windows: Morning drop-off (07:30–08:30), Afternoon pick-up (14:30–15:30).
   - Weekend influence: 0.
2. **Office**:
   - Weekday peak windows: Morning commute (08:00–09:30), Evening commute (17:00–18:30).
   - Weekend influence: Minimal (0.05).
3. **Mall**:
   - Weekday peak windows: Evening leisure (18:00–21:00).
   - Weekend peak windows: Afternoon & evening (12:00–20:00).
4. **Store**:
   - General daytime retail curve (09:00–19:00) on both weekdays and weekends.

## Temporal Kernel Formulation
Each activity window $[t_{\text{start}}, t_{\text{end}}]$ uses a smooth Beta-style polynomial kernel with rise power $p$ and fall power $q$:
$$K(t) = \left( \frac{t - t_{\text{start}}}{t_{\text{end}} - t_{\text{start}}} \right)^p \left( \frac{t_{\text{end}} - t}{t_{\text{end}} - t_{\text{start}}} \right)^q \cdot \frac{(p+q)^{p+q}}{p^p q^q}$$
This guarantees $K(t) \in [0, 1]$ with peak exactly 1.0 and smooth derivative transitions at window boundaries.
