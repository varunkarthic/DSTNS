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

/** How hard a pull it took to get to a displacement: the opposite of `resist`. */
function unresist(shown: number, bound: number, constant = 0.55): number {
  const part = Math.min(0.98, Math.abs(shown) / bound);
  return Math.sign(shown) * (1 / (1 - part) - 1) * (bound / constant);
}

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
// The bounce: a critically damped spring on the position shown, so it leaves at the speed it
// arrived, slows, and comes back as one curve. Apple does not publish its figures; this
// peaks about 90 ms after arriving and is home about 0.6 s later.
const BOUNCE = { k: 121, c: 22 };
const OMEGA = Math.sqrt(BOUNCE.k);
// While a finger is pulling, the content stays with it, a frame or two behind at most.
const HOLD = { k: 900, c: 60 };
// A region gives up to this share of its own size, within a limit.
const EDGE_SHARE = 0.3;
const EDGE_LIMIT = 120;
// A wheel has no release: this long without being pushed is letting go.
const LET_GO_MS = 120;
// Momentum only ever fades, and smoothly. A finger is noisy, so it takes this many shrinking
// events in a row to call it momentum, and this many holding up to call it a finger again.
const FADING_EVENTS = 5;
const PULLING_EVENTS = 3;
const PULLING_DELTA = 6;
// And no lift either: this long with no wheel events at all is a new gesture. Momentum
// arrives far more often than this, so it is always part of the gesture that began it.
const GESTURE_GAP_MS = 180;
// Between the page asking for a bounce and the compositor showing it, the content keeps
// travelling. Starting this long before the limit means the two meet there, rather than
// the content stopping dead and waiting. Measured in Chrome; see the design decisions.
const LEAD_S = 0.034;

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

type Axis = "x" | "y";

/** How the spring moves from (x, v), `t` seconds later. */
function spring(x: number, v: number, t: number): [number, number] {
  const fall = Math.exp(-OMEGA * t);
  const lift = v + OMEGA * x;
  return [(x + lift * t) * fall, (v - OMEGA * lift * t) * fall];
}

/** Past the end the content moves up, and the clip holds its top edge where the frame is. */
function shownAt(axis: Axis, x: number): { transform: string; clipPath: string } {
  const px = (-x).toFixed(2);
  const gap = Math.abs(x).toFixed(2);
  return axis === "y"
    ? { transform: `translate3d(0, ${px}px, 0)`, clipPath: x > 0 ? `inset(${gap}px 0 0 0)` : `inset(0 0 ${gap}px 0)` }
    : { transform: `translate3d(${px}px, 0, 0)`, clipPath: x > 0 ? `inset(0 0 0 ${gap}px)` : `inset(0 ${gap}px 0 0)` };
}

interface Stretch {
  axis: Axis;
  /** Which way this gesture went past the limit. */
  direction: number;
  /** Where a push is holding the content, and how fast it is moving there. */
  x: number;
  v: number;
  /** A continuing push, before the rubber-band curve. Zero once let go. */
  pull: number;
  pushedAt: number;
  lastDelta: number;
  fading: number;
  pulling: number;
  /** This gesture has had its one motion, so the rest of its events do nothing. */
  spent: boolean;
  gesture: number;
  /** A push, followed on the main thread because that is where wheel events arrive. */
  holding: (() => void) | null;
  /** Everything else, which runs on the compositor and so never waits for the page. */
  bounce: Animation | null;
  bounceFrom: [number, number];
}

/**
 * Installs itself once, for every scrolling region now and later.
 *
 * Scrolling itself belongs to the browser and runs on the compositor, whatever the page
 * is doing. This only listens, and takes over at the moment the browser reaches a limit,
 * as a scroll view does: the content carries on at the speed it arrived and a critically
 * damped spring turns it round and brings it home. A slow scroll barely shows at the edge
 * and a fast one travels further, because it is one motion, not a stop followed by a
 * separate effect, and one gesture only ever gets one. The curve is worked out once and
 * handed to the compositor, so it stays smooth while the page is busy. The region's frame
 * stays where it is and only what is inside it moves.
 */
