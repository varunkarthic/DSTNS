# Interface system

How the observer looks and moves, for anyone changing it.

## Motion

Everything that moves is a damped spring, defined in `ui-engine/src/motion.ts` by
stiffness and damping rather than a duration and a curve. Motion should feel deliberate
and physical, never decorative. If a transition does not explain hierarchy, cause,
destination or continuity, it should not happen.

| Spring | k | c | Use for |
|---|---|---|---|
| `spatialFast` | 800 | 52 | Press, thumb, tooltip, small moves |
| `spatialDefault` | 420 | 38 | Popovers, dialogs, panels, expanding |
| `spatialSlow` | 220 | 28 | Large moves, page changes |
| `effectsFast` | 900 | 60 | Hover, focus, colour, dismissal |
| `effectsDefault` | 400 | 40 | Fades, shadow |
| `effectsSlow` | 196 | 28 | Blur, the start-up dissolve |
| `lively` | 420 | 30 | Direct manipulation: release, switch thumb, selection pill |
| `camera` | 42 | 13 | The map's long moves. Never overshoots |
| `cameraZoom` | 260 | 32.2 | Wheel and button zoom |

**Spatial** springs move position, size and shape, and may overshoot slightly.
**Effects** springs change opacity, colour, blur and shadow, and are critically damped
because those cannot overshoot. Overshoot above 5% needs a written reason, and nothing
here has one.

### Using it

- **In CSS,** use the published tokens: `transition: transform var(--spring-spatialDefault-ms) var(--spring-spatialDefault)`. Older `--ease` and `--t-*` tokens route through them.
- **To enter,** prefer a transition with `@starting-style` over keyframes, because a
  transition reverses from wherever it has got to. Keyframes jump.
- **For something dragged or thrown,** use `Spring` from `motion.ts`, which keeps its
  velocity when retargeted. The settings drawer and map camera do this.
- **For a surface leaving the DOM,** take its time from `MOTION_MS`, so timers cannot
  drift from the CSS that moves it.
- **Animate** `transform` and `opacity`. Do not route per-frame values through React
  state: the map hands its camera to the overlay directly, because state would re-render
  the shell every frame.

### Reduced motion

`reduce_motion` follows the operating system (`auto`) unless a person chooses, and
Adaptive Simulation Backpressure can hold it on. Under `.reduce-motion`, travel, scale
and blur collapse to a short fade or nothing, the map camera jumps, and the map does not
coast. Test the three modes, not only the full one.

## Tokens

Defined in `system.css`. Use these rather than literal values.

| Kind | Tokens |
|---|---|
| Radius | `--r-xs` 6, `--r-sm` 10, `--r-md` 14, `--r-lg` 18, `--r-xl` 24, `--r-pill` |
| Control height | `--ctl-sm` 26, `--ctl` 32, `--ctl-lg` 36 |
| Surface | `--glass` translucent, `--surface-solid` where text is read at length |
| Palette | `--accent`, `--ok`, `--warn`, `--danger`, `--text`, `--text-dim`, `--text-faint` |

Interactive targets are at least 24 px, the WCAG 2.5.8 minimum. A surface holding text
someone reads at length uses `--surface-solid`, because the map behind it otherwise
competes with the text.

## Start-up

One surface, `LoadingSurface` in `boot` mode, for every state before a map:

| State | Shows |
|---|---|
| Waiting | The mark and what to do. No motion, because nothing is happening |
| Loading | The mark, the real stage, and the five stages on one line. A bar only where a real total is known; otherwise a band that claims no amount |
| Failed | What happened, that nothing was lost, and Reload. Clears by itself when the simulator answers |
| Shut down | That the server has stopped, and how to start again |

It dissolves into the map as soon as the map exists. Nothing is held for effect, and
stages are never shown as if they were still running after they finish.

## Known limits

The four stylesheets (`style.css`, `theme.css`, `hud.css`, `system.css`) still overlap,
with later files winning. Merging them into cascade layers would change which rules win
wherever specificity and load order disagree, so it needs a visual regression suite
first. Tokens and shared rules are the path in the meantime: do not add a fifth way to
do something. A few small bars still animate `width`.
