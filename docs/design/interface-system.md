# Interface system

How the observer looks and moves, for anyone changing it.

## Motion

Everything that moves is a damped spring, defined in `WebKit/src/motion.ts` by
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
| `expressiveFast`, `expressiveDefault`, `expressiveSlow` | 700, 380, 200 | 34, 24, 17 | Moments meant to be felt: a thumb landing, an expand, a page arriving. Overshoot stays under 12% |
| `camera` | 42 | 13 | The map's long moves. Never overshoots |
| `cameraZoom` | 260 | 32.2 | Wheel and button zoom |

**Spatial** springs move position, size and shape, and may overshoot slightly.
**Effects** springs change opacity, colour, blur and shadow, and are critically damped
because those cannot overshoot. Overshoot above 5% is for the expressive scheme only.

Ask for a spring by what the movement is for, through `--motion-<purpose>` and
`--motion-<purpose>-ms` (`press`, `release`, `thumb`, `hover`, `reveal`, `dismiss`, `expand`,
`collapse`, `shift`, `overlay`, `page`, `drag`, `snap`, `success`, `fade`, `blur`, `stagger`), so
related movements stay related.

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

## Curvature

One scale, in `system.css`, and a test that fails on anything else. Floating surfaces (bars, panels, menus, cards)
take `--r-lg` (18 px). What sits on them takes `--r-md` (14 px) or `--r-sm` (10 px), which is also every button and
control. Small marks take `--r-xs` (6 px). Only badges, chips, switches and slider tracks are fully round, because
that shape says what they are.

## Dynamic Edge Resistance

Whatever has a limit answers being pushed past it the same way: it follows at first, gives
ever less the further it goes, and comes back on a critically damped spring. It starts at the speed the content arrived, so a slow scroll barely shows and a fast one travels further, as one motion. It never blocks scrolling, which stays with the browser, and the frame of the region stays still while what is inside it moves. That says "this
is the end" without a hard stop. `resistance.ts` holds it, using the curve Apple's scroll
views use:

\[ d(p) = b\left(1 - \frac{1}{0.55\,p / b + 1}\right) \]

for a pull \(p\) past the limit and a bound \(b\) that follows the size of what is being
stretched, so a small menu gives less than a long panel. A stiff spring follows the pull, which
smooths the steps a mouse wheel arrives in; a softer one with no bounce takes it home.

| Where | Limit |
|---|---|
| Every scrolling region | Its top and bottom. `installEdgeResistance` covers them all, so a new menu needs nothing |
| Map zoom | 5% past fit is free, resistance to a hard 10%, and it settles back to 5% |
| Map pan | Part of the network stays on screen |
| Speed and interval sliders | Either end |

**The page never scrolls.** Only a region under the pointer does. `html`, `body`, the shell and
the workspace use `overflow: clip`, wheel events over anything else are cancelled, and a focus
or `scrollIntoView` that moves one of those containers anyway is put straight back. Focus with
`{ preventScroll: true }`.

## Secondary panels

Settings and search grow from the dock like a drop: a bead at the icon bulges out on a neck, the
neck thins and lets go, and the drop swells upward and outward into a panel the height of the
dock. Closing runs the same path backward. `FluidPanel.tsx` drives it all from one spring value,
so it can reverse at any point, and neither panel closes when the map is used. There is one
open at a time.

Slider-like choices use `QuantizedSlider`: it follows the pointer and settles on the labelled
stop its momentum reaches. Use a switch at the end of a row; put anything larger under the title
with `<Row stacked>`. Use `Select`, never a native `<select>`.

Keep icon motion rare and meaningful: most icons do not move at all on hover.

## Accessibility settings

| Setting | Effect |
|---|---|
| Appearance | Dark, light, or following the device. Colours are tokens (`--ink-rgb`, `--surface-rgb`, `--line-rgb`), and the map's canvas reads the same palette from `appearance.ts` |
| Colour vision | Palettes for protanopia, deuteranopia, tritanopia and monochrome, for road states, severity and application series. `tests/appearance.test.ts` simulates each with the Machado 2009 matrices and requires the road states to stay apart |
| Reduce motion | As above |
| Reduce transparency | Fully opaque surfaces and overlays |
| Advanced mode | Off, demand multipliers, radii, identifiers and technical details step aside. Mark such things `.advanced-only` |

Never write a raw colour. Add it to the palette, or use a token. Light mode is designed in its
own right: white surfaces lifted by soft shadow rather than outlines, and a pale map. Logos use
the official drawing for each theme through `BrandLogo`, never a filter.

## Performance

Surfaces over the map are solid: a blurred surface re-blurs the moving canvas beneath it on every
frame. Anything that changes per frame or per pointer move goes straight to the page rather than
through React state; `MapReadout` is the pattern. Flow markers draw at half the frame rate, leaving
the main thread free. Under a 4× CPU throttle in headless Chrome, these took pointer movement from 42
to 60 fps and zooming from 34 to 58 fps. Headless Chrome cannot show what the GPU saves.

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
| Opening | Nothing for two seconds, then a still title: the name, its designer and its licence. It then moves to the corner and the film begins |
| Waiting | The film, and what to do. No progress, because nothing is loading |
| Loading | The film, the current stage, and the five stages along the bottom. A segment fills only where a real total is known; otherwise it moves without claiming how far along it is |
| Failed | What happened, that nothing was lost, and Reload. Clears by itself when the simulator answers |
| Shut down | That the server has stopped, and how to start again |

The film is one WebGL2 draw of 24,000 particles that re-form into the wordmark, streets, a city, traffic,
weather, a world of seeds and the WebFabric weave, each with a caption. It never reflects progress. The pointer
parts the cloud and a click sends a ring through it. When the map is ready, the particles fly to the
roads exactly where the map has drawn them and give way to it, so the film becomes the map. A failure
or a shutdown is something to read, so it stays a card in the middle, with the network resting dimly behind it.

Generating a new world uses the same particles, without a break. They lift off the current map's roads, form the name, blast apart and recollect into it, and the film carries on until they land on the new world's roads. It does not repeat the title, and it does not wait for a full cycle of the film: once the name has re-formed, it leaves as soon as the world is ready.

It dissolves into the map as soon as the map exists, and the interface arrives around it in
a stagger. Nothing is held for effect, and
stages are never shown as if they were still running after they finish.

## Known limits

The stylesheets (`style.css`, `theme.css`, `hud.css`, `system.css`, then `design.css`) still
overlap, with later files winning. Merging them into cascade layers would change which rules win
wherever specificity and load order disagree, so it needs a visual regression suite
first. Tokens and shared rules are the path in the meantime: do not add a fifth way to
do something. A few small bars still animate `width`.

## Keyboard shortcuts

`shortcuts.ts` holds the defaults, and only what a person changes is stored. They do nothing while typing in a field, in a dialog, during the
tutorial or during start-up, and Space on a focused control still presses that control. A key already in use swaps, so no key has two meanings.

## Intentional System Design

`ISDHandler.tsx` explains what is on purpose but looks like a fault. A notification in the tray states that it is
intended, why, and what to do next. Do Not Disturb does not silence it, and it appears once per page load. To add a case,
add it to `isdNote` and its condition where the hook is used. Real failures do not belong here: they are reported as errors.
