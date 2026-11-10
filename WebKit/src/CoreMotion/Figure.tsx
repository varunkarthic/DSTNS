// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/**
 * DSTNS's line drawings: one small figure above an empty state's words or at the head of a dialog, drawn from what the
 * simulation is about (roads, a day, a mast, a circuit) and acting out what the words say.
 *
 * Every figure is on the same 160 by 100 plate in the same four line weights of colour: `edge` (the default), `mid`,
 * `lo`, and `hi` for the one thing the figure is about. It draws itself in, stroke by stroke, then keeps one slow
 * movement. The finished drawing is the resting state of every rule in motion.css's figure section, so with reduced
 * motion it is simply a picture. Hidden from assistive technology: the words beside it say the same.
 *
 * Classes: `dash` a dashed line (fades in), `dot` a filled point, `plate` filled with the ground it stands on;
 * `travel` moves along `--path`, `pulse` breathes, `redraw` is drawn and erased over and over, `swing` and `slide`
 * and `close` are the single movements of the figures that use them.
 */

const path = (d: string, extra?: CSSProperties) => ({ "--path": `path("${d}")`, ...extra }) as CSSProperties;
const delay = (s: number) => ({ "--delay": `${s}s` }) as CSSProperties;

const FIGURES = {
  /** No incidents: a junction with traffic passing freely. */
  junction: (
    <>
      <path d="M10 40H62Q70 40 70 32V8" />
      <path d="M150 40H98Q90 40 90 32V8" />
      <path d="M10 60H62Q70 60 70 68V92" />
      <path d="M150 60H98Q90 60 90 68V92" />
      <path className="lo dash" d="M10 50H62M98 50H150M80 8V32M80 68V92" />
      <circle className="dot travel" r="2.6" style={path("M4 55H156", { "--time": "5.2s" } as CSSProperties)} />
      <circle className="dot travel" r="2.6" style={path("M85 0V100", { "--time": "6.4s", "--delay": "2.1s" } as CSSProperties)} />
    </>
  ),
  /** Nothing has happened yet: the day's sun barely up over an unwritten page. */
  dawn: (
    <>
      <path d="M14 70H146" />
      <path className="mid" d="M36 70V74M58 70V74M80 70V75M102 70V74M124 70V74" />
      <path className="lo dash" d="M24 70A56 56 0 0 1 136 70" />
      <circle className="hi plate pulse" cx="27.4" cy="50.8" r="5.5" />
      <path className="hi" d="M17 44L13.5 41.5M27.4 39.5V35.5M38 44L41.5 41.5" />
      <path className="lo" d="M44 83H116M56 91H104" />
    </>
  ),
  /** Nothing scheduled: an empty timeline with the clock's hand passing along it. */
  timeline: (
    <>
      <path d="M12 58H148" />
      <path className="mid" d="M32 58V46M66 58V46M100 58V46M134 58V46" />
      <rect className="mid dash" x="20" y="26" width="24" height="16" rx="4" />
      <rect className="mid dash" x="54" y="26" width="24" height="16" rx="4" />
      <rect className="mid dash" x="88" y="26" width="24" height="16" rx="4" />
      <rect className="mid dash" x="122" y="26" width="24" height="16" rx="4" />
      <path className="lo" d="M15 58V62M49 58V62M83 58V62M117 58V62M148 58V62" />
      <g className="slide">
        <path className="hi" d="M16 20V68" />
        <path className="hi plate" d="M12 68H20L16 75Z" />
      </g>
    </>
  ),
  /** No notifications: a mast with nothing to say, listening. */
  mast: (
    <>
      <path className="lo" d="M30 88H130" />
      <path d="M80 88V47" />
      <path className="mid" d="M71 88L80 60L89 88M75.5 74H84.5" />
      <circle className="hi plate" cx="80" cy="42" r="3.4" />
      <path className="hi pulse" d="M92.3 31.7A16 16 0 0 1 92.3 52.3M67.7 31.7A16 16 0 0 0 67.7 52.3" />
      <path className="mid pulse" style={delay(0.35)} d="M101.4 24A28 28 0 0 1 101.4 60M58.6 24A28 28 0 0 0 58.6 60" />
      <path className="lo pulse" style={delay(0.7)} d="M110.6 16.3A40 40 0 0 1 110.6 67.7M49.4 16.3A40 40 0 0 0 49.4 67.7" />
    </>
  ),
  /** Nothing of this kind: a filter with nothing coming through. */
  filter: (
    <>
      <path d="M30 30H130L98 60V84L62 74V60Z" />
      <path className="mid" d="M44 42H116" />
      <circle className="mid dash" cx="58" cy="15" r="4.5" />
      <circle className="mid dash" cx="80" cy="12" r="4.5" />
      <circle className="mid dash" cx="102" cy="15" r="4.5" />
      <path className="lo dash" d="M80 84V97" />
      <circle className="dot travel" r="2.4" style={path("M80 12V58", { "--time": "4.6s" } as CSSProperties)} />
    </>
  ),
  /** Nothing connected: a plug and its socket, a gap between them. */
  socket: (
    <>
      <path className="mid" d="M6 50H22M138 50H154" />
      <rect x="22" y="37" width="36" height="26" rx="7" />
      <path d="M58 45H69M58 55H69" />
      <rect x="98" y="33" width="40" height="34" rx="9" />
      <path className="mid" d="M106 45H114M106 55H114" />
      <path className="lo dash" d="M73 50H94" />
      <circle className="dot pulse" cx="83.5" cy="50" r="2.6" />
    </>
  ),
  /** No applications: places for them, and one being added. */
  tiles: (
    <>
      <rect className="mid dash" x="20" y="30" width="34" height="34" rx="9" />
      <rect className="hi" x="63" y="30" width="34" height="34" rx="9" />
      <path className="hi pulse" d="M80 40V54M73 47H87" />
      <rect className="mid dash" x="106" y="30" width="34" height="34" rx="9" />
      <path className="lo" d="M20 78H140" />
    </>
  ),
  /** Search: a glass passing over the streets. */
  glass: (
    <>
      <path className="lo" d="M14 30H146M14 58H146M14 84H112M42 12V92M84 12V92M122 12V72" />
      <g className="drift">
        <circle className="hi plate" cx="90" cy="46" r="18" />
        <path className="mid" d="M76 46H104M84 32V60" />
        <path className="hi" d="M103 59L119 75" />
      </g>
    </>
  ),
  /** No such place: a pin that has nowhere to stand. */
  nowhere: (
    <>
      <path className="lo" d="M14 80Q48 68 80 78T146 74M14 91Q58 80 90 88T146 86" />
      <ellipse className="mid" cx="80" cy="74" rx="9" ry="2.6" />
      <g className="hover">
        <path className="dash" d="M80 66C69 52 64 46 64 38A16 16 0 1 1 96 38C96 46 91 52 80 66Z" />
        <circle className="hi" cx="80" cy="38" r="5" />
      </g>
    </>
  ),
  /** Reset: the sun going back along the day to where it rose. */
  rewind: (
    <>
      <path d="M14 76H146" />
      <path className="mid" d="M36 76V80M58 76V80M80 76V81M102 76V80M124 76V80" />
      <path className="mid" d="M24 76A56 56 0 0 1 136 76" />
      <circle className="lo dash" cx="124.1" cy="41.5" r="5.5" />
      <path className="hi" d="M25.5 46.5L27.4 56.8L37 52" />
      <circle className="dot travel back" r="4.2" style={path("M124.1 41.5A56 56 0 0 0 27.4 56.8", { "--time": "3.4s" } as CSSProperties)} />
    </>
  ),
  /** A new world: the same block of city, its streets drawn again and again. */
  redraw: (
    <>
      <rect x="30" y="12" width="100" height="76" rx="12" />
      <path className="hi redraw" d="M30 40H130" />
      <path className="hi redraw" style={delay(0.5)} d="M64 12V88" />
      <path className="mid redraw" style={delay(1)} d="M64 64H130" />
      <path className="mid redraw" style={delay(1.5)} d="M98 40V88" />
      <path className="mid redraw" style={delay(2)} d="M64 26H112Q118 26 118 32V40" />
      <path className="lo dash" d="M40 22H54M40 30H50M40 52H54M40 60H48M40 74H54M76 76H88M108 52H120M108 76H120" />
    </>
  ),
  /** Terminate: a circuit opened, and what was flowing through it stopping at the gap. */
  breaker: (
    <>
      <path d="M12 54H60" />
      <path className="lo dash" d="M100 54H148" />
      <path className="hi swing" d="M62 54H98" />
      <circle className="plate" cx="62" cy="54" r="3.4" />
      <circle className="plate" cx="100" cy="54" r="3.4" />
      <path className="mid" d="M22 54V44M38 54V44M122 54V44M138 54V44" />
      <circle className="dot travel stop" r="2.6" style={path("M12 54H56", { "--time": "2.8s" } as CSSProperties)} />
    </>
  ),
  /** Auto Focus: a frame closing on what is happening. */
  viewfinder: (
    <>
      <path className="lo" d="M10 64H150M10 30H96M58 8V92M112 30V92" />
      <g className="close">
        <path d="M44 34V24H58M102 24H116V34M116 66V76H102M58 76H44V66" />
      </g>
      <circle className="hi pulse" cx="80" cy="50" r="9" />
      <circle className="dot" cx="80" cy="50" r="2.8" />
    </>
  ),
  /** The day is complete: the whole arc, travelled. */
  arc: (
    <>
      <path d="M14 76H146" />
      <path className="mid" d="M36 76V80M58 76V80M80 76V81M102 76V80M124 76V80" />
      <path className="hi slow" d="M24 76A56 56 0 0 1 136 76" />
      <circle className="hi plate" cx="24" cy="76" r="3" />
      <circle className="hi plate" cx="136" cy="76" r="8.5" />
      <path className="hi" d="M131.8 76.2L134.9 79.4L140.4 72.6" />
    </>
  ),
  /** Out of step: the observer still beating, the simulation holding still. */
  apart: (
    <>
      <path d="M14 36H58L64 24L72 48L78 36H146" />
      <circle className="dot travel" r="2.6" style={path("M14 36H58L64 24L72 48L78 36H146", { "--time": "3.6s" } as CSSProperties)} />
      <path className="mid dash" d="M14 70H68M92 70H146" />
      <path className="hi pulse" d="M76 62V78M84 62V78" />
    </>
  ),
  /** About: a city, the mast that serves it, and the road beneath. */
  city: (
    <>
      <path d="M10 80H150" />
      <path className="mid" d="M20 80V58H36V80M40 80V44H58V80M102 80V50H118V80M122 80V62H140V80" />
      <path className="lo" d="M45 52H53M45 60H53M45 68H53M107 58H113M107 66H113M25 66H31M127 70H135" />
      <path d="M80 80V41" />
      <path className="mid" d="M73 80L80 56L87 80" />
      <circle className="hi plate" cx="80" cy="36" r="3.2" />
      <path className="hi pulse" d="M89.2 28.3A12 12 0 0 1 89.2 43.7M70.8 28.3A12 12 0 0 0 70.8 43.7" />
      <path className="mid pulse" style={delay(0.35)} d="M96.9 21.9A22 22 0 0 1 96.9 50.1M63.1 21.9A22 22 0 0 0 63.1 50.1" />
      <path className="lo dash" d="M10 91H150" />
      <circle className="dot travel" r="2.4" style={path("M6 91H154", { "--time": "6s" } as CSSProperties)} />
    </>
  ),
} as const satisfies Record<string, ReactNode>;

