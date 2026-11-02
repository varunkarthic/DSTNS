// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { filmAvailable, landingPoints } from "./BootScene";
import { coverFrame, paintCover } from "./reportCover";
import type { MapTransform } from "./NetworkMap";
import type { Snapshot, Topology } from "./types";

/**
 * The report being made, in the start-up film's language. The map's own roads brighten as the interface
 * softens behind them. They lift off as particles, ride one current together, and land on the same roads as
 * the cover draws them, and the cover then fades in under them, as the map does under its roads at the
 * start. Once the file is ready it saves, and they go back the way they came. Nothing is timed to look
 * busy: the work is on a worker, and this only has to be worth watching for the few seconds it takes.
 */

export interface ReportPreview {
  city: string;
  country: string;
  seed: string;
  generated: string;
  topology: Topology;
  snapshot: Snapshot;
  virtualS: number;
}

const COUNT = 18000;
// All of these are seconds, and all of them are eased in the shader or here.
const LIFT_S = 0.35;
const GATHER_S = 2.4;
const COVER_AT_S = LIFT_S + GATHER_S * 0.76;
const COVER_S = 1.05;
const MIN_S = 4.1;
const RETURN_S = 1.95;

const smoother = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

const VERTEX = `#version 300 es
in vec2 aFrom, aTo;
in vec3 aMeta; // seed, order, how much of it stays once it is on the page
uniform float uMix, uTime, uAspect, uAlpha, uPixels, uSettle, uSweep;
uniform vec3 uInk, uLit;
out vec3 vColour;
out float vAlpha;
const float PI = 3.14159265;
void main() {
  float seed = aMeta.x;
  // A front, from the middle outward, and no sudden start or stop in speed or in the change of speed.
  float m = clamp(uMix * 1.5 - aMeta.y * 0.5, 0.0, 1.0);
  m = m * m * m * (m * (m * 6.0 - 15.0) + 10.0);
  vec2 p = mix(aFrom, aTo, m);
  vec2 q = vec2(p.x * uAspect, p.y);
  // One body of water: a slow field they are all carried by, and only a little of their own. Squared, so
  // that it adds no speed of its own where a particle starts or stops.
  float swing = sin(m * PI);
  float arc = swing * swing;
  vec2 current = vec2(sin(q.y * 1.9 + uTime * 0.5) + cos(q.x * 1.3 - uTime * 0.4), sin(q.x * 1.7 + uTime * 0.45) + cos(q.y * 1.1 + uTime * 0.35));
  float angle = seed * 40.0 + uTime * 0.6;
  q += arc * (current * 0.075 + vec2(cos(angle), sin(angle * 1.3)) * (0.012 + seed * 0.03));
  float turn = arc * (0.22 + seed * 0.12);
  q = mat2(cos(turn), -sin(turn), sin(turn), cos(turn)) * q;
  gl_Position = vec4(q.x / uAspect, q.y, 0.0, 1.0);
  // While the work goes on, a slow light passes down the page's roads.
  float band = exp(-pow((aTo.y - uSweep) * 9.0, 2.0)) * m;
  gl_PointSize = uPixels * (1.0 + seed * 0.7) * (1.0 + 0.3 * swing + band * 0.7);
  vAlpha = uAlpha * mix(1.0, aMeta.z, smoothstep(0.55, 1.0, m)) * (1.0 - 0.3 * swing) * mix(1.0, uSettle + band * 0.8, m);
  vColour = mix(uInk, uLit, m);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec3 vColour;
in float vAlpha;
uniform float uCover;
out vec4 colour;
void main() {
  float a = min(1.0, smoothstep(0.5, 0.08, length(gl_PointCoord - 0.5)) * vAlpha);
  colour = vec4(vColour * a, a * uCover);
}`;

