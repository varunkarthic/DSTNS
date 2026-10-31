// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { animate, stepSpring } from "./motion";

/**
 * Dynamic Edge Resistance.
 *
 * Whatever has a limit (a list's end, the map's widest zoom, a slider) answers
 * being pushed past it the same way: it follows at first, then gives ever less, up
 * to a bound, and returns the moment the push stops growing. That says "this is the end" without a
 * hard stop.
 *
 * The curve is the one Apple's scroll views use. Dynamic, because its bound follows
 * the size of what is being stretched, so a small menu gives less than a long panel
 * and the same gesture feels the same on both.
 */

/** Visible displacement for a pull past a limit. Never reaches `bound`. */
export function resist(pull: number, bound = 64, constant = 0.55): number {
  if (pull === 0 || bound <= 0) return 0;
  const magnitude = Math.abs(pull);
  return Math.sign(pull) * (1 - 1 / ((magnitude * constant) / bound + 1)) * bound;
}

/** The bound for something this many pixels long. */
export function resistBound(dimension: number): number {
  return Math.min(120, Math.max(28, dimension * 0.28));
}

/** Clamp to [min, max], with resistance past either end rather than a wall. */
export function resistClamp(value: number, min: number, max: number, bound = resistBound(max - min)): number {
  if (value < min) return min + resist(value - min, bound);
  if (value > max) return max + resist(value - max, bound);
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
  return rest * Math.exp(resist(Math.log(scale / rest), room, 1.8));
}

const SCROLLING = /(auto|scroll)/;
// Follows the pull closely, but smooths the steps a mouse wheel arrives in.
const FOLLOW = { k: 1500, c: 78 };
// How fast a stretch lets go, per second. A wheel has no release, and a trackpad goes
// on sending events long after the fingers lift, so nothing waits for the input to
// stop: the pull drains all the time, and the input only has to outrun it.
const RELEASE = 15;

function normalised(event: WheelEvent, page: number): [number, number] {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page : 1;
  return [event.deltaX * unit, event.deltaY * unit];
}

/** The region this wheel event should act on: the nearest one that scrolls that way. */
function regionFor(start: Element | null, axis: "x" | "y"): HTMLElement | null {
  let fallback: HTMLElement | null = null;
  for (let el = start; el && el !== document.documentElement; el = el.parentElement) {
    if (el.tagName === "IFRAME" || el.tagName === "TEXTAREA") return null;
    const style = getComputedStyle(el);
    if (!SCROLLING.test(axis === "y" ? style.overflowY : style.overflowX)) continue;
    const html = el as HTMLElement;
    const room = axis === "y" ? html.scrollHeight - html.clientHeight : html.scrollWidth - html.clientWidth;
    if (room > 1) return html;
    fallback ??= html;
  }
  return fallback;
}

interface Stretch { axis: "x" | "y"; pull: number; x: number; v: number; cancel: (() => void) | null }

/**
 * Installs itself once, for every scrolling region now and later, so no menu has to
 * ask. It also holds the page itself still: nothing but a region under the pointer
 * ever scrolls.
 */
export function installEdgeResistance(root: Document = document): () => void {
  const stretches = new WeakMap<HTMLElement, Stretch>();
  const reduced = () => root.documentElement.classList.contains("reduce-motion");

  const paint = (el: HTMLElement, s: Stretch) => {
    if (Math.abs(s.x) < 0.05 && !s.pull) {
      el.removeAttribute("data-edge");
      el.style.removeProperty("--edge-x");
      el.style.removeProperty("--edge-y");
      return;
    }
    el.setAttribute("data-edge", "");
    el.style.setProperty(s.axis === "y" ? "--edge-y" : "--edge-x", `${s.x.toFixed(2)}px`);
  };

  const run = (el: HTMLElement, s: Stretch) => {
    s.cancel ??= animate((dt) => {
      s.pull *= Math.exp(-RELEASE * dt);
      if (Math.abs(s.pull) < 0.5) s.pull = 0;
      const target = -resist(s.pull, resistBound(s.axis === "y" ? el.clientHeight : el.clientWidth));
      [s.x, s.v] = stepSpring(s.x, s.v, target, FOLLOW, dt);
      const done = !s.pull && Math.abs(s.x) < 0.05 && Math.abs(s.v) < 1;
      if (done) s.x = 0;
      paint(el, s);
      if (done) s.cancel = null;
      return !done;
    });
  };

  const push = (el: HTMLElement, axis: "x" | "y", delta: number) => {
    let s = stretches.get(el);
    if (!s) {
      s = { axis, pull: 0, x: 0, v: 0, cancel: null };
      stretches.set(el, s);
    }
    s.axis = axis;
    // Turning back takes the stretch back first, and stops at the edge.
    const next = s.pull + delta;
    s.pull = s.pull && Math.sign(next) !== Math.sign(s.pull) ? 0 : next;
    run(el, s);
  };

  const onWheel = (event: WheelEvent) => {
    const target = event.target as Element | null;
    // Pinches and the map's own zoom must never zoom or scroll the page.
    if (event.ctrlKey || target?.tagName === "CANVAS") {
      event.preventDefault();
      return;
    }
    const [dx, dy] = normalised(event, root.documentElement.clientHeight);
    const axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
    const delta = axis === "y" ? dy : dx;
    const el = regionFor(target, axis);
    if (!el) {
      // Over something that does not scroll: nothing moves, and certainly not the page.
      if (target?.tagName !== "IFRAME") event.preventDefault();
      return;
    }
    const position = axis === "y" ? el.scrollTop : el.scrollLeft;
    const size = axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    const atEnd = delta < 0 ? position <= 0 : position >= size - 1;
    const active = stretches.get(el);
    // Reversing while stretched unwinds the stretch before the content scrolls.
    const unwinding = !!active?.pull && Math.sign(active.pull) !== Math.sign(delta);
    if ((atEnd || unwinding) && !reduced()) {
      event.preventDefault();
      push(el, axis, delta);
    } else if (atEnd) {
      event.preventDefault();
    }
  };

  let lastTouch: { x: number; y: number } | null = null;
  const onTouchStart = (event: TouchEvent) => {
    lastTouch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!lastTouch) return;
    const touch = event.touches[0];
    const delta = lastTouch.y - touch.clientY;
    lastTouch = { x: touch.clientX, y: touch.clientY };
    const el = regionFor(event.target as Element, "y");
    if (!el) return;
    const atEnd = delta < 0 ? el.scrollTop <= 0 : el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
    if (delta && atEnd && !reduced()) push(el, "y", delta);
  };

  // Focus and scrollIntoView can move an overflow-hidden ancestor even with no
  // scrollbar, which is what shifted the interface under open panels. Those
  // ancestors are never meant to have moved, so they are put straight back.
  const onScroll = (event: Event) => {
    const el = event.target;
    if (el === root || (el instanceof Element && el.matches("html, body, #root, .app-shell, .workspace, .bottom-stack, .lower-hud, .hud-zone, .map-layer"))) {
      if (el === root) root.documentElement.scrollTop = root.documentElement.scrollLeft = 0;
      else {
        (el as Element).scrollTop = 0;
        (el as Element).scrollLeft = 0;
      }
    }
  };

  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("touchstart", onTouchStart, { passive: true });
  root.addEventListener("touchmove", onTouchMove, { passive: true });
  root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    root.removeEventListener("wheel", onWheel);
    root.removeEventListener("touchstart", onTouchStart);
    root.removeEventListener("touchmove", onTouchMove);
    root.removeEventListener("scroll", onScroll, { capture: true });
  };
}
