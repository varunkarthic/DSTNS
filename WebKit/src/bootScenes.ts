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
  /** Turns about the z axis in fixed steps, vx steps a second. */
  tick: 6,
  /** Swells and fades in place. */
  pulse: 7,
  /** Appears as a front passes outward. */
  reveal: 8,
  /** Traffic in a lane, held back while its signal is red. */
  lane: 9,
  /** A signal head. Its hue says which approach it belongs to. */
  light: 10,
  /** Carried by a wave across the sheet. */
  wave: 11,
  /** Crosses the sky over the scene. */
  sun: 12,
  /** Closes in on a target, then locks. vx and vz are the target. */
  bracket: 13,
  /** Part of a cloud, turning over slowly. */
  boil: 14,
  /** A band of light passes across. */
  shimmer: 15,
  /** Flies from here to there over the curve of the globe. */
  route: 16,
} as const;

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

/** An old city seen from above: a river, a ring road, avenues and lanes, drawn from the centre out. */
function cityMap(): Float32Array {
  const random = sequence(90210);
  type Road = { points: [number, number][]; weight: number; flow: boolean };
  const roads: Road[] = [];
  const reach = 1.72;
  // Avenues run out from the old centre, each bending its own way.
  const avenues = 11;
  const spokes: { angle: number; bend: number; phase: number }[] = [];
  for (let n = 0; n < avenues; n++) spokes.push({ angle: (n / avenues) * TAU + (random() - 0.5) * 0.3, bend: 0.16 + random() * 0.2, phase: random() * TAU });
  const spokeAt = (s: { angle: number; bend: number; phase: number }, r: number): [number, number] => {
    const a = s.angle + Math.sin(r * 2.2 + s.phase) * s.bend * Math.min(1, r);
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  for (const s of spokes) {
    const points: [number, number][] = [];
    for (let r = 0.08; r <= reach; r += 0.05) points.push(spokeAt(s, r));
    roads.push({ points, weight: 3, flow: true });
  }
  // Ring roads, not quite round, broken where the river runs.
  for (const [radius, weight] of [[0.42, 2], [0.86, 3], [1.34, 2]] as const) {
    const wobble = random() * TAU;
    const points: [number, number][] = [];
    for (let k = 0; k <= 96; k++) {
      const a = (k / 96) * TAU;
      const r = radius * (1 + Math.sin(a * 3 + wobble) * 0.05);
      points.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    roads.push({ points, weight, flow: weight === 3 });
  }
  // Lanes between the avenues, short and irregular.
  for (let n = 0; n < 300; n++) {
    const s = spokes[Math.floor(random() * avenues)];
    const r = 0.22 + random() * 1.42;
    const [x, z] = spokeAt(s, r);
    const heading = s.angle + Math.PI / 2 + (random() - 0.5) * 0.7;
    const length = 0.1 + random() * 0.24;
    const points: [number, number][] = [];
    for (let t = 0; t <= 1.001; t += 0.2) {
      const curl = heading + t * (random() - 0.5) * 0.3;
      points.push([x + Math.cos(curl) * length * t, z + Math.sin(curl) * length * t]);
    }
    roads.push({ points, weight: 1.1, flow: false });
  }
  const lengths = roads.map((road) => road.points.reduce((sum, p, k) => (k ? sum + Math.hypot(p[0] - road.points[k - 1][0], p[1] - road.points[k - 1][1]) : 0), 0) * road.weight);
  const total = lengths.reduce((a, b) => a + b, 0);
  const pick = (value: number) => {
    let left = value * total;
    for (let k = 0; k < roads.length; k++) {
      left -= lengths[k];
      if (left <= 0) return roads[k];
    }
    return roads[0];
  };
  const riverAt = (t: number): [number, number] => [-1.9 + t * 3.8, 0.34 + Math.sin(t * 5.2 + 0.6) * 0.34 + (t - 0.5) * 0.5];
  return formation((put, rnd) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 20;
      if (kind < 3) {
        // The river: two soft banks, with the water moving between them.
        const t = rnd();
        const [x, z] = riverAt(t);
        const side = kind === 0 ? -1 : kind === 1 ? 1 : (rnd() - 0.5) * 1.4;
        const nz = z + side * 0.075;
        if (kind === 2) {
          const [nx2, nz2] = riverAt(Math.min(1, t + 0.12));
          put(i, x, -0.01, nz, { v: [nx2 - x, 0, nz2 - z], kind: KIND.flow, tint: 0.85, hue: HUE.ramp });
        } else put(i, x, -0.01, nz, { tint: 0.55, kind: KIND.reveal, phase: Math.hypot(x, nz) / 2.3 });
        continue;
      }
      const road = pick(rnd());
      const at = rnd() * (road.points.length - 1);
      const k = Math.min(road.points.length - 2, Math.floor(at));
      const f = at - k;
      const x = road.points[k][0] + (road.points[k + 1][0] - road.points[k][0]) * f;
      const z = road.points[k][1] + (road.points[k + 1][1] - road.points[k][1]) * f;
      if (kind < 5 && road.flow) {
        const a = road.points[Math.max(0, k - 2)];
        const b = road.points[Math.min(road.points.length - 1, k + 3)];
        put(i, x, 0.01, z, { v: [(b[0] - a[0]) * 1.2, 0, (b[1] - a[1]) * 1.2], kind: KIND.flow, tint: 1 });
        continue;
      }
      put(i, x + (rnd() - 0.5) * 0.006, 0, z + (rnd() - 0.5) * 0.006, { kind: KIND.reveal, phase: Math.hypot(x, z) / 2.3, tint: road.weight >= 2 ? 0.7 : 0.22 });
    }
  }, 12);
}

