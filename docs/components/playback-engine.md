# Playback and Checkpoints (`dstns::SimulationEngine`)

## Purpose
`SimulationEngine` maps elapsed wall time onto a virtual day $t_D \in [0,86400]$ using the configured playback duration $T_P$. Its built-in deterministic traffic physics advances in virtual-time steps; an optional SUMO run is a separate exported process, not a third synchronized engine clock.

## Lifecycle States
```text
BOOTING -> IDLE -> PREPARING -> READY -> RUNNING <-> PAUSED
                                            |            |
                                            v            v
                                         SEEKING      STOPPING -> STOPPED -> IDLE
                                            |
                                            v
                                        COMPLETED -> TERMINATING
```

## Three-Clock Model & Rate Scaling
1. **Base Rate**:
   $$\text{base\_rate} = \frac{86400}{T_P}$$
2. **Tick Rate**: Multiplier $k_{\text{tick}} \in (0, 100]$ (default 1.0).
3. **Target Virtual Rate**:
   $$\text{target\_virtual\_rate} = \text{base\_rate} \cdot k_{\text{tick}}$$
4. **Stepping**: The worker wakes about every 50 ms and calls `step_to`; physics is integrated in steps no larger than 60 virtual seconds and shortened at checkpoint boundaries.

## Checkpointing & Fast Seeking
- Checkpoints are captured at fixed 900-virtual-second boundaries. Physics steps are shortened when necessary to land exactly on each crossed boundary, even after an unaligned live tick or seek.
- Seeking to target virtual time $t_{\text{target}}$ restores the nearest preceding checkpoint $t_{\text{cp}} \le t_{\text{target}}$ and rolls physics forward to $t_{\text{target}}$.
- Checkpoints include the news-log size and next news identifier. Rewinding truncates invalid future checkpoints and restores that cursor before replay, so state and news identifiers reproduce exactly.
- Forward seeks advance from current state; backward seeks restore and replay from the nearest retained checkpoint.