function program(gl: WebGL2RenderingContext): WebGLProgram | null {
  const made = gl.createProgram();
  if (!made) return null;
  for (const [kind, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
    const shader = gl.createShader(kind);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(made, shader);
  }
  gl.linkProgram(made);
  return gl.getProgramParameter(made, gl.LINK_STATUS) ? made : null;
}

/** The cover as the report's own, smaller: the same picture, with its words. */
function paintPage(canvas: HTMLCanvasElement, preview: ReportPreview) {
  const g = canvas.getContext("2d");
  if (!g) return;
  const [w, h] = [canvas.width, canvas.height];
  g.fillStyle = "#071420";
  g.fillRect(0, 0, w, h);
  const city = paintCover(preview.topology, preview.snapshot, preview.virtualS, Math.min(w, 460), true);
  if (city) g.drawImage(city as CanvasImageSource, 0, 0, w, h);
  const edge = w * 0.076;
  let size = w * 0.215;
  g.font = `400 ${size}px Inter, system-ui, sans-serif`;
  size = Math.min(size, (size * w * 0.848) / g.measureText(preview.city).width);
  const under = h * 0.729;
  g.font = `500 ${w * 0.022}px Inter, system-ui, sans-serif`;
  g.fillStyle = "#5ee3bf";
  g.fillText("A SIMULATED DAY IN", edge, under - size * 1.26);
  g.font = `400 ${size}px Inter, system-ui, sans-serif`;
  g.fillStyle = "#ffffff";
  g.fillText(preview.city, edge, under - size * 0.28);
  g.font = `400 ${w * 0.036}px Inter, system-ui, sans-serif`;
  g.fillStyle = "#b7cbd7";
  g.fillText(preview.country, edge, under + w * 0.038);
  g.font = `400 ${w * 0.024}px Inter, system-ui, sans-serif`;
  g.fillStyle = "#e8f1f6";
  g.fillText(`Seed ${preview.seed.length > 22 ? `${preview.seed.slice(0, 20)}…` : preview.seed}`, edge, h * 0.885);
  g.fillText(preview.generated, w * 0.53, h * 0.885);
}

const rgbOf = (value: string, fallback: [number, number, number]): [number, number, number] => {
  const parts = value.trim().split(/[\s,]+/).map(Number);
  return parts.length >= 3 && parts.every(Number.isFinite) ? [parts[0] / 255, parts[1] / 255, parts[2] / 255] : fallback;
};

export function ReportFilm({ label, share, ready, preview, view, reduceMotion, onSave, onDone }: {
  label: string;
  share: number;
  ready: boolean;
  preview: ReportPreview;
  /** Where the map is on screen now. */
  view: () => { view: MapTransform; box: DOMRect } | null;
  reduceMotion: boolean;
  /** The file is ready, and the page is about to give way to the map. */
  onSave: () => void;
  onDone: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const air = useRef<HTMLCanvasElement>(null);
  const page = useRef<HTMLCanvasElement>(null);
  const fill = useRef<HTMLElement>(null);
  const words = useRef<HTMLParagraphElement>(null);
  const latest = useRef({ share, ready, onSave, onDone, preview });
  latest.current = { share, ready, onSave, onDone, preview };
  // The words keep pace with what is seen, not with the worker, which is usually ahead of it.
  const said = useRef<{ share: number; label: string }[]>([]);
  if (said.current[said.current.length - 1]?.label !== label && label !== "Done") said.current.push({ share, label });

  useEffect(() => {
    const sheet = page.current;
    const canvas = air.current;
    if (reduceMotion || !sheet || !canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const box = sheet.getBoundingClientRect();
    sheet.width = Math.round(box.width * ratio);
    sheet.height = Math.round(box.height * ratio);
    paintPage(sheet, latest.current.preview);

    const gl = filmAvailable() ? canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false }) : null;
    const made = gl && program(gl);
    let uniform: (name: string) => WebGLUniformLocation | null = () => null;
    let drawn = 0;
    if (gl && made) {
      canvas.width = window.innerWidth * ratio;
      canvas.height = window.innerHeight * ratio;
      gl.viewport(0, 0, canvas.width, canvas.height);
      const { topology } = latest.current.preview;
      const roads = topology.edges.filter((edge) => !edge.synthetic_reverse && edge.geometry.length > 1).map((edge) => edge.geometry);
      const here = view();
      const frame = coverFrame(topology, box.width);
      // Sampled the same way for both, so that each particle has the same place on a road in each.
      const from = here && landingPoints(roads, here.view, here.box, window.innerWidth, window.innerHeight, COUNT);
      const to = frame && landingPoints(roads.map((road) => road.map((p) => ({ x_m: frame.U(p.x_m, p.y_m), y_m: frame.V(p.x_m, p.y_m) }))), { x: frame.left, y: frame.top, scale: frame.scale }, box, window.innerWidth, window.innerHeight, COUNT);
      if (from && to) {
        const data = new Float32Array(COUNT * 7);
        let [seed, aspect] = [12345, window.innerWidth / window.innerHeight];
        const page01 = (y: number) => (((1 - y) / 2) * window.innerHeight - box.top) / box.height;
        for (let i = 0; i < COUNT; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
          const [fx, fy, tx, ty] = [from[i * 4], from[i * 4 + 1], to[i * 4], to[i * 4 + 1]];
          const inside = Math.abs(((tx + 1) / 2) * window.innerWidth - (box.left + box.width / 2)) < box.width / 2;
          const yy = page01(ty);
          // The same fall-off as the cover's own drawing, so that nothing lands where the page has no road.
          const keep = !inside || yy < 0 || yy > 0.69 ? 0 : Math.min(1, yy < 0.24 ? 0.1 + (yy / 0.24) * 0.9 : yy > 0.48 ? (0.69 - yy) / 0.21 : 1);
          data.set([fx, fy, tx, ty, (seed >>> 8) / 16777216, Math.min(1, Math.hypot(fx * aspect, fy) / 1.5), keep], i * 7);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        const attribute = (name: string, size: number, offset: number) => {
          const at = gl.getAttribLocation(made, name);
          gl.enableVertexAttribArray(at);
          gl.vertexAttribPointer(at, size, gl.FLOAT, false, 28, offset);
        };
        gl.useProgram(made);
        attribute("aFrom", 2, 0);
        attribute("aTo", 2, 8);
        attribute("aMeta", 3, 16);
        uniform = (name) => gl.getUniformLocation(made, name);
        const style = getComputedStyle(document.documentElement);
        const light = document.documentElement.dataset.theme === "light";
        gl.uniform3fv(uniform("uInk"), rgbOf(style.getPropertyValue("--accent-rgb"), [0.22, 0.84, 1]));
        gl.uniform3fv(uniform("uLit"), [0.42, 0.88, 1]);
        gl.uniform1f(uniform("uCover"), light ? 1 : 0.7);
        gl.uniform1f(uniform("uAspect"), aspect);
        gl.uniform1f(uniform("uPixels"), ratio * 1.55);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        drawn = COUNT;
      }
    }
    const [uMix, uTime, uAlpha, uSettle, uSweep] = ["uMix", "uTime", "uAlpha", "uSettle", "uSweep"].map(uniform);
    const pageTop = 1 - ((box.top / window.innerHeight) * 2);
    const pageSpan = (box.height / window.innerHeight) * 2;

    const started = performance.now();
    let previous = started;
    let shown = 0;
    let leftAt = 0;
    let finished = false;
    let frame = 0;
    const paint = (now: number) => {
      const dt = Math.min(0.05, (now - previous) / 1000);
      previous = now;
      const t = (now - started) / 1000;
      // Follows the work, smoothly, and never faster than can be followed.
      shown += (Math.min(latest.current.ready ? 1 : latest.current.share, t / MIN_S) - shown) * Math.min(1, dt * 5);
      if (fill.current) fill.current.style.transform = `translateX(${Math.min(1, shown) * 100 - 100}%)`;
      if (words.current && !leftAt) {
        const now_ = latest.current.ready && t > MIN_S * 0.9 ? "Done" : [...said.current].reverse().find((step) => step.share <= shown)?.label ?? said.current[0]?.label ?? "";
        if (words.current.textContent !== now_) words.current.textContent = now_;
      }
      if (latest.current.ready && t >= MIN_S && !leftAt) {
        leftAt = t;
        root.current?.classList.add("leaving");
        latest.current.onSave();
      }
      const back = leftAt ? (t - leftAt) / RETURN_S : 0;
      sheet.style.opacity = String(leftAt ? 1 - smoother((t - leftAt) / 0.75) : smoother((t - COVER_AT_S) / COVER_S));
      if (gl && drawn) {
        const mix = leftAt ? 1 - Math.min(1, back) : Math.min(1, Math.max(0, (t - LIFT_S) / GATHER_S));
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(uMix, mix);
        gl.uniform1f(uTime, t);
        // In over the first half second, and out over the last of the way back, on the roads they came from.
        gl.uniform1f(uAlpha, smoother(t / 0.5) * (leftAt ? 1 - smoother((back - 0.72) / 0.28) : 1));
        // Once the cover has come in under them they are only its light, and they come up again to leave.
        gl.uniform1f(uSettle, 1 - 0.68 * (leftAt ? 1 - smoother((t - leftAt) / 0.5) : smoother((t - COVER_AT_S) / COVER_S)));
        const waited = (t - COVER_AT_S - COVER_S) / 2.6;
        gl.uniform1f(uSweep, waited > 0 && !leftAt ? pageTop - (waited % 1) * pageSpan * 1.3 : -3);
        gl.drawArrays(gl.POINTS, 0, drawn);
      }
      if (leftAt && back >= 1 && !finished) {
        finished = true;
        latest.current.onDone();
        return;
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(frame);
      // A browser allows only so many of these, and a person may make many reports.
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    };
    // Everything that changes while it runs is read through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  // With no film to finish, or nobody watching it, the file saves as soon as it is ready.
  useEffect(() => {
    if (ready && (reduceMotion || document.hidden)) {
      onSave();
      onDone();
    }
  }, [ready, reduceMotion, onSave, onDone]);

  // On the page itself, because a blur can only see what its own ancestors let it.
  return createPortal(
    <div ref={root} className={`report-film${reduceMotion ? " still" : ""}`} role="status" aria-live="polite">
      <canvas ref={page} className="report-page" aria-hidden="true" />
      <canvas ref={air} className="report-film-air" aria-hidden="true" />
      <div className="film-caption report-caption">
        <span className="film-chapter">{preview.country ? `${preview.city}, ${preview.country}` : preview.city}</span>
        <h3>Simulation report</h3>
        <p ref={words}>{said.current[0]?.label}</p>
        <span className="report-film-bar" aria-hidden="true"><i ref={fill} style={reduceMotion ? { transform: `translateX(${share * 100 - 100}%)` } : undefined} /></span>
      </div>
    </div>,
    document.body,
  );
}
