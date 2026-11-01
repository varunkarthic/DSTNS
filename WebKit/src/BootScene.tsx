// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef, useState } from "react";
import { LOGO_SVG } from "./logoAsset";
import { stepSpring } from "./motion";

/**
 * The start-up film.
 *
 * A single cloud of particles, drawn in three dimensions, keeps re-forming into what
 * DSTNS does: the wordmark, a street network, a city, traffic, weather, a world of
 * seeds and the weave of WebFabric. It plays for as long as the system takes to load,
 * and is not a measure of it: progress is reported separately, from what the core says.
 *
 * All the movement happens in the vertex shader, so the page spends one draw call on
 * it. Without WebGL2 the captions still play over the plain background.
 */

const COUNT = 24000;
const STRIDE = 7; // x y z, vx vy vz, tint
const HOLD_S = 3.6;
const MORPH = { k: 11, c: 5.6 };
// Going to and from the logo and the map are timed, not sprung: an ease in and out has no
// sudden start, which is what makes particles leaving a shape feel soft.
const DISSOLVE_S = 2.1;
const LAND_S = 1.35;
const easeInOut = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const CAMERA = { k: 9, c: 6 };
/** How long the handover takes. The surface stays mounted this long. */
export const LANDING_MS = 2300;
/** A new world: how long the old one takes to leave, before the particles recollect. */
export const REJOIN_AT_MS = 5800;
/** Whether this browser can draw the film at all. */
export const filmAvailable = () => typeof WebGL2RenderingContext !== "undefined";
/** And how long before a ready world may interrupt them forming the name again. */
export const REJOIN_MIN_MS = REJOIN_AT_MS + 2800;
// With nothing to do, the network rests dimly, out of the way of what is on screen.
const REST_DIM = 0.14;
// How long the particles stand on the logo before letting go, while it fades.
const DISSOLVE_HOLD_S = 0.6;

// One or two words and one short line, with no commas. Nothing here may suggest it is
// happening now or for real: it is a simulation, and these are its features.
export const FILM_CHAPTERS: readonly { label: string; title: string; text: string }[] = [
  { label: "Deterministic Spatiotemporal Transport Network Simulator", title: "Traffic simulation", text: "A full simulated day in one district." },
  { label: "Networks", title: "Mapped streets", text: "Every district comes from OpenStreetMap." },
  { label: "Signals", title: "Signal timing", text: "Every junction runs its own schedule." },
  { label: "Demand", title: "Travel demand", text: "Every school and office draws trips." },
  { label: "Rhythm", title: "Rush hour", text: "Modelled demand rises and falls through the day." },
  { label: "Physics", title: "Fixed steps", text: "One-second steps at any playback speed." },
  { label: "Environment", title: "Simulated weather", text: "Rain cells cross the district and roads flood." },
  { label: "Places", title: "Cities worldwide", text: "A seed chooses the district." },
  { label: "Reproducibility", title: "One seed", text: "The same day on any machine." },
  { label: "Camera", title: "Auto Focus", text: "The camera follows what matters." },
  { label: "Extensions", title: "WebFabric", text: "Connect your own applications." },
];

interface Camera { yaw: number; pitch: number; distance: number; spin: number }
const CAMERAS: Camera[] = [
  { yaw: 0, pitch: 0, distance: 3.1, spin: 0.012 },
  { yaw: 0.5, pitch: 0.95, distance: 3.5, spin: 0.05 },
  { yaw: -0.5, pitch: 0.55, distance: 2.8, spin: 0.05 },
  { yaw: -0.7, pitch: 0.62, distance: 3.2, spin: 0.06 },
  { yaw: 0.3, pitch: 0.24, distance: 2.9, spin: -0.03 },
  { yaw: 0.9, pitch: 0.82, distance: 2.9, spin: -0.05 },
  { yaw: -0.3, pitch: 0.34, distance: 3.3, spin: 0.04 },
  { yaw: 0.3, pitch: -0.1, distance: 2.9, spin: -0.03 },
  { yaw: 0, pitch: 0.2, distance: 3.2, spin: 0.12 },
  { yaw: 0.25, pitch: 1.0, distance: 3.1, spin: 0.03 },
  { yaw: 0.6, pitch: 0.72, distance: 3.0, spin: -0.04 },
];

/** A fixed sequence, so the film is the same each time it is seen. */
function sequence(seed = 48271) {
  let state = seed;
  return () => (state = (state * 48271) % 2147483647) / 2147483647;
}

type Put = (i: number, x: number, y: number, z: number, vx?: number, vy?: number, vz?: number, tint?: number) => void;
function formation(fill: (put: Put, random: () => number) => void, seed: number): Float32Array {
  const data = new Float32Array(COUNT * STRIDE);
  const put: Put = (i, x, y, z, vx = 0, vy = 0, vz = 0, tint = 0) => data.set([x, y, z, vx, vy, vz, tint], i * STRIDE);
  fill(put, sequence(seed));
  return data;
}