export function installEdgeResistance(root: Document = document): () => void {
  const stretches = new WeakMap<HTMLElement, Stretch>();
  const positions = new WeakMap<Element, { at: number; top: number; speed: number }>();
  const reduced = () => root.documentElement.classList.contains("reduce-motion");
  let wheelAt = -Infinity;
  let gestureAt = -Infinity;
  let gesture = 0;

  const stretchFor = (el: HTMLElement, axis: Axis) => {
    let s = stretches.get(el);
    if (!s) {
      s = { axis, direction: 0, x: 0, v: 0, pull: 0, pushedAt: -Infinity, lastDelta: 0, fading: 0, pulling: 0, spent: false, gesture, holding: null, bounce: null, bounceFrom: [0, 0] };
      stretches.set(el, s);
    }
    if (s.gesture !== gesture) {
      s.gesture = gesture;
      s.spent = false;
      s.fading = 0;
      s.pulling = 0;
      s.lastDelta = 0;
    }
    s.axis = axis;
    return s;
  };

  const boundOf = (el: HTMLElement, axis: Axis) => Math.min(EDGE_LIMIT, (axis === "y" ? el.clientHeight : el.clientWidth) * EDGE_SHARE);

  /** Where the content is shown now, whichever of the two is moving it. */
  const where = (s: Stretch): [number, number] => {
    if (s.holding) return [s.x, s.v];
    if (!s.bounce) return [0, 0];
    return spring(s.bounceFrom[0], s.bounceFrom[1], Number(s.bounce.currentTime ?? 0) / 1000);
  };

  /** From here, home: the whole curve at once, for the compositor to play. */
  const bounce = (el: HTMLElement, s: Stretch, x: number, v: number) => {
    s.bounce?.cancel();
    s.bounce = null;
    if (typeof el.animate !== "function") return;
    const frames = [shownAt(s.axis, x)];
    let t = 0;
    for (;;) {
      t += 1 / 60;
      const [nextX, nextV] = spring(x, v, t);
      if (t > 2 || (Math.abs(nextX) < 0.25 && Math.abs(nextV) < 6)) break;
      frames.push(shownAt(s.axis, nextX));
    }
    frames.push(shownAt(s.axis, 0));
    const played = el.animate(frames, { duration: t * 1000, easing: "linear" });
    s.bounce = played;
    s.bounceFrom = [x, v];
    played.onfinish = () => {
      if (s.bounce === played) s.bounce = null;
    };
  };

  const stopHolding = (el: HTMLElement, s: Stretch) => {
    s.holding?.();
    s.holding = null;
    el.style.removeProperty("transform");
    el.style.removeProperty("clip-path");
  };

  /** The content is reaching a limit at this speed: it keeps going, and the spring turns it round. */
  const arrive = (el: HTMLElement, axis: Axis, speed: number) => {
    const s = stretchFor(el, axis);
    if (s.spent) return;
    s.spent = true;
    s.direction = Math.sign(speed);
    s.pull = 0;
    const [x] = where(s);
    stopHolding(el, s);
    // A critically damped spring leaving its rest position peaks at v / (omega * e). The curve
    // is applied to that peak, so a harder fling still travels further, by less and less.
    const peak = resist(Math.abs(speed) / (OMEGA * Math.E), boundOf(el, axis), 1);
    bounce(el, s, x, s.direction * peak * OMEGA * Math.E);
  };

  /**
   * Pulling against a limit: the content comes with the pull, ever less the further it goes,
   * and goes back when it is let go. Momentum arriving here is not a pull, however long it lasts.
   */
  const press = (el: HTMLElement, axis: Axis, delta: number) => {
    const s = stretchFor(el, axis);
    const size = Math.abs(delta);
    const holdingUp = size >= s.lastDelta * 0.97;
    s.fading = holdingUp ? 0 : s.fading + 1;
    s.pulling = holdingUp ? s.pulling + 1 : 0;
    s.lastDelta = size;
    const bound = boundOf(el, axis);
    if (s.spent) {
      if (s.pulling < PULLING_EVENTS || size < PULLING_DELTA) return;
      // It kept going after all: someone is pulling, so pick it up from wherever it is now.
      s.spent = false;
      s.pull = unresist(where(s)[0], bound);
    }
    if (s.fading >= FADING_EVENTS) {
      s.spent = true;
      s.pull = 0;
      return;
    }
    s.direction = Math.sign(delta);
    s.pushedAt = performance.now();
    s.pull = s.pull && Math.sign(s.pull) !== Math.sign(delta) ? 0 : s.pull + delta;
    if (s.holding) return;
    [s.x, s.v] = where(s);
    s.bounce?.cancel();
    s.bounce = null;
    s.holding = animate((dt) => {
      if (performance.now() - s.pushedAt > LET_GO_MS) s.pull = 0;
      if (!s.pull) {
        s.holding = null;
        el.style.removeProperty("transform");
        el.style.removeProperty("clip-path");
        bounce(el, s, s.x, s.v);
        return false;
      }
      [s.x, s.v] = stepSpring(s.x, s.v, resist(s.pull, bound), HOLD, dt);
      const shown = shownAt(s.axis, s.x);
      el.style.transform = shown.transform;
      el.style.clipPath = shown.clipPath;
      return true;
    });
  };

  // Wheel events are gathered and looked at once a frame. A gesture stays with the region
  // it began in, as the browser's own scrolling does, so that is only worked out once.
  let waiting: { target: Element | null; axis: Axis; delta: number } | null = null;
  let scheduled = false;
  let latched: { gesture: number; axis: Axis; el: HTMLElement | null } | null = null;
  const settle = () => {
    scheduled = false;
    const now = waiting;
    waiting = null;
    if (!now || reduced()) return;
    if (latched?.gesture !== gesture || latched.axis !== now.axis) latched = { gesture, axis: now.axis, el: regionFor(now.target, now.axis) };
    const el = latched.el;
    if (!el) return;
    const position = now.axis === "y" ? el.scrollTop : el.scrollLeft;
    const size = now.axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    if (now.delta < 0 ? position <= 0 : position >= size - 1) press(el, now.axis, now.delta);
    else {
      // Scrolling back from the limit: whatever comes next is new. Still heading for it is not.
      const s = stretches.get(el);
      if (s && s.direction !== Math.sign(now.delta)) {
        s.pull = 0;
        s.spent = false;
        s.lastDelta = 0;
        s.fading = 0;
        s.pulling = 0;
      }
    }
  };
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    // When the input happened, not when the page got to it: events held up behind a busy
    // page arrive together, and the wait must not read as a new gesture.
    const at = event.timeStamp;
    if (at - wheelAt > GESTURE_GAP_MS) {
      gesture += 1;
      gestureAt = at;
    }
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

  /** How fast the content is heading for a limit is read from the scroll itself. */
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
    if (!last || now - wheelAt > 150 || Math.abs(speed) < 60 || reduced() || !(el instanceof HTMLElement)) return;
    const left = speed < 0 ? top : el.scrollHeight - el.clientHeight - top;
    if (left > Math.abs(speed) * LEAD_S) return;
    // The page was busy as the content arrived, and it has already stopped. A bounce now
    // would be a second movement, long after the first, so this gesture goes without.
    if (now - last.at > 100 && gestureAt < last.at && left <= 0) stretchFor(el, "y").spent = true;
    else arrive(el, "y", speed);
  };

  // Focus and scrollIntoView can move an overflow-hidden ancestor even with no
  // scrollbar, which is what shifted the interface under open panels. Those
  // ancestors are never meant to have moved, so they are put straight back.
  const onScroll = (event: Event) => {
    const el = event.target;
    if (el instanceof Element) watch(el);
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