/** One junction, close up: stop lines, lanes of waiting cars, and the lights that release them. */
function junction(): Float32Array {
  const half = 0.34;
  const span = 1.9;
  // Each lane enters at the far end, crosses the junction and leaves by the other.
  const lanes = [
    { x: 0.17, z: -span, dx: 0, dz: 1 },
    { x: -0.17, z: span, dx: 0, dz: -1 },
    { x: -span, z: -0.17, dx: 1, dz: 0 },
    { x: span, z: 0.17, dx: -1, dz: 0 },
  ];
  const cars = 11;
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 40;
      if (kind < 10) {
        // The road's edges and the centre line, broken at the crossing.
        const along = (random() * 2 - 1) * span;
        const across = kind < 4 ? half : kind < 8 ? -half : 0;
        if (Math.abs(along) < half) {
          i % 2 ? put(i, half * (random() < 0.5 ? 1 : -1) * 1.04, 0, half * (random() < 0.5 ? 1 : -1) * 1.04, { tint: 0.12 }) : put(i, across, 0, along * 3, { tint: 0.08 });
          continue;
        }
        const dashed = across === 0 && Math.floor(Math.abs(along) * 12) % 2 === 0;
        const tint = across === 0 ? (dashed ? 0.02 : 0.22) : 0.3;
        if (i % 2) put(i, across + (random() - 0.5) * 0.006, 0, along, { tint });
        else put(i, along, 0, across + (random() - 0.5) * 0.006, { tint });
      } else if (kind < 13) {
        // Stop lines.
        const [lx, lz] = [[1, -1], [-1, 1], [-1, -1], [1, 1]][i % 4];
        const t = random() * half;
        if (i % 4 < 2) put(i, (lx * t), 0.002, lz * (half + 0.03), { tint: 0.8 });
        else put(i, lz * (half + 0.03), 0.002, lx * t, { tint: 0.8 });
      } else if (kind < 37) {
        // Cars: each a small block, the whole car sharing one phase, with tail lights.
        const lane = lanes[i % 4];
        const car = (i >> 2) % cars;
        const phase = car / cars;
        const long = (random() - 0.5) * 0.14;
        const wide = (random() - 0.5) * 0.075;
        const tail = long < -0.052;
        const x = lane.x + (lane.dx ? long * lane.dx : wide);
        const z = lane.z + (lane.dz ? long * lane.dz : wide);
        put(i, x, 0.018 + random() * 0.02, z, { v: [lane.dx * span * 2, 0, lane.dz * span * 2], kind: KIND.lane, phase, tint: 0.95, hue: tail ? HUE.danger : HUE.ramp });
      } else {
        // The lights, one on each corner, facing their own approach.
        const corner = i % 4;
        const north = corner < 2;
        const sx = corner === 0 || corner === 3 ? 1 : -1;
        const sz = corner < 2 ? -sx : sx;
        const a = random() * TAU;
        const r = Math.sqrt(random()) * 0.042;
        put(i, sx * (half + 0.13) + Math.cos(a) * r, 0.06, sz * (half + 0.13) + Math.sin(a) * r, { kind: KIND.light, tint: 1, hue: north ? HUE.signalNorth : HUE.signalEast });
      }
    }
  }, 21);
}

