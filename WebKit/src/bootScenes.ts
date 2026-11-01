// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * What the start-up film's particles form.
 *
 * Every scene is its own subject, built only for what it says, and none shares a layout
 * with another. A particle carries where it is and how it behaves while the scene holds;
 * the behaviours themselves are in the vertex shader in BootScene.tsx, so a scene costs
 * the page nothing to keep moving.
 */

import { canvasGlyph } from "./placeGlyphs";

export const COUNT = 32000;
/** x y z, vx vy vz, tint kind phase hue */
export const STRIDE = 10;

/** How a particle moves while its scene holds. The numbers are shared with the shader. */
export const KIND = {
  rest: 0,
  /** Travels along its vector and starts again. */
  flow: 1,
  /** The same, on a lifted arc. */
  arc: 2,
  /** Grows up from the height in vy, in turn. */
  rise: 3,
  /** Falls fast along its vector. */
  fall: 4,
  /** Spreads out along its vector and fades. */
  ring: 5,
  /** Swells and fades in place. */
  pulse: 7,
  /** Appears as a front passes outward. */
  reveal: 8,
  /** A vehicle in a lane of the junction, held at the stop line. vx and vz are where the lane starts, vy says it turns. */
  lane: 9,
  /** One lamp of a signal head. Hue says which road it serves, phase whether it is red, amber or green. */
  lamp: 10,
  /** Carried by a wave across the sheet. */
  wave: 11,
  /** A person on a crossing, walking while the road they cross is held. */
  walker: 12,
  /** A viewfinder, still on screen, tightening each time it locks on. */
  bracket: 13,
  /** Part of a cloud, turning over slowly. */
  boil: 14,
  /** A band of light passes across. */
  shimmer: 15,
  /** Flies from here to there over the curve of the globe. */
  route: 16,
  /** A point on one road's traffic through the day, carried along it. vx is how far back the road lies, vy how busy it is. */
  ridge: 17,
  /** The moment of the day, a curtain of light going across. */
  sweep: 18,
  /** A car on a road blocked ahead, caught by the queue as it grows back. vx is its lane, vy its direction. */
  queue: 19,
  /** Part of the wreck, from the moment it happens. With a vector, it spreads out along it. */
  crash: 20,
  /** A trip from a home to the place that draws it, joining the queue at its door. vx is which road, vy how busy that place is. */
  trip: 21,
  /** Demand standing over a place, growing from the height in vy. */
  beam: 22,
  /** Something that happens at a set moment of the day, in the same place each time. */
  ping: 23,
  /** An application's window arriving from along its vector. The whole part of phase says which application. */
  dock: 24,
  /** Something an application has sent: it arrives after its window does. The whole part of phase says which, the rest when. */
  sent: 25,
} as const;

/** Added to a kind: it belongs to the world Auto Focus is flying over, and moves with it. */
export const IN_WORLD = 30;
export const FOCUS_A: readonly [number, number] = [0.62, -0.44];
export const FOCUS_B: readonly [number, number] = [-0.7, 0.5];
/** Where the road is blocked. Shared with the shader. */
export const WRECK_AT = 0.4;
/** How the road incident is seen, so that its warning sign can face the viewer. */
export const CAMERA_YAW_INCIDENT = -0.62;
/** Tint runs from base to accent. These replace that ramp where meaning needs a colour. */
export const HUE = { ramp: 0, warm: 1, danger: 2, ok: 3, signalNorth: 4, signalEast: 5 } as const;

/** A fixed sequence, so the film is the same each time it is seen. */
export function sequence(seed = 48271) {
  let state = seed;
  return () => (state = (state * 48271) % 2147483647) / 2147483647;
}

interface Options {
  v?: [number, number, number];
  tint?: number;
  kind?: number;
  phase?: number;
  hue?: number;
}
export type Put = (i: number, x: number, y: number, z: number, options?: Options) => void;

export function formation(fill: (put: Put, random: () => number) => void, seed: number): Float32Array {
  const data = new Float32Array(COUNT * STRIDE);
  const random = sequence(seed);
  const put: Put = (i, x, y, z, { v, tint = 0, kind = KIND.rest, phase, hue = HUE.ramp } = {}) => {
    const at = i * STRIDE;
    data[at] = x;
    data[at + 1] = y;
    data[at + 2] = z;
    if (v) {
      data[at + 3] = v[0];
      data[at + 4] = v[1];
      data[at + 5] = v[2];
    }
    data[at + 6] = tint;
    data[at + 7] = kind;
    data[at + 8] = phase ?? random();
    data[at + 9] = hue;
  };
  fill(put, random);
  return data;
}

const TAU = Math.PI * 2;

/** Where a drawing fills, as points from 0 to 1 across, with its height as a share of its width. */
function drawn(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): { points: [number, number][]; aspect: number } | null {
  if (typeof Path2D === "undefined" || typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  draw(ctx);
  const alpha = ctx.getImageData(0, 0, width, height).data;
  const points: [number, number][] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (alpha[(y * width + x) * 4 + 3] > 110) points.push([x / width, y / height]);
  return points.length ? { points, aspect: height / width } : null;
}

/** A place's own map icon, so that it reads as what it reads as everywhere else. */
function iconPoints(kind: string) {
  const glyph = canvasGlyph(kind);
  if (!glyph) return null;
  return drawn(192, 192, (ctx) => {
    ctx.scale(8, 8);
    ctx.lineWidth = 1.9;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const path of glyph) ctx.stroke(path);
  });
}

/** The cloud the film gathers out of. */
function cloud(): Float32Array {
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const a = random() * TAU;
      const r = 1.2 + random() * 1.4;
      put(i, Math.cos(a) * r, (random() - 0.5) * 2, Math.sin(a) * r, { tint: 0.2 });
    }
  }, 11);
}