type Segment = [number, number, number, number];
function streets(): { roads: Segment[]; cells: [number, number, number][] } {
  const random = sequence(90210);
  const span = 1.7;
  const steps = 11;
  const size = (span * 2) / steps;
  const at: [number, number][][] = [];
  for (let i = 0; i <= steps; i++) {
    at[i] = [];
    for (let j = 0; j <= steps; j++) at[i][j] = [-span + i * size + (random() - 0.5) * size * 0.5, -span + j * size + (random() - 0.5) * size * 0.5];
  }
  const roads: Segment[] = [];
  const cells: [number, number, number][] = [];
  for (let i = 0; i <= steps; i++)
    for (let j = 0; j <= steps; j++) {
      const [x, z] = at[i][j];
      if (i < steps && random() > 0.14) roads.push([x, z, at[i + 1][j][0], at[i + 1][j][1]]);
      if (j < steps && random() > 0.14) roads.push([x, z, at[i][j + 1][0], at[i][j + 1][1]]);
      if (i < steps && j < steps) cells.push([x + size / 2, z + size / 2, size * 0.34]);
    }
  return { roads, cells };
}

function buildFormations(): Float32Array[] {
  const { roads, cells } = streets();
  const onRoad = (random: () => number) => {
    const [ax, az, bx, bz] = roads[Math.floor(random() * roads.length)];
    const t = random();
    return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, ax, az, bx, bz };
  };
  const scatter = (put: Put, i: number, random: () => number) => {
    const a = random() * Math.PI * 2;
    const r = 1.2 + random() * 1.4;
    put(i, Math.cos(a) * r, (random() - 0.5) * 2, Math.sin(a) * r);
  };
  return [
    // The wordmark, until its drawing arrives: a soft cloud.
    formation((put, random) => {
      for (let i = 0; i < COUNT; i++) scatter(put, i, random);
    }, 11),
    // Streets: the roads, with junctions picked out.
    formation((put, random) => {
      for (let i = 0; i < COUNT; i++) {
        const road = onRoad(random);
        if (i % 9 === 0) put(i, road.ax + (random() - 0.5) * 0.014, 0, road.az + (random() - 0.5) * 0.014, 0, 0, 0, 1);
        else put(i, road.x, (random() - 0.5) * 0.006, road.z, 0, 0, 0, 0.18);
      }
    }, 12),
    // Signals: traffic waiting at each junction, thinning away from the stop line, with
    // the rest of the road moving and one small light over the junction.
    formation((put, random) => {
      for (let i = 0; i < COUNT; i++) {
        const [ax, az, bx, bz] = roads[Math.floor(random() * roads.length)];
        const kind = i % 10;
        if (kind < 2) {
          const t = random();
          put(i, ax + (bx - ax) * t, 0, az + (bz - az) * t, 0, 0, 0, 0.1);
        } else if (kind < 7) {
          // A queue: dense at the stop line, and thinning as it goes back along the road.
          const back = Math.pow(random(), 2.4) * 0.42;
          const towardsB = i % 2 === 0;
          const t = towardsB ? 1 - 0.035 - back : 0.035 + back;
          const side = (random() - 0.5) * 0.012;
          put(i, ax + (bx - ax) * t + side, 0.012, az + (bz - az) * t - side, 0, 0, 0, 0.8 - back);
        } else if (kind < 9) {
          // Traffic that has the green, moving through.
          if (i % 2) put(i, ax, 0.012, az, bx - ax, 0, bz - az, 0.55);
          else put(i, bx, 0.012, bz, ax - bx, 0, az - bz, 0.55);
        } else {
          // The light, small and steady, just above the junction.
          const [x, z] = i % 20 < 10 ? [ax, az] : [bx, bz];
          const a = random() * Math.PI * 2;
          const r = Math.pow(random(), 1.5) * 0.011;
          put(i, x + Math.cos(a) * r, 0.05 + (random() - 0.5) * 0.012, z + Math.sin(a) * r, 0, 0, 0, 1);
        }
      }
    }, 21),
    // A city: blocks standing between the roads.
    formation((put, random) => {
      const heights = cells.map(() => 0.1 + Math.pow(random(), 2.6) * 0.9);
      for (let i = 0; i < COUNT; i++) {
        if (i % 4 === 0) {
          const road = onRoad(random);
          put(i, road.x, 0, road.z, 0, 0, 0, 0.1);
          continue;
        }
        const index = Math.floor(random() * cells.length);
        const [cx, cz, half] = cells[index];
        const h = heights[index];
        const side = Math.floor(random() * 4);
        const along = (random() - 0.5) * 2 * half;
        const up = random() < 0.25 ? h : random() * h;
        const top = up === h;
        const x = top ? cx + (random() - 0.5) * 2 * half : cx + (side < 2 ? along : side === 2 ? half : -half);
        const z = top ? cz + (random() - 0.5) * 2 * half : cz + (side >= 2 ? along : side === 0 ? half : -half);
        put(i, x, up, z, 0, 0, 0, top ? 0.9 : 0.25 + (up / h) * 0.3);
      }
    }, 13),
    // The day's rhythm: an hour to a column, with its two peaks.
    formation((put, random) => {
      const hours = 24;
      const rhythm = (h: number) => 0.14 + 0.95 * Math.exp(-((h - 8.3) ** 2) / 3.4) + 1.15 * Math.exp(-((h - 17.6) ** 2) / 4.6) + 0.38 * Math.exp(-((h - 12.8) ** 2) / 14);
      for (let i = 0; i < COUNT; i++) {
        const hour = Math.floor(random() * hours);
        const height = rhythm(hour);
        const up = random() < 0.2 ? height : random() * height;
        const x = (hour - (hours - 1) / 2) * 0.125 + (random() - 0.5) * 0.085;
        const z = (random() - 0.5) * 0.5;
        put(i, x, up - 0.55, z, 0, 0, 0, Math.min(1, 0.16 + (up / 1.25) * 0.95));
      }
    }, 22),
    // Traffic: the roads faint, and vehicles running along them.
    formation((put, random) => {
      for (let i = 0; i < COUNT; i++) {
        const road = onRoad(random);
        if (i % 3 === 0) put(i, road.x, 0, road.z, 0, 0, 0, 0.08);
        else if (random() < 0.5) put(i, road.ax, 0.012, road.az, road.bx - road.ax, 0, road.bz - road.az, 1);
        else put(i, road.bx, 0.012, road.bz, road.ax - road.bx, 0, road.az - road.bz, 1);
      }
    }, 14),
    // Weather: rain falling from cells, onto roads and the rings it leaves there.
    formation((put, random) => {
      const storms = [[-0.7, -0.4, 0.8], [0.8, 0.5, 0.65], [0.1, 1.0, 0.45]];
      for (let i = 0; i < COUNT; i++) {
        const [cx, cz, radius] = storms[i % storms.length];
        const a = random() * Math.PI * 2;
        if (i % 2 === 0) {
          const r = Math.sqrt(random()) * radius;
          put(i, cx + Math.cos(a) * r, 1.15 + random() * 0.3, cz + Math.sin(a) * r, 0, -1.3, 0, 0.75);
        } else if (i % 4 === 1) {
          const r = radius * (0.35 + 0.65 * Math.floor(random() * 3) / 2);
          put(i, cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r, 0, 0, 0, 0.55);
        } else {
          const road = onRoad(random);
          put(i, road.x, 0, road.z, 0, 0, 0, 0.12);
        }
      }
    }, 15),
    // Cities: filled in once its typeface has loaded.
    formation((put, random) => {
      for (let i = 0; i < COUNT; i++) scatter(put, i, random);
    }, 24),
    // Seeds: a world, with one district drawing the eye.
    formation((put, random) => {
      const golden = Math.PI * (3 - Math.sqrt(5));
      const radius = 1.18;
      for (let i = 0; i < COUNT; i++) {
        const y = 1 - (2 * (i + 0.5)) / COUNT;
        const r = Math.sqrt(1 - y * y);
        const a = i * golden;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const near = Math.hypot(x - 0.42, y - 0.5, z - 0.75);
        if (near < 0.3) put(i, x * radius, y * radius, z * radius, 0, 0, 0, 1);
        else put(i, x * radius, y * radius, z * radius, 0, 0, 0, random() < 0.05 ? 0.7 : 0.14);
      }
    }, 16),
    // Auto Focus: a frame closing on an event, with the rings of its footprint.
    formation((put, random) => {
      const half = 0.62;
      for (let i = 0; i < COUNT; i++) {
        const kind = i % 10;
        if (kind < 4) {
          const road = onRoad(random);
          put(i, road.x, 0, road.z, 0, 0, 0, 0.1);
        } else if (kind < 7) {
          // Four corners of the frame.
          const sx = i % 2 ? 1 : -1;
          const sz = (i >> 1) % 2 ? 1 : -1;
          const along = random() * 0.26;
          const flip = (i >> 2) % 2;
          const x = sx * (flip ? half : half - along);
          const z = sz * (flip ? half - along : half);
          put(i, x + (random() - 0.5) * 0.012, 0.03, z + (random() - 0.5) * 0.012, 0, 0, 0, 1);
        } else {
          const a = random() * Math.PI * 2;
          const r = 0.42 + (random() - 0.5) * 0.02;
          put(i, Math.cos(a) * r, 0.02, Math.sin(a) * r, -Math.cos(a) * 0.36, 0, -Math.sin(a) * 0.36, 0.8);
        }
      }
    }, 25),
    // WebFabric: strands passing over and under one another.
    formation((put, random) => {
      const strands = 15;
      for (let i = 0; i < COUNT; i++) {
        const across = i % 2 === 0;
        const n = Math.floor(random() * strands);
        const u = (random() - 0.5) * 3.2;
        const v = (n - (strands - 1) / 2) * (3.2 / strands);
        const phase = Math.sin(u * (strands / 3.2) * Math.PI + n * Math.PI);
        const y = (across ? 1 : -1) * phase * 0.075 + (random() - 0.5) * 0.008;
        const width = (random() - 0.5) * 0.09;
        if (across) put(i, u, y, v + width, 0, 0, 0, 0.72);
        else put(i, v + width, y, u, 0, 0, 0, 0.3);
      }
    }, 17),
  ];
}