/** A skyline rising, with windows lit, and trips arcing in to the places that draw them. */
function skyline(): Float32Array {
  const random = sequence(4711);
  const ground = -0.72;
  interface Tower { x: number; z: number; w: number; d: number; h: number; order: number; lean: number }
  const towers: Tower[] = [];
  // Rings around a centre, so that it is a town and not a grid, tall in the middle.
  for (let n = 0; n < 58; n++) {
    const r = Math.pow(n / 58, 0.62) * 1.55;
    const a = n * 2.399963;
    const fall = Math.exp(-r * r * 1.5);
    towers.push({ x: Math.cos(a) * r, z: Math.sin(a) * r * 0.82, w: 0.065 + random() * 0.05, d: 0.065 + random() * 0.05, h: 0.14 + fall * (0.82 + random() * 0.72) + random() * 0.14, order: r / 1.55, lean: random() });
  }
  const weights = towers.map((t) => t.h * (t.w + t.d));
  const total = weights.reduce((a, b) => a + b, 0);
  const pickTower = (value: number) => {
    let left = value * total;
    for (let k = 0; k < towers.length; k++) {
      left -= weights[k];
      if (left <= 0) return k;
    }
    return 0;
  };
  const hubs = [towers[1], towers[4], towers[9]];
  return formation((put, rnd) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 25;
      if (kind >= 22) {
        // Trips: rising from anywhere in town and landing on a hub.
        const hub = hubs[i % hubs.length];
        const a = rnd() * TAU;
        const r = 0.6 + rnd() * 1.1;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r * 0.82;
        put(i, x, ground, z, { v: [hub.x - x, hub.h, hub.z - z], kind: KIND.arc, tint: 1, hue: HUE.warm });
        continue;
      }
      if (kind === 21) {
        // The hubs themselves, marked.
        const hub = hubs[i % hubs.length];
        const a = rnd() * TAU;
        const r = Math.sqrt(rnd()) * 0.05;
        put(i, hub.x + Math.cos(a) * r, ground + hub.h + 0.05, hub.z + Math.sin(a) * r, { kind: KIND.pulse, tint: 1, hue: HUE.warm });
        continue;
      }
      if (kind === 20) {
        // The ground the town stands on, in a soft disc.
        const a = rnd() * TAU;
        const r = Math.sqrt(rnd()) * 1.75;
        put(i, Math.cos(a) * r, ground, Math.sin(a) * r * 0.82, { tint: 0.04 });
        continue;
      }
      const index = pickTower(rnd());
      const t = towers[index];
      const phase = t.order * 0.85;
      const v: [number, number, number] = [0, ground, 0];
      const shape = rnd();
      if (shape < 0.34) {
        // Its corners, which are what make it read as a building.
        const sx = rnd() < 0.5 ? -1 : 1;
        const sz = rnd() < 0.5 ? -1 : 1;
        put(i, t.x + sx * t.w, ground + rnd() * t.h, t.z + sz * t.d, { v, kind: KIND.rise, phase, tint: 0.46 });
      } else if (shape < 0.5) {
        // The roof's outline.
        const along = rnd() * 2 - 1;
        const flip = rnd() < 0.5;
        const sign = rnd() < 0.5 ? -1 : 1;
        put(i, t.x + (flip ? along * t.w : sign * t.w), ground + t.h, t.z + (flip ? sign * t.d : along * t.d), { v, kind: KIND.rise, phase, tint: 0.85 });
      } else {
        // Lit windows in rows. A dark window is simply not drawn.
        const floors = Math.max(2, Math.round(t.h / 0.05));
        const columns = 3;
        let floor = 0;
        let column = 0;
        for (let tries = 0; tries < 8; tries++) {
          floor = Math.floor(rnd() * floors);
          column = Math.floor(rnd() * columns);
          if ((index * 7 + floor * 13 + column * 5) % 5 < 3) break;
        }
        const y = ((floor + 0.5) / floors) * t.h;
        const across = ((column + 0.5) / columns) * 2 - 1;
        const face = Math.floor(rnd() * 4);
        const x = face < 2 ? t.x + across * t.w : t.x + (face === 2 ? t.w : -t.w);
        const z = face < 2 ? t.z + (face === 0 ? t.d : -t.d) : t.z + across * t.d;
        put(i, x + (rnd() - 0.5) * 0.012, ground + y + (rnd() - 0.5) * 0.012, z + (rnd() - 0.5) * 0.012, { v, kind: KIND.rise, phase, tint: 0.95 });
      }
    }
  }, 13);
}

