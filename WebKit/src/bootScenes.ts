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
  /** Part of a stream through the day, as wide as the day is busy there. vx is across it, vz its depth. */
  stream: 17,
  /** Part of a ring that fills to vx as demand builds. Phase is how far round it is. */
  gauge: 18,
  /** A car on a road blocked ahead, caught by the queue as it grows back. vx is its lane, vy its direction. */
  queue: 19,
  /** Part of the wreck, from the moment it happens. With a vector, it spreads out along it. */
  crash: 20,
  /** One point of a bloom turning on the same clock as its twin. vx is which point, vy and vz the bloom's centre. */
  bloom: 21,
} as const;

/** Added to a kind: it belongs to the world Auto Focus is flying over, and moves with it. */
export const IN_WORLD = 30;
export const FOCUS_A: readonly [number, number] = [0.62, -0.44];
export const FOCUS_B: readonly [number, number] = [-0.7, 0.5];
/** Where the road is blocked, and the points in each bloom. Shared with the shader. */
export const WRECK_AT = 0.4;
/** How the road incident is seen, so that its warning sign can face the viewer. */
export const CAMERA_YAW_INCIDENT = -0.62;
export const BLOOM_POINTS = 11200;
/** How far a bloom reaches, past the corners of its screen, and half of that screen, which clips it. */
export const BLOOM_REACH = 0.92;
export const BLOOM_HALF: readonly [number, number] = [0.74, 0.6];
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

/** The places that draw trips, in their own map icons, with homes sending trips to them and their demand filling up. */
function demand(): Float32Array {
  const random = sequence(4711);
  const hubs = [
    { kind: "school", x: -1.2, y: 0.28, fill: 0.92 },
    { kind: "office", x: 0, y: 0.62, fill: 0.74 },
    { kind: "shops", x: 1.2, y: 0.28, fill: 0.5 },
  ].map((hub) => ({ ...hub, icon: iconPoints(hub.kind) }));
  const homes = Array.from({ length: 58 }, (_, n) => {
    const t = n / 57;
    return { x: -1.72 + t * 3.44 + (random() - 0.5) * 0.1, y: -0.48 - random() * 0.24, order: random() };
  });
  const ring = 0.5;
  const size = 0.68;
  return formation((put, rnd) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 40;
      const hub = hubs[i % hubs.length];
      if (kind < 19) {
        // The icon, large and steady.
        const spot = hub.icon?.points[Math.floor(rnd() * hub.icon.points.length)];
        if (spot) put(i, hub.x + (spot[0] - 0.5) * size, hub.y + (0.5 - spot[1]) * size, (rnd() - 0.5) * 0.015, { tint: 0.95, kind: KIND.shimmer });
        else {
          const a = rnd() * TAU;
          put(i, hub.x + Math.cos(a) * 0.2, hub.y + Math.sin(a) * 0.2, 0, { tint: 0.95 });
        }
      } else if (kind < 22) {
        // A faint full ring, and the part demand has filled.
        const a = rnd();
        const angle = Math.PI / 2 - a * TAU;
        put(i, hub.x + Math.cos(angle) * ring, hub.y + Math.sin(angle) * ring, 0, { tint: 0.1 });
      } else if (kind < 28) {
        const a = rnd();
        const angle = Math.PI / 2 - a * TAU;
        const r = ring + (rnd() - 0.5) * 0.022;
        put(i, hub.x + Math.cos(angle) * r, hub.y + Math.sin(angle) * r, 0.01, { v: [hub.fill, 0, 0], kind: KIND.gauge, phase: a, tint: 1, hue: HUE.warm });
      } else if (kind < 32) {
        // Homes: a small roof over a small house.
        const home = homes[Math.floor(rnd() * homes.length)];
        const u = (rnd() - 0.5) * 0.06;
        const roof = rnd() < 0.42;
        const y = roof ? 0.024 + (0.03 - Math.abs(u)) * 0.8 * rnd() : rnd() * 0.024;
        put(i, home.x + (roof ? u : u * 0.72), home.y + y, 0, { tint: 0.5, kind: KIND.rise, v: [0, home.y, 0], phase: home.order * 0.3 });
      } else {
        // Trips: from a home, up and over, to the place that draws them.
        const home = homes[(i * 7) % homes.length];
        const landAt = rnd() * TAU;
        const tx = hub.x + Math.cos(landAt) * 0.1;
        const ty = hub.y + Math.sin(landAt) * 0.1;
        put(i, home.x, home.y + 0.05, (rnd() - 0.5) * 0.08, { v: [tx - home.x, ty - home.y - 0.05, 0], kind: KIND.arc, tint: 1, hue: HUE.warm });
      }
    }
  }, 13);
}

