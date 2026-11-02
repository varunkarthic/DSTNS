// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef, useState } from "react";
import { LOGO_SVG } from "./logoAsset";
import { appearance } from "./appearance";
import { stepSpring } from "./motion";
import { buildFormations, CAMERA_YAW_INCIDENT, COUNT, endMist, FOCUS_A, FOCUS_B, formation, IN_WORLD, JOINS, KIND, ORB_HEIGHT, ORB_HUES, sequence, SEAM, SEEDS_AT, STRIDE, TRIP_ROADS, WRECK_AT } from "./bootScenes";

/**
 * The start-up film.
 *
 * A single cloud of particles, drawn in three dimensions, keeps re-forming into what
 * DSTNS does, each scene its own subject (see bootScenes.ts) and moving for as long as it
 * holds. It plays for as long as the system takes to load, and is not a measure of it:
 * progress is reported separately, from what the core says.
 *
 * All the movement happens in the vertex shader, so the page spends one draw call on
 * it. Without WebGL2 the captions still play over the plain background.
 */

const HOLD_S = 4;
// How long each scene holds: a junction needs time for its lights to go round.
const HOLDS = [4.4, 4.8, 6.6, 6, 5.4, 5.8, 4.4, 4.4, 6.8, 5, 7.4];
// Between scenes, timed and not sprung: each particle starts and stops with no jolt. The front that
// sets them off crosses in this time, and the camera arrives a little after they do.
const MORPH_S = 1.95;
const CAMERA_S = 2.5;
// Which way each scene's particles set off from. Nothing here means the middle, outward.
const FRONTS: readonly (readonly [number, number, number])[] = [[1, 0, 0], [0, 0, 1], [0, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, -1], [1, 0, 0], [0, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 0]];
const smoother = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
// Going to and from the logo and the map are timed, not sprung: an ease in and out has no
// sudden start, which is what makes particles leaving a shape feel soft.
const DISSOLVE_S = 2.1;
// Arriving: the particles gather into the name, then build the roads from the centre out,
// as the end of a session plays backwards. Only then does the map come, then the panels.
const GATHER_S = 1.15;
const LAND_S = 2.3;
const easeInOut = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const POINTER = { k: 70, c: 15 };
const BURST = { k: 16, c: 7.2 };
/** When the map fades in under the roads the particles have just built. */
export const MAP_AT_MS = Math.round((GATHER_S + LAND_S * 0.86) * 1000);
/** When the panels come in around it. */
export const PANELS_AT_MS = MAP_AT_MS + 650;
/** How long the handover takes. The surface stays mounted this long. */
export const LANDING_MS = PANELS_AT_MS + 500;
/** Coming back to a run already going, on reload: the same arrival, without the film or the wait. */
const QUICK_LAND_S = 0.95;
export const QUICK_ARRIVAL = { mapAt: 780, panelsAt: 1020, landing: 1500 } as const;
/** A new world: how long the old one takes to leave, before the particles recollect. */
export const REJOIN_AT_MS = 5800;
/** Whether this browser can draw the film at all. */
export const filmAvailable = () => typeof WebGL2RenderingContext !== "undefined";
/** And how long before a ready world may interrupt them forming the name again. */
export const REJOIN_MIN_MS = REJOIN_AT_MS + 2800;
// With nothing to do, the network rests dimly, out of the way of what is on screen.
const REST_DIM = 0.14;
// The title's logo comes apart in a sweep from left to right, each part of it turning to
// particles as the sweep reaches it. They stand a moment, then let go.
const SWEEP_DELAY_S = 0.18;
const SWEEP_S = 1.2;
const DISSOLVE_HOLD_S = SWEEP_DELAY_S + SWEEP_S + 0.15;
// The end: the panels leave, the map goes from under its own roads, those roads fly into
// the name, and the name is blown into a mint mist that thins into the light behind it.
// Then nothing moves, and nothing is drawn. About as long as it always was.
const END_ROADS_AT_S = 0.3;
const END_GATHER_AT_S = 1.15;
const END_GATHER_S = 2.3;
const END_SCATTER_AT_S = 4.3;
const END_THIN_AT_S = 5.1;
const END_STILL_S = 10.5;

// One or two words and one short line, with no commas. Nothing here may suggest it is
// happening now or for real: it is a simulation, and these are its features.
export const FILM_CHAPTERS: readonly { label: string; title: string; text: string }[] = [
  { label: "Deterministic Spatiotemporal Transport Network Simulator", title: "Traffic simulation", text: "A full simulated day in one district." },
  { label: "Networks", title: "Mapped streets", text: "Every district comes from OpenStreetMap." },
  { label: "Signals", title: "Signal timing", text: "Signalled junctions each run their own schedule." },
  { label: "Demand", title: "Travel demand", text: "Every school and office draws trips." },
  { label: "Rhythm", title: "Rush hour", text: "Modelled demand rises and falls through the day." },
  { label: "Incidents", title: "Road incidents", text: "A collision closes lanes and the queue spreads back." },
  { label: "Environment", title: "Simulated weather", text: "Rain cells cross the district and roads flood." },
  { label: "Places", title: "Cities worldwide", text: "A seed chooses the district." },
  { label: "Reproducibility", title: "Repeatable worlds", text: "Any seed grows the same day on any machine." },
  { label: "Camera", title: "Auto Focus", text: "The camera follows what matters." },
  { label: "Extensions", title: "WebFabric", text: "Your own applications weave into the simulation." },
];

interface Camera { yaw: number; pitch: number; distance: number; spin: number; push: number }
const CAMERAS: Camera[] = [
  { yaw: 0, pitch: 0, distance: 3.1, spin: 0.012, push: 0.03 },
  { yaw: 0.2, pitch: 1.2, distance: 3.7, spin: 0.018, push: 0.07 },
  { yaw: -0.28, pitch: 1.02, distance: 3.3, spin: 0.02, push: 0.07 },
  { yaw: 0.14, pitch: 0.74, distance: 3.55, spin: 0.006, push: 0.05 },
  { yaw: -0.08, pitch: 0.42, distance: 3.5, spin: 0.005, push: 0.04 },
  { yaw: CAMERA_YAW_INCIDENT, pitch: 0.46, distance: 3.05, spin: 0.006, push: 0.05 },
  { yaw: 0.26, pitch: 0.13, distance: 3.75, spin: -0.04, push: 0.07 },
  { yaw: 0.2, pitch: 0.3, distance: 3.3, spin: 0.26, push: 0.05 },
  { yaw: 0, pitch: 0, distance: 3.6, spin: 0.012, push: 0.04 },
  { yaw: 0.14, pitch: 1.12, distance: 3.2, spin: 0.012, push: 0.03 },
  { yaw: 0.12, pitch: 0.42, distance: 3.5, spin: 0.012, push: 0.05 },
];

