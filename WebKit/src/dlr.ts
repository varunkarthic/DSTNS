// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { Spring, SPRINGS } from "./motion";

/**
 * Dynamic Logarithmic Resistance.
 *
 * Whatever has a limit (a list's end, the map's widest zoom, a drawer, a slider)
 * answers being pushed past it the same way: it gives, ever less the further it
 * goes, up to a bound, then springs home. That is how the interface says "this is
 * the end" without a hard stop.
 *
 * Logarithmic, because each further unit of pull moves it less. Dynamic, because the
 * bound follows the size of what is being stretched: a small menu gives less than a
 * long panel, so the same gesture feels the same on both.
 */

/** Visible displacement for a pull past a limit. Never reaches `bound`. */
export function dlr(pull: number, bound = 64, coefficient = 0.35): number {
  if (pull === 0 || bound <= 0) return 0;
  const magnitude = Math.abs(pull);
  const displaced = bound * (1 - 1 / (1 + Math.log1p((magnitude * coefficient) / bound)));
  return Math.sign(pull) * displaced;
}

/** The bound for something this many pixels long. */
export function dlrBound(dimension: number): number {
  return Math.min(72, Math.max(20, dimension * 0.14));
}

/** Clamp to [min, max], with resistance past either end rather than a wall. */
export function dlrClamp(value: number, min: number, max: number, bound = dlrBound(max - min)): number {
  if (value < min) return min + dlr(value - min, bound);
  if (value > max) return max + dlr(value - max, bound);
  return value;
}

/**
 * The map's zoom-out limit. Fit is 1: zooming out to 5% past fit is free, then
 * resistance sets in, approaching but never passing 10%. Released, it settles back
 * to the 5% rest point. Works on log scale, as the camera does.
 */
export const ZOOM_REST = 0.95;
export const ZOOM_FLOOR = 0.9;
export function resistZoomOut(scale: number, fitScale: number): number {
  const rest = fitScale * ZOOM_REST;
  if (scale >= rest) return scale;
  const room = Math.log(ZOOM_REST / ZOOM_FLOOR);
  return rest * Math.exp(dlr(Math.log(scale / rest), room, 1.4));
}

/** Where a scrolling thing is, against the direction it is being pushed. */
function atLimit(position: number, size: number, viewport: number, delta: number): boolean {
  return delta < 0 ? position <= 0 : position + viewport >= size - 1;
}

const SCROLLING = /(auto|scroll)/;

function scrollerFor(start: Element | null, axis: "x" | "y"): HTMLElement | null {
  for (let el = start; el && el !== document.documentElement; el = el.parentElement) {
    if (el.tagName === "CANVAS" || el.tagName === "IFRAME" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return null;
    const style = getComputedStyle(el);
    if (SCROLLING.test(axis === "y" ? style.overflowY : style.overflowX)) return el as HTMLElement;
  }
  return null;
}

interface Stretch {
  pull: number;
  spring: Spring;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Applies resistance to every scrolling region in the interface, present or
 * future, so no menu has to ask for it. Content moves through a custom property;
 * the rule in motion.css applies it to the region's children, so the region's own
 * frame and scrollbar stay still.
 */
export function installDLR(root: Document = document): () => void {
  const stretches = new WeakMap<HTMLElement, Stretch>();
  const reduced = () => !!root.querySelector(".reduce-motion");

  const push = (el: HTMLElement, axis: "x" | "y", delta: number) => {
    let stretch = stretches.get(el);
    if (!stretch) {
      stretch = {
        pull: 0,
        timer: undefined,
        spring: new Spring(0, SPRINGS.spatialDefault, (value) => {
          if (Math.abs(value) < 0.05) {
            el.removeAttribute("data-dlr");
            el.style.removeProperty("--dlr-x");
            el.style.removeProperty("--dlr-y");
          } else {
            el.setAttribute("data-dlr", "");
            el.style.setProperty(axis === "y" ? "--dlr-y" : "--dlr-x", `${value.toFixed(2)}px`);
          }
        }, 0.05),
      };
      stretches.set(el, stretch);
    }
    const s = stretch;
    s.pull += delta;
    s.spring.jump(-dlr(s.pull, dlrBound(axis === "y" ? el.clientHeight : el.clientWidth)));
    clearTimeout(s.timer);
    // Letting go is when the wheel stops: it springs home from wherever it got to.
    s.timer = setTimeout(() => {
      s.pull = 0;
      s.spring.set(0);
    }, 90);
  };

  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || reduced()) return;
    const axis = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? "y" : "x";
    const delta = axis === "y" ? event.deltaY : event.deltaX;
    if (!delta) return;
    const el = scrollerFor(event.target as Element, axis);
    if (!el) return;
    const limit = axis === "y" ? atLimit(el.scrollTop, el.scrollHeight, el.clientHeight, delta) : atLimit(el.scrollLeft, el.scrollWidth, el.clientWidth, delta);
    if (limit) push(el, axis, delta);
  };

  let lastTouch: { x: number; y: number } | null = null;
  const onTouchStart = (event: TouchEvent) => {
    lastTouch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!lastTouch || reduced()) return;
    const touch = event.touches[0];
    const delta = lastTouch.y - touch.clientY;
    lastTouch = { x: touch.clientX, y: touch.clientY };
    const el = scrollerFor(event.target as Element, "y");
    if (el && delta && atLimit(el.scrollTop, el.scrollHeight, el.clientHeight, delta)) push(el, "y", delta);
  };

  root.addEventListener("wheel", onWheel, { passive: true });
  root.addEventListener("touchstart", onTouchStart, { passive: true });
  root.addEventListener("touchmove", onTouchMove, { passive: true });
  return () => {
    root.removeEventListener("wheel", onWheel);
    root.removeEventListener("touchstart", onTouchStart);
    root.removeEventListener("touchmove", onTouchMove);
  };
}