/** A district as a map shows it: quarters on their own grids, arteries, a river with bridges, parks and buildings. */
function cityMap(): Float32Array {
  const random = sequence(90210);
  const reach = 1.75;
  const riverAt = (x: number) => 0.3 + Math.sin(x * 1.5 + 0.5) * 0.28 + x * 0.12;
  const inside = (x: number, z: number) => Math.hypot(x, z * 1.08) < reach;
  // Quarters, each laid out at its own angle, as a real city grows.
  const quarters = [
    { x: -0.95, z: -0.7, angle: 0.22, gap: 0.17 }, { x: 0.15, z: -0.95, angle: -0.42, gap: 0.2 }, { x: 1.05, z: -0.3, angle: 0.08, gap: 0.16 },
    { x: -1.1, z: 0.85, angle: -0.18, gap: 0.19 }, { x: 0.1, z: 1.0, angle: 0.5, gap: 0.17 }, { x: 1.1, z: 0.95, angle: -0.08, gap: 0.2 },
  ];
  const nearest = (x: number, z: number) => {
    let best = 0;
    let far = Infinity;
    quarters.forEach((q, k) => {
      const d = Math.hypot(x - q.x, z - q.z);
      if (d < far) {
        far = d;
        best = k;
      }
    });
    return best;
  };
  type Line = { points: [number, number][]; order: number };
  const streets: Line[] = [];
  quarters.forEach((q, k) => {
    for (const across of [0, Math.PI / 2]) {
      const a = q.angle + across;
      const [dx, dz, nx, nz] = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a)];
      for (let line = -14; line <= 14; line++) {
        const bend = random() * 0.02;
        let run: [number, number][] = [];
        const flush = () => {
          if (run.length > 3) streets.push({ points: run, order: (k + random()) / quarters.length });
          run = [];
        };
        for (let t = -2.4; t <= 2.4; t += 0.025) {
          const x = q.x + dx * t + nx * line * q.gap + nx * Math.sin(t * 3 + line) * bend;
          const z = q.z + dz * t + nz * line * q.gap + nz * Math.sin(t * 3 + line) * bend;
          // A street stops at its quarter's edge, at the map's edge and at the water.
          if (nearest(x, z) === k && inside(x, z) && Math.abs(z - riverAt(x)) > 0.1) run.push([x, z]);
          else flush();
        }
        flush();
      }
    }
  });
  const smooth = (via: [number, number][]) => {
    const out: [number, number][] = [];
    for (let k = 0; k < via.length - 1; k++) {
      const [p0, p1, p2, p3] = [via[Math.max(0, k - 1)], via[k], via[k + 1], via[Math.min(via.length - 1, k + 2)]];
      for (let n = 0; n < 24; n++) {
        const t = n / 24;
        const curve = (i: 0 | 1) => 0.5 * (2 * p1[i] + (p2[i] - p0[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t * t + (3 * p1[i] - p0[i] - 3 * p2[i] + p3[i]) * t * t * t);
        out.push([curve(0), curve(1)]);
      }
    }
    return out;
  };
  // The arteries, crossing the river on bridges and tying the quarters together.
  const arteries = [
    [[-1.6, -0.35], [-0.8, -0.2], [0, -0.28], [0.8, -0.05], [1.62, 0.05]],
    [[-0.25, -1.6], [-0.15, -0.8], [0, -0.28], [0.1, 0.4], [-0.05, 1.05], [0.2, 1.62]],
    [[-1.15, -1.15], [-0.55, -0.45], [0.1, 0.4], [0.75, 0.9], [1.1, 1.22]],
    [[1.05, -1.25], [0.75, -0.55], [0.8, -0.05], [0.95, 0.65], [0.75, 0.9]],
    [[-1.55, 0.72], [-0.75, 0.8], [-0.05, 1.05], [0.75, 0.9], [1.5, 0.75]],
  ].map((via) => smooth(via as [number, number][]));
  const buildings: { x: number; z: number; w: number; d: number; angle: number }[] = [];
  for (let n = 0; n < 900 && buildings.length < 420; n++) {
    const x = (random() - 0.5) * 3.4;
    const z = (random() - 0.5) * 3.3;
    if (!inside(x, z) || Math.abs(z - riverAt(x)) < 0.14 || Math.hypot(x + 0.62, z + 0.72) < 0.27 || Math.hypot(x - 1.0, z - 0.1) < 0.2) continue;
    buildings.push({ x, z, w: 0.016 + random() * 0.028, d: 0.016 + random() * 0.028, angle: quarters[nearest(x, z)].angle });
  }
  const weighted = (lines: { points: [number, number][] }[]) => {
    const sums: number[] = [];
    let total = 0;
    for (const line of lines) sums.push((total += line.points.length));
    return (value: number) => {
      const target = value * total;
      let low = 0;
      let high = lines.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (sums[middle] < target) low = middle + 1;
        else high = middle;
      }
      return low;
    };
  };
  const pickStreet = weighted(streets);
  return formation((put, rnd) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 40;
      if (kind < 3) {
        // The water: two banks, and a current between them.
        const x = -reach + rnd() * reach * 2;
        const z = riverAt(x);
        if (Math.hypot(x, z) > reach) {
          put(i, x * 0.8, 0, z * 0.8, { tint: 0.02 });
          continue;
        }
        const side = kind === 0 ? -1 : 1;
        if (kind < 2) put(i, x, -0.008, z + side * 0.085 + (rnd() - 0.5) * 0.006, { tint: 0.55, kind: KIND.reveal, phase: 0.02 + ((x + reach) / (reach * 2)) * 0.3 });
        else put(i, x, -0.012, z + (rnd() - 0.5) * 0.13, { v: [0.34, 0, Math.cos(x * 1.5 + 0.5) * 0.42 + 0.04], kind: KIND.flow, tint: 0.62 });
      } else if (kind < 5) {
        // Parks.
        const park = i % 2 ? { x: -0.62, z: -0.72, r: 0.25 } : { x: 1.0, z: 0.1, r: 0.18 };
        const a = rnd() * TAU;
        const r = Math.sqrt(rnd()) * park.r * (1 + Math.sin(a * 3) * 0.1);
        put(i, park.x + Math.cos(a) * r, -0.004, park.z + Math.sin(a) * r, { tint: 0.5, hue: HUE.ok, kind: KIND.reveal, phase: 0.5 + rnd() * 0.08 });
      } else if (kind < 12) {
        // Buildings, last of all: small footprints that fill the blocks in.
        const b = buildings[Math.floor(rnd() * buildings.length)];
        const u = (rnd() - 0.5) * 2 * b.w;
        const v = (rnd() - 0.5) * 2 * b.d;
        const [c, n] = [Math.cos(b.angle), Math.sin(b.angle)];
        put(i, b.x + u * c - v * n, 0.002, b.z + u * n + v * c, { tint: 0.16, kind: KIND.reveal, phase: 0.72 + rnd() * 0.24 });
      } else if (kind < 19) {
        // Arteries first, each drawn from one end to the other, wide and bright.
        const k = i % arteries.length;
        const line = arteries[k];
        const at = rnd();
        const [x, z] = line[Math.min(line.length - 1, Math.floor(at * line.length))];
        put(i, x + (rnd() - 0.5) * 0.018, 0.004, z + (rnd() - 0.5) * 0.018, { tint: 0.95, kind: KIND.reveal, phase: 0.0 + k * 0.05 + at * 0.26 });
      } else if (kind < 21) {
        // Traffic already on them.
        const line = arteries[i % arteries.length];
        const at = Math.floor(rnd() * (line.length - 12));
        const [ax, az] = line[at];
        const [bx, bz] = line[at + 11];
        put(i, ax, 0.012, az, { v: [(bx - ax) * 1.8, 0, (bz - az) * 1.8], kind: KIND.flow, tint: 1, hue: HUE.warm });
      } else {
        // Streets, quarter by quarter, each drawn along its length.
        const street = streets[pickStreet(rnd())];
        const at = rnd();
        const [x, z] = street.points[Math.min(street.points.length - 1, Math.floor(at * street.points.length))];
        put(i, x + (rnd() - 0.5) * 0.004, 0, z + (rnd() - 0.5) * 0.004, { tint: 0.52, kind: KIND.reveal, phase: 0.3 + street.order * 0.42 + at * 0.1 });
      }
    }
  }, 12);
}

