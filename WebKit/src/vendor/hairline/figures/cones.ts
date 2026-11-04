// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic
// A DSTNS figure on Hairline's engine (MIT, see ../LICENSE), drawn to its ten rules.

import { Cam, circ, facing, fit, hull, open, poly, prism, proj, rings, run, type Ring, type Vec2, type Vec3 } from "../core/iso";
import { tdone, tset, tval, tween } from "../core/motion";
import { disposer, mk, pointer, put, register, solid, type FigureMount, type Solid } from "../core/stage";
import { TABLE } from "../intensity";

/**
 * Cones: traffic cones on a kerb, with nothing to close off. Four stand nested
 * in a stack, the top one sitting a little proud; one stands apart, ready, its
 * outline bright. The pointer's height picks a cone in the stack: it lifts
 * clear with the ones above it, staggered outward from the pick, and shows its
 * bare reflective band. The read-out names the cone and counts the incidents
 * it is out for: none. The slider is how far a cone lifts.
 *
 * The pattern: one of many, as Drawer's. A tween per cone on its lift. The
 * pick reads the pointer's screen height against each cone's band where it
 * stands at rest, which never moves with what is on screen.
 */

const N = 4, STEP = 6, BS = 28, BT = 2.4, RB = 10.5, RT = 2.4, HC = 34;  // stacked cones, their pitch, base side and thickness, body radii, body height
const KW = 132, KD = 64, KZ = 4, A: Vec2 = [40, 30], B: Vec2 = [96, 38], S = 2.05; // the kerb, the stack's and the lone cone's places, scale
const BAND = [0.44, 0.62] as const, REST = 0.3, STAGGER = 45;            // the reflective band, as shares of the body; the rest lift of the top cone; ms per cone from the pick

type Cone = { base: Solid; body: Solid; drawn: number };

export const mount: FigureMount = ({ stage, svg, read }, value) => {
  const bag = disposer();
  const C = Cam(45, 0.5, S);
  const top = (k: number, lift: number) => KZ + k * STEP + BT + HC + lift;
  const ext: Vec3[] = [[0, 0, 0], [KW, 0, 0], [0, KD, 0], [KW, KD, 0], [A[0], A[1], top(N - 1, TABLE.cones[2])], [B[0], B[1], top(0, 0)]];
  fit(C, ext, 200, 170);
  const P = proj(C), front = facing(C);
  const g = mk("g", {}, svg);

  const [kr, ki] = rings(0, 0, KW, KD, 6, 1.6);
  put(solid(g), prism(P, front, kr, ki, 0, KZ));

  const at = (ring: Ring, [x, y]: Vec2, z: number) => ring.map((q): Vec2 => P(x + q.u, y + q.v, z));
  const foot = circ(RB, 48), tip = circ(RT, 24);
  /** A cone standing at `p` from height z: its square rubber base, then its body, the band marked on the side we see. */
  function draw(cone: Cone, p: Vec2, z: number) {
    if (z === cone.drawn) return;
    cone.drawn = z;
    const [br, bi] = rings(p[0] - BS / 2, p[1] - BS / 2, p[0] + BS / 2, p[1] + BS / 2, 4, 1.2);
    put(cone.base, prism(P, front, br, bi, z, z + BT));
    const z0 = z + BT, z1 = z0 + HC;
    const band = BAND.map((t) => open(at(run(circ(RB + (RT - RB) * t, 48), front), p, z0 + HC * t))).join("");
    put(cone.body, { sil: poly(hull(at(foot, p, z0).concat(at(tip, p, z1)))), crease: band });
  }

  // Back to front: the stack from its foot up, then the lone cone, which stands nearer.
  const cones: Cone[] = Array.from({ length: N }, () => ({ base: solid(g), body: solid(g), drawn: NaN }));
  const lone: Cone = { base: solid(g), body: solid(g), drawn: NaN };
  draw(lone, B, KZ);

  let lift = value, picked = -2;
  const tw = cones.map((_, k) => tween(k === N - 1 ? lift * REST : 0));
  const loop = register(stage, (_dt, now) => {
    let moving = false;
    cones.forEach((c, k) => { draw(c, A, KZ + k * STEP + tval(tw[k], now)); if (!tdone(tw[k], now)) moving = true; });
    return moving;
  });
  bag.add(loop.unregister);

  /** Lifts cone f and those above it, outward from f; -1 settles the stack with its top cone proud. */
  function choose(f: number, now: number) {
    if (f === picked) return;
    picked = f;
    tw.forEach((t, k) => tset(t, f < 0 ? (k === N - 1 ? lift * REST : 0) : k >= f ? lift : 0, now, f < 0 ? 0 : Math.abs(k - f) * STAGGER));
    cones.forEach((c, k) => c.body.sil.classList.toggle("hi", k === f));
    lone.body.sil.classList.toggle("hi", f < 0);
    read.textContent = f < 0 ? "rest" : `cone ${N - f} · 0`;
    loop.wake();
  }
  choose(-1, -1e9);

  /** The cone whose band, where it stands at rest, is nearest the pointer's height; off the stack's side, none. */
  const bands = cones.map((_, k) => P(A[0], A[1], KZ + k * STEP + BT + HC * 0.53)[1]);
  const half = Math.abs(P(A[0] + RB * 2.2, A[1], 0)[0] - P(A[0], A[1], 0)[0]);
  function pick([x, y]: Vec2) {
    if (Math.abs(x - P(A[0], A[1], 0)[0]) > half) return -1;
    return bands.reduce((best, b, k) => (Math.abs(y - b) < Math.abs(y - bands[best]) ? k : best), 0);
  }
  bag.add(pointer(stage, { move: (p) => choose(pick(p), performance.now()), leave: () => choose(-1, performance.now()) }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { lift = v; const f = picked; picked = -2; choose(f, performance.now()); },
    destroy: bag.dispose,
  };
};
