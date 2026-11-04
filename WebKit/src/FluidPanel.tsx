// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Spring } from "./motion";

/**
 * A secondary panel that grows out of the side panel like a drop.
 *
 * It starts as a bead at the icon that asked for it, inside the dock's edge. The
 * bead bulges out on a neck of the same material, the neck thins and lets go, and
 * the drop swells upward and outward into a panel the height of the column. Closing
 * runs the same path backward, so it is drawn back in. Everything is one spring
 * value, so opening and closing can interrupt each other at any point.
 */

const OPEN = { k: 46, c: 10.5 };
const CLOSE = { k: 74, c: 15 };
const BEAD = 21;
const GAP = 12;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The shape at a point along the way. Pure, so it can be checked. */
export function fluidFrame(t: number, height: number, width: number, anchorY: number) {
  const out = smooth(t / 0.34);
  const swell = smooth((t - 0.16) / 0.84);
  const lift = smooth((t - 0.22) / 0.78);
  return {
    shiftX: lerp(-(GAP + BEAD * 1.7), 0, out),
    top: Math.max(0, lerp(anchorY - BEAD, 0, lift)),
    bottom: Math.max(0, lerp(height - anchorY - BEAD, 0, swell)),
    right: Math.max(0, lerp(width - BEAD * 2, 0, swell)),
    radius: lerp(BEAD, 36, swell),
    /** Half-thickness of the neck at its waist; gone by the time the drop lets go. */
    neck: t < 0.6 ? lerp(BEAD * 0.86, 0, smooth(t / 0.6)) : 0,
    content: smooth((t - 0.46) / 0.42),
  };
}

export const FluidPanel = forwardRef<HTMLElement, {
  open: boolean;
  /** The icon the panel grows from. */
  anchor: string;
  label: string;
  width?: number;
  /** A panel shorter than the column, centred on its icon. By default it runs from the dock's top to the lower bar. */
  fitHeight?: number;
  className?: string;
  reduceMotion?: boolean;
  children: ReactNode;
}>(function FluidPanel({ open, anchor, label, width = 372, fitHeight, className = "", reduceMotion = false, children }, ref) {
  const panel = useRef<HTMLElement>(null);
  const neck = useRef<SVGPathElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const geometry = useRef({ left: 0, top: 0, height: 0, anchorY: 0 });
  const spring = useRef<Spring | null>(null);
  const [resting, setResting] = useState<"closed" | "moving" | "open">(open ? "open" : "closed");
  useImperativeHandle(ref, () => panel.current as HTMLElement, []);

  const measure = () => {
    const dock = document.querySelector(".map-dock")?.getBoundingClientRect();
    const icon = document.querySelector(anchor)?.getBoundingClientRect();
    if (!dock || !icon) return;
    const iconY = icon.top + icon.height / 2;
    // From the top of the dock to just above the lower bar: the whole column, so that nothing in it is squeezed.
    const floor = document.querySelector(".lower-hud")?.getBoundingClientRect().top ?? window.innerHeight - 24;
    const column = Math.max(dock.height, floor - GAP - dock.top);
    const height = fitHeight ?? column;
    const top = fitHeight ? Math.max(dock.top, Math.min(iconY - fitHeight / 2, dock.bottom - fitHeight)) : dock.top;
    geometry.current = { left: dock.right + GAP, top, height, anchorY: iconY - top };
    const el = panel.current;
    if (el) {
      el.style.left = `${dock.right + GAP}px`;
      el.style.top = `${top}px`;
      el.style.height = `${height}px`;
      el.style.width = `${width}px`;
    }
    if (svg.current) {
      svg.current.style.left = `${dock.right - 3}px`;
      svg.current.style.top = `${icon.top + icon.height / 2 - 40}px`;
    }
  };

  const paint = (t: number) => {
    const el = panel.current;
    if (!el) return;
    const { height, anchorY } = geometry.current;
    const f = fluidFrame(t, height, width, anchorY);
    const settled = t > 0.995;
    el.style.transform = settled ? "" : `translateX(${f.shiftX.toFixed(2)}px)`;
    // At rest there is no clip, so the panel's shadow can be seen.
    el.style.clipPath = settled ? "" : `inset(${f.top.toFixed(1)}px ${f.right.toFixed(1)}px ${f.bottom.toFixed(1)}px 0 round ${f.radius.toFixed(1)}px)`;
    if (content.current) {
      content.current.style.opacity = f.content.toFixed(3);
      content.current.style.transform = settled ? "" : `translateY(${((1 - f.content) * 12).toFixed(1)}px)`;
      content.current.style.filter = f.content > 0.98 ? "" : `blur(${((1 - f.content) * 5).toFixed(1)}px)`;
    }
    if (neck.current) {
      if (f.neck <= 0.05 || t < 0.004) neck.current.setAttribute("d", "");
      else {
        const span = GAP + 6;
        const e = BEAD * 0.92;
        const m = f.neck;
        neck.current.setAttribute(
          "d",
          `M0 ${40 - e} C ${span * 0.42} ${40 - e} ${span * 0.42} ${40 - m} ${span / 2} ${40 - m} C ${span * 0.58} ${40 - m} ${span * 0.58} ${40 - e} ${span} ${40 - e} L ${span} ${40 + e} C ${span * 0.58} ${40 + e} ${span * 0.58} ${40 + m} ${span / 2} ${40 + m} C ${span * 0.42} ${40 + m} ${span * 0.42} ${40 + e} 0 ${40 + e} Z`,
        );
      }
    }
  };

  useLayoutEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    const dock = document.querySelector(".map-dock");
    const observer = typeof ResizeObserver === "undefined" || !dock ? null : new ResizeObserver(measure);
    if (dock) observer?.observe(dock);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, width]);

  useEffect(() => {
    measure();
    spring.current ??= new Spring(0, OPEN, (t) => {
      paint(t);
      if (!spring.current) return;
    }, 0.002);
    const s = spring.current;
    if (reduceMotion) {
      s.jump(open ? 1 : 0);
      setResting(open ? "open" : "closed");
      return;
    }
    setResting("moving");
    s.setPreset(open ? OPEN : CLOSE);
    s.set(open ? 1 : 0);
    // When the spring has rested, nothing here should cost anything.
    const timer = setTimeout(() => setResting(open ? "open" : "closed"), open ? 1500 : 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reduceMotion]);
  useEffect(() => () => spring.current?.stop(), []);

  return (
    <>
      <svg ref={svg} className="fluid-neck" width={GAP + 6} height={80} viewBox={`0 0 ${GAP + 6} 80`} aria-hidden="true">
        <path ref={neck} d="" />
      </svg>
      <aside
        ref={panel}
        className={`fluid-panel ${className}${open ? " open" : ""}${resting === "closed" ? " fluid-closed" : ""}`}
        aria-label={label}
        aria-hidden={!open}
        inert={!open || undefined}
        role="dialog"
      >
        <div ref={content} className="fluid-content">
          {resting === "closed" && !open ? null : children}
        </div>
      </aside>
    </>
  );
});