/** One junction, close up and in detail: lanes, stop lines, crossings, three-lamp signals, queues that release from the front, and people crossing. */
function junction(): Float32Array {
  const road = 0.42;
  const span = 1.95;
  const stopLine = 0.6;
  const kerb = 0.17;
  // The four ways in, each with its right-hand side: traffic keeps right, and the outer lane turns right.
  const ways: { dx: number; dz: number }[] = [{ dx: 0, dz: -1 }, { dx: 0, dz: 1 }, { dx: 1, dz: 0 }, { dx: -1, dz: 0 }];
  const right = (w: { dx: number; dz: number }): [number, number] => [-w.dz, w.dx];
  const start = (w: { dx: number; dz: number }, offset: number): [number, number] => {
    const [nx, nz] = right(w);
    return [-w.dx * span + nx * offset, -w.dz * span + nz * offset];
  };
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 40;
      const along = stopLine + random() * (span - stopLine);
      const sign = random() < 0.5 ? 1 : -1;
      const armNorth = random() < 0.5;
      const onArm = (a: number, across: number): [number, number] => (armNorth ? [across, a] : [a, across]);
      if (kind < 5) {
        // The kerbs along each arm.
        const [x, z] = onArm(sign * Math.max(along, road + kerb), (random() < 0.5 ? 1 : -1) * road);
        put(i, x, 0, z, { tint: 0.3 });
      } else if (kind < 7) {
        // Kerbs rounding each corner.
        const [sx, sz] = [random() < 0.5 ? 1 : -1, random() < 0.5 ? 1 : -1];
        const a = random() * (Math.PI / 2);
        put(i, sx * (road + kerb - Math.cos(a) * kerb), 0, sz * (road + kerb - Math.sin(a) * kerb), { tint: 0.3 });
      } else if (kind === 7) {
        // The solid centre line, both sides of it.
        const [x, z] = onArm(sign * along, (random() < 0.5 ? 1 : -1) * 0.012);
        put(i, x, 0.001, z, { tint: 0.5 });
      } else if (kind === 8) {
        // Broken lines between the lanes.
        const dash = Math.floor(along * 11);
        const a = (dash + random() * 0.55) / 11;
        const [x, z] = onArm(sign * Math.max(stopLine, a), (random() < 0.5 ? 1 : -1) * 0.21);
        put(i, x, 0.001, z, { tint: 0.22 });
      } else if (kind === 9) {
        // Stop lines, across the lanes coming in.
        const way = ways[Math.floor(random() * 4)];
        const [nx, nz] = right(way);
        const t = random() * road;
        put(i, -way.dx * stopLine + nx * t, 0.002, -way.dz * stopLine + nz * t, { tint: 0.95 });
      } else if (kind < 13) {
        // Zebra crossings on all four arms.
        const bars = 10;
        const bar = Math.floor(random() * bars);
        const across = -road + ((bar + 0.18 + random() * 0.62) / bars) * road * 2;
        const a = sign * (0.44 + random() * 0.12);
        const [x, z] = onArm(a, across);
        put(i, x, 0.002, z, { tint: 0.72 });
      } else if (kind < 35) {
        // Vehicles. Most go straight on; the outer lane turns right. Each is a body with a
        // windscreen gap, brighter at the front, with tail lights that show when it is held.
        const lane = (i >> 1) % 8;
        const way = ways[lane % 4];
        const turning = lane >= 4;
        const cars = turning ? 5 : 9;
        const car = (i >> 4) % cars;
        const phase = (car + (lane * 0.37) % 1) / cars;
        let long = (random() - 0.5) * 0.15;
        const wide = (random() - 0.5) * 0.074;
        if (long > 0.018 && long < 0.038) long = 0.05;
        const tail = long < -0.055;
        const [sx, sz] = start(way, turning ? 0.31 : 0.11);
        put(i, long, 0.02 + random() * 0.018, wide, { v: [sx, turning ? 1 : 0, sz], kind: KIND.lane, phase, tint: tail ? 1 : 0.55 + ((car * 5 + lane * 3) % 4) * 0.15, hue: tail ? HUE.danger : HUE.ramp });
      } else if (kind < 38) {
        // Signals: a head of three lamps beside each way in.
        const way = ways[Math.floor(random() * 4)];
        const north = way.dx === 0;
        const [nx, nz] = right(way);
        const lamp = Math.floor(random() * 3);
        const offset = (lamp - 1) * 0.07;
        const cx = -way.dx * (stopLine + 0.1 + offset) + nx * (road + 0.09);
        const cz = -way.dz * (stopLine + 0.1 + offset) + nz * (road + 0.09);
        const a = random() * TAU;
        const r = Math.sqrt(random()) * 0.03;
        put(i, cx + Math.cos(a) * r, 0.05, cz + Math.sin(a) * r, { kind: KIND.lamp, tint: 1, phase: lamp, hue: north ? HUE.signalNorth : HUE.signalEast });
      } else {
        // People, waiting at the kerb and crossing while the traffic is held.
        const way = ways[Math.floor(random() * 4)];
        const north = way.dx === 0;
        const person = Math.floor(random() * 6);
        const a = random() * TAU;
        const r = Math.sqrt(random()) * 0.016;
        const across = road * 0.98;
        const dir = person % 2 ? 1 : -1;
        const row = (way.dx + way.dz) * (0.47 + (person % 3) * 0.035);
        const [x, z] = north ? [-dir * across, row] : [row, -dir * across];
        put(i, x + Math.cos(a) * r, 0.03, z + Math.sin(a) * r, { v: north ? [dir * across * 2, 0, 0] : [0, 0, dir * across * 2], kind: KIND.walker, tint: 0.9, phase: person / 6, hue: HUE.warm });
      }
    }
  }, 21);
}

/**
 * A point of a building: its edges sharp and its windows in rows, so that it reads as a
 * building and not a haze. x and z are shares of its half-width and half-depth.
 */
function buildingPoint(draw: () => number, across: number, deep: number, height: number, edges = 0.3): [number, number, number, number] {
  const part = draw();
  if (part < edges) {
    const corner = Math.floor(draw() * 4);
    const [sx, sz] = [corner < 2 ? -1 : 1, corner % 2 ? -1 : 1];
    if (draw() < 0.46) return [sx, draw() * height, sz, 0.9];
    const t = draw() * 2 - 1;
    return draw() < 0.5 ? [t, height, sz, 1] : [sx, height, t, 1];
  }
  if (part < edges + 0.1) return [draw() * 2 - 1, height, draw() * 2 - 1, 0.34];
  const wide = draw() < 0.5;
  const cols = Math.max(2, Math.round(((wide ? across : deep) * 2) / 0.042));
  const rows = Math.max(2, Math.round(height / 0.05));
  const col = Math.floor(draw() * cols);
  const row = Math.floor(draw() * rows);
  const side = draw() < 0.5 ? 1 : -1;
  const at = -1 + ((col + 0.5 + (draw() - 0.5) * 0.42) * 2) / cols;
  const y = ((row + 0.5 + (draw() - 0.5) * 0.42) * height) / rows;
  const lit = (col * 7 + row * 13 + (wide ? 3 : 0)) % 4 !== 0;
  return wide ? [at, y, side, lit ? 0.92 : 0.12] : [side, y, at, lit ? 0.92 : 0.12];
}

/** The places that draw trips, with the angles their roads leave at. A tower, a long low school and a shopping centre. */
const DRAWS = [
  { x: 0, z: -0.62, w: 0.15, d: 0.15, h: 0.66, busy: 1, level: 0.3, roads: [-158, -112, -68, -22, 42, 138] },
  { x: -1.22, z: 0.12, w: 0.3, d: 0.13, h: 0.15, busy: 0.82, level: 0.24, roads: [176, -128, -48, 40, 88] },
  { x: 1.22, z: 0.1, w: 0.22, d: 0.18, h: 0.24, busy: 0.62, level: 0.18, roads: [4, -48, -132, 62, 118] },
];
/** Every road, home to door: from x, from z, to x, to z. Shared with the shader. */
export const TRIP_ROADS: readonly (readonly [number, number, number, number])[] = DRAWS.flatMap((draw) =>
  draw.roads.map((degrees, n) => {
    const [dx, dz] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
    const door = Math.hypot(draw.w, draw.d) * 0.95;
    const reach = 0.78 + ((n * 37) % 5) * 0.07;
    return [draw.x + dx * reach, draw.z + dz * reach, draw.x + dx * door, draw.z + dz * door] as const;
  }),
);

