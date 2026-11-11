// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { Spring, type SpringPreset } from "./motion";

/**
 * A panel that divides from the surface that asked for it, the way a cell does.
 *
 * The parent's edge swells into a bud at the control that was pressed. The bud is drawn out on a neck of the same
 * material, the neck thins at its waist and parts, what is left of it on each side is drawn back in, and the freed
 * drop grows into the panel. Closing is the same path backward: the panel gathers into a drop, touches the parent and
 * is taken up. It is all one spring value, so opening and closing can interrupt each other at any point.
 *
 * The moving outline is an SVG drawn under the parent and the panel: every shape is stroked, then every shape is filled
 * over the strokes, so the shapes read as one body with one edge, and the parent hides whatever has not left it yet.
 * The panel itself is only clipped to the drop.
 */

export type BudDirection = "right" | "left" | "up" | "down";

export interface BudGeometry {
  /** Which way the panel leaves its parent. */
  dir: BudDirection;
  /** The parent's edge, in viewport pixels along that direction. */
  wall: number;
  /** Where on the edge it buds from: a viewport y for right and left, an x for up and down. */
  anchor: number;
  /** Where the panel rests. */
  rect: { left: number; top: number; width: number; height: number };
  /** The panel's corner radius at rest. */
  radius: number;
}

// Opening carries through without a long creep at its end; closing is quicker, as a panel put away is done with.
export const BUD_OPEN: SpringPreset = { k: 70, c: 14.6 };
export const BUD_CLOSE: SpringPreset = { k: 150, c: 23.3 };
const BEAD = 22;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The shape at a point along the way, in the bud's own axes: `u` is the distance out from the parent's edge and `v`
 * runs along it. The panel rests at u in [gap, gap + U] and v in [0, V]; `a` is where along v it buds from.
 * Pure, so it can be checked.
 */
export function budFrame(t: number, U: number, V: number, a: number, gap: number, radius: number) {
  // A stadium's corner is half its height, however it was declared: a pill of 999px is a radius of 20 here.
  radius = Math.min(radius, U / 2, V / 2);
  const r = Math.min(BEAD, U / 2, V / 2);
  const at = Math.max(r, Math.min(V - r, a));
  // Drawn out, then swelling into the panel while still joined, and only then letting go: one body dividing, never a
  // drop that has already left before it has become anything.
  const out = smooth(t / 0.36);
  const grow = smooth((t - 0.32) / 0.6);
  const pinch = smooth((t - 0.5) / 0.22);
  const retract = smooth((t - 0.72) / 0.18);
  const centre = lerp(-r, gap + r, out);
  // Drawn out, the drop is longer than it is wide.
  const stretch = Math.sin(Math.PI * out) * r * 0.3;
  const body = {
    u0: centre - r,
    u1: lerp(centre + r + stretch, gap + U, grow),
    v0: lerp(at - r, 0, grow),
    v1: lerp(at + r, V, grow),
    r: lerp(r, radius, grow),
  };
  const half = Math.min(at - body.v0, body.v1 - at);
  /** Half-widths of the neck where it meets the parent and the drop, and at its waist. */
  const foot = r * 1.4 * smooth(t / 0.14) * (1 - retract);
  const root = 0.8 * Math.min(r, half) * (1 - retract);
  const waist = Math.min(foot, root) * (1 - pinch);
  const mid = Math.max(0, body.u0 * 0.5, Math.min(0.35 * r, 0.35 * (body.u0 + r)));
  const parted = pinch >= 1;
  return {
    at,
    body,
    // A foot keeps to the parent's straight edge, short of its rounded corners.
    neck: { foot0: Math.min(foot, Math.max(waist, at - radius * 0.6)), foot1: Math.min(foot, Math.max(waist, V - at - radius * 0.6)), root, waist, tipParent: parted ? mid * (1 - retract) : mid, tipDrop: parted ? lerp(mid, body.u0, retract) : mid, gone: retract >= 1 || t <= 0 },
    content: smooth((t - 0.62) / 0.34),
  };
}