/** The wordmark as points, sampled from its own drawing, so it can never differ from the logo. */
function wordmarkFormation(image: HTMLImageElement): { data: Float32Array; uv: Float32Array } | null {
  const width = 720;
  const height = Math.round((width * (image.naturalHeight || 1)) / (image.naturalWidth || 1));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, width, height);
  const alpha = ctx.getImageData(0, 0, width, height).data;
  const inside: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (alpha[(y * width + x) * 4 + 3] > 120) inside.push(x, y);
  if (!inside.length) return null;
  // Where each particle sits within the drawing, so the same particle can also stand on
  // the logo as it appears on the page.
  const uv = new Float32Array(COUNT * 2);
  const data = formation((put, random) => {
    const scale = 2.1 / width;
    for (let i = 0; i < COUNT; i++) {
      const pick = Math.floor(random() * (inside.length / 2)) * 2;
      const x = inside[pick] + random();
      const y = inside[pick + 1] + random();
      uv[i * 2] = x / width;
      uv[i * 2 + 1] = y / height;
      put(i, (x - width / 2) * scale, (height / 2 - y) * scale, (random() - 0.5) * 0.05, 0, 0, 0, random() < 0.12 ? 0.8 : 0.3);
    }
  }, 18);
  return { data, uv };
}

/**
 * Where the particles land: along the roads, exactly where the map has drawn them, in
 * clip space. x, y and a tint for each. Longer roads get more particles.
 */