/** A neighbourhood seen from above: trips leave the homes, and queues grow back from the doors of what draws them. */
function demand(): Float32Array {
  const roadsOf = DRAWS.flatMap((draw) => draw.roads.map(() => draw));
  const carsPerRoad = 16;
  const cars = TRIP_ROADS.length * carsPerRoad;
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 50;
      const road = Math.floor(random() * TRIP_ROADS.length);
      const [fx, fz, tx, tz] = TRIP_ROADS[road];
      const length = Math.hypot(tx - fx, tz - fz);
      const [dx, dz] = [(tx - fx) / length, (tz - fz) / length];
      if (kind < 4) {
        // The road's two edges.
        const along = random() * length;
        const side = random() < 0.5 ? 1 : -1;
        put(i, fx + dx * along - dz * side * 0.034, 0, fz + dz * along + dx * side * 0.034, { tint: 0.24 });
      } else if (kind < 8) {
        // Homes at the far end of each road: walls and a roof, in a small group.
        const house = Math.floor(random() * 5);
        const across = ((house * 0.37) % 1) * 0.22 + 0.08;
        const back = ((house * 0.61) % 1) * 0.2 - 0.1;
        const [hx, hz] = [fx + dx * back - dz * across * (house % 2 ? 1 : -1), fz + dz * back + dx * across * (house % 2 ? 1 : -1)];
        const [u, w] = [(random() - 0.5) * 0.058, (random() - 0.5) * 0.058];
        const roof = random() < 0.38;
        const y = roof ? 0.036 + (0.029 - Math.max(Math.abs(u), 0)) * 0.72 : random() * 0.036;
        put(i, hx + u, y, hz + w, { kind: KIND.rise, v: [0, 0, 0], phase: 0.02 + ((road * 0.13) % 0.25), tint: roof ? 0.62 : 0.4 });
      } else if (kind < 20) {
        // What draws them: a building with lit windows, standing up first of all.
        const draw = DRAWS[random() < 0.5 ? 0 : random() < 0.6 ? 1 : 2];
        const [ax, y, az, tint] = buildingPoint(random, draw.w, draw.d, draw.h);
        put(i, draw.x + ax * draw.w, y, draw.z + az * draw.d, { kind: KIND.rise, v: [0, 0, 0], phase: 0.02, tint });
      } else if (kind < 42) {
        // The trips. Each car is a small body whose colour comes from what it is caught in.
        const car = Math.floor(random() * cars);
        const on = Math.floor(car / carsPerRoad);
        const place = car % carsPerRoad;
        let long = (random() - 0.5) * 0.062;
        if (long > 0.008 && long < 0.015) long = 0.021;
        put(i, long, 0.008 + random() * 0.02, (random() - 0.5) * 0.034, { v: [on, roadsOf[on].busy, 0], kind: KIND.trip, phase: (place + ((on * 0.37) % 1)) / carsPerRoad, tint: 0.92, hue: HUE.ok });
      } else if (kind < 46) {
        // Rings closing in on each place: it is pulling.
        const draw = DRAWS[Math.floor(random() * DRAWS.length)];
        const a = random() * TAU;
        const reach = 0.34 + draw.busy * 0.16;
        put(i, draw.x + Math.cos(a) * reach, 0.006, draw.z + Math.sin(a) * reach, { v: [-Math.cos(a) * (reach - 0.16), 0, -Math.sin(a) * (reach - 0.16)], kind: KIND.flow, phase: Math.floor(random() * 2) / 2, tint: 0.5, hue: HUE.warm });
      } else {
        // How much it is drawing, as a column over the roof that grows with the morning.
        const draw = DRAWS[Math.floor(random() * DRAWS.length)];
        const a = random() * TAU;
        const r = Math.sqrt(random()) * 0.032;
        const top = random() ** 0.8;
        put(i, draw.x + Math.cos(a) * r, draw.h + 0.02 + top * draw.level, draw.z + Math.sin(a) * r, { v: [0, draw.h + 0.02, 0], kind: KIND.beam, tint: 0.6 + top * 0.4, hue: HUE.warm });
      }
    }
  }, 13);
}

/** Rows of a ridgeline, front to back: each is one road's traffic through the day, so that the two rush hours stand up as ranges of hills. */
export const RIDGES = 22;

/** The day as a landscape: each line is a road's traffic from midnight to midnight, and a curtain of light goes across, raising them as it passes. */
function rushHour(): Float32Array {
  const atHour = (h: number) => -1.8 + (h / 24) * 3.6;
  const front = 0.92;
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 50;
      if (kind === 0) {
        // The day's axis along the front, steady, with a mark for each hour and a longer one every six.
        put(i, -1.8 + random() * 3.6, -0.04, front + 0.12, { kind: KIND.dock, phase: -1, tint: 0.45 });
      } else if (kind < 3) {
        const hour = Math.floor(random() * 25);
        const major = hour % 6 === 0;
        put(i, atHour(hour), -0.04 - random() * (major ? 0.11 : 0.04), front + 0.12, { kind: KIND.dock, phase: -1, tint: major ? 1 : 0.4 });
      } else if (kind < 5) {
        // The curtain.
        put(i, 0, random(), front - random() * 1.9, { kind: KIND.sweep, tint: 0.25 });
      } else {
        // The roads, carried along through the day. Each has its own size, and its peaks fall a little differently.
        const row = Math.floor(random() * RIDGES);
        put(i, 0, 0, 0, { v: [front - (row / (RIDGES - 1)) * 1.9, 0.72 + ((row * 37) % 11) * 0.05, ((row * 53) % 17) / 17], kind: KIND.ridge, tint: 0.7 });
      }
    }
  }, 22);
}

/** A collision on a dual carriageway, seen from above the verge: lanes close and the queue grows back up the road, while the other side runs on. */
function incident(): Float32Array {
  const edge = 0.58;
  const lanes = [0.13, 0.31, 0.49];
  const cars = 168;
  const perLane = cars / 6;
  // Where the wreck lies, in the two outer lanes.
  const wreck = [
    { x: WRECK_AT, z: 0.28, angle: 0.7 },
    { x: WRECK_AT + 0.13, z: 0.46, angle: -0.5 },
  ];
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 50;
      if (kind < 3) {
        // The road's edges, and the barrier down its middle.
        const side = Math.floor(random() * 4);
        put(i, -2.6 + random() * 5.2, 0, [edge, -edge, 0.035, -0.035][side], { tint: side < 2 ? 0.42 : 0.26 });
      } else if (kind < 5) {
        // Broken lines between the lanes.
        const z = [0.22, 0.4, -0.22, -0.4][Math.floor(random() * 4)];
        const dash = Math.floor(random() * 26);
        put(i, -2.6 + (dash + random() * 0.45) * 0.2, 0, z, { tint: 0.2 });
      } else if (kind < 38) {
        // The cars: bodies with a gap for the windscreen. Their colour comes from what they are caught in.
        const car = Math.floor(random() * cars);
        const lane = car % 6;
        const place = Math.floor(car / 6);
        let long = (random() - 0.5) * 0.105;
        if (long > 0.012 && long < 0.024) long = 0.034;
        const height = 0.012 + random() * 0.03;
        put(i, long, height, (random() - 0.5) * 0.06, {
          v: [lanes[lane % 3] * (lane < 3 ? 1 : -1), lane < 3 ? 1 : -1, 0],
          kind: KIND.queue,
          phase: (place + (lane * 0.37) % 1) / perLane,
          tint: lane < 3 ? 0.9 : 0.42,
          hue: HUE.ok,
        });
      } else if (kind < 40) {
        // The wreck: two cars, skewed across their lanes.
        const body = wreck[random() < 0.5 ? 0 : 1];
        const [u, w] = [(random() - 0.5) * 0.13, (random() - 0.5) * 0.07];
        put(i, body.x + u * Math.cos(body.angle) - w * Math.sin(body.angle), 0.012 + random() * 0.035, body.z + u * Math.sin(body.angle) + w * Math.cos(body.angle), { kind: KIND.crash, tint: 1, hue: HUE.danger });
      } else if (kind < 45) {
        // Rings going out from it across the road.
        const a = random() * TAU;
        put(i, WRECK_AT + 0.06, 0.012, 0.37, { v: [Math.cos(a) * 0.46, 0, Math.sin(a) * 0.46], kind: KIND.crash, tint: 0.9, hue: HUE.danger, phase: Math.floor(random() * 3) / 3 });
      } else if (kind < 47) {
        // A warning triangle standing over it, turned to face the viewer.
        const side = Math.floor(random() * 3);
        const t = random();
        const corners: [number, number][] = [[0, 0.1], [0.09, -0.055], [-0.09, -0.055]];
        const [a, b] = [corners[side], corners[(side + 1) % 3]];
        const across = a[0] + (b[0] - a[0]) * t + (random() - 0.5) * 0.009;
        const up = a[1] + (b[1] - a[1]) * t + (random() - 0.5) * 0.009;
        put(i, WRECK_AT + 0.06 + across * Math.cos(CAMERA_YAW_INCIDENT), 0.26 + up, 0.37 + across * Math.sin(CAMERA_YAW_INCIDENT), { kind: KIND.crash, tint: 1, hue: HUE.warm });
      } else {
        // The verge: posts along both sides, so that the road has somewhere to be.
        const post = Math.floor(random() * 28);
        put(i, -2.6 + post * 0.2, random() * 0.04, (post % 2 ? 1 : -1) * (edge + 0.1), { tint: 0.14 });
      }
    }
  }, 23);
}