/** The day's rhythm in stacked bars, rising as the sun crosses them. */
function rushHour(): Float32Array {
  const hours = 24;
  const rhythm = (h: number) => 0.1 + 0.98 * Math.exp(-((h - 8.3) ** 2) / 3.2) + 1.2 * Math.exp(-((h - 17.6) ** 2) / 4.2) + 0.32 * Math.exp(-((h - 12.8) ** 2) / 14);
  const base = -0.62;
  const levels = 22;
  const unit = 1.32 / levels;
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 40;
      if (kind === 0) {
        // The axis, and a tick for each hour.
        const x = (random() - 0.5) * 3.2;
        put(i, x, base - 0.03, (random() - 0.5) * 0.02, { tint: 0.35 });
      } else if (kind === 1) {
        const hour = Math.floor(random() * hours);
        put(i, (hour - (hours - 1) / 2) * 0.132, base - 0.05 - random() * 0.03, 0, { tint: hour % 6 === 0 ? 0.9 : 0.3 });
      } else if (kind < 4) {
        // The sun.
        const a = random() * TAU;
        const r = Math.pow(random(), 0.6) * 0.085;
        put(i, Math.cos(a) * r, Math.sin(a) * r, 0, { kind: KIND.sun, tint: 1, hue: HUE.warm });
      } else {
        const hour = Math.floor(random() * hours);
        const height = rhythm(hour);
        const stack = Math.max(1, Math.round(height / unit));
        const level = Math.floor(random() * stack);
        const y = base + (level + 0.2 + random() * 0.6) * unit;
        const x = (hour - (hours - 1) / 2) * 0.132 + (random() - 0.5) * 0.098;
        const z = (random() - 0.5) * 0.3;
        const busy = (level * unit) / 1.32;
        put(i, x, y, z, { v: [0, base, 0], kind: KIND.rise, phase: hour / hours, tint: 0.3 + busy * 0.7, hue: busy > 0.68 ? HUE.warm : HUE.ramp });
      }
    }
  }, 22);
}