export function landingPoints(roads: readonly { x_m: number; y_m: number }[][], view: { x: number; y: number; scale: number }, box: { left: number; top: number }, width: number, height: number, count = COUNT): Float32Array | null {
  const lengths: number[] = [];
  let total = 0;
  for (const road of roads) {
    let length = 0;
    for (let i = 1; i < road.length; i++) length += Math.hypot(road[i].x_m - road[i - 1].x_m, road[i].y_m - road[i - 1].y_m);
    lengths.push(length);
    total += length;
  }
  if (!(total > 0) || !(width > 0) || !(height > 0)) return null;
  const random = sequence(5150);
  const data = new Float32Array(count * 3);
  let road = 0;
  let passed = lengths[0];
  for (let i = 0; i < count; i++) {
    const at = ((i + 0.5) / count) * total;
    while (at > passed && road < roads.length - 1) passed += lengths[++road];
    const points = roads[road];
    let left = at - (passed - lengths[road]);
    let segment = 1;
    for (; segment < points.length - 1; segment++) {
      const piece = Math.hypot(points[segment].x_m - points[segment - 1].x_m, points[segment].y_m - points[segment - 1].y_m);
      if (left <= piece) break;
      left -= piece;
    }
    const p = points[segment - 1] ?? points[0];
    const q = points[segment] ?? p;
    const piece = Math.hypot(q.x_m - p.x_m, q.y_m - p.y_m) || 1;
    const t = Math.min(1, left / piece);
    const x = box.left + view.x + (p.x_m + (q.x_m - p.x_m) * t) * view.scale;
    const y = box.top + view.y - (p.y_m + (q.y_m - p.y_m) * t) * view.scale;
    data.set([(x / width) * 2 - 1, 1 - (y / height) * 2, 0.45 + random() * 0.55], i * 3);
  }
  return data;
}

/** A word in solid particles, deep enough to read as an object when the camera turns. */
function wordFormation(word: string, seed: number): Float32Array | null {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const font = `600 220px "Space Grotesk", system-ui, sans-serif`;
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(word).width) + 20;
  const height = 280;
  canvas.width = width;
  canvas.height = height;
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(word, width / 2, height / 2);
  const alpha = ctx.getImageData(0, 0, width, height).data;
  const inside: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (alpha[(y * width + x) * 4 + 3] > 120) inside.push(x, y);
  if (!inside.length) return null;
  const scale = Math.min(2.7 / width, 1.5 / height);
  return formation((put, random) => {
    for (let i = 0; i < COUNT; i++) {
      const pick = Math.floor(random() * (inside.length / 2)) * 2;
      const depth = (random() - 0.5) * 0.34;
      put(i, (inside[pick] + random() - width / 2) * scale, (height / 2 - inside[pick + 1] - random()) * scale, depth, 0, 0, 0, depth > 0.12 ? 0.85 : 0.22);
    }
  }, seed);
}

