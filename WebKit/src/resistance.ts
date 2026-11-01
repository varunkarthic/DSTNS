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

let lastScroll = -Infinity;
/** Something is being scrolled. Whatever can wait until it stops, should. */
export function scrollingNow(): boolean {
  return performance.now() - lastScroll < 180;
}

const SCROLLING = /(auto|scroll)/;
// The bounce: a critically damped spring on the position seen, so it leaves at the speed it
// arrived, slows, and comes back as one curve. Apple does not publish its figures; this
// peaks about 90 ms after arriving and is home about 0.6 s later.
const BOUNCE = { k: 121, c: 22 };
const OMEGA = Math.sqrt(BOUNCE.k);
// A region gives up to this share of its own size, within a limit.
const EDGE_SHARE = 0.3;
const EDGE_LIMIT = 120;
// A wheel has no release: this long without being pushed is letting go.
const LET_GO_MS = 90;
// And no lift either: this long with no wheel events at all is a new gesture. Momentum
// arrives far more often than this, so it is always part of the gesture that began it.
const GESTURE_GAP_MS = 180;

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

interface Stretch {
  axis: "x" | "y";
  /** How far past the limit the content is shown, and how fast it is moving. */
  x: number;
  v: number;
  /** A continuing push, before the rubber-band curve. Zero once let go. */
  pull: number;
  pushedAt: number;
  lastDelta: number;
  fading: number;
  /** This gesture has had its one motion, so the rest of its events do nothing. */
  spent: boolean;
  gesture: number;
  cancel: (() => void) | null;
}

/**
 * Installs itself once, for every scrolling region now and later.
 *
 * Scrolling itself belongs to the browser and runs on the compositor, whatever the page
 * is doing. This only listens, and takes over at the moment the browser stops at a limit,
 * as a scroll view does: the content carries on at the speed it arrived and a critically
 * damped spring turns it round and brings it home. A slow scroll barely shows at the edge
 * and a fast one travels further, because it is one motion, not a stop followed by a
 * separate effect, and one gesture only ever gets one. The region's frame stays where it
 * is and only what is inside it moves, using one transform and one clip, touched only
 * while it is moving.
 */