/** A storm cell seen from the side: a cloud turning over, rain, and rings where it lands. */
function storm(): Float32Array {
  const puffs: [number, number, number, number][] = [
    [-0.85, 0.98, 0.1, 0.36], [-0.4, 1.12, -0.12, 0.46], [0.1, 1.2, 0.05, 0.55], [0.6, 1.1, -0.08, 0.44], [1.02, 0.96, 0.1, 0.33],
    [-0.15, 0.94, 0.26, 0.38], [0.36, 0.92, 0.28, 0.34], [-0.55, 0.86, -0.25, 0.28], [0.72, 0.84, -0.3, 0.27],
  ];
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 20;
      if (kind < 10) {
        const [cx, cy, cz, r] = puffs[Math.floor(random() * puffs.length)];
        const u = random() * 2 - 1;
        const a = random() * TAU;
        const s = Math.sqrt(1 - u * u);
        // Mostly on the surface, so each puff has a shape, lit from above.
        const d = r * (0.8 + random() * 0.2);
        const y = cy + u * d * 0.78;
        put(i, cx + s * Math.cos(a) * d, Math.max(0.56, y - 0.2), cz + s * Math.sin(a) * d, { kind: KIND.boil, tint: 0.16 + Math.max(0, u) * 0.75 });
      } else if (kind < 15) {
        // Rain, in streaks: every drop is a line of particles falling together.
        const drop = Math.floor(random() * 340);
        const hx = Math.sin(drop * 12.9898) * 1.2;
        const hz = Math.sin(drop * 78.233) * 0.7;
        const behind = random() * 0.12;
        put(i, hx + behind * 0.08, 0.66 + behind, hz, { v: [-0.12, -1.42, 0], kind: KIND.fall, tint: 0.95, phase: (drop * 0.618) % 1 });
      } else if (kind < 19) {
        // Rings on the ground, where the rain lands.
        const hit = Math.floor(random() * 26);
        const hx = Math.sin(hit * 12.9898) * 1.15;
        const hz = Math.sin(hit * 78.233) * 0.75;
        const a = random() * TAU;
        put(i, hx, -0.76, hz, { v: [Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3], kind: KIND.ring, tint: 0.85, phase: (hit * 0.137) % 1 });
      } else {
        // Standing water, gathered low.
        const a = random() * TAU;
        const r = Math.sqrt(random()) * 1.6;
        put(i, Math.cos(a) * r, -0.76, Math.sin(a) * r * 0.62, { tint: 0.12 + (1 - r / 1.6) * 0.25 });
      }
    }
  }, 15);
}

// Coarse outlines, longitude then latitude, close enough for a globe made of dots.
const LAND: [number, number][][] = [
  [[-168, 65], [-156, 71], [-125, 70], [-95, 72], [-80, 73], [-62, 60], [-55, 50], [-66, 44], [-75, 38], [-81, 30], [-82, 25], [-90, 29], [-97, 26], [-97, 20], [-88, 16], [-83, 10], [-79, 8], [-92, 15], [-105, 20], [-112, 28], [-118, 34], [-124, 42], [-125, 49], [-135, 58], [-150, 60], [-165, 55]],
  [[-79, 8], [-72, 12], [-60, 8], [-50, 1], [-35, -6], [-39, -15], [-48, -25], [-57, -36], [-65, -42], [-68, -54], [-74, -50], [-73, -37], [-71, -18], [-81, -5]],
  [[-10, 36], [-9, 43], [-1, 46], [-4, 49], [3, 52], [8, 55], [5, 60], [12, 66], [25, 71], [45, 68], [70, 73], [100, 77], [130, 72], [170, 70], [178, 65], [163, 58], [155, 52], [140, 55], [135, 45], [128, 38], [122, 30], [120, 23], [108, 18], [109, 10], [103, 2], [98, 8], [95, 16], [88, 22], [80, 12], [77, 8], [72, 20], [62, 25], [57, 25], [52, 16], [44, 12], [38, 22], [34, 30], [35, 36], [27, 36], [22, 37], [15, 38], [9, 44], [3, 42], [-1, 37], [-6, 36]],
  [[-17, 15], [-16, 22], [-10, 30], [-6, 36], [3, 37], [11, 37], [20, 32], [32, 31], [37, 20], [43, 12], [51, 12], [42, -2], [39, -12], [35, -24], [27, -34], [18, -34], [13, -18], [9, -1], [9, 4], [-4, 5], [-13, 8]],
  [[114, -22], [122, -18], [131, -12], [137, -12], [142, -11], [146, -19], [153, -26], [150, -37], [140, -38], [131, -32], [116, -35], [113, -26]],
  [[-45, 60], [-22, 70], [-20, 80], [-60, 83], [-72, 77], [-55, 68]],
  [[130, 32], [141, 36], [142, 44], [140, 41], [133, 35]],
  [[-6, 50], [1, 51], [-2, 58], [-6, 57]],
  [[95, 5], [106, -6], [116, -8], [120, -2], [110, 1]],
  [[44, -16], [50, -14], [47, -25], [44, -23]],
  [[167, -46], [174, -41], [178, -38], [173, -42]],
];
const PINS: [number, number][] = [[-74, 41], [-118, 34], [-46, -23], [-58, -35], [0, 51], [13, 52], [37, 56], [3, 6], [31, 30], [28, -26], [77, 29], [72, 19], [90, 24], [121, 31], [139, 36], [151, -34], [103, 1], [-99, 19]];

export function onLand(lon: number, lat: number): boolean {
  for (const shape of LAND) {
    let inside = false;
    for (let a = 0, b = shape.length - 1; a < shape.length; b = a++) {
      const [ax, ay] = shape[a];
      const [bx, by] = shape[b];
      if (ay > lat !== by > lat && lon < ((bx - ax) * (lat - ay)) / (by - ay) + ax) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

function onGlobe(lon: number, lat: number, r: number): [number, number, number] {
  const a = (lon * Math.PI) / 180;
  const b = (lat * Math.PI) / 180;
  return [Math.cos(b) * Math.sin(a) * r, Math.sin(b) * r, Math.cos(b) * Math.cos(a) * r];
}

/** The world in dots, with continents, cities pinging, and routes lifting off between them. */
function globe(): Float32Array {
  const radius = 1.14;
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 20;
      if (kind < 14) {
        // Land, as an even field of dots, so that the coastlines read.
        let lon = 0;
        let lat = 0;
        for (let tries = 0; tries < 40; tries++) {
          lon = random() * 360 - 180;
          lat = (Math.asin(random() * 2 - 1) * 180) / Math.PI;
          if (onLand(lon, lat)) break;
        }
        const [x, y, z] = onGlobe(lon, lat, radius);
        put(i, x, y, z, { tint: 0.55 + random() * 0.25 });
      } else if (kind < 16) {
        // A faint graticule, so that the ocean is still a sphere.
        const along = random() * 360 - 180;
        const line = (Math.floor(random() * 6) - 2.5) * 30;
        const [x, y, z] = i % 2 ? onGlobe(along, line, radius * 0.995) : onGlobe(line * 2, along / 2, radius * 0.995);
        put(i, x, y, z, { tint: 0.03 });
      } else if (kind < 18) {
        // Cities.
        const [lon, lat] = PINS[Math.floor(random() * PINS.length)];
        const a = random() * TAU;
        const r = Math.sqrt(random()) * 2.3;
        const [x, y, z] = onGlobe(lon + Math.cos(a) * r, lat + Math.sin(a) * r, radius * 1.006);
        put(i, x, y, z, { kind: KIND.pulse, tint: 1, hue: HUE.warm, phase: ((lon + 180) / 360 + lat / 90) % 1 });
      } else {
        // Routes.
        const from = PINS[i % PINS.length];
        const to = PINS[(i * 7 + 3) % PINS.length];
        const [ax, ay, az] = onGlobe(from[0], from[1], radius);
        const [bx, by, bz] = onGlobe(to[0], to[1], radius);
        put(i, ax, ay, az, { v: [bx - ax, by - ay, bz - az], kind: KIND.route, tint: 1 });
      }
    }
  }, 16);
}