/** A dial that moves in whole steps, with rings at different rates that all step together. */
function dial(): Float32Array {
  const radius = 1.18;
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 20;
      if (kind < 6) {
        // The rim.
        const a = random() * TAU;
        const r = radius + (random() - 0.5) * 0.018;
        put(i, Math.cos(a) * r, Math.sin(a) * r, (random() - 0.5) * 0.04, { tint: 0.32 });
      } else if (kind < 11) {
        // Ticks, longer on the twelve.
        const tick = Math.floor(random() * 60);
        const major = tick % 5 === 0;
        const a = (tick / 60) * TAU;
        const r = radius - 0.03 - random() * (major ? 0.13 : 0.05);
        const off = (random() - 0.5) * (major ? 0.022 : 0.009);
        put(i, Math.cos(a) * r - Math.sin(a) * off, Math.sin(a) * r + Math.cos(a) * off, 0, { tint: major ? 1 : 0.4 });
      } else if (kind < 16) {
        // Rings of beads, each stepping at its own rate: every speed, the same steps.
        const ring = i % 3;
        const beads = [6, 9, 12][ring];
        const bead = Math.floor(random() * beads);
        const a = (bead / beads) * TAU;
        const r = [0.42, 0.62, 0.82][ring];
        const blob = random() * TAU;
        const size = Math.sqrt(random()) * 0.03;
        put(i, Math.cos(a) * r + Math.cos(blob) * size, Math.sin(a) * r + Math.sin(blob) * size, 0.01, { v: [[1, 2, 5][ring], 0, 0], kind: KIND.tick, tint: 0.75 + ring * 0.12 });
      } else if (kind < 19) {
        // The hand, stepping once a second.
        const along = random() * 0.98;
        put(i, (random() - 0.5) * 0.016, along, 0.03, { v: [1, 0, 0], kind: KIND.tick, tint: 1, hue: HUE.warm });
      } else {
        // The centre.
        const a = random() * TAU;
        const r = Math.sqrt(random()) * 0.05;
        put(i, Math.cos(a) * r, Math.sin(a) * r, 0.03, { kind: KIND.pulse, tint: 1, hue: HUE.warm });
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

/** Two seeds, two trees, and every branch the same: one seed always grows the same day. */
function twinTrees(): Float32Array {
  const random = sequence(2718);
  interface Limb { ax: number; ay: number; az: number; bx: number; by: number; bz: number; depth: number }
  const limbs: Limb[] = [];
  const grow = (x: number, y: number, z: number, turn: number, tilt: number, length: number, depth: number) => {
    const bx = x + Math.sin(tilt) * Math.cos(turn) * length;
    const by = y + Math.cos(tilt) * length;
    const bz = z + Math.sin(tilt) * Math.sin(turn) * length;
    limbs.push({ ax: x, ay: y, az: z, bx, by, bz, depth });
    if (depth >= 6) return;
    const branches = depth < 2 ? 2 : random() < 0.7 ? 2 : 3;
    for (let k = 0; k < branches; k++) {
      grow(bx, by, bz, turn + (k / branches) * TAU + random() * 1.1, Math.min(1.25, tilt + 0.28 + random() * 0.26), length * (0.68 + random() * 0.1), depth + 1);
    }
  };
  grow(0, -0.95, 0, 0, 0.02, 0.5, 0);
  // Weighted by how thick each limb should look.
  const thick = limbs.map((limb) => Math.hypot(limb.bx - limb.ax, limb.by - limb.ay, limb.bz - limb.az) * (7 - limb.depth));
  const total = thick.reduce((a, b) => a + b, 0);
  const cumulative: number[] = [];
  thick.reduce((sum, value, k) => (cumulative[k] = sum + value), 0);
  const limbAt = (value: number) => {
    let low = 0;
    let high = limbs.length - 1;
    const target = value * total;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] < target) low = mid + 1;
      else high = mid;
    }
    return limbs[low];
  };
  const gap = 0.92;
  return formation((put, rnd) => {
    for (let i = 0; i < COUNT; i++) {
      const side = i % 2 ? 1 : -1;
      const kind = i % 25;
      if (kind === 24 || kind === 23) {
        // The seed itself.
        const a = rnd() * TAU;
        const r = Math.pow(rnd(), 0.6) * 0.07;
        put(i, side * gap + Math.cos(a) * r, -0.98 + Math.sin(a) * r * 0.7, 0, { kind: KIND.pulse, tint: 1, hue: HUE.warm });
        continue;
      }
      if (kind === 22) {
        // Ground beneath them both, one line.
        put(i, (rnd() - 0.5) * 3.4, -1.02, (rnd() - 0.5) * 0.04, { tint: 0.22 });
        continue;
      }
      const limb = limbAt(rnd());
      const t = rnd();
      const spread = 0.012 * (7 - limb.depth) * 0.45;
      const x = limb.ax + (limb.bx - limb.ax) * t + (rnd() - 0.5) * spread;
      const y = limb.ay + (limb.by - limb.ay) * t + (rnd() - 0.5) * spread;
      const z = limb.az + (limb.bz - limb.az) * t + (rnd() - 0.5) * spread;
      const tip = limb.depth >= 5;
      put(i, x + side * gap, y, z, { kind: KIND.reveal, phase: ((limb.depth + t) / 7) * 0.92, tint: tip ? 0.95 : 0.35 + limb.depth * 0.08 });
    }
  }, 26);
}

