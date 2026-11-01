// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef, useState } from "react";
import { LOGO_SVG } from "./logoAsset";
import { appearance } from "./appearance";
import { stepSpring } from "./motion";
import { BLOOM_HALF, BLOOM_POINTS, BLOOM_REACH, buildFormations, CAMERA_YAW_INCIDENT, COUNT, endMist, FOCUS_A, FOCUS_B, formation, IN_WORLD, KIND, sequence, STRIDE, WRECK_AT } from "./bootScenes";

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
const HOLDS = [4, 4.4, 6.2, 4.6, 4.4, 5.4, 4, 4, 5, 4.6, 4];
const MORPH = { k: 11, c: 5.6 };
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
const CAMERA = { k: 9, c: 6 };
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
const END_THIN_AT_S = 4.9;
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
  { label: "Extensions", title: "WebFabric", text: "Connect your own applications." },
];

interface Camera { yaw: number; pitch: number; distance: number; spin: number; push: number }
const CAMERAS: Camera[] = [
  { yaw: 0, pitch: 0, distance: 3.1, spin: 0.012, push: 0.03 },
  { yaw: 0.2, pitch: 1.2, distance: 3.7, spin: 0.018, push: 0.07 },
  { yaw: -0.28, pitch: 1.02, distance: 3.3, spin: 0.02, push: 0.07 },
  { yaw: 0, pitch: 0.06, distance: 3.35, spin: 0.006, push: 0.04 },
  { yaw: 0, pitch: 0.03, distance: 3.25, spin: 0.006, push: 0.04 },
  { yaw: CAMERA_YAW_INCIDENT, pitch: 0.46, distance: 3.05, spin: 0.006, push: 0.05 },
  { yaw: 0.26, pitch: 0.13, distance: 3.75, spin: -0.04, push: 0.07 },
  { yaw: 0.2, pitch: 0.3, distance: 3.3, spin: 0.26, push: 0.05 },
  { yaw: 0, pitch: 0.03, distance: 3.5, spin: 0.004, push: 0.04 },
  { yaw: 0.14, pitch: 1.12, distance: 3.2, spin: 0.012, push: 0.03 },
  { yaw: 0.55, pitch: 0.78, distance: 3.2, spin: -0.05, push: 0.08 },
];

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
uniform float uMix, uTime, uPixels, uLand, uAgeFrom, uAgeTo, uSweep;
uniform vec2 uPointer;
uniform vec3 uRipple, uBase, uAccent, uWarm, uDanger, uOk, uRoad;
out vec3 vColour;
out float vAlpha;
const float PI = 3.14159265;
float ease(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
float overshoot(float x) { x = clamp(x, 0.0, 1.0) - 1.0; return 1.0 + 2.4 * x * x * x + 1.4 * x * x; }
// The junction's cycle, 6 s. Each road has 2.4 s of green, 0.6 s of amber, then red.
float cycleOf(bool north, float age) { return mod(age + 0.5 + (north ? 0.0 : 3.0), 6.0); }
// How much a road is held, for a vehicle this far behind the stop line: the queue goes from the front.
float heldAt(float x, float behind) {
  if (x < 2.4) return 1.0 - smoothstep(behind, behind + 0.5, x);
  return smoothstep(2.4, 2.95, x);
}
float rhythm(float h) {
  return 0.05 + 0.62 * exp(-pow(h - 8.3, 2.0) / 3.2) + 0.76 * exp(-pow(h - 17.6, 2.0) / 4.2) + 0.2 * exp(-pow(h - 12.8, 2.0) / 14.0);
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
  } else if (kind == ${KIND.stream}) {
    float f = fract(t * 0.07 + phase * 37.0);
    float r = rhythm(f * 24.0);
    float x = -1.75 + 3.5 * f;
    float grow = smoothstep(0.0, 0.1, age / 2.4 - f);
    p = vec3(x, 0.06 + v.x * r * 0.88 * mix(0.35, 1.0, grow), v.z * r * 0.4);
    alpha = 0.35 + 0.65 * grow;
    tint = 0.28 + r * 0.8;
    float noise = fract(phase * 91.0) * 0.12;
    hue = r > 0.6 + noise ? 2.0 : (r > 0.34 + noise ? 1.0 : 0.0);
  } else if (kind == ${KIND.gauge}) {
    float filled = v.x * ease((age - 0.2) / 2.6);
    alpha = smoothstep(filled + 0.012, filled - 0.004, phase);
    float front = exp(-pow((phase - filled) * 34.0, 2.0));
    size = 1.0 + front * 2.0;
    p.z += 0.0;
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
  } else if (kind == ${KIND.bloom}) {
    // The same point of the same pattern on both screens, on the same clock: a small
    // change of angle turns the whole bloom through one form after another. It fills its
    // screen, and the screen's edge cuts it off.
    float k = v.x;
    float n = sqrt(k / ${BLOOM_POINTS}.0);
    float grown = ease(age / 1.8);
    float angle = k * (2.39996 + 0.0011 * pow(sin(age * 0.46), 2.0));
    float r = n * ${BLOOM_REACH.toFixed(2)} * (0.3 + 0.7 * grown);
    vec2 off = vec2(cos(angle), sin(angle)) * r;
    p = vec3(v.y + off.x, v.z + off.y, p.z);
    vec2 past = abs(off) - vec2(${BLOOM_HALF[0].toFixed(2)} - 0.17, ${BLOOM_HALF[1].toFixed(2)} - 0.17);
    float inside = length(max(past, 0.0)) - 0.13;
    alpha = smoothstep(0.012, -0.012, inside) * smoothstep(n - 0.08, n + 0.02, grown * 1.1);
    // Its spirals, lit, so that its form can be seen to change.
    float arm = fract(k / 34.0);
    tint = 0.16 + 0.84 * smoothstep(0.62, 0.98, arm);
    float wave = exp(-pow((n - fract(t * 0.3) * 1.4) * 5.0, 2.0));
    tint = max(tint, wave * 0.8);
    size = 0.85 + wave * 0.5;
  } else if (kind == ${KIND.wave}) {
    p.y += 0.075 * sin(p.x * 2.6 + p.z * 1.8 - t * 1.9) + 0.03 * sin(p.z * 5.0 + t * 1.2);
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
  float order = mix(aSeed, clamp((aTo.x + 1.9) / 3.8, 0.0, 1.0), 0.62);
  float m = clamp(uMix * 1.5 - order * 0.5, 0.0, 1.0);
  m = m * m * (3.0 - 2.0 * m);
  Live a = live(aFrom, aFromV, aFromM, uAgeFrom);
  Live b = live(aTo, aToV, aToM, uAgeTo);
  vec3 p = mix(a.p, b.p, m);
  // On the way they ride one current together, each a little off its line.
  float swing = sin(m * 3.14159);
  float angle = aSeed * 40.0 + uTime * 0.6;
  vec3 current = vec3(sin(p.y * 2.3 + uTime * 0.7), sin(p.z * 2.1 + uTime * 0.6 + 1.3), cos(p.x * 2.5 + uTime * 0.5));
  p += swing * (current * 0.3 + vec3(cos(angle), sin(angle * 1.3) * 0.7, sin(angle)) * (0.06 + aSeed * 0.14));
  float turn = swing * (0.35 + aSeed * 0.35);
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
  // Building the map: each particle flies in on a curve to its place on a road, nearest
  // the middle first, and catches the light as it lands.
  // Letting go of the title they go nearly together, so that it grows rather than tears.
  float landOrder = uSweep < 8.0 ? aSeed * 0.3 : aLand.w;
  float l = clamp(uLand * 1.5 - landOrder * 0.5, 0.0, 1.0);
  l = l * l * (3.0 - 2.0 * l);
  vec2 way = aLand.xy - ndc;
  ndc = mix(ndc, aLand.xy, l) + vec2(-way.y, way.x) * sin(l * 3.14159) * (0.1 + (aSeed - 0.5) * 0.14);
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
  gl_PointSize = mix(uPixels * size * (1.0 + aSeed * 0.9) * clamp(3.4 / depth, 0.35, 2.6), uPixels * (0.85 + arriving * 1.5 + seam * 1.1), l);
  float tint = mix(a.tint, b.tint, m);
  vColour = mix(mix(colourOf(a.tint, a.hue), colourOf(b.tint, b.hue), m), uSweep < 8.0 ? uBase : mix(uRoad, uAccent, arriving * 0.7), l);
  // Nearer and further than the focal distance falls away, as with a lens.
  float shown = (0.32 + tint * 0.68) * clamp(1.5 - abs(depth - 3.1) * 0.5, 0.18, 1.0) * mix(a.alpha, b.alpha, m);
  vAlpha = mix(shown, 0.92, l) * hidden;
  vColour = mix(vColour, uAccent, seam);
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
    const u = { view: uniform("uView"), mix: uniform("uMix"), time: uniform("uTime"), pixels: uniform("uPixels"), pointer: uniform("uPointer"), ripple: uniform("uRipple"), base: uniform("uBase"), accent: uniform("uAccent"), warm: uniform("uWarm"), danger: uniform("uDanger"), ok: uniform("uOk"), road: uniform("uRoad"), ageFrom: uniform("uAgeFrom"), ageTo: uniform("uAgeTo"), sweep: uniform("uSweep"), dim: uniform("uDim"), cover: uniform("uCover"), land: uniform("uLand") };
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
    const camera = { yaw: CAMERAS[0].yaw, pitch: CAMERAS[0].pitch, distance: CAMERAS[0].distance, vy: 0, vp: 0, vd: 0, orbit: 0 };
    const pointer = { x: 9, y: 9 };
    let ripple = { x: 0, y: 0, age: -1 };
    let last = performance.now();

    function paint() {
      if (!gl || !element) return;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // Closing slowly on whatever is holding.
      const push = 1 - CAMERAS[scene].push * easeInOut(held / (HOLDS[scene] + 1));
      gl.uniformMatrix4fv(u.view, false, viewMatrix(element.width / element.height, camera.yaw + camera.orbit, camera.pitch + Math.sin(time * 0.31) * 0.012, camera.distance * push));
      gl.uniform1f(u.ageFrom, ageFrom);
      gl.uniform1f(u.ageTo, ageTo);
      gl.uniform1f(u.sweep, sweep);
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
      ageFrom = ageTo;
      ageTo = 0;
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
      ageFrom += dt;
      // A scene starts its own story as the particles arrive, not as they set off.
      ageTo += blend > 0.55 ? dt : 0;
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