/**
 * A seed is a code, drawn as a barcode because it needs no numbers. The same code prints the same town, building for
 * building, car for car and event for event, and a different code prints a different town.
 */
function twinWorlds(): Float32Array {
  const scale = 0.31;
  interface Box { u: number; v: number; w: number; d: number; h: number; from: number }
  // A seed decides everything: how the streets fall, and where the town is tallest.
  const grow = (seed: number, cells: number, peak: readonly [number, number]) => {
    const r = sequence(seed);
    const lines = () => [-1, ...Array.from({ length: cells - 1 }, (_, n) => -1 + ((n + 1 + (r() - 0.5) * 0.5) * 2) / cells), 1];
    const [us, vs] = [lines(), lines()];
    const boxes: Box[] = [];
    for (let a = 0; a < cells; a++) {
      for (let b = 0; b < cells; b++) {
        const [ua, ub, va, vb] = [us[a] + 0.07, us[a + 1] - 0.07, vs[b] + 0.07, vs[b + 1] - 0.07];
        const tall = Math.max(0, 1 - Math.hypot((ua + ub) / 2 - peak[0], (va + vb) / 2 - peak[1]) / 1.15);
        for (let n = 0; n < 2; n++) {
          // Each block is split along its longer side, and each part holds one building.
          const long = ub - ua > vb - va;
          const [m0, m1] = n === 0 ? [0, 0.47] : [0.53, 1];
          const [bu, eu, bv, ev] = long ? [ua + (ub - ua) * m0, ua + (ub - ua) * m1, va, vb] : [ua, ub, va + (vb - va) * m0, va + (vb - va) * m1];
          const [u, v] = [(bu + eu) / 2, (bv + ev) / 2];
          boxes.push({ u, v, w: (eu - bu) / 2 - 0.01, d: (ev - bv) / 2 - 0.01, h: 0.05 + r() * 0.08 + tall * tall * (0.2 + r() * 0.5), from: Math.hypot(u, v) / 1.42 });
        }
      }
    }
    return { us: us.slice(1, cells), vs: vs.slice(1, cells), boxes };
  };
  const same = grow(2718, 3, [0.05, -0.05]);
  const other = grow(31337, 2, [-0.55, 0.5]);
  const tiles = [{ cx: -1.3, world: same }, { cx: 0, world: same }, { cx: 1.3, world: other }];
  const place = (cx: number, u: number, v: number): [number, number] => [cx + (u - v) * scale, (u + v) * scale];
  // The codes, over each town, the same in the first two.
  const code = (seed: number) => {
    const r = sequence(seed);
    const bars: [number, number][] = [];
    for (let at = -0.5; at < 0.5; ) {
      const wide = 0.018 + r() * 0.05;
      bars.push([at, Math.min(0.5, at + wide)]);
      at += wide + 0.016 + r() * 0.036;
    }
    return bars;
  };
  const codes = [code(2718), code(2718), code(31337)];
  const codeAt = 0.82; // How high they float.
  // Each slot draws the same numbers in every world, so that the two made from one seed are alike point for point.
  const slots = Math.ceil(COUNT / 3);
  const numbers = new Float32Array(slots * 12);
  const stream = sequence(26);
  for (let n = 0; n < numbers.length; n++) numbers[n] = stream();
  return formation((put) => {
    for (let i = 0; i < COUNT; i++) {
      const slot = Math.floor(i / 3);
      const side = i % 3;
      const tile = tiles[side];
      let cursor = slot * 12;
      const draw = () => numbers[cursor++];
      const kind = slot % 40;
      const { world, cx } = tile;
      if (kind < 4) {
        // The streets, drawn outward from the middle.
        const line = Math.floor(draw() * world.us.length * 2);
        const along = draw() * 2 - 1;
        const n = world.us.length;
        const [u, v] = line < n ? [world.us[line], along] : [along, world.vs[line - n]];
        const [x, z] = place(cx, u, v);
        put(i, x, 0.002, z, { kind: KIND.reveal, phase: 0.04 + Math.hypot(u, v) * 0.14, tint: 0.5 });
      } else if (kind < 22) {
        // Buildings, standing up from the middle outward.
        const box = world.boxes[Math.floor(draw() * world.boxes.length)];
        const [ax, y, az, tint] = buildingPoint(draw, box.w * scale, box.d * scale, box.h, 0.56);
        const [x, z] = place(cx, box.u + ax * box.w, box.v + az * box.d);
        put(i, x, y, z, { kind: KIND.rise, v: [0, 0, 0], phase: 0.08 + box.from * 0.5, tint });
      } else if (kind < 25) {
        // Traffic, the same cars at the same moment.
        const car = Math.floor(draw() * 18);
        const n = world.us.length;
        const line = car % (n * 2);
        const across = (car % 2 ? 1 : -1) * 0.022;
        const [au, av, bu, bv] = line < n ? [world.us[line] + across, -1, world.us[line] + across, 1] : [-1, world.vs[line - n] + across, 1, world.vs[line - n] + across];
        const [ax, az] = place(cx, au, av);
        const [bx, bz] = place(cx, bu, bv);
        const [ox, oz] = [(draw() - 0.5) * 0.016, (draw() - 0.5) * 0.016];
        put(i, (car % 2 ? bx : ax) + ox, 0.01 + draw() * 0.008, (car % 2 ? bz : az) + oz, { v: car % 2 ? [ax - bx, 0, az - bz] : [bx - ax, 0, bz - az], kind: KIND.flow, phase: car / 18, tint: 0.7, hue: HUE.ok });
      } else if (kind < 29) {
        // The slab each stands on: its edges above and below, and the corners between them.
        const edge = Math.floor(draw() * 4);
        const t = draw() * 2 - 1;
        const [u, v] = edge === 0 ? [t, -1] : edge === 1 ? [t, 1] : edge === 2 ? [-1, t] : [1, t];
        const [x, z] = place(cx, u, v);
        const below = draw();
        put(i, x, below < 0.62 ? 0 : -0.075, z, { tint: below < 0.62 ? 0.55 : 0.2 });
      } else if (kind < 31) {
        // Something happens: the same moment and the same place in the same world.
        const [x, z] = place(cx, world.us[world.us.length - 1], world.vs[0]);
        const a = draw() * TAU;
        put(i, x, 0.016, z, { v: [Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2], kind: KIND.ping, tint: 1, hue: HUE.danger, phase: 0.5 });
      } else if (kind < 37) {
        // The code over this town, turned to face the viewer.
        const bars = codes[side];
        const [from, to] = bars[Math.floor(draw() * bars.length)];
        const x = from + (to - from) * draw();
        const y = (draw() - 0.5) * 0.2;
        put(i, cx + x, codeAt + y * 0.85, -0.3 + y * 0.53, { v: [0, 0.22, 0], kind: KIND.dock, phase: 0.02, tint: 1, hue: side === 2 ? HUE.ramp : HUE.warm });
      } else if (kind < 38) {
        // Read down into the town: a thread from each bar.
        const bars = codes[side];
        const [from, to] = bars[Math.floor(draw() * bars.length)];
        const x = (from + to) / 2;
        put(i, cx + x, codeAt - 0.08, -0.3, { v: [-x * 0.6, -codeAt + 0.2, 0.3], kind: KIND.flow, phase: draw(), tint: 0.5, hue: side === 2 ? HUE.ramp : HUE.warm });
      } else if (side === 2) {
        // A different town has nothing to join it to the others.
        const edge = draw() * 2 - 1;
        const [x, z] = place(cx, edge, 1);
        put(i, x, 0, z, { tint: 0.5 });
      } else {
        // Threads between the same buildings in the two towns: these two are alike.
        const box = [...same.boxes].sort((a, b) => b.h - a.h)[Math.floor(draw() * 5)];
        const [x, z] = place(tiles[0].cx, box.u, box.v);
        put(i, x, box.h + 0.01, z, { v: [tiles[1].cx - tiles[0].cx, 0, 0], kind: KIND.arc, tint: 0.9, hue: HUE.ok, phase: draw() });
      }
    }
  }, 26);
}