/** How far the map's camera has carried the roads since the particles were told where they are. */
export const mapCarry = { x: 0, y: 0 };

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
      put(i, (x - width / 2) * scale, (height / 2 - y) * scale, (random() - 0.5) * 0.05, { kind: KIND.shimmer, tint: random() < 0.12 ? 0.8 : 0.3 });
    }
  }, 18);
  return { data, uv };
}

/**
 * Where the particles land: along the roads, exactly where the map has drawn them, in
 * clip space. x, y, a tint, and when it arrives: nearest the middle of the map first, so
 * that the network builds outward along its own roads. Longer roads get more particles.
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
  const data = new Float32Array(count * 4);
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
    data[i * 4] = (x / width) * 2 - 1;
    data[i * 4 + 1] = 1 - (y / height) * 2;
    data[i * 4 + 2] = 0.45 + random() * 0.55;
  }
  // The middle of the network, in the window's proportions rather than the map's.
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < count; i++) {
    cx += data[i * 4] / count;
    cy += data[i * 4 + 1] / count;
  }
  const aspect = width / height;
  let furthest = 1e-6;
  for (let i = 0; i < count; i++) {
    const d = Math.hypot((data[i * 4] - cx) * aspect, data[i * 4 + 1] - cy);
    data[i * 4 + 3] = d;
    if (d > furthest) furthest = d;
  }
  for (let i = 0; i < count; i++) data[i * 4 + 3] = data[i * 4 + 3] / furthest * 0.92 + random() * 0.08;
  return data;
}

const VERTEX = `#version 300 es
in vec3 aFrom, aFromV, aTo, aToV;
in vec4 aFromM, aToM; // tint kind phase hue
in vec4 aLand; // x y tint order
in float aSeed;
uniform mat4 uView;
uniform float uMix, uTime, uPixels, uLand, uAgeFrom, uAgeTo, uSweep, uAspect, uReach, uBurst, uInhale, uTurn;
uniform vec2 uPointer, uPointerV, uLandShift;
uniform vec3 uFront;
uniform vec3 uRipple, uBase, uAccent, uWarm, uDanger, uOk, uRoad;
out vec3 vColour;
out float vAlpha;
const float PI = 3.14159265;
const vec4 TRIP_ROADS[${TRIP_ROADS.length}] = vec4[${TRIP_ROADS.length}](${TRIP_ROADS.map((r) => `vec4(${r.map((n) => n.toFixed(3)).join(", ")})`).join(", ")});
float ease(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
float overshoot(float x) { x = clamp(x, 0.0, 1.0) - 1.0; return 1.0 + 2.4 * x * x * x + 1.4 * x * x; }
// The junction's cycle, 6 s. Each road has 2.4 s of green, 0.6 s of amber, then red.
float cycleOf(bool north, float age) { return mod(age + 0.5 + (north ? 0.0 : 3.0), 6.0); }
// How much a road is held, for a vehicle this far behind the stop line: the queue goes from the front.
float heldAt(float x, float behind) {
  if (x < 2.4) return 1.0 - smoothstep(behind, behind + 0.5, x);
  return smoothstep(2.4, 2.95, x);
}
// Where each application joins the fabric, and the colour it brings.
const vec3 JOINS[${JOINS.length}] = vec3[${JOINS.length}](${JOINS.map((j) => `vec3(${j.map((n) => n.toFixed(3)).join(", ")})`).join(", ")});
const float ORB_HUE[${ORB_HUES.length}] = float[${ORB_HUES.length}](${ORB_HUES.map((h) => `${h}.0`).join(", ")});
// The cloth at a point: its height, how strongly a ring is passing, and whose. The rings run out from
// each join and come again, weaker with distance, so that the whole cloth keeps being touched.
vec3 clothAt(vec2 q, float t, float age) {
  float height = 0.055 * sin(q.x * 2.1 + q.y * 1.3 - t * 1.1) + 0.028 * sin(q.y * 3.4 - q.x * 0.9 + t * 0.8);
  float best = 0.0, whose = 0.0, lift = 0.0;
  for (int i = 0; i < ${JOINS.length}; i++) {
    float since = age - JOINS[i].z;
    if (since < 0.0) continue;
    float x = mod(since, 3.6);
    float d = length(q - JOINS[i].xy);
    float ring = exp(-pow((d - x * 1.35) * 3.4, 2.0)) * exp(-x * 0.5) * smoothstep(0.0, 0.2, x);
    lift += ring * 0.15;
    if (ring > best) {
      best = ring;
      whose = float(i);
    }
  }
  return vec3(height + lift, best, whose);
}
struct Live { vec3 p; float alpha; float size; float tint; float hue; };
Live live(vec3 p, vec3 v, vec4 m, float age) {
  float t = uTime, tint = m.x, phase = m.z, hue = m.w, alpha = 1.0, size = 1.0;
  int kind = int(m.y + 0.5);
  bool inWorld = kind >= ${IN_WORLD};
  if (inWorld) kind -= ${IN_WORLD};
  if (kind == ${KIND.flow}) {
    float f = fract(t * 0.22 + phase * 37.0);
    p += v * f;
    alpha = smoothstep(0.0, 0.08, f) * smoothstep(1.0, 0.92, f);
  } else if (kind == ${KIND.arc}) {
    float f = fract(t * 0.3 + phase * 37.0);
    float s = f * f * (3.0 - 2.0 * f);
    p += v * s;
    p.y += 4.0 * f * (1.0 - f) * 0.3 * length(v);
    alpha = smoothstep(0.0, 0.1, f) * smoothstep(1.0, 0.86, f);
  } else if (kind == ${KIND.route}) {
    float f = fract(t * 0.2 + phase * 37.0);
    float s = f * f * (3.0 - 2.0 * f);
    p = normalize(p + v * s + 1e-4) * length(p) * (1.0 + 0.22 * sin(f * PI));
    alpha = smoothstep(0.0, 0.1, f) * smoothstep(1.0, 0.86, f);
  } else if (kind == ${KIND.rise}) {
    float g = overshoot((age - 0.1 - phase * 1.3) / 0.75);
    p.y = v.y + (p.y - v.y) * g;
    alpha = ease(g * 4.0);
    if (tint > 0.8) alpha *= 0.72 + 0.28 * sin(t * 1.7 + phase * 90.0 + p.x * 60.0 + p.y * 40.0);
  } else if (kind == ${KIND.fall}) {
    float f = fract(t * 1.08 + phase * 37.0);
    p += v * f;
    alpha = smoothstep(0.0, 0.06, f) * (1.0 - f * 0.25);
  } else if (kind == ${KIND.ring}) {
    float f = fract(t * 0.42 + phase);
    p += v * f;
    alpha = (1.0 - f) * smoothstep(0.0, 0.06, f);
  } else if (kind == ${KIND.pulse}) {
    float w = 0.5 + 0.5 * sin(t * 2.3 + phase * 6.283);
    w *= w;
    alpha = 0.4 + 0.6 * w;
    size = 1.5 + w * 1.5;
  } else if (kind == ${KIND.reveal}) {
    float r = age / 2.3;
    float g = smoothstep(phase, phase + 0.05, r);
    float front = exp(-pow((r - phase) * 16.0, 2.0));
    alpha = g;
    size = 1.0 + front * 1.9;
    tint = max(tint, front);
    p.y += (1.0 - g) * 0.16;
  } else if (kind == ${KIND.lane}) {
    vec2 start = v.xz;
    bool north = abs(start.y) > abs(start.x);
    vec2 dir = north ? vec2(0.0, -sign(start.y)) : vec2(-sign(start.x), 0.0);
    vec2 right = vec2(-dir.y, dir.x);
    float reach = dot(-start, dir);
    float offset = dot(start, right);
    float total = reach * 2.0;
    float dist = fract(t * 0.082 + phase) * total;
    float stopAt = reach - 0.68;
    float behind = max(0.0, stopAt - dist);
    float h = heldAt(cycleOf(north, age), behind * 0.9);
    if (dist < stopAt) dist = stopAt - behind * mix(1.0, 0.44, h);
    vec2 head = dir;
    vec2 c = start + dir * dist;
    if (v.y > 0.5) {
      float r = 0.2;
      float straight = reach - offset - r;
      float arc = PI * r * 0.5;
      if (dist > straight) {
        vec2 centre = start + dir * straight + right * r;
        if (dist < straight + arc) {
          float a = (dist - straight) / r;
          c = centre - right * r * cos(a) + dir * r * sin(a);
          head = dir * cos(a) + right * sin(a);
        } else {
          c = centre + dir * r + right * (dist - straight - arc);
          head = right;
        }
      }
    }
    vec2 across = vec2(-head.y, head.x);
    vec2 q = c + head * p.x + across * p.z;
    p = vec3(q.x, p.y, q.y);
    alpha = smoothstep(0.0, 0.04, dist / total) * smoothstep(1.0, 0.96, dist / total);
    // Tail lights come on when it is held.
    if (hue > 1.5 && hue < 2.5) {
      float braking = dist <= stopAt + 0.01 ? h : 0.0;
      alpha *= 0.2 + 0.8 * braking;
      size = 1.0 + braking * 0.5;
    }
  } else if (kind == ${KIND.lamp}) {
    float x = cycleOf(hue < 4.5, age);
    float now = x < 2.4 ? 2.0 : (x < 3.0 ? 1.0 : 0.0);
    bool lit = abs(phase - now) < 0.5;
    hue = phase < 0.5 ? 2.0 : (phase < 1.5 ? 1.0 : 3.0);
    alpha = lit ? 1.0 : 0.13;
    size = lit ? 2.5 : 1.3;
  } else if (kind == ${KIND.walker}) {
    bool crossesNorth = abs(v.x) > abs(v.z);
    float x = mod(cycleOf(crossesNorth, age) - 3.15, 6.0);
    float f = clamp(x / 2.3 - phase * 0.28, 0.0, 1.0);
    p += v * f;
    alpha = x < 2.7 ? 1.0 : smoothstep(6.0, 5.7, x) * 0.0 + 0.0;
    size = 1.3;
  } else if (kind == ${KIND.ridge}) {
    // Carried along its road through the day. It stands at the height of that road's
    // traffic once the moment of the day has passed it, and lies flat until then.
    float f = fract(t * 0.05 + phase * 37.0);
    float h = f * 24.0;
    float shift = (v.z - 0.5) * 1.3;
    float r = (0.05 + 0.62 * exp(-pow(h - 8.3 - shift, 2.0) / (2.0 + v.z * 2.4)) + 0.76 * exp(-pow(h - 17.6 + shift, 2.0) / (2.6 + v.z * 2.8)) + 0.2 * exp(-pow(h - 12.8, 2.0) / 14.0)) * v.y;
    float passed = smoothstep(f - 0.03, f + 0.03, age / 3.4);
    p = vec3(-1.8 + 3.6 * f, (r + 0.012 * sin(f * 90.0 + v.x * 40.0)) * passed * 1.05, v.x);
    tint = 0.3 + r * 0.8;
    float noise = fract(phase * 91.0) * 0.1;
    hue = passed < 0.5 ? 0.0 : (r < 0.3 + noise ? 0.0 : (r < 0.56 + noise ? 1.0 : 2.0));
    alpha = 0.45 + 0.55 * passed;
  } else if (kind == ${KIND.sweep}) {
    float at = age / 3.4;
    p = vec3(-1.8 + 3.6 * at, p.y * 1.15, p.z);
    alpha = smoothstep(0.0, 0.04, at) * smoothstep(1.02, 0.94, at) * 0.5;
  } else if (kind == ${KIND.queue}) {
    // Those reaching the queue slow to a crawl, and those in the outer lanes squeeze into
    // the inner one to get past. The tail works back up the road.
    float u = -2.6 + fract(t * 0.128 + phase) * 11.6;
    float x = u;
    float z = v.x;
    float wreck = ${WRECK_AT.toFixed(2)};
    float dir = v.y;
    if (dir > 0.0) {
      float tail = wreck - min(age * 0.6 - 0.5, 3.3) * step(0.84, age);
      float crawl = 0.3;
      float cleared = tail + (wreck - tail) / crawl;
      if (age > 0.84 && u > tail) {
        if (u < cleared) {
          x = tail + (u - tail) * crawl;
          float depth = (x - tail) / (wreck - tail + 1e-3);
          x += 0.012 * sin(x * 9.0 + t * 2.2);
          hue = depth > 0.3 ? 2.0 : 1.0;
        } else {
          x = wreck + u - cleared;
        }
      }
      float squeeze = smoothstep(0.5, 1.0, age) * smoothstep(wreck - 0.6, wreck - 0.14, x) * (1.0 - smoothstep(wreck + 0.25, wreck + 0.7, x));
      z = mix(z, 0.13, squeeze);
    } else {
      x = -u;
    }
    p = vec3(x + p.x * dir, p.y, z + p.z);
    alpha = smoothstep(-2.6, -2.25, p.x) * smoothstep(2.6, 2.25, p.x);
  } else if (kind == ${KIND.crash}) {
    float flash = exp(-pow((age - 0.9) * 5.0, 2.0));
    alpha = smoothstep(0.78, 0.92, age);
    size = 1.0 + flash * 3.0;
    tint = max(tint, flash);
    if (dot(v, v) > 0.0) {
      float f = fract(t * 0.42 + phase);
      p += v * f;
      alpha *= (1.0 - f) * smoothstep(0.0, 0.06, f);
    } else if (p.y > 0.1) {
      float blink = 0.5 + 0.5 * sin(t * 4.2);
      alpha *= 0.45 + 0.55 * blink;
      size += blink * 0.4;
    }
  } else if (kind == ${KIND.trip}) {
    // A trip leaves a home once the scene has begun, so the roads fill as demand builds.
    // Those reaching the queue slow to a crawl, and its tail grows back up the road.
    vec4 road = TRIP_ROADS[int(v.x + 0.5)];
    float len = length(road.zw - road.xy);
    vec2 along = (road.zw - road.xy) / len;
    float rate = 0.26;
    float cycle = fract(t * rate + phase);
    float s = cycle * len * 2.7;
    float q = clamp((age - 1.4) * 0.2, 0.0, 0.62) * v.y * len;
    float tail = len - q;
    float crawl = 0.3;
    float x = s;
    alpha = step(0.0, age - cycle / rate) * smoothstep(0.0, 0.08, s / len);
    if (s > tail) {
      if (s < tail + q / crawl) {
        x = tail + (s - tail) * crawl;
        hue = (x - tail) / max(q, 1e-3) > 0.35 ? 2.0 : 1.0;
      } else {
        x = len;
        alpha = 0.0; // In through the door.
      }
    }
    vec2 at = road.xy + along * (x + p.x) + vec2(-along.y, along.x) * p.z;
    p = vec3(at.x, p.y, at.y);
  } else if (kind == ${KIND.beam}) {
    float g = ease((age - 0.5) / 3.6);
    p.y = v.y + (p.y - v.y) * g;
    alpha = smoothstep(0.0, 0.08, g) * (0.7 + 0.3 * sin(t * 3.0 + p.y * 24.0));
  } else if (kind == ${KIND.dock}) {
    // Phase is when it comes, on the scene's own clock. It arrives, overshoots a little and settles.
    float g = ease((age - phase) / 0.7);
    float settle = 1.0 - g;
    p += v * settle * settle;
    alpha = smoothstep(0.0, 0.3, g);
    size = 1.0 + exp(-pow((age - phase - 0.72) * 5.0, 2.0)) * 1.1;
  } else if (kind == ${KIND.tower}) {
    // Grows as the first ripple passes, and turns into the second city as the second one does.
    float d = v.z;
    float first = ease(((age - ${SEEDS_AT[0].toFixed(2)}) * 1.75 - d) / 0.42);
    float second = ease(((age - ${SEEDS_AT[1].toFixed(2)}) * 1.9 - d) / 0.42);
    float h = mix(0.0, v.x, first);
    h = mix(h, v.y, second);
    p.y = p.y * h + ${SEAM.toFixed(2)};
    float front = exp(-pow((age - ${SEEDS_AT[0].toFixed(2)}) * 1.75 - d, 2.0) * 16.0) + exp(-pow((age - ${SEEDS_AT[1].toFixed(2)}) * 1.9 - d, 2.0) * 16.0);
    alpha = smoothstep(0.0, 0.03, h);
    tint = max(tint, min(1.0, front));
    size = 1.0 + min(1.0, front) * 0.9;
  } else if (kind == ${KIND.ripple}) {
    float x = age - phase;
    float reach = x * 1.9;
    p = v * reach;
    p.y = ${SEAM.toFixed(2)};
    alpha = step(0.0, x) * smoothstep(2.3, 0.2, reach);
    size = 1.0;
  } else if (kind == ${KIND.seedfall}) {
    // Falls with gathering speed, meets its twin at the seam, and is spent.
    float x = clamp((age - phase + 0.62) / 0.62, 0.0, 1.0);
    float y = v.y * 1.3 * (1.0 - x * x);
    float spent = smoothstep(phase, phase + 0.22, age);
    p = vec3(p.x, p.y + y + ${SEAM.toFixed(2)}, 0.0);
    alpha = step(phase - 0.62, age) * (1.0 - spent);
    size = 1.6 + spent * 2.0;
  } else if (kind == ${KIND.cloth}) {
    vec3 at = clothAt(p.xz, t, age);
    p.y = at.x - 0.16;
    tint = max(tint, min(1.0, at.y * 1.7));
    if (at.y > 0.1) hue = ORB_HUE[int(at.z)];
    size = 1.0 + at.y * 1.3;
    alpha = smoothstep(0.0, 0.5, age + 0.15 - abs(p.x) * 0.1) * smoothstep(0.86, 0.22, p.z);
  } else if (kind == ${KIND.thread}) {
    int who = int(v.x + 0.5);
    float out_ = abs(p.x - JOINS[who].x);
    float since = age - JOINS[who].z;
    vec3 at = clothAt(p.xz, t, age);
    p.y = at.x - 0.16 + 0.008;
    alpha = smoothstep(out_ - 0.06, out_ + 0.06, since * 1.5) * smoothstep(3.0, 2.2, out_);
    float pulse = exp(-pow((out_ - fract(t * 0.32) * 3.2) * 5.0, 2.0));
    tint = 1.0;
    size = 1.05 + pulse * 1.4 + exp(-pow((out_ - since * 1.5) * 8.0, 2.0)) * 1.6;
  } else if (kind == ${KIND.orb}) {
    int who = int(v.x + 0.5);
    float grown = overshoot((age - JOINS[who].z + 0.55) / 0.6);
    float bob = sin(t * 1.1 + float(who) * 1.7) * 0.022;
    p = vec3(JOINS[who].x, ${ORB_HEIGHT.toFixed(2)} + bob - 0.16, JOINS[who].y) + p * grown * (1.0 + 0.08 * sin(t * 2.3 + float(who)));
    alpha = smoothstep(0.0, 0.25, age - JOINS[who].z + 0.55);
    size = 1.3;
  } else if (kind == ${KIND.strand}) {
    int who = int(v.x + 0.5);
    float f = fract(t * 0.9 + phase * 37.0);
    float bob = sin(t * 1.1 + float(who) * 1.7) * 0.022;
    vec3 at = clothAt(v.yz, t, age);
    float top = ${ORB_HEIGHT.toFixed(2)} + bob - 0.16;
    p = vec3(JOINS[who].x + p.x, mix(top, at.x - 0.16, f * f), JOINS[who].y + p.z);
    alpha = step(JOINS[who].z - 0.1, age) * smoothstep(0.0, 0.08, f) * (0.35 + 0.65 * f);
  } else if (kind == ${KIND.bracket}) {
    // Wider while the camera is moving, snapping tight each time it arrives.
    float move1 = clamp((age - 0.75) / 0.65, 0.0, 1.0);
    float move2 = clamp((age - 2.6) / 0.65, 0.0, 1.0);
    float wide = sin(move1 * PI) + sin(move2 * PI);
    float hunt = 1.0 - smoothstep(0.0, 0.75, age);
    p.xz *= 1.0 + wide * 0.34 + hunt * 0.5;
    float locked = exp(-pow((age - 1.42) * 6.0, 2.0)) + exp(-pow((age - 3.27) * 6.0, 2.0));
    size = 1.0 + locked * 1.6;
    tint = max(tint, locked);
  } else if (kind == ${KIND.boil}) {
    p += 0.035 * vec3(sin(t * 0.55 + p.y * 7.0 + phase * 6.0), sin(t * 0.65 + p.x * 6.0), cos(t * 0.5 + p.z * 7.0));
    p.x += sin(t * 0.22) * 0.09;
  } else if (kind == ${KIND.shimmer}) {
    float band = exp(-pow((p.x - (fract(t * 0.3) * 4.0 - 2.0)) * 3.4, 2.0));
    tint = max(tint, band);
    size = 1.0 + band * 0.9;
    p.z += 0.016 * sin(p.x * 4.0 + t * 1.4);
    p.y += 0.004 * sin(p.x * 9.0 + t * 2.0 + phase * 6.0);
  }
  if (inWorld) {
    // The world flies under the viewfinder to one event, then the next, closing in.
    float move1 = ease((age - 0.75) / 0.65);
    float move2 = ease((age - 2.6) / 0.65);
    vec2 aim = mix(mix(vec2(0.0), vec2(${FOCUS_A[0]}, ${FOCUS_A[1]}), move1), vec2(${FOCUS_B[0]}, ${FOCUS_B[1]}), move2);
    float zoom = mix(1.0, 1.65, move1);
    p.xz = (p.xz - aim) * zoom;
    p.x = clamp(p.x, -2.6, 2.6);
    p.z = clamp(p.z, -2.6, 2.6);
  }
  if (kind == ${KIND.rest} || kind == ${KIND.reveal}) p += 0.009 * vec3(sin(t * 0.9 + phase * 40.0), sin(t * 1.1 + phase * 57.0), cos(t * 0.8 + phase * 31.0));
  return Live(p, alpha, size, tint, hue);
}
vec3 colourOf(float tint, float hue) {
  if (hue < 0.5) return mix(uBase, uAccent, tint);
  if (hue < 1.5) return uWarm;
  if (hue < 2.5) return uDanger;
  if (hue < 3.5) return uOk;
  return uAccent;
}
void main() {
  // Particles set off as a front across the scene, not as a block and not as noise.
  // Which way that front goes changes from scene to scene: across, or outward from the middle.
  float along = dot(uFront, uFront) < 0.5 ? clamp(length(aTo) / 2.4, 0.0, 1.0) : clamp(dot(aTo, uFront) / 3.8 + 0.5, 0.0, 1.0);
  float order = mix(aSeed, along, 0.62);
  float m = clamp(uMix * 1.5 - order * 0.5, 0.0, 1.0);
  // No sudden start or stop, in speed or in the change of speed.
  m = m * m * m * (m * (m * 6.0 - 15.0) + 10.0);
  // The end blows outward from the middle all at once, hard, and then slows.
  if (uBurst > 0.5) {
    m = clamp(uMix * 1.12 - aSeed * 0.12, 0.0, 1.0);
    m = 1.0 - pow(1.0 - m, 3.4);
  }
  Live a = live(aFrom, aFromV, aFromM, uAgeFrom);
  Live b = live(aTo, aToV, aToM, uAgeTo);
  // The name draws in on itself just before it goes, as anything does before a burst.
  float drawn = 1.0 - uInhale * 0.075;
  a.p *= drawn;
  if (uBurst < 0.5) b.p *= drawn;
  vec3 p = mix(a.p, b.p, m);
  // On the way they ride one current together, each a little off its line.
  // Squared, so that what lifts them off their line begins and ends with no speed of its own.
  float swing = sin(m * 3.14159);
  float arc = swing * swing * (1.0 - uBurst);
  float angle = aSeed * 40.0 + uTime * 0.6;
  // One body of water: a slow field they are all carried by, and only a little of their own.
  vec3 current = vec3(sin(p.y * 1.7 + uTime * 0.5) + cos(p.z * 1.3 - uTime * 0.4), sin(p.z * 1.9 + uTime * 0.45) + cos(p.x * 1.1 + uTime * 0.35), sin(p.x * 1.6 - uTime * 0.5) + cos(p.y * 1.2 + uTime * 0.3));
  p += arc * (current * 0.17 + vec3(cos(angle), sin(angle * 1.3) * 0.7, sin(angle)) * (0.025 + aSeed * 0.07));
  float turn = arc * uTurn * (0.26 + aSeed * 0.14);
  p.xz = mat2(cos(turn), -sin(turn), sin(turn), cos(turn)) * p.xz;
  vec4 clip = uView * vec4(p, 1.0);
  // The pointer moves through them like a hand through water: those nearby ease aside and
  // turn a little around it, are carried along with its movement, and catch the light.
  vec2 ndc = clip.xy / clip.w;
  vec2 d = (ndc - uPointer) * vec2(uAspect, 1.0);
  float near = exp(-dot(d, d) * 11.0) * uReach;
  vec2 out_ = d / (length(d) + 0.05);
  vec2 nudge = out_ * 0.05 + vec2(-out_.y, out_.x) * (0.018 + aSeed * 0.02) + uPointerV * (0.5 + aSeed * 0.6);
  ndc += nudge * near / vec2(uAspect, 1.0);
  if (uRipple.z >= 0.0) {
    vec2 r = ndc - uRipple.xy;
    float reach = length(r) - uRipple.z * 1.5;
    ndc += normalize(r + 1e-4) * exp(-reach * reach * 60.0) * 0.07 * exp(-uRipple.z * 2.2);
  }
  // Building the map: each particle flies in on a curve to its place on a road, nearest
  // the middle first, and catches the light as it lands.
  // Letting go of the title they go nearly together, so that it grows rather than tears.
  float landOrder = uSweep < 8.0 ? aSeed * 0.3 : aLand.w;
  float l = clamp(uLand * 1.5 - landOrder * 0.5, 0.0, 1.0);
  l = l * l * (3.0 - 2.0 * l);
  // On the roads as they are now, which the camera may be carrying as the panels arrive.
  vec2 roads = aLand.xy + uLandShift;
  vec2 way = roads - ndc;
  ndc = mix(ndc, roads, l) + vec2(-way.y, way.x) * sin(l * 3.14159) * (0.1 + (aSeed - 0.5) * 0.14);
  float arriving = smoothstep(0.72, 1.0, l) * smoothstep(1.0, 0.0, (uLand * 1.5 - landOrder * 0.5 - 1.0) * 5.0);
  // The title coming apart: as the sweep passes, each particle appears, kicks out and settles.
  float swept = uSweep - aLand.w;
  float hidden = smoothstep(-0.012, 0.012, swept);
  float kick = sin(clamp(swept / 0.42, 0.0, 1.0) * PI);
  float kickAngle = aSeed * 6.283 * 7.0;
  ndc += vec2(cos(kickAngle) * 0.6 + 0.5, sin(kickAngle)) * kick * kick * (0.004 + aSeed * 0.022) * step(uSweep, 8.0);
  float seam = exp(-pow(swept * 26.0, 2.0)) * step(uSweep, 8.0);
  gl_Position = vec4(ndc * clip.w, clip.z, clip.w);
  float depth = clip.w;
  float size = mix(a.size, b.size, m);
  gl_PointSize = mix(uPixels * size * (1.0 + aSeed * 0.9 + near * 0.6) * clamp(3.4 / depth, 0.35, 2.6), uPixels * (0.85 + arriving * 1.5 + seam * 1.1), l);
  float tint = mix(a.tint, b.tint, m);
  vColour = mix(mix(colourOf(a.tint, a.hue), colourOf(b.tint, b.hue), m), uSweep < 8.0 ? uBase : mix(uRoad, uAccent, arriving * 0.7), l);
  // Nearer and further than the focal distance falls away, as with a lens.
  float shown = (0.32 + tint * 0.68) * clamp(1.5 - abs(depth - 3.1) * 0.5, 0.18, 1.0) * mix(a.alpha, b.alpha, m);
  // A little quieter in flight, so that the crossing is a veil, not a blaze.
  shown = min(1.0, shown * (1.0 + near * 0.9)) * (1.0 - 0.3 * swing * (1.0 - uBurst));
  vAlpha = mix(shown, 0.92, l) * hidden;
  vColour = mix(vColour, uAccent, max(seam, near * 0.35 * (1.0 - l)));
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec3 vColour;
in float vAlpha;
uniform float uDim, uCover;
out vec4 colour;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = min(1.0, smoothstep(0.5, 0.08, d) * vAlpha * uDim);
  // Part light, part paint: enough cover that a crowded point keeps its colour rather than
  // adding up to white, which is what lets a signal look red.
  colour = vec4(vColour * a, a * uCover);
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

export function BootScene({ playing, asleep = false, closing = false, landing, ending = false, rejoin = false, quiet = false, quick = false, onCycle, reduceMotion }: {
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
  /** Back into a run already going: the name, then the roads, and no film. */
  quick?: boolean;
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
      attribute("aFromM", scenes[from], 4, 6);
      attribute("aTo", scenes[to], 3, 0);
      attribute("aToV", scenes[to], 3, 3);
      attribute("aToM", scenes[to], 4, 6);
    };
    // Only the end of a session comes to rest in it.
    const mist = ending && !rejoin ? scenes.push((() => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, endMist(), gl.STATIC_DRAW);
      return buffer;
    })()) - 1 : 0;
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const u = { view: uniform("uView"), mix: uniform("uMix"), time: uniform("uTime"), pixels: uniform("uPixels"), pointer: uniform("uPointer"), ripple: uniform("uRipple"), base: uniform("uBase"), accent: uniform("uAccent"), warm: uniform("uWarm"), danger: uniform("uDanger"), ok: uniform("uOk"), road: uniform("uRoad"), ageFrom: uniform("uAgeFrom"), ageTo: uniform("uAgeTo"), sweep: uniform("uSweep"), dim: uniform("uDim"), cover: uniform("uCover"), land: uniform("uLand"), aspect: uniform("uAspect"), reach: uniform("uReach"), pointerV: uniform("uPointerV"), burst: uniform("uBurst"), inhale: uniform("uInhale"), front: uniform("uFront"), turn: uniform("uTurn"), landShift: uniform("uLandShift") };
    const landAt = gl.getAttribLocation(program, "aLand");
    const landBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, landBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(COUNT * 4), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(landAt);
    gl.vertexAttribPointer(landAt, 4, gl.FLOAT, false, 0, 0);

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
      if (quick) from = wordmark;
      bind(from, to);
      blend = quick ? 1 : 0;
      morph = blend;
      velocity = 0;
    };
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
      gl.uniform3fv(u.warm, rgb(style.getPropertyValue("--warn-rgb"), [1, 0.72, 0.22]));
      gl.uniform3fv(u.danger, rgb(style.getPropertyValue("--danger-rgb"), [1, 0.42, 0.45]));
      gl.uniform3fv(u.ok, rgb(style.getPropertyValue("--ok-rgb"), [0.37, 0.89, 0.75]));
      // Once landed they are the map's own roads, in the map's own colour.
      const clear = appearance.meaning.clear;
      gl.uniform3f(u.road, parseInt(clear.slice(1, 3), 16) / 255, parseInt(clear.slice(3, 5), 16) / 255, parseInt(clear.slice(5, 7), 16) / 255);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(u.cover, light ? 1 : 0.7);
      strength = light ? 1.5 : 1;
      if (reduceMotion) paint();
    };
    // The theme can arrive after this does, and can change while it plays.
    const themes = new MutationObserver(colours);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-vision"] });

    let wordmark = -1;
    let started = false;
    let wordmarkUv: Float32Array | null = null;
    let logoFrame: HTMLElement | null = null;
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
    let morph = 1;
    let scene = 0; // Which chapter the cloud is showing.
    let held = 0;
    let sweep = 9; // Where the title's sweep has got to, once it starts.
    let ageFrom = 99; // How long each of the two scenes being mixed has been on screen.
    let ageTo = 0;
    let time = 0;
    let frame = 0;
    let dim = asleepRef.current || ending ? 0 : playingRef.current ? 1 : REST_DIM;
    let strength = 1;
    let count = COUNT;
    let slow = 0;
    const camera = { yaw: CAMERAS[0].yaw, pitch: CAMERAS[0].pitch, distance: CAMERAS[0].distance, orbit: 0 };
    let leaving = { yaw: camera.yaw, pitch: camera.pitch, distance: camera.distance };
    let travel = 1;
    // Closing slowly on whatever is holding, once the camera has arrived.
    const pushed = () => 1 - CAMERAS[scene].push * easeInOut((held - CAMERA_S * 0.7) / (HOLDS[scene] + 1 - CAMERA_S * 0.7));
    // Where the pointer is, and the softer place the particles feel it, which follows it.
    const pointer = { x: 0, y: 0, vx: 0, vy: 0, toX: 0, toY: 0, dx: 0, dy: 0, reach: 0, inside: false, movedAt: 0 };
    let ripple = { x: 0, y: 0, age: -1 };
    let last = performance.now();

    function paint() {
      if (!gl || !element) return;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniformMatrix4fv(u.view, false, viewMatrix(element.width / element.height, camera.yaw + camera.orbit + Math.sin(time * 0.23) * 0.008, camera.pitch + Math.sin(time * 0.31) * 0.01, camera.distance * pushed()));
      gl.uniform1f(u.ageFrom, ageFrom);
      gl.uniform1f(u.ageTo, ageTo);
      gl.uniform1f(u.sweep, sweep);
      gl.uniform1f(u.mix, blend);
      gl.uniform3fv(u.front, FRONTS[scene % FRONTS.length]);
      gl.uniform1f(u.turn, scene % 2 ? 1 : -1);
      gl.uniform1f(u.land, landing);
      gl.uniform1f(u.time, time);
      gl.uniform2f(u.pointer, pointer.x, pointer.y);
      gl.uniform2f(u.pointerV, pointer.dx, pointer.dy);
      gl.uniform1f(u.reach, pointer.reach);
      gl.uniform1f(u.aspect, element.width / element.height);
      gl.uniform1f(u.burst, endScattered && !rejoin ? 1 : 0);
      gl.uniform1f(u.inhale, ending && !rejoin && started ? easeInOut((performance.now() / 1000 - endStart - (END_SCATTER_AT_S - 0.42)) / 0.42) : 0);
      gl.uniform2f(u.landShift, (mapCarry.x / window.innerWidth) * 2, -(mapCarry.y / window.innerHeight) * 2);
      gl.uniform3f(u.ripple, ripple.x, ripple.y, ripple.age);
      gl.uniform1f(u.dim, dim * strength);
      gl.drawArrays(gl.POINTS, 0, count);
    }
    const next = (restTo?: number) => {
      const after = restTo ?? (scene + 1) % FILM_CHAPTERS.length;
      if (restTo === undefined && after === 0) cycleRef.current?.();
      const buffer = (chapterIndex: number) => (chapterIndex === 0 ? (wordmark >= 0 ? wordmark : 0) : chapterIndex);
      const closedTo = pushed();
      from = to;
      to = buffer(after);
      scene = after;
      bind(from, to);
      blend = 0;
      morph = 0;
      velocity = 0;
      ageFrom = ageTo;
      ageTo = 0;
      // Each scene has its own framing. The drift of the last one is folded into the
      // camera, which then turns by the short way to where this one should be seen.
      const turn = Math.PI * 2;
      const yaw = camera.yaw + camera.orbit;
      // From exactly where it is, slow push included, so that nothing jumps as the scene changes.
      leaving = { yaw: CAMERAS[after].yaw + ((((yaw - CAMERAS[after].yaw + Math.PI) % turn) + turn) % turn) - Math.PI, pitch: camera.pitch, distance: camera.distance * closedTo };
      camera.yaw = leaving.yaw;
      camera.distance = leaving.distance;
      camera.orbit = 0;
      travel = 0;
      held = 0;
      setChapter(after);
    };
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      time += dt;
      held += dt;
      ageFrom += dt;
      // A scene starts its own story as the particles arrive, not as they set off.
      ageTo += blend > 0.55 ? dt : 0;
      // Blown apart, it goes as a spring does, all at once. Otherwise steadily, with each particle easing.
      if (endScattered && !rejoin) [blend, velocity] = stepSpring(blend, velocity, 1, BURST, dt);
      else blend = morph = Math.min(1, morph + dt / (closingRef.current ? GATHER_S : MORPH_S));
      const want = CAMERAS[scene];
      // One unhurried move from where it was to where this scene is seen from, drawing back a little
      // on the way as a crane does. Its slow drift comes in only once it has arrived.
      travel = Math.min(1, travel + dt / CAMERA_S);
      const moved = smoother(travel);
      camera.yaw = leaving.yaw + (want.yaw - leaving.yaw) * moved;
      camera.pitch = leaving.pitch + (want.pitch - leaving.pitch) * moved;
      camera.distance = (leaving.distance + (want.distance - leaving.distance) * moved) * (1 + Math.sin(moved * Math.PI) * 0.065);
      camera.orbit += want.spin * dt * smoother((travel - 0.55) / 0.45);
      // The wordmark faces the viewer; it sways, and does not turn away.
      if (scene === 0) camera.orbit += (Math.sin(time * 0.5) * 0.06 - camera.orbit) * Math.min(1, dt * 2);
      if (ripple.age >= 0) ripple = { ...ripple, age: ripple.age > 1.6 ? -1 : ripple.age + dt };
      const [lastX, lastY] = [pointer.x, pointer.y];
      [pointer.x, pointer.vx] = stepSpring(pointer.x, pointer.vx, pointer.toX, POINTER, dt);
      [pointer.y, pointer.vy] = stepSpring(pointer.y, pointer.vy, pointer.toY, POINTER, dt);
      pointer.dx += ((pointer.x - lastX) - pointer.dx) * Math.min(1, dt * 7);
      pointer.dy += ((pointer.y - lastY) - pointer.dy) * Math.min(1, dt * 7);
      const wanted = pointer.inside && now - pointer.movedAt < 2400 ? 1 : 0;
      pointer.reach += (wanted - pointer.reach) * Math.min(1, dt * (wanted ? 5 : 1.4));
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
          // First the name, as the end of a session finishes on it.
          if (wordmark >= 0 && to !== wordmark) next(0);
        }
      }
      if (closingFor >= 0) closingFor += dt;
      if (landed) landing = Math.max(landedFrom, quick ? easeInOut(closingFor / QUICK_LAND_S) : easeInOut((closingFor - GATHER_S) / LAND_S));
      else if (dissolving) {
        sweep = (held - SWEEP_DELAY_S) / SWEEP_S;
        logoFrame?.style.setProperty("--sweep", String(Math.max(-0.1, Math.min(1.1, sweep))));
        landing = 1 - easeInOut((held - DISSOLVE_HOLD_S) / DISSOLVE_S);
        if (landing <= 0.0001) {
          landing = 0;
          dissolving = false;
          sweep = 9;
        }
      } else if (ending && started && !rejoined) {
        // The end: off the roads and into the name, from the edges in, and then it is blown away.
        const t = now / 1000 - endStart;
        landing = 1 - easeInOut((t - END_GATHER_AT_S) / END_GATHER_S);
        if (t > END_SCATTER_AT_S && !endScattered) {
          endScattered = true;
          from = to;
          to = rejoin ? 0 : mist;
          bind(from, to);
          blend = 0;
          morph = 0;
          velocity = 0;
        }
        if (t > END_STILL_S && !rejoin) {
          dim = 0;
          paint();
          return; // Nothing else will happen here, so nothing else is spent.
        }
      }
      // Having landed, they give way to the map's own roads.
      const endingDim = quietRef.current ? REST_DIM : ending && !rejoined ? (!rejoin && now / 1000 - endStart > END_THIN_AT_S ? 0 : now / 1000 - endStart > END_ROADS_AT_S ? 1 : 0) : null;
      const dimTo = endingDim ?? (landed ? (closingFor > ((quick ? QUICK_ARRIVAL.mapAt : MAP_AT_MS) + (quick ? 220 : 500)) / 1000 ? 0 : 1) : closingRef.current || asleepRef.current ? 0 : playingRef.current ? 1 : REST_DIM);
      dim += (dimTo - dim) * Math.min(1, dt * (quietRef.current ? 1.6 : ending && !rejoined ? (now / 1000 - endStart > END_SCATTER_AT_S ? 0.72 : 5) : landed ? (quick ? 5 : 2.6) : dissolving ? 3.2 : playingRef.current && !closingRef.current ? 2.4 : 8));
      // The old world's particles, blown apart, come back together as the name, and the
      // film carries on from there as it does at start-up.
      if (rejoin && started && !rejoined && playingRef.current) {
        rejoined = true;
        from = to;
        to = wordmark;
        scene = 0;
        bind(from, to);
        blend = 0;
        morph = 0;
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
        morph = 1;
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
            const points = new Float32Array(COUNT * 4);
            for (let i = 0; i < COUNT; i++) {
              const x = logo.left + wordmarkUv[i * 2] * logo.width;
              const y = logo.top + wordmarkUv[i * 2 + 1] * logo.height;
              points.set([(x / window.innerWidth) * 2 - 1, 1 - (y / window.innerHeight) * 2, 0.8, wordmarkUv[i * 2]], i * 4);
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, landBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, points, gl.DYNAMIC_DRAW);
            from = to = wordmark;
            bind(from, to);
            blend = 1;
            morph = 1;
            landing = 1;
            dissolving = true;
            logoFrame = document.querySelector<HTMLElement>(".boot-title-logo");
            sweep = -0.1;
            dim = 1;
          } else if (wordmark >= 0) {
            to = wordmark;
            if (quick) from = wordmark;
            bind(from, to);
            blend = quick ? 1 : 0;
            morph = blend;
            velocity = 0;
          }
        }
        if (held > HOLDS[scene] && !closingRef.current && !quick) next();
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
      pointer.toX = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.toY = 1 - (event.clientY / window.innerHeight) * 2;
      // Arriving from outside, it starts where it is rather than sweeping across.
      if (!pointer.inside && pointer.reach < 0.02) [pointer.x, pointer.y, pointer.vx, pointer.vy] = [pointer.toX, pointer.toY, 0, 0];
      pointer.inside = true;
      pointer.movedAt = performance.now();
    };
    const onLeave = () => {
      pointer.inside = false;
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
  }, [reduceMotion, ending, rejoin, quick]);

  const shown = FILM_CHAPTERS[playing ? chapter : 0];
  return (
    <>
      {/* A context is lost for good when the scene restarts, so each restart gets a new canvas. */}
      <canvas key={`${reduceMotion}/${ending}/${rejoin}/${quick}`} ref={canvas} className="boot-scene" aria-hidden="true" />
      {playing && !quick && (
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