/** A viewfinder hunting across a quiet field, and locking on to the one thing happening. */
function viewfinder(): Float32Array {
  const target: [number, number] = [0.42, -0.26];
  const half = 0.5;
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const kind = i % 20;
      if (kind < 7) {
        // The field: scattered points, in soft contour lines rather than streets.
        const a = random() * TAU;
        const r = Math.sqrt(random()) * 2;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const contour = Math.sin(x * 2.1 + Math.sin(z * 1.7) * 1.6) + Math.sin(z * 2.4 - x * 0.7);
        const onLine = Math.abs((contour * 3) % 1) < 0.1;
        put(i, x, 0, z, { tint: onLine ? 0.2 : 0.02 });
      } else if (kind < 13) {
        // The frame's four corners.
        const sx = i % 2 ? 1 : -1;
        const sz = (i >> 1) % 2 ? 1 : -1;
        const along = random() * 0.17;
        const flip = (i >> 2) % 2;
        const x = target[0] + sx * (flip ? half : half - along);
        const z = target[1] + sz * (flip ? half - along : half);
        put(i, x + (random() - 0.5) * 0.012, 0.03, z + (random() - 0.5) * 0.012, { v: [target[0], 0, target[1]], kind: KIND.bracket, tint: 1, phase: 0 });
      } else if (kind < 14) {
        // Crosshair ticks on the frame's sides.
        const side = i % 4;
        const t = random() * 0.085;
        const x = target[0] + (side === 0 ? half - t : side === 1 ? -half + t : 0);
        const z = target[1] + (side === 2 ? half - t : side === 3 ? -half + t : 0);
        put(i, x, 0.03, z, { v: [target[0], 0, target[1]], kind: KIND.bracket, tint: 0.8, phase: 0 });
      } else if (kind < 16) {
        // The event itself.
        const a = random() * TAU;
        const r = Math.sqrt(random()) * 0.055;
        put(i, target[0] + Math.cos(a) * r, 0.02, target[1] + Math.sin(a) * r, { kind: KIND.pulse, tint: 1, hue: HUE.danger, phase: 0.25 });
      } else {
        // Rings going out from it.
        const a = random() * TAU;
        put(i, target[0], 0.015, target[1], { v: [Math.cos(a) * 0.46, 0, Math.sin(a) * 0.46], kind: KIND.ring, tint: 0.9, hue: HUE.danger, phase: Math.floor(random() * 3) / 3 });
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
        const edge = i % 4;
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

/** In chapter order. The first is the cloud, and the wordmark takes its place once drawn. */
export function buildFormations(): Float32Array[] {
  return [cloud(), cityMap(), junction(), skyline(), rushHour(), dial(), storm(), globe(), twinTrees(), viewfinder(), weave()];
}