/** The world from above, with the camera flying to one event and then the next, inside a steady viewfinder. */
function viewfinder(): Float32Array {
  const half = 0.42;
  const random = sequence(611);
  const roads: [number, number][][] = [];
  for (let n = 0; n < 16; n++) {
    let x = (random() - 0.5) * 3.8;
    let z = (random() - 0.5) * 3.8;
    let heading = random() * TAU;
    const curl = (random() - 0.5) * 0.09;
    const road: [number, number][] = [];
    for (let k = 0; k < 90; k++) {
      road.push([x, z]);
      heading += curl;
      x += Math.cos(heading) * 0.05;
      z += Math.sin(heading) * 0.05;
    }
    roads.push(road);
  }
  const events = [
    { at: FOCUS_A, hue: HUE.danger, big: true },
    { at: FOCUS_B, hue: HUE.warm, big: true },
    { at: [1.2, 0.95] as const, hue: HUE.ramp, big: false },
    { at: [-1.25, -1.05] as const, hue: HUE.ramp, big: false },
  ];
  return formation((put, rnd) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 25;
      if (kind < 8) {
        // Streets, so that it is a place being looked at.
        const road = roads[i % roads.length];
        const [x, z] = road[Math.floor(rnd() * road.length)];
        put(i, x, 0, z, { kind: IN_WORLD + KIND.rest, tint: 0.2 });
      } else if (kind < 12) {
        // Scattered buildings.
        const x = (rnd() - 0.5) * 4.4;
        const z = (rnd() - 0.5) * 4.4;
        put(i, x, 0, z, { kind: IN_WORLD + KIND.rest, tint: 0.03 });
      } else if (kind < 15) {
        // Each event's core, in the world.
        const event = events[i % events.length];
        const a = rnd() * TAU;
        const r = Math.sqrt(rnd()) * (event.big ? 0.05 : 0.026);
        put(i, event.at[0] + Math.cos(a) * r, 0.02, event.at[1] + Math.sin(a) * r, { kind: IN_WORLD + KIND.pulse, tint: 1, hue: event.hue, phase: (i % events.length) * 0.25 });
      } else if (kind < 20) {
        // Rings going out from them.
        const event = events[i % events.length];
        const a = rnd() * TAU;
        const reach = event.big ? 0.42 : 0.2;
        put(i, event.at[0], 0.015, event.at[1], { v: [Math.cos(a) * reach, 0, Math.sin(a) * reach], kind: IN_WORLD + KIND.ring, tint: 0.9, hue: event.hue, phase: Math.floor(rnd() * 3) / 3 });
      } else if (kind < 24) {
        // The frame's four corners, which stay in the middle of the view.
        const sx = i % 2 ? 1 : -1;
        const sz = (i >> 1) % 2 ? 1 : -1;
        const along = rnd() * 0.15;
        const flip = (i >> 2) % 2;
        put(i, sx * (flip ? half : half - along) + (rnd() - 0.5) * 0.012, 0.02, sz * (flip ? half - along : half) + (rnd() - 0.5) * 0.012, { kind: KIND.bracket, tint: 1, phase: 0 });
      } else {
        // Ticks on the frame's sides, and a dot in the middle.
        const side = i % 5;
        const t = rnd() * 0.07;
        const x = side === 0 ? half - t : side === 1 ? -half + t : side === 4 ? (rnd() - 0.5) * 0.02 : 0;
        const z = side === 2 ? half - t : side === 3 ? -half + t : side === 4 ? (rnd() - 0.5) * 0.02 : 0;
        put(i, x, 0.02, z, { kind: KIND.bracket, tint: 0.8, phase: 0 });
      }
    }
  }, 25);
}

/**
 * The interface itself, in miniature: its header, tools, map, telemetry and controls. Applications come in from outside and
 * become part of it: one takes a sidebar and drives a route on the map, one adds a tool and shades a district, one adds a
 * panel beside the telemetry and raises a notification.
 */
