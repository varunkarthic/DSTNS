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
const HOLD_S = 4.6;
const MORPH = { k: 11, c: 5.6 };
const CAMERA = { k: 9, c: 6 };

export const FILM_CHAPTERS: readonly { title: string; text: string }[] = [
  { title: "Deterministic Spatiotemporal Transport Network Simulator", text: "A full day of a city's traffic, computed second by second." },
  { title: "Real streets", text: "Every world is a real district, read from OpenStreetMap." },
  { title: "Places that move people", text: "Schools, offices, malls and stores shape demand through the day." },
  { title: "One-second physics", text: "Traffic advances in fixed one-second steps, whatever the playback speed." },
  { title: "Weather and flooding", text: "Rain cells cross the district, and flooded roads change how traffic moves." },
  { title: "One seed, one day", text: "The same seed gives the same day, second by second, on any machine." },
  { title: "Built to be extended", text: "Applications connect through Fabric and appear in the interface through WebFabric." },
];

interface Camera { yaw: number; pitch: number; distance: number; spin: number }
const CAMERAS: Camera[] = [
  { yaw: 0, pitch: 0, distance: 3.1, spin: 0.012 },
  { yaw: 0.5, pitch: 0.95, distance: 3.5, spin: 0.05 },
  { yaw: -0.7, pitch: 0.62, distance: 3.2, spin: 0.06 },
  { yaw: 0.9, pitch: 0.82, distance: 2.9, spin: -0.05 },
  { yaw: -0.3, pitch: 0.34, distance: 3.3, spin: 0.04 },
  { yaw: 0, pitch: 0.2, distance: 3.2, spin: 0.12 },
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
function wordmarkFormation(image: HTMLImageElement): Float32Array | null {
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
  return formation((put, random) => {
    const scale = 2.1 / width;
    for (let i = 0; i < COUNT; i++) {
      const pick = Math.floor(random() * (inside.length / 2)) * 2;
      put(i, (inside[pick] + random() - width / 2) * scale, (height / 2 - inside[pick + 1] - random()) * scale, (random() - 0.5) * 0.05, 0, 0, 0, random() < 0.12 ? 0.8 : 0.3);
    }
  }, 18);
}

const VERTEX = `#version 300 es
in vec3 aFrom, aFromV, aTo, aToV;
in float aFromTint, aToTint;
in float aSeed;
uniform mat4 uView;
uniform float uMix, uTime, uPixels;
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
  gl_Position = vec4(ndc * clip.w, clip.z, clip.w);
  float depth = clip.w;
  gl_PointSize = uPixels * (1.0 + aSeed * 0.9) * clamp(3.4 / depth, 0.35, 2.6);
  vTint = mix(aFromTint, aToTint, m);
  // Nearer and further than the focal distance falls away, as with a lens.
  vAlpha = (0.32 + vTint * 0.68) * clamp(1.5 - abs(depth - 3.1) * 0.5, 0.18, 1.0);
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

export function BootScene({ playing, closing = false, reduceMotion }: {
  /** The film runs; otherwise the wordmark holds, for a screen that is not loading anything. */
  playing: boolean;
  closing?: boolean;
  reduceMotion: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [chapter, setChapter] = useState(0);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const closingRef = useRef(closing);
  closingRef.current = closing;

  useEffect(() => {
    const element = canvas.current;
    const gl = element?.getContext("webgl2", { alpha: true, antialias: false, powerPreference: "low-power" }) ?? null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const advanceCaption = () => setChapter((c) => (c + 1) % FILM_CHAPTERS.length);
    if (!element || !gl) {
      // No particles, but the film's words still play.
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
    const u = { view: uniform("uView"), mix: uniform("uMix"), time: uniform("uTime"), pixels: uniform("uPixels"), pointer: uniform("uPointer"), ripple: uniform("uRipple"), base: uniform("uBase"), accent: uniform("uAccent"), dim: uniform("uDim") };

    // Starts as the cloud, and the first thing it does is become the wordmark.
    let from = 0, to = 0;
    bind(from, to);
    const image = new Image();
    let cancelled = false;
    image.onload = () => {
      if (cancelled) return;
      const mark = wordmarkFormation(image);
      if (!mark) return;
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, mark, gl.STATIC_DRAW);
      // The cloud stays what the film first gathers out of, and the wordmark takes its turn.
      scenes.push(buffer);
      wordmark = scenes.length - 1;
      if (reduceMotion) return;
      to = wordmark;
      bind(from, to);
      blend = 0;
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
    let blend = 1;
    let velocity = 0;
    let scene = 0; // Which chapter the cloud is showing.
    let held = 0;
    let time = 0;
    let frame = 0;
    let dim = 1;
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
      gl.uniform1f(u.time, time);
      gl.uniform2f(u.pointer, pointer.x, pointer.y);
      gl.uniform3f(u.ripple, ripple.x, ripple.y, ripple.age);
      gl.uniform1f(u.dim, dim * strength);
      gl.drawArrays(gl.POINTS, 0, count);
    }
    const next = () => {
      const after = playingRef.current ? (scene + 1) % FILM_CHAPTERS.length : 0;
      const buffer = (chapterIndex: number) => (chapterIndex === 0 ? (wordmark >= 0 ? wordmark : 0) : chapterIndex);
      from = to;
      to = buffer(after);
      scene = after;
      bind(from, to);
      blend = 0;
      velocity = 0;
      held = 0;
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
      const dimTo = closingRef.current ? 0 : 1;
      dim += (dimTo - dim) * Math.min(1, dt * 8);
      if (playingRef.current && held > HOLD_S) next();
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
  }, [reduceMotion]);

  const shown = FILM_CHAPTERS[playing ? chapter : 0];
  return (
    <>
      <canvas ref={canvas} className="boot-scene" aria-hidden="true" />
      {playing && (
        <div className="film-caption" aria-hidden="true" key={chapter}>
          <span className="film-chapter mono">{String(chapter + 1).padStart(2, "0")} / {String(FILM_CHAPTERS.length).padStart(2, "0")}</span>
          <h3>{shown.title}</h3>
          <p>{shown.text}</p>
        </div>
      )}
    </>
  );
}
