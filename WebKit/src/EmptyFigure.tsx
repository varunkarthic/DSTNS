// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef } from "react";
import { cones, drawer, hub, loupe, plug, setReducedMotion } from "./vendor/hairline";

const FIGURES = { cones, drawer, hub, loupe, plug } as const;
export type EmptyFigureName = keyof typeof FIGURES;

/**
 * A small line drawing above an empty state's words: the thing that would hold what is missing, holding none of it.
 * It answers the pointer a little, and at rest it is a picture. With reduced motion it still answers, without moving
 * on the way. Hidden from assistive technology: the words beside it say the same.
 */
export function EmptyFigure({ figure, className = "" }: { figure: EmptyFigureName; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || typeof SVGElement === "undefined") return;
    let drawn: ReturnType<typeof loupe> | null = null;
    try {
      drawn = FIGURES[figure](el, { intensity: 0.4 });
    } catch {
      return; // A browser that cannot draw it shows the words alone.
    }
    el.setAttribute("aria-hidden", "true");
    el.removeAttribute("role");
    el.removeAttribute("aria-label");
    return () => drawn?.destroy();
  }, [figure]);
  // The interface's own Reduce motion counts as much as the system's.
  useEffect(() => {
    const quiet = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    setReducedMotion(quiet || document.documentElement.classList.contains("reduce-motion"));
  });
  return <div ref={host} className={`empty-figure ${className}`} />;
}
