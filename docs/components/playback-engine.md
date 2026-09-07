# Playback Engine & Checkpoints (`dstns::engine`)

## Purpose
The Playback Engine coordinates time progression across the three-clock model (playback clock $t_P \in [0, T_P]$, virtual day clock $t_D \in [0, 86399]$, and physics engine clock $t_{\text{SUMO}}$). It handles start, pause, play, seek, rate scaling, and periodic snapshotting.

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
2. **Tick Rate**: Multiplier $k_{\text{tick}} \in (0, 10]$ (default 1.0).
3. **Target Virtual Rate**:
   $$\text{target\_virtual\_rate} = \text{base\_rate} \cdot k_{\text{tick}}$$
4. **Effective Virtual Rate & Lag**: If computational throughput cannot achieve target speed, physics steps are never skipped; the simulation tracks lagging virtual seconds $\Delta t_{\text{lag}}$.

## Checkpointing & Fast Seeking
- Checkpoints are captured at fixed 900-virtual-second boundaries. Physics steps are shortened when necessary to land exactly on each crossed boundary, even after an unaligned live tick or seek.
- Seeking to target virtual time $t_{\text{target}}$ restores the nearest preceding checkpoint $t_{\text{cp}} \le t_{\text{target}}$ and rolls physics forward to $t_{\text{target}}$.
- Checkpoints include the news-log size and next news identifier. Rewinding truncates invalid future checkpoints and restores that cursor before replay, so state and news identifiers reproduce exactly.
- Forward seeks advance from current state; backward seeks restore and replay from the nearest retained checkpoint.