const VERTEX = `#version 300 es
in vec3 aFrom, aFromV, aTo, aToV, aLand;
in float aFromTint, aToTint;
in float aSeed;
uniform mat4 uView;
uniform float uMix, uTime, uPixels, uLand;
uniform vec2 uPointer;
uniform vec3 uRipple;
out float vTint, vAlpha;
void main() {
  // Particles set off in turn, not as a block.
  float m = clamp(uMix * 1.5 - aSeed * 0.5, 0.0, 1.0);
  m = m * m * (3.0 - 2.0 * m);
  float flight = fract(uTime * 0.22 + aSeed * 37.0);
  vec3 a = aFrom + aFromV * flight;
  vec3 b = aTo + aToV * flight;
  vec3 p = mix(a, b, m);
  // On the way, each one swings out on its own path, and the cloud turns as it travels.
  float swing = sin(m * 3.14159);
  float angle = aSeed * 40.0 + uTime * 0.6;
  p += swing * vec3(cos(angle), sin(angle * 1.3) * 0.7, sin(angle)) * (0.18 + aSeed * 0.4);
  float turn = swing * (0.5 + aSeed * 0.6);
  p.xz = mat2(cos(turn), -sin(turn), sin(turn), cos(turn)) * p.xz;
  vec4 clip = uView * vec4(p, 1.0);
  // The pointer parts the cloud, and a click sends a ring through it.
  vec2 ndc = clip.xy / clip.w;
  vec2 d = ndc - uPointer;
  ndc += d * exp(-dot(d, d) * 26.0) * 0.5;
  if (uRipple.z >= 0.0) {
    vec2 r = ndc - uRipple.xy;
    float reach = length(r) - uRipple.z * 1.5;
    ndc += normalize(r + 1e-4) * exp(-reach * reach * 60.0) * 0.07 * exp(-uRipple.z * 2.2);
  }
  // Handing over to the map: from wherever each particle is, to its place on a road.
  float l = clamp(uLand * 1.4 - aSeed * 0.4, 0.0, 1.0);
  l = l * l * (3.0 - 2.0 * l);
  ndc = mix(ndc, aLand.xy, l);
  gl_Position = vec4(ndc * clip.w, clip.z, clip.w);
  float depth = clip.w;
  gl_PointSize = mix(uPixels * (1.0 + aSeed * 0.9) * clamp(3.4 / depth, 0.35, 2.6), uPixels * 0.8, l);
  vTint = mix(mix(aFromTint, aToTint, m), aLand.z, l);
  // Nearer and further than the focal distance falls away, as with a lens.
  vAlpha = mix((0.32 + vTint * 0.68) * clamp(1.5 - abs(depth - 3.1) * 0.5, 0.18, 1.0), 0.9, l);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in float vTint, vAlpha;
uniform vec3 uBase, uAccent;
uniform float uDim;
out vec4 colour;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = min(1.0, smoothstep(0.5, 0.08, d) * vAlpha * uDim);
  colour = vec4(mix(uBase, uAccent, vTint) * a, a);
}`;

