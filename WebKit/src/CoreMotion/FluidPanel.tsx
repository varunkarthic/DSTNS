// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { Bud } from "./bud";

/** The moving outline a Bud draws: every shape stroked, then every shape filled over the strokes. */
export function BudMembrane({ ref }: { ref: Ref<SVGSVGElement> }) {
  return (
    <svg ref={ref} className="bud-membrane" aria-hidden="true" style={{ display: "none" }}>
      <path className="bud-line" />
      <path className="bud-fill" />
    </svg>
  );
}

const GAP = 12;

/**
 * A secondary panel that divides from the map's dock (see bud.ts), at the icon that asked for it, and rests beside
 * the dock at the dock's height.
 */
export const FluidPanel = forwardRef<HTMLElement, {
  open: boolean;
  /** The icon the panel grows from. */
  anchor: string;
  label: string;
  width?: number;
  /** A panel shorter than the dock, centred on its icon. By default it is the dock's height. */
  fitHeight?: number;
  className?: string;
  reduceMotion?: boolean;
  children: ReactNode;
}>(function FluidPanel({ open, anchor, label, width = 372, fitHeight, className = "", reduceMotion = false, children }, ref) {
  const panel = useRef<HTMLElement>(null);
  const membrane = useRef<SVGSVGElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const bud = useRef<Bud | null>(null);
  const [resting, setResting] = useState<"closed" | "moving" | "open">(open ? "open" : "closed");
  useImperativeHandle(ref, () => panel.current as HTMLElement, []);

  const measure = () => {
    const dock = document.querySelector(".map-dock")?.getBoundingClientRect();
    const icon = document.querySelector(anchor)?.getBoundingClientRect();
    const el = panel.current;
    if (!dock || !icon || !el) return;
    const iconY = icon.top + icon.height / 2;
    const height = fitHeight ?? dock.height;
    const top = fitHeight ? Math.max(dock.top, Math.min(iconY - fitHeight / 2, dock.bottom - fitHeight)) : dock.top;
    const left = dock.right + GAP;
    const shown = Math.min(width, window.innerWidth - left - 12);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.height = `${height}px`;
    el.style.width = `${shown}px`;
    bud.current?.place({ dir: "right", wall: dock.right, anchor: iconY, rect: { left, top, width: shown, height }, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 24 });
  };

  useLayoutEffect(() => {
    if (membrane.current && panel.current) bud.current = new Bud(membrane.current, panel.current, content.current, (at) => setResting(at ? "open" : "closed"), open ? 1 : 0);
    measure();
    window.addEventListener("resize", measure);
    const dock = document.querySelector(".map-dock");
    const observer = typeof ResizeObserver === "undefined" || !dock ? null : new ResizeObserver(measure);
    if (dock) observer?.observe(dock);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
      bud.current?.destroy();
      bud.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, width]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    measure();
    if (!reduceMotion) setResting("moving");
    bud.current?.set(open, reduceMotion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reduceMotion]);

  return (
    <>
      <BudMembrane ref={membrane} />
      <aside
        ref={panel}
        className={`fluid-panel ${className}${open ? " open" : ""}${resting === "closed" && !open ? " fluid-closed" : ""}`}
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