export function installEdgeResistance(root: Document = document): () => void {
  const stretches = new WeakMap<HTMLElement, Stretch>();
  const positions = new WeakMap<Element, { at: number; top: number; speed: number }>();
  const reduced = () => root.documentElement.classList.contains("reduce-motion");
  let wheelAt = -Infinity;
  let gesture = 0;

  const stretchFor = (el: HTMLElement, axis: "x" | "y") => {
    let s = stretches.get(el);
    if (!s) {
      s = { axis, x: 0, v: 0, pull: 0, pushedAt: -Infinity, lastDelta: 0, fading: 0, spent: false, gesture, cancel: null };
      stretches.set(el, s);
    }
    if (s.gesture !== gesture) {
      s.gesture = gesture;
      s.spent = false;
      s.fading = 0;
      s.lastDelta = 0;
    }
    s.axis = axis;
    return s;
  };

  const boundOf = (el: HTMLElement, axis: "x" | "y") => Math.min(EDGE_LIMIT, (axis === "y" ? el.clientHeight : el.clientWidth) * EDGE_SHARE);

  const run = (el: HTMLElement, s: Stretch) => {
    if (s.cancel) return;
    s.cancel = animate((dt) => {
      if (performance.now() - s.pushedAt > LET_GO_MS) s.pull = 0;
      [s.x, s.v] = stepSpring(s.x, s.v, resist(s.pull, boundOf(el, s.axis)), BOUNCE, dt);
      if (!s.pull && Math.abs(s.x) < 0.3 && Math.abs(s.v) < 6) {
        s.x = s.v = 0;
        s.cancel = null;
        el.style.removeProperty("transform");
        el.style.removeProperty("clip-path");
        return false;
      }
      // Past the bottom the content moves up: its top edge is held in place by the clip.
      const shown = -s.x;
      const px = shown.toFixed(2);
      const clipped = Math.abs(shown).toFixed(2);
      if (s.axis === "y") {
        el.style.transform = `translate3d(0, ${px}px, 0)`;
        el.style.clipPath = shown < 0 ? `inset(${clipped}px 0 0 0)` : `inset(0 0 ${clipped}px 0)`;
      } else {
        el.style.transform = `translate3d(${px}px, 0, 0)`;
        el.style.clipPath = shown < 0 ? `inset(0 0 0 ${clipped}px)` : `inset(0 ${clipped}px 0 0)`;
      }
      return true;
    });
  };

  /** The content reached a limit at this speed: it keeps going, and the spring turns it round. */
  const arrive = (el: HTMLElement, axis: "x" | "y", speed: number) => {
    const s = stretchFor(el, axis);
    if (s.spent) return;
    s.spent = true;
    s.pull = 0;
    // A critically damped spring leaving its rest position peaks at v / (omega * e). The curve is applied to
    // that peak, so a harder fling still travels further, by less and less.
    const peak = resist(Math.abs(speed) / (OMEGA * Math.E), boundOf(el, axis), 1);
    s.v = Math.sign(speed) * peak * OMEGA * Math.E;
    run(el, s);
  };

  /** Pushing against a limit already reached. Once a push starts to fade, it is over. */
  const press = (el: HTMLElement, axis: "x" | "y", delta: number) => {
    const s = stretchFor(el, axis);
    if (s.spent) return;
    const size = Math.abs(delta);
    s.fading = size < s.lastDelta * 0.97 ? s.fading + 1 : 0;
    s.lastDelta = size;
    if (s.fading >= 2) {
      s.spent = true;
      s.pull = 0;
      return;
    }
    s.pushedAt = performance.now();
    s.pull = s.pull && Math.sign(s.pull) !== Math.sign(delta) ? 0 : s.pull + delta;
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
    if (now.delta < 0 ? position <= 0 : position >= size - 1) press(el, now.axis, now.delta);
    else {
      // Scrolling away from the limit: whatever comes next is new.
      const s = stretches.get(el);
      if (s) {
        s.pull = 0;
        s.spent = false;
        s.lastDelta = 0;
        s.fading = 0;
      }
    }
  };
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    const at = performance.now();
    if (at - wheelAt > GESTURE_GAP_MS) gesture += 1;
    wheelAt = at;
    const [dx, dy] = normalised(event, root.documentElement.clientHeight);
    const axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
    const delta = axis === "y" ? dy : dx;
    waiting = { target: event.target as Element | null, axis, delta: (waiting?.axis === axis ? waiting.delta : 0) + delta };
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(settle);
    }
  };

  /** Scrolling reached a limit: how fast it was going is read from the scroll itself. */
  const watch = (el: Element) => {
    const now = performance.now();
    const top = el.scrollTop;
    const last = positions.get(el);
    // The step that reaches the limit is cut short by it, so the step before says more.
    // After a pause the gap says nothing about speed: the first step took one frame.
    const elapsed = last ? (now - last.at > 60 ? 16 : Math.max(4, now - last.at)) : 16;
    const measured = last ? ((top - last.top) / elapsed) * 1000 : 0;
    const recent = last && now - last.at < 60 && Math.sign(last.speed) === Math.sign(measured) ? last.speed : 0;
    const speed = Math.abs(recent) > Math.abs(measured) ? recent : measured;
    positions.set(el, { at: now, top, speed: measured });
    // Only a person's scrolling: a list being reset by code has no speed to carry.
    if (!last || now - wheelAt > 150 || reduced() || !(el instanceof HTMLElement)) return;
    const atLimit = (speed < 0 && top <= 0) || (speed > 0 && top >= el.scrollHeight - el.clientHeight - 1);
    if (atLimit && Math.abs(speed) > 60) arrive(el, "y", speed);
  };

  let scrolling: HTMLElement | null = null;
  let scrollEnd: ReturnType<typeof setTimeout> | undefined;

  // Focus and scrollIntoView can move an overflow-hidden ancestor even with no
  // scrollbar, which is what shifted the interface under open panels. Those
  // ancestors are never meant to have moved, so they are put straight back.
  const onScroll = (event: Event) => {
    const el = event.target;
    lastScroll = performance.now();
    if (el instanceof Element) watch(el);
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