function fabric(): Float32Array {
  const [left, right, top, bottom] = [-1.5, 1.5, 1.02, -0.62];
  const r = 0.09;
  const random = sequence(2024);
  type Seg = [number, number, number, number];
  // A rounded rectangle as straight runs, with each corner as a short curve.
  const rounded = (x0: number, y0: number, x1: number, y1: number, radius: number): Seg[] => {
    const out: Seg[] = [[x0 + radius, y1, x1 - radius, y1], [x1, y1 - radius, x1, y0 + radius], [x1 - radius, y0, x0 + radius, y0], [x0, y0 + radius, x0, y1 - radius]];
    for (const [cx, cy, start] of [[x1 - radius, y1 - radius, 0], [x0 + radius, y1 - radius, Math.PI / 2], [x0 + radius, y0 + radius, Math.PI], [x1 - radius, y0 + radius, Math.PI * 1.5]] as const) {
      for (let n = 0; n < 6; n++) {
        const [a, c] = [start + (n / 6) * (Math.PI / 2), start + ((n + 1) / 6) * (Math.PI / 2)];
        out.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, cx + Math.cos(c) * radius, cy + Math.sin(c) * radius]);
      }
    }
    return out;
  };
  const along = (segs: Seg[], value: number): [number, number] => {
    const lengths = segs.map(([a, b, c, d]) => Math.hypot(c - a, d - b));
    let at = value * lengths.reduce((sum, length) => sum + length, 0);
    for (let n = 0; n < segs.length; n++) {
      if (at <= lengths[n] || n === segs.length - 1) {
        const t = Math.min(1, at / (lengths[n] || 1));
        return [segs[n][0] + (segs[n][2] - segs[n][0]) * t, segs[n][1] + (segs[n][3] - segs[n][1]) * t];
      }
      at -= lengths[n];
    }
    return [0, 0];
  };
  // The parts of the interface.
  const frame = rounded(left, bottom, right, top, r);
  const header = top - 0.13;
  const dock = rounded(left + 0.06, 0.02, left + 0.2, header - 0.06, 0.07);
  const deck = rounded(right - 0.72, bottom + 0.26, right - 0.06, header - 0.06, 0.05);
  const rail = rounded(left + 0.28, bottom + 0.05, right - 0.06, bottom + 0.2, 0.075);
  const map = { x0: left + 0.26, x1: right - 0.78, y0: bottom + 0.26, y1: header - 0.06 };
  const streets: Seg[] = [];
  for (let n = 0; n < 7; n++) {
    const y = map.y0 + ((n + 0.5 + (random() - 0.5) * 0.5) / 7) * (map.y1 - map.y0);
    streets.push([map.x0, y, map.x1, y + (random() - 0.5) * 0.1]);
  }
  for (let n = 0; n < 9; n++) {
    const x = map.x0 + ((n + 0.5 + (random() - 0.5) * 0.5) / 9) * (map.x1 - map.x0);
    streets.push([x, map.y0, x + (random() - 0.5) * 0.1, map.y1]);
  }
  // What the applications bring. Their windows start outside, and the sidebar takes the room the map gives it.
  const sidebar = rounded(map.x0 + 0.02, map.y0 + 0.02, map.x0 + 0.46, map.y1 - 0.02, 0.05);
  const panel = rounded(right - 0.68, bottom + 0.3, right - 0.1, bottom + 0.72, 0.04);
  const tool = { x: left + 0.13, y: 0.14, r: 0.045 };
  const capsule = rounded(map.x0 + 0.5, bottom + 0.3, map.x0 + 1.14, bottom + 0.4, 0.05);
  const route: Seg[] = (() => {
    const via: [number, number][] = [[map.x0 + 0.52, map.y0 + 0.24], [map.x0 + 0.72, map.y0 + 0.28], [map.x0 + 0.78, map.y0 + 0.62], [map.x0 + 1.12, map.y0 + 0.66], [map.x0 + 1.2, map.y0 + 1.0], [map.x1 - 0.1, map.y0 + 1.04]];
    return via.slice(1).map((end, n) => [via[n][0], via[n][1], end[0], end[1]] as Seg);
  })();
  const district = { x: map.x0 + 1.16, y: map.y0 + 0.34, rx: 0.2, ry: 0.15 };
  // When each arrives, then when what it sends appears. Reveal runs on age / 2.3.
  const arrives = [0.5, 1.5, 2.5];
  const after = (app: number, delay: number) => (arrives[app] + 0.75 + delay) / 2.3;
  const dock_ = (app: number) => arrives[app];
  const HUES = [HUE.warm, HUE.ok, HUE.ramp];
  // Already there, and steady: this is the interface, which does not shimmer.
  const still = { v: [0, 0, 0] as [number, number, number], kind: KIND.dock, phase: -1 };
  return formation((put, rnd) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 50;
      if (kind < 4) {
        // The window it all sits in.
        const [x, y] = along(frame, rnd());
        put(i, x, y, 0, { ...still, tint: 0.72 });
      } else if (kind < 5) {
        // The header's line, with the name and a few controls as marks.
        const mark = rnd();
        if (mark < 0.5) put(i, left + rnd() * (right - left), header, 0, { ...still, tint: 0.28 });
        else if (mark < 0.8) put(i, left + 0.08 + rnd() * 0.24, top - 0.065 + (rnd() - 0.5) * 0.02, 0, { ...still, tint: 0.9 });
        else put(i, right - 0.42 + rnd() * 0.34, top - 0.065 + (rnd() - 0.5) * 0.024, 0, { ...still, tint: 0.5 });
      } else if (kind < 9) {
        // The tools down the side, and the telemetry and controls.
        const [x, y] = along(dock, rnd());
        const part = rnd();
        if (part < 0.25) put(i, x, y, 0, { ...still, tint: 0.5 });
        else if (part < 0.6) {
          const [dx, dy] = along(deck, rnd());
          put(i, dx, dy, 0, { ...still, tint: 0.5 });
        } else {
          const [rx, ry] = along(rail, rnd());
          put(i, rx, ry, 0, { ...still, tint: 0.5 });
        }
      } else if (kind < 11) {
        // What is in them: tool marks, telemetry rows, and the rail's controls and timeline.
        const part = rnd();
        if (part < 0.2) {
          const n = Math.floor(rnd() * 5);
          put(i, left + 0.13 + (rnd() - 0.5) * 0.04, 0.2 + n * 0.12 + (rnd() - 0.5) * 0.04, 0, { ...still, tint: 0.55 });
        } else if (part < 0.72) {
          const n = Math.floor(rnd() * 7);
          put(i, right - 0.66 + rnd() * 0.54 * (0.6 + ((n * 37) % 5) * 0.1), header - 0.14 - n * 0.075, 0, { ...still, tint: 0.42 });
        } else {
          put(i, left + 0.5 + rnd() * 1.9, bottom + 0.125 + (rnd() - 0.5) * 0.012, 0, { ...still, tint: 0.48 });
        }
      } else if (kind < 16) {
        // The map's streets.
        const [x, y] = along([streets[Math.floor(rnd() * streets.length)]], rnd());
        put(i, x, y, 0, { ...still, tint: 0.24 });
      } else if (kind < 22) {
        // The first application's sidebar, coming in from the left.
        const [x, y] = along(sidebar, rnd());
        const row = rnd();
        const [px, py] = row < 0.5 ? [x, y] : [map.x0 + 0.07 + rnd() * 0.3, map.y1 - 0.1 - Math.floor(rnd() * 7) * 0.13];
        put(i, px, py, 0.02, { v: [-1.5, 0.15, 0.5], kind: KIND.dock, phase: dock_(0), tint: row < 0.5 ? 1 : 0.7, hue: HUES[0] });
      } else if (kind < 27 || kind >= 45) {
        // Its route, drawn along the streets, and what it drives along it.
        const at = rnd();
        const [x, y] = along(route, at);
        put(i, x + (rnd() - 0.5) * 0.012, y + (rnd() - 0.5) * 0.012, 0.015, { v: [0, 0, at], kind: KIND.sent, phase: arrives[0] + 0.75, tint: 0.85, hue: HUES[0] });
      } else if (kind < 29) {
        // The second's tool, joining the others from above.
        const a = rnd() * TAU;
        const d = Math.sqrt(rnd()) * tool.r;
        put(i, tool.x + Math.cos(a) * d, tool.y + Math.sin(a) * d, 0.02, { v: [-0.7, -1.2, 0.5], kind: KIND.dock, phase: dock_(1), tint: 1, hue: HUES[1] });
      } else if (kind < 32) {
        // The district it shades, with an edge that holds it.
        const a = rnd() * TAU;
        const inside = rnd() < 0.4;
        const d = inside ? Math.sqrt(rnd()) : 1 + (rnd() - 0.5) * 0.02;
        put(i, district.x + Math.cos(a) * d * district.rx, district.y + Math.sin(a) * d * district.ry, 0.01, { kind: KIND.reveal, phase: after(1, d * 0.3), tint: inside ? 0.2 : 0.9, hue: HUES[1] });
      } else if (kind < 42) {
        // The third's panel, coming in from the right, with a chart in it.
        const part = rnd();
        if (part < 0.42) {
          const [x, y] = along(panel, rnd());
          put(i, x, y, 0.02, { v: [1.5, -0.2, 0.5], kind: KIND.dock, phase: dock_(2), tint: 1, hue: HUES[2] });
        } else {
          const n = Math.floor(rnd() * 9);
          const tall = [0.3, 0.5, 0.8, 0.55, 0.95, 0.7, 0.45, 0.62, 0.38][n];
          put(i, right - 0.62 + (n + 0.2 + rnd() * 0.6) * 0.052, bottom + 0.34 + rnd() * tall * 0.3, 0.02, { v: [1.5, -0.2, 0.5], kind: KIND.dock, phase: dock_(2), tint: 0.85, hue: HUES[2] });
        }
      } else if (kind < 45) {
        // And the notification it raises.
        const [x, y] = along(capsule, rnd());
        put(i, x, y, 0.02, { v: [0, -0.32, 0], kind: KIND.dock, phase: arrives[2] + 0.85, tint: 1, hue: HUES[2] });
      }
    }
  }, 17);
}

/** What the end of a session blows the name into: a wide burst, thickest in the middle, in the colour the screen comes to rest in. */
export function endMist(): Float32Array {
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const a = random() * TAU;
      // A ring ahead of the rest, going out through everything as the shock of it.
      const shock = i % 9 === 0;
      const r = shock ? 3.1 + random() * 0.12 : 0.2 + Math.sqrt(-2 * Math.log(1 - random() * 0.985)) * 0.95;
      put(i, Math.cos(a) * r, Math.sin(a) * r, shock ? 0 : (random() - 0.5) * 1.1, { kind: KIND.boil, tint: shock ? 0.9 : 0.14 + random() * 0.3, hue: HUE.ok });
    }
  }, 31);
}

/** In chapter order. The first is the cloud, and the wordmark takes its place once drawn. */
export function buildFormations(): Float32Array[] {
  return [cloud(), cityMap(), junction(), demand(), rushHour(), incident(), storm(), globe(), twinWorlds(), viewfinder(), fabric()];
}