function compile(gl: WebGL2RenderingContext): WebGLProgram | null {
  const program = gl.createProgram();
  for (const [kind, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
    const shader = gl.createShader(kind);
    if (!shader || !program) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  if (!program) return null;
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

function viewMatrix(aspect: number, yaw: number, pitch: number, distance: number): Float32Array {
  // Wide windows see the scene whole; tall ones draw back so that it still fits.
  const d = distance * (aspect < 1.5 ? 1.5 / aspect : 1);
  const f = 1 / Math.tan(0.42);
  const near = 0.1, far = 30;
  const depthA = (far + near) / (near - far), depthB = (2 * far * near) / (near - far);
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // Turn about y, tilt about x, move back by d, then project. By column.
  const row = (x: number, y: number, z: number) => [(f / aspect) * x, f * y, depthA * z, -z] as const;
  const c0 = row(cy, sp * sy, -cp * sy);
  const c1 = row(0, cp, sp);
  const c2 = row(sy, -sp * cy, cp * cy);
  return new Float32Array([...c0, ...c1, ...c2, 0, 0, depthA * -d + depthB, d]);
}

function rgb(value: string, fallback: [number, number, number]): [number, number, number] {
  const parts = value.trim().split(/[\s,]+/).map(Number);
  return parts.length >= 3 && parts.every(Number.isFinite) ? [parts[0] / 255, parts[1] / 255, parts[2] / 255] : fallback;
}

export function BootScene({ playing, asleep = false, closing = false, landing, ending = false, rejoin = false, quiet = false, onCycle, reduceMotion }: {
  /** The film runs; otherwise the network rests dimly behind whatever is on screen. */
  playing: boolean;
  /** Nothing is drawn yet, because the title has the screen. */
  asleep?: boolean;
  closing?: boolean;
  /** Where the map has drawn its roads, asked for once the surface starts to close. */
  landing?: () => Float32Array | null;
  /** The server has stopped: particles leave the roads, form the name once, and rest. */
  ending?: boolean;
  /** After ending, the same particles recollect into the name and the film carries on. */
  rejoin?: boolean;
  /** Something is to be read on screen: stay out of its way. */
  quiet?: boolean;
  /** The film has shown every scene once. */
  onCycle?: () => void;
  reduceMotion: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [chapter, setChapter] = useState(0);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const closingRef = useRef(closing);
  closingRef.current = closing;
  const quietRef = useRef(quiet);
  quietRef.current = quiet;
  const cycleRef = useRef(onCycle);
  cycleRef.current = onCycle;
  const asleepRef = useRef(asleep);
  asleepRef.current = asleep;
  const landingRef = useRef(landing);
  landingRef.current = landing;

  useEffect(() => {
    const element = canvas.current;
    const gl = element?.getContext("webgl2", { alpha: true, antialias: false, powerPreference: "low-power" }) ?? null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const advanceCaption = () => setChapter((c) => (c + 1) % FILM_CHAPTERS.length);
    if (!element || !gl) {
      // No film to sit through, then. Its words still play if there is a wait.
      cycleRef.current?.();
      if (!reduceMotion) timer = setInterval(() => playingRef.current && advanceCaption(), HOLD_S * 1000);
      return () => clearInterval(timer);
    }
    const program = compile(gl);
    if (!program) return;
    gl.useProgram(program);

    const scenes = buildFormations().map((data) => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return buffer;
    });
    const seeds = new Float32Array(COUNT);
    const random = sequence(777);
    for (let i = 0; i < COUNT; i++) seeds[i] = random();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const seedBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, seedBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    const seedAt = gl.getAttribLocation(program, "aSeed");
    gl.enableVertexAttribArray(seedAt);
    gl.vertexAttribPointer(seedAt, 1, gl.FLOAT, false, 0, 0);

    const attribute = (name: string, buffer: WebGLBuffer | null, size: number, offset: number) => {
      const at = gl.getAttribLocation(program, name);
      if (at < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
    };
    const bind = (from: number, to: number) => {
      attribute("aFrom", scenes[from], 3, 0);
      attribute("aFromV", scenes[from], 3, 3);
      attribute("aFromTint", scenes[from], 1, 6);
      attribute("aTo", scenes[to], 3, 0);
      attribute("aToV", scenes[to], 3, 3);
      attribute("aToTint", scenes[to], 1, 6);
    };
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const u = { view: uniform("uView"), mix: uniform("uMix"), time: uniform("uTime"), pixels: uniform("uPixels"), pointer: uniform("uPointer"), ripple: uniform("uRipple"), base: uniform("uBase"), accent: uniform("uAccent"), dim: uniform("uDim"), land: uniform("uLand") };
    const landAt = gl.getAttribLocation(program, "aLand");
    const landBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, landBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(COUNT * 3), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(landAt);
    gl.vertexAttribPointer(landAt, 3, gl.FLOAT, false, 0, 0);

    // Starts as the cloud, and the first thing it does is become the wordmark.
    let from = 0, to = 0;
    bind(from, to);
    const image = new Image();
    let cancelled = false;
    image.onload = () => {
      if (cancelled) return;
      const mark = wordmarkFormation(image);
      if (!mark) return;
      wordmarkUv = mark.uv;
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, mark.data, gl.STATIC_DRAW);
      // The cloud stays what the film first gathers out of, and the wordmark takes its turn.
      scenes.push(buffer);
      wordmark = scenes.length - 1;
      // A film already under way, and still on its opening, gathers into the wordmark now.
      if (reduceMotion || !started || scene !== 0 || ending) return;
      to = wordmark;
      bind(from, to);
      blend = 0;
      velocity = 0;
    };
    // The words wait for their typeface, and are swapped in without anyone seeing.
    void document.fonts?.load(`600 220px "Space Grotesk"`).then(() => {
      if (cancelled) return;
      for (const [index, word] of [[7, "150+"]] as const) {
        const data = wordFormation(word, 30 + index);
        if (!data) continue;
        gl.bindBuffer(gl.ARRAY_BUFFER, scenes[index]);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      }
    });
    image.src = `data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}`;

    const size = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      element.width = Math.round(window.innerWidth * ratio);
      element.height = Math.round(window.innerHeight * ratio);
      gl.viewport(0, 0, element.width, element.height);
      gl.uniform1f(u.pixels, 2.1 * ratio);
    };
    const colours = () => {
      const style = getComputedStyle(element);
      const light = document.documentElement.dataset.theme === "light";
      gl.uniform3fv(u.base, rgb(style.getPropertyValue("--line-rgb"), [0.7, 0.92, 1]));
      gl.uniform3fv(u.accent, rgb(style.getPropertyValue("--accent-rgb"), [0.2, 0.84, 1]));
      gl.enable(gl.BLEND);
      // Light adds up towards white on a dark page; on a light one it has to cover.
      if (light) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else gl.blendFunc(gl.ONE, gl.ONE);
      strength = light ? 1.5 : 1;
      if (reduceMotion) paint();
    };
    // The theme can arrive after this does, and can change while it plays.
    const themes = new MutationObserver(colours);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-vision"] });

    let wordmark = -1;
    let started = false;
    let wordmarkUv: Float32Array | null = null;
    let dissolving = false; // The title's logo is becoming the particles.
    let landing = 0;
    let landingVelocity = 0;
    let landed = false; // Whether the particles have somewhere to land.
    let landedFrom = 0;
    let endScattered = false;
    let rejoined = false;
    let endStart = 0;
    let closingFor = -1;
    let blend = 1;
    let velocity = 0;
    let scene = 0; // Which chapter the cloud is showing.
    let held = 0;
    let time = 0;
    let frame = 0;
    let dim = asleepRef.current || ending ? 0 : playingRef.current ? 1 : REST_DIM;
    let strength = 1;
    let count = COUNT;
    let slow = 0;
    const camera = { yaw: CAMERAS[0].yaw, pitch: CAMERAS[0].pitch, distance: CAMERAS[0].distance, vy: 0, vp: 0, vd: 0, orbit: 0 };
    const pointer = { x: 9, y: 9 };
    let ripple = { x: 0, y: 0, age: -1 };
    let last = performance.now();

    function paint() {
      if (!gl || !element) return;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniformMatrix4fv(u.view, false, viewMatrix(element.width / element.height, camera.yaw + camera.orbit, camera.pitch, camera.distance));
      gl.uniform1f(u.mix, blend);
      gl.uniform1f(u.land, landing);
      gl.uniform1f(u.time, time);
      gl.uniform2f(u.pointer, pointer.x, pointer.y);
      gl.uniform3f(u.ripple, ripple.x, ripple.y, ripple.age);
      gl.uniform1f(u.dim, dim * strength);
      gl.drawArrays(gl.POINTS, 0, count);
    }
    const next = (restTo?: number) => {
      const after = restTo ?? (scene + 1) % FILM_CHAPTERS.length;
      if (restTo === undefined && after === 0) cycleRef.current?.();
      const buffer = (chapterIndex: number) => (chapterIndex === 0 ? (wordmark >= 0 ? wordmark : 0) : chapterIndex);
      from = to;
      to = buffer(after);
      scene = after;
      bind(from, to);
      blend = 0;
      velocity = 0;
      held = 0;
      // Each scene has its own framing. The drift of the last one is folded into the
      // camera, which then turns by the short way to where this one should be seen.
      const turn = Math.PI * 2;
      camera.yaw += camera.orbit;
      camera.orbit = 0;
      camera.yaw = CAMERAS[after].yaw + ((((camera.yaw - CAMERAS[after].yaw + Math.PI) % turn) + turn) % turn) - Math.PI;
      setChapter(after);
    };
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      time += dt;
      held += dt;
      [blend, velocity] = stepSpring(blend, velocity, 1, MORPH, dt);
      const want = CAMERAS[scene];
      [camera.yaw, camera.vy] = stepSpring(camera.yaw, camera.vy, want.yaw, CAMERA, dt);
      [camera.pitch, camera.vp] = stepSpring(camera.pitch, camera.vp, want.pitch, CAMERA, dt);
      [camera.distance, camera.vd] = stepSpring(camera.distance, camera.vd, want.distance, CAMERA, dt);
      camera.orbit += want.spin * dt;
      // The wordmark faces the viewer; it sways, and does not turn away.
      if (scene === 0) camera.orbit += (Math.sin(time * 0.5) * 0.06 - camera.orbit) * Math.min(1, dt * 2);
      if (ripple.age >= 0) ripple = { ...ripple, age: ripple.age > 1.6 ? -1 : ripple.age + dt };
      if (closingRef.current && closingFor < 0) {
        closingFor = 0;
        const points = landingRef.current?.();
        if (points) {
          gl.bindBuffer(gl.ARRAY_BUFFER, landBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);
          landed = true;
          dissolving = false;
          landedFrom = 0;
          landing = 0;
        }
      }
      if (closingFor >= 0) closingFor += dt;
      if (landed) landing = Math.max(landedFrom, easeInOut(closingFor / LAND_S));
      else if (dissolving) {
        landing = 1 - easeInOut((held - DISSOLVE_HOLD_S) / DISSOLVE_S);
        if (landing <= 0.0001) {
          landing = 0;
          dissolving = false;
        }
      } else if (ending && started && !rejoined) {
        // The end, simply: off the roads into the name, and then it drifts apart and rests.
        const t = now / 1000 - endStart;
        landing = 1 - easeInOut((t - 0.5) / 2.2);
        if (t > 4.2 && !endScattered) {
          endScattered = true;
          from = to;
          to = 0;
          bind(from, to);
          blend = 0;
          velocity = 0;
        }
        if (t > 9 && !rejoin) {
          paint();
          return; // Nothing else will happen here, so nothing else is spent.
        }
      }
      // Having landed, they give way to the map's own roads.
      const endingDim = quietRef.current ? REST_DIM : ending && !rejoined ? (!rejoin && now / 1000 - endStart > 4.6 ? REST_DIM : 1) : null;
      const dimTo = endingDim ?? (landed ? (closingFor > LAND_S + 0.1 ? 0 : 1) : closingRef.current || asleepRef.current ? 0 : playingRef.current ? 1 : REST_DIM);
      dim += (dimTo - dim) * Math.min(1, dt * (quietRef.current || (ending && !rejoined) ? 1.6 : landed ? 4 : dissolving ? 3.2 : playingRef.current && !closingRef.current ? 2.4 : 8));
      // The old world's particles, blown apart, come back together as the name, and the
      // film carries on from there as it does at start-up.
      if (rejoin && started && !rejoined && playingRef.current) {
        rejoined = true;
        from = to;
        to = wordmark;
        scene = 0;
        bind(from, to);
        blend = 0;
        velocity = 0;
        held = 0;
        landing = 0;
        setChapter(0);
      }
      if (ending && !started && wordmark >= 0) {
        // Starts standing on the map's roads, wherever they are, and gathers into the name.
        started = true;
        endStart = now / 1000;
        const points = landingRef.current?.();
        from = wordmark;
        to = wordmark;
        bind(from, to);
        blend = 1;
        if (points) {
          gl.bindBuffer(gl.ARRAY_BUFFER, landBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);
          landing = 1;
        }
        dim = 0;
      }
      if (playingRef.current) {
        if (!started) {
          // The film opens by gathering the cloud into the wordmark.
          started = true;
          held = 0;
          const logo = document.querySelector(".boot-title-logo svg")?.getBoundingClientRect();
          if (wordmark >= 0 && wordmarkUv && logo && !reduceMotion) {
            // Every particle starts on the logo itself, exactly where it is drawn on
            // the page. As the logo fades, they are what is left, and then they let go.
            const points = new Float32Array(COUNT * 3);
            for (let i = 0; i < COUNT; i++) {
              const x = logo.left + wordmarkUv[i * 2] * logo.width;
              const y = logo.top + wordmarkUv[i * 2 + 1] * logo.height;
              points.set([(x / window.innerWidth) * 2 - 1, 1 - (y / window.innerHeight) * 2, 0.8], i * 3);
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, landBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, points, gl.DYNAMIC_DRAW);
            from = to = wordmark;
            bind(from, to);
            blend = 1;
            landing = 1;
            dissolving = true;
            dim = 0;
          } else if (wordmark >= 0) {
            to = wordmark;
            bind(from, to);
            blend = 0;
            velocity = 0;
          }
        }
        if (held > HOLD_S && !closingRef.current) next();
      } else if (!asleepRef.current && !ending && !quietRef.current && scene !== 1) {
        next(1);
      }
      paint();
      // A machine that cannot keep up draws fewer, rather than stuttering.
      slow = dt > 0.03 ? slow + 1 : Math.max(0, slow - 0.25);
      if (slow > 40) {
        count = Math.max(6000, Math.round(count * 0.7));
        slow = 0;
      }
      frame = requestAnimationFrame(tick);
    };
    const onMove = (event: PointerEvent) => {
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = 1 - (event.clientY / window.innerHeight) * 2;
    };
    const onLeave = () => {
      pointer.x = pointer.y = 9;
    };
    const onPress = (event: PointerEvent) => {
      ripple = { x: (event.clientX / window.innerWidth) * 2 - 1, y: 1 - (event.clientY / window.innerHeight) * 2, age: 0 };
    };
    const onResize = () => {
      size();
      if (reduceMotion) paint();
    };
    const onVisibility = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden && !reduceMotion) {
        last = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };
    size();
    colours();
    window.addEventListener("resize", onResize);
    if (reduceMotion) {
      // One still picture of the network, and nothing moves.
      from = to = 1;
      scene = 1;
      bind(from, to);
      const still = CAMERAS[1];
      camera.yaw = still.yaw;
      camera.pitch = still.pitch;
      camera.distance = still.distance;
      paint();
    } else {
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerdown", onPress);
      document.addEventListener("pointerleave", onLeave);
      document.addEventListener("visibilitychange", onVisibility);
      frame = requestAnimationFrame(tick);
    }
    return () => {
      cancelled = true;
      themes.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onPress);
      document.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [reduceMotion, ending, rejoin]);

  const shown = FILM_CHAPTERS[playing ? chapter : 0];
  return (
    <>
      <canvas ref={canvas} className="boot-scene" aria-hidden="true" />
      {playing && (
        <div className="film-caption" aria-hidden="true" key={chapter}>
          <span className="film-chapter">{shown.label}</span>
          <h3>{shown.title}</h3>
          <p>{shown.text}</p>
          <span className="film-ticks">
            {FILM_CHAPTERS.map((c, i) => (
              <i key={c.label} className={i === chapter ? "on" : ""} />
            ))}
          </span>
        </div>
      )}
    </>
  );
}
