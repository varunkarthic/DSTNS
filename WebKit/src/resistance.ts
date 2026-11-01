// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { animate } from "./motion";

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

let lastScroll = -Infinity;
/** Something is being scrolled. Whatever can wait until it stops, should. */
export function scrollingNow(): boolean {
  return performance.now() - lastScroll < 180;
}

const SCROLLING = /(auto|scroll)/;
// How far a region gives: subtle, and in proportion to it.
const EDGE_LIMIT = 12;
// How fast it lets go, per second, and how closely it follows the push.
const RELEASE = 26;
const FOLLOW = 42;

function normalised(event: WheelEvent, page: number): [number, number] {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page : 1;
  return [event.deltaX * unit, event.deltaY * unit];
}

// A region's overflow does not change, so it is read once. Reading styles on every wheel
// event would make scrolling wait for the page to finish whatever it is doing.
const scrolls = new WeakMap<Element, { x: boolean; y: boolean }>();
function overflowOf(el: Element) {
  let known = scrolls.get(el);
  if (!known) {
    const style = getComputedStyle(el);
    known = { x: SCROLLING.test(style.overflowX), y: SCROLLING.test(style.overflowY) };
    scrolls.set(el, known);
  }
  return known;
}

/** The region this wheel event acts on: the nearest one that scrolls that way. */
function regionFor(start: Element | null, axis: "x" | "y"): HTMLElement | null {
  for (let el = start; el && el !== document.documentElement; el = el.parentElement) {
    if (el.tagName === "IFRAME" || el.tagName === "TEXTAREA" || el.tagName === "CANVAS") return null;
    if (!overflowOf(el)[axis]) continue;
    const html = el as HTMLElement;
    const room = axis === "y" ? html.scrollHeight - html.clientHeight : html.scrollWidth - html.clientWidth;
    if (room > 1) return html;
  }
  return null;
}

interface Stretch { axis: "x" | "y"; pull: number; x: number; cancel: (() => void) | null }

/**
 * Installs itself once, for every scrolling region now and later.
 *
 * It only ever listens. Scrolling itself belongs to the browser and runs on the
 * compositor, whatever the page is doing, so a busy map cannot make a list lag. All this
 * adds, at a limit, is a small movement of the region as a whole: one compositor transform,
 * touched only while it is moving.
 */
export function installEdgeResistance(root: Document = document): () => void {
  const stretches = new WeakMap<HTMLElement, Stretch>();
  const reduced = () => root.documentElement.classList.contains("reduce-motion");

  const run = (el: HTMLElement, s: Stretch) => {
    if (s.cancel) return;
    s.cancel = animate((dt) => {
      s.pull *= Math.exp(-RELEASE * dt);
      if (Math.abs(s.pull) < 0.5) s.pull = 0;
      const dimension = s.axis === "y" ? el.clientHeight : el.clientWidth;
      const target = -resist(s.pull, Math.min(EDGE_LIMIT, dimension * 0.05));
      s.x += (target - s.x) * Math.min(1, FOLLOW * dt);
      const done = !s.pull && Math.abs(s.x) < 0.05;
      if (done) {
        s.x = 0;
        s.cancel = null;
        el.style.removeProperty("transform");
        return false;
      }
      el.style.transform = s.axis === "y" ? `translate3d(0, ${s.x.toFixed(2)}px, 0)` : `translate3d(${s.x.toFixed(2)}px, 0, 0)`;
      return true;
    });
  };

  const push = (el: HTMLElement, axis: "x" | "y", delta: number) => {
    let s = stretches.get(el);
    if (!s) {
      s = { axis, pull: 0, x: 0, cancel: null };
      stretches.set(el, s);
    }
    s.axis = axis;
    const next = s.pull + delta;
    s.pull = s.pull && Math.sign(next) !== Math.sign(s.pull) ? 0 : next;
    run(el, s);
  };

  // Wheel events are gathered and looked at once a frame, once layout is settled.
  let waiting: { target: Element | null; axis: "x" | "y"; delta: number } | null = null;
  let scheduled = false;
  const settle = () => {
    scheduled = false;
    const now = waiting;
    waiting = null;
    if (!now || reduced()) return;
    const el = regionFor(now.target, now.axis);
    if (!el) return;
    const position = now.axis === "y" ? el.scrollTop : el.scrollLeft;
    const size = now.axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    if (now.delta < 0 ? position <= 0 : position >= size - 1) push(el, now.axis, now.delta);
  };
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    const [dx, dy] = normalised(event, root.documentElement.clientHeight);
    const axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
    const delta = axis === "y" ? dy : dx;
    waiting = { target: event.target as Element | null, axis, delta: (waiting?.axis === axis ? waiting.delta : 0) + delta };
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(settle);
    }
  };

  let scrolling: HTMLElement | null = null;
  let scrollEnd: ReturnType<typeof setTimeout> | undefined;

  // Focus and scrollIntoView can move an overflow-hidden ancestor even with no
  // scrollbar, which is what shifted the interface under open panels. Those
  // ancestors are never meant to have moved, so they are put straight back.
  const onScroll = (event: Event) => {
    const el = event.target;
    lastScroll = performance.now();
    // Rows passing under the pointer would each restyle on hover, on the main thread.
    if (el instanceof HTMLElement && el !== scrolling) {
      scrolling?.classList.remove("is-scrolling");
      scrolling = el;
      el.classList.add("is-scrolling");
    }
    clearTimeout(scrollEnd);
    scrollEnd = setTimeout(() => {
      scrolling?.classList.remove("is-scrolling");
      scrolling = null;
    }, 120);
    if (el === root || (el instanceof Element && el.matches("html, body, #root, .app-shell, .workspace, .bottom-stack, .lower-hud, .hud-zone"))) {
      if (el === root) root.documentElement.scrollTop = root.documentElement.scrollLeft = 0;
      else {
        (el as Element).scrollTop = 0;
        (el as Element).scrollLeft = 0;
      }
    }
  };

  root.addEventListener("wheel", onWheel, { passive: true });
  root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    root.removeEventListener("wheel", onWheel);
    root.removeEventListener("scroll", onScroll, { capture: true });
  };
}