/** The outline at `t` as SVG path data in viewport pixels, and the panel's clip. */
export function budShape(t: number, g: BudGeometry, gap: number) {
  const along = g.dir === "right" || g.dir === "left";
  const U = along ? g.rect.width : g.rect.height;
  const V = along ? g.rect.height : g.rect.width;
  const v0 = along ? g.rect.top : g.rect.left;
  const sign = g.dir === "right" || g.dir === "down" ? 1 : -1;
  const f = budFrame(t, U, V, g.anchor - v0, gap, g.radius);
  const P = (u: number, v: number) => (along ? `${(g.wall + sign * u).toFixed(2)} ${(v0 + v).toFixed(2)}` : `${(v0 + v).toFixed(2)} ${(g.wall + sign * u).toFixed(2)}`);
  const { body: b, neck: n, at } = f;

  // The drop: a rounded rectangle, its corners as cubic curves so a mirrored axis needs no arc flags.
  const k = b.r * 0.5523;
  let d =
    `M${P(b.u0 + b.r, b.v0)}L${P(b.u1 - b.r, b.v0)}C${P(b.u1 - b.r + k, b.v0)} ${P(b.u1, b.v0 + b.r - k)} ${P(b.u1, b.v0 + b.r)}` +
    `L${P(b.u1, b.v1 - b.r)}C${P(b.u1, b.v1 - b.r + k)} ${P(b.u1 - b.r + k, b.v1)} ${P(b.u1 - b.r, b.v1)}` +
    `L${P(b.u0 + b.r, b.v1)}C${P(b.u0 + b.r - k, b.v1)} ${P(b.u0, b.v1 - b.r + k)} ${P(b.u0, b.v1 - b.r)}` +
    `L${P(b.u0, b.v0 + b.r)}C${P(b.u0, b.v0 + b.r - k)} ${P(b.u0 + b.r - k, b.v0)} ${P(b.u0 + b.r, b.v0)}Z`;

  if (!n.gone) {
    // The parent's half: out of the edge on a fillet, to the waist or to a tip.
    const tp = n.tipParent + 0.4;
    d +=
      `M${P(-BEAD, at - n.foot0)}L${P(0, at - n.foot0)}C${P(0, at - n.foot0 + (n.foot0 - n.waist) * 0.6)} ${P(tp * 0.4, at - n.waist)} ${P(tp, at - n.waist)}` +
      `L${P(tp, at + n.waist)}C${P(tp * 0.4, at + n.waist)} ${P(0, at + n.foot1 - (n.foot1 - n.waist) * 0.6)} ${P(0, at + n.foot1)}L${P(-BEAD, at + n.foot1)}Z`;
    // The drop's half: from the waist or its tip, round onto the drop's own outline.
    const half = Math.min(at - b.v0, b.v1 - at);
    const excess = Math.max(0, n.root - (half - b.r));
    const inset = b.r - Math.sqrt(Math.max(0, b.r * b.r - excess * excess));
    const pu = b.u0 + inset;
    const length = Math.hypot(excess, b.r - inset) || 1;
    const reach = (n.root - n.waist) * 0.6;
    const tu = (excess / length) * reach;
    const tv = ((b.r - inset) / length) * reach;
    const td = n.tipDrop - 0.4;
    const pull = td + (pu - td) * 0.55;
    d +=
      `M${P(td, at - n.waist)}C${P(pull, at - n.waist)} ${P(pu - tu, at - n.root + tv)} ${P(pu, at - n.root)}` +
      `L${P(pu + b.r, at)}L${P(pu, at + n.root)}C${P(pu - tu, at + n.root - tv)} ${P(pull, at + n.waist)} ${P(td, at + n.waist)}Z`;
  }

  // The panel shows only where the drop is.
  const lo = Math.max(0, b.u0 - gap);
  const hi = Math.max(0, gap + U - b.u1);
  const near = Math.max(0, b.v0);
  const far = Math.max(0, V - b.v1);
  const inset = along
    ? `${near.toFixed(1)}px ${(sign > 0 ? hi : lo).toFixed(1)}px ${far.toFixed(1)}px ${(sign > 0 ? lo : hi).toFixed(1)}px`
    : `${(sign > 0 ? lo : hi).toFixed(1)}px ${far.toFixed(1)}px ${(sign > 0 ? hi : lo).toFixed(1)}px ${near.toFixed(1)}px`;
  return { d, clip: `inset(${inset} round ${b.r.toFixed(1)}px)`, content: f.content };
}

/**
 * Drives one panel. `membrane` is the SVG from BudMembrane; `content` is what fades in once the drop is a panel
 * (without one, the panel is given `--bud-content` to fade its children by).
 * `rested` is told when it comes to rest open or closed.
 */