export type FigureName = keyof typeof FIGURES;
export const FIGURE_NAMES = Object.keys(FIGURES) as FigureName[];

export function Figure({ name, className = "" }: { name: FigureName; className?: string }) {
  const svg = useRef<SVGSVGElement>(null);
  // Pressed, it draws itself again.
  const [drawing, setDrawing] = useState(0);
  // Each stroke is drawn in after the one before it.
  useLayoutEffect(() => {
    svg.current?.querySelectorAll<SVGElement>("path, rect, circle, ellipse").forEach((el, i) => {
      el.style.setProperty("--i", String(i));
      if (!el.matches(".dash, .dot")) el.setAttribute("pathLength", "1");
    });
  }, [name, drawing]);
  // It leans toward the pointer over what holds it, its one subject a little further than the rest, and settles back
  // when the pointer leaves. Nothing moves under reduced motion.
  useEffect(() => {
    const host = svg.current?.parentElement;
    if (!host || document.documentElement.classList.contains("reduce-motion") || matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const lean = (x: number, y: number) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        svg.current?.style.setProperty("--fx", x.toFixed(3));
        svg.current?.style.setProperty("--fy", y.toFixed(3));
      });
    };
    const move = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      lean(Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1)), Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1)));
    };
    const leave = () => lean(0, 0);
    const press = (e: PointerEvent) => {
      if (e.button === 0 && !(e.target as Element).closest?.("button, a, input")) setDrawing((n) => n + 1);
    };
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    host.addEventListener("pointerdown", press);
    return () => {
      cancelAnimationFrame(frame);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      host.removeEventListener("pointerdown", press);
    };
  }, [name]);
  return (
    <svg ref={svg} key={`${name}-${drawing}`} className={`figure figure-${name} ${className}`} viewBox="0 0 160 100" aria-hidden="true" focusable="false">
      {FIGURES[name]}
    </svg>
  );
}