/** The whole day as a stream of traffic, swelling at each rush hour, with a mark over each peak and the hours beneath it. */
function rushHour(): Float32Array {
  const atHour = (h: number) => -1.75 + (h / 24) * 3.5;
  const axis = -0.84;
  // The peaks, and how high the stream stands at each: see rhythm() in the shader.
  const peaks = [
    { hour: 8.3, top: 0.7 },
    { hour: 17.6, top: 0.81 },
  ];
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 50;
      if (kind === 0) {
        put(i, -1.75 + random() * 3.5, axis, 0, { tint: 0.35 });
      } else if (kind < 3) {
        const hour = Math.floor(random() * 25);
        const major = hour % 6 === 0;
        put(i, atHour(hour) + (random() - 0.5) * 0.008, axis - random() * (major ? 0.09 : 0.035), 0, { tint: major ? 0.95 : 0.35 });
      } else if (kind < 5) {
        // A small caret over each peak, arriving as the stream reaches it.
        const peak = peaks[random() < 0.5 ? 0 : 1];
        const t = random() * 2 - 1;
        const y = peak.top + 0.1 + Math.abs(t) * 0.05 + (random() - 0.5) * 0.01;
        put(i, atHour(peak.hour) + t * 0.055, y, 0, { tint: 0.95, hue: HUE.warm, kind: KIND.rise, v: [0, peak.top, 0], phase: (peak.hour / 24) * 1.4 });
      } else {
        // Across the stream, evenly, so that its outline is sharp, with a little depth.
        const across = random() * 2 - 1;
        put(i, 0, 0, 0, { v: [across, 0, (random() - 0.5) * 2], kind: KIND.stream, tint: 0.6 });
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

/** Two machines, one seed: a seed between them feeds a bloom on each screen, and the two are the same point for point, at every moment. */
function twinBlooms(): Float32Array {
  const centres = [-0.94, 0.94];
  const middle = 0.2;
  const [hw, hh, corner] = [BLOOM_HALF[0], BLOOM_HALF[1], 0.14];
  // A line drawing, kept to straight runs and the corners between them.
  const outline: [number, number, number, number][] = [];
  const arc = (cx: number, cy: number, from: number) => {
    for (let n = 0; n < 8; n++) {
      const [a, b] = [from + (n / 8) * (Math.PI / 2), from + ((n + 1) / 8) * (Math.PI / 2)];
      outline.push([cx + Math.cos(a) * corner, cy + Math.sin(a) * corner, cx + Math.cos(b) * corner, cy + Math.sin(b) * corner]);
    }
  };
  for (const cx of centres) {
    const [l, r, t, b] = [cx - hw, cx + hw, middle + hh, middle - hh];
    outline.push([l + corner, t, r - corner, t], [r, t - corner, r, b + corner], [r - corner, b, l + corner, b], [l, b + corner, l, t - corner]);
    arc(r - corner, t - corner, 0);
    arc(l + corner, t - corner, Math.PI / 2);
    arc(l + corner, b + corner, Math.PI);
    arc(r - corner, b + corner, Math.PI * 1.5);
  }
  // One stands on a foot; the other is a laptop, with a keyboard below its screen.
  const low = middle - hh;
  const seedAt = low - 0.1;
  const [a, b] = centres;
  outline.push([a - 0.05, low, a - 0.05, low - 0.16], [a + 0.05, low, a + 0.05, low - 0.16], [a - 0.26, low - 0.16, a + 0.26, low - 0.16]);
  outline.push([b - 0.8, low - 0.05, b + 0.8, low - 0.05], [b - 0.84, low - 0.1, b + 0.84, low - 0.1], [b - 0.8, low - 0.05, b - 0.84, low - 0.1], [b + 0.8, low - 0.05, b + 0.84, low - 0.1]);
  const lengths = outline.map(([ax, ay, bx, by]) => Math.hypot(bx - ax, by - ay));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const counted = [0, 0];
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 40;
      if (kind < 28) {
        // Each bloom, one point at a time, so that the two hold exactly the same points.
        const side = i % 2;
        const k = counted[side]++ % BLOOM_POINTS;
        const r = Math.sqrt(k / BLOOM_POINTS) * BLOOM_REACH;
        const angle = k * 2.39996;
        put(i, centres[side] + Math.cos(angle) * r, middle + Math.sin(angle) * r, 0, { v: [k, centres[side], middle], kind: KIND.bloom, phase: 0.5, tint: 0.5 });
      } else if (kind < 34) {
        // The two machines.
        let at = random() * total;
        let line = 0;
        while (at > lengths[line] && line < outline.length - 1) at -= lengths[line++];
        const [ax, ay, bx, by] = outline[line];
        const t = at / (lengths[line] || 1);
        put(i, ax + (bx - ax) * t + (random() - 0.5) * 0.007, ay + (by - ay) * t + (random() - 0.5) * 0.007, 0, { kind: KIND.shimmer, tint: 0.5 });
      } else if (kind < 36) {
        // The seed, on the ground between them.
        const a = random() * TAU;
        const r = Math.pow(random(), 0.7) * 0.06;
        put(i, Math.cos(a) * r, seedAt + Math.sin(a) * r, 0.02, { kind: KIND.pulse, tint: 1, hue: HUE.warm, phase: 0.1 });
      } else {
        // What it sends up to each, to the heart of the bloom.
        const to = centres[i % 2];
        put(i, (random() - 0.5) * 0.04, seedAt + (random() - 0.5) * 0.04, 0.02, { v: [to, middle - seedAt, 0], kind: KIND.arc, tint: 1, hue: HUE.warm });
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

/** A weave with a wave through it, shuttles running along it and sockets on its edges. */
function weave(): Float32Array {
  const strands = 15;
  const width = 3.2;
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 20;
      const across = i % 2 === 0;
      const n = Math.floor(random() * strands);
      const v = (n - (strands - 1) / 2) * (width / strands);
      if (kind >= 18) {
        // Sockets along the edge, where applications join.
        const a = random() * TAU;
        const r = Math.sqrt(random()) * 0.045;
        const edge = Math.floor(random() * 4);
        const u = edge < 2 ? (edge === 0 ? -1 : 1) * (width / 2 + 0.1) : (edge === 2 ? -1 : 1) * (width / 2 + 0.1);
        const x = edge < 2 ? u : v;
        const z = edge < 2 ? v : u;
        put(i, x + Math.cos(a) * r, 0, z + Math.sin(a) * r, { kind: KIND.pulse, tint: 1, hue: n % 4 === 0 ? HUE.warm : HUE.ramp, phase: n / strands });
        continue;
      }
      const u = (random() - 0.5) * width;
      const phase = Math.sin(u * (strands / width) * Math.PI + n * Math.PI);
      const y = (across ? 1 : -1) * phase * 0.075 + (random() - 0.5) * 0.008;
      const thick = (random() - 0.5) * 0.095;
      if (kind >= 15) {
        // Shuttles, running the length of a strand.
        const dir = n % 2 ? 1 : -1;
        const start = -dir * width * 0.5;
        const [x, z] = across ? [start, v + thick * 0.4] : [v + thick * 0.4, start];
        const [vx, vz] = across ? [dir * width, 0] : [0, dir * width];
        put(i, x, y + 0.03, z, { v: [vx, 0, vz], kind: KIND.flow, tint: 1 });
      } else if (across) put(i, u, y, v + thick, { kind: KIND.wave, tint: 0.72 });
      else put(i, v + thick, y, u, { kind: KIND.wave, tint: 0.28 });
    }
  }, 17);
}

/** What the end of a session blows the name into: a mist, thickest in the middle, in the colour the screen comes to rest in. */
export function endMist(): Float32Array {
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const a = random() * TAU;
      const r = Math.sqrt(-2 * Math.log(1 - random() * 0.98)) * 0.62;
      put(i, Math.cos(a) * r, Math.sin(a) * r, (random() - 0.5) * 0.5, { kind: KIND.boil, tint: 0.1 + random() * 0.2, hue: HUE.ok });
    }
  }, 31);
}

/** In chapter order. The first is the cloud, and the wordmark takes its place once drawn. */
export function buildFormations(): Float32Array[] {
  return [cloud(), cityMap(), junction(), demand(), rushHour(), incident(), storm(), globe(), twinBlooms(), viewfinder(), weave()];
}