export class Bud {
  private spring: Spring;
  private geometry: BudGeometry | null = null;
  private target = 0;
  gap = 12;
  /** Cut the membrane off at the parent's edge, for a parent it cannot be drawn beneath. */
  cut = false;

  constructor(
    private membrane: SVGSVGElement,
    private panel: HTMLElement,
    private content: HTMLElement | null,
    private rested: (open: boolean) => void,
    initial = 0,
  ) {
    this.target = initial;
    this.spring = new Spring(initial, BUD_OPEN, (t) => this.paint(t), 0.002);
    this.spring.bounds = [0, 1];
  }

  /** Where the parent and the panel are now. Safe to call while moving. */
  place(geometry: BudGeometry): void {
    this.geometry = geometry;
    if (this.cut) {
      const { dir, wall } = geometry;
      const far = (dir === "right" || dir === "left" ? window.innerWidth : window.innerHeight) - wall;
      const edge = { right: `0 0 0 ${wall}px`, left: `0 ${far}px 0 0`, down: `${wall}px 0 0 0`, up: `0 0 ${far}px 0` }[dir];
      this.membrane.style.clipPath = `inset(${edge})`;
    }
    if (this.spring.value > 0 && this.spring.value < 1) this.paint(this.spring.value);
  }

  /**
   * The pointer is over the control that opens this panel: a bead swells a little at the edge, so the panel is
   * already on its way before the press, and settles back if the pointer leaves. Nothing while open or moving.
   */
  anticipate(on: boolean): void {
    if (this.target !== 0) return;
    if (!on && this.spring.value === 0) return;
    this.spring.setPreset(BUD_CLOSE);
    if (on) this.paint(Math.max(0.001, this.spring.value));
    this.spring.set(on ? 0.07 : 0);
  }

  set(open: boolean, still = false): void {
    this.target = open ? 1 : 0;
    if (still) {
      this.spring.jump(this.target);
      return;
    }
    this.spring.setPreset(open ? BUD_OPEN : BUD_CLOSE);
    // Its first shape now, not a frame late, so the whole panel never shows before it has divided.
    this.paint(Math.max(0.001, Math.min(0.999, this.spring.value)));
    // Aimed a little past the end, so it arrives moving and stops there: no last bead lingering at the edge, no panel
    // creeping its last few pixels.
    // From rest it leaves at once, as if the press had thrown it, rather than gathering speed at the edge.
    const thrown = open && this.spring.value < 0.1 && Math.abs(this.spring.velocity) < 0.5 ? 2.6 : undefined;
    this.spring.set(open ? 1.03 : -0.2, thrown);
  }

  private paint(t: number): void {
    const moving = t > 0 && t < 1;
    this.membrane.style.display = moving ? "" : "none";
    this.panel.classList.toggle("budding", moving);
    if (!moving || !this.geometry) {
      // Closed, it stays clipped to nothing until whatever holds it hides it, or it shows whole for a frame.
      this.panel.style.clipPath = t >= 1 || !this.geometry ? "" : "inset(50%)";
      if (this.content) this.content.style.cssText = "";
      this.panel.style.removeProperty("--bud-content");
      this.rested(t >= 1);
      return;
    }
    // A spring may pass its target a little; the shape stops at it.
    const shape = budShape(Math.min(t, 0.9999), this.geometry, this.gap);
    for (const path of this.membrane.querySelectorAll("path")) path.setAttribute("d", shape.d);
    this.panel.style.clipPath = shape.clip;
    if (!this.content) this.panel.style.setProperty("--bud-content", shape.content.toFixed(3));
    else {
      this.content.style.opacity = shape.content.toFixed(3);
      this.content.style.transform = `translateY(${((1 - shape.content) * 10).toFixed(1)}px)`;
      this.content.style.filter = shape.content > 0.98 ? "" : `blur(${((1 - shape.content) * 4).toFixed(1)}px)`;
    }
  }

  /** Stops where it is and leaves nothing drawn: the shape is cleared and the panel shown whole or not at all. */
  destroy(): void {
    this.spring.stop();
    this.membrane.style.display = "none";
    this.panel.classList.remove("budding");
    this.panel.style.clipPath = "";
    if (this.content) this.content.style.cssText = "";
    this.panel.style.removeProperty("--bud-content");
  }
}
