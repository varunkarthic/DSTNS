// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef } from "react";
import { sequence } from "./bootScenes";

/**
 * The report being put together, out of what is on screen. Particles leave the map's roads and the
 * panels and land on a sheet of paper in the places the report keeps those things: the roads become
 * its map, the telemetry its figures and charts, and the controls its lines of text. Their departure
 * follows the real progress of the worker building the file, so this cannot run ahead of it. When
 * it is done the sheet flies to the button that asked for it, and the file saves as it arrives.
 *
 * Nothing blocks: the worker has the work, and this draws only what is in flight, because what has
 * landed is painted once onto the sheet.
 */

interface Block { u0: number; v0: number; u1: number; v1: number; ink: string; share: number; from: "roads" | "panels" }

// Where things are on a page of the report, as shares of its width and height.
const PAGE: Block[] = [
  { u0: 0.08, v0: 0.06, u1: 0.3, v1: 0.085, ink: "#0a7f9e", share: 0.03, from: "panels" },
  { u0: 0.08, v0: 0.1, u1: 0.62, v1: 0.135, ink: "#0f1d27", share: 0.06, from: "panels" },
  ...[0, 1, 2, 3].map((n) => ({ u0: 0.08 + n * 0.215, v0: 0.17, u1: 0.27 + n * 0.215, v1: 0.245, ink: ["#0a7f9e", "#b86e00", "#c0303a", "#0d8f6b"][n], share: 0.05, from: "panels" as const })),
  ...[0, 1, 2, 3, 4, 5].map((n) => ({ u0: 0.08, v0: 0.28 + n * 0.022, u1: 0.92 - ((n * 37) % 5) * 0.06, v1: 0.287 + n * 0.022, ink: "#4b5c68", share: 0.02, from: "panels" as const })),
  ...[0.3, 0.5, 0.85, 0.62, 1, 0.74, 0.46, 0.58, 0.9, 0.7, 0.4, 0.28].map((tall, n) => ({ u0: 0.08 + n * 0.071, v0: 0.57 - tall * 0.15, u1: 0.13 + n * 0.071, v1: 0.57, ink: tall > 0.8 ? "#b86e00" : "#0a7f9e", share: 0.012, from: "panels" as const })),
  { u0: 0.08, v0: 0.61, u1: 0.92, v1: 0.94, ink: "#2fa98a", share: 0.46, from: "roads" },
];
const COUNT = 5200;
const MIN_S = 2.3;
const FLIGHT_S = 0.72;

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

export function ReportFilm({ label, share, ready, roads, target, reduceMotion, onDone }: {
  label: string;
  /** How far the worker has got, 0 to 1. */
  share: number;
  /** The file is finished. */
  ready: boolean;
  /** The map's roads, as points on the page in clip space, four numbers each. */
  roads: () => Float32Array | null;
  /** What the sheet flies to at the end. */
  target: () => DOMRect | null;
  reduceMotion: boolean;
  onDone: () => void;
}) {
  const air = useRef<HTMLCanvasElement>(null);
  const page = useRef<HTMLCanvasElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLElement>(null);
  const latest = useRef({ share, ready, onDone });
  latest.current = { share, ready, onDone };

  useEffect(() => {
    if (reduceMotion) return;
    const canvas = air.current;
    const paper = page.current;
    const holder = sheet.current;
    const ctx = canvas?.getContext("2d");
    const ink = paper?.getContext("2d");
    if (!canvas || !paper || !holder || !ctx || !ink) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = window.innerWidth * ratio;
    canvas.height = window.innerHeight * ratio;
    const box = holder.getBoundingClientRect();
    paper.width = box.width * ratio;
    paper.height = box.height * ratio;
    ctx.scale(ratio, ratio);
    ink.scale(ratio, ratio);

    const random = sequence(4077);
    // Where they come from: what is actually on screen at this moment.
    const onRoads = roads();
    const rects = [...document.querySelectorAll(".metric, .stream-card, .rail, .map-dock, .hud-group, .capsule, .app-header")].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    // The roads keep their shape on the way: the map shrinks onto the page, rather than scattering.
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    if (onRoads) {
      for (let at = 0; at < onRoads.length; at += 4) {
        minX = Math.min(minX, onRoads[at]);
        maxX = Math.max(maxX, onRoads[at]);
        minY = Math.min(minY, onRoads[at + 1]);
        maxY = Math.max(maxY, onRoads[at + 1]);
      }
    }
    let lastRoad = 0;
    const fromRoad = (): [number, number] => {
      if (!onRoads?.length) return [random() * window.innerWidth, random() * window.innerHeight];
      lastRoad = Math.floor(random() * (onRoads.length / 4)) * 4;
      return [((onRoads[lastRoad] + 1) / 2) * window.innerWidth, ((1 - onRoads[lastRoad + 1]) / 2) * window.innerHeight];
    };
    const fromPanel = (): [number, number] => {
      if (!rects.length) return fromRoad();
      const r = rects[Math.floor(random() * rects.length)];
      return [r.left + random() * r.width, r.top + random() * r.height];
    };
    const inFlight = new Float32Array(COUNT * 7); // from x y, to x y, leaves, arc, block
    const weights: number[] = [];
    PAGE.forEach((block) => weights.push((weights[weights.length - 1] ?? 0) + block.share));
    const total = weights[weights.length - 1];
    for (let i = 0; i < COUNT; i++) {
      const pick = random() * total;
      const index = weights.findIndex((w) => w >= pick);
      const block = PAGE[Math.max(0, index)];
      const [sx, sy] = block.from === "roads" ? fromRoad() : fromPanel();
      // The page fills from the top: each block leaves around when its part of the report is being made.
      const depart = Math.min(0.94, ((block.v0 + (block.v1 - block.v0) * random()) * 0.9 + random() * 0.08));
      let [u, v] = [random(), random()];
      if (block.from === "roads" && onRoads?.length) {
        // Where this point of road falls in the map on the page, keeping the map's proportions.
        const fit = Math.min(((block.u1 - block.u0) * box.width) / (maxX - minX), ((block.v1 - block.v0) * box.height) / (maxY - minY));
        const [w, h] = [(maxX - minX) * fit, (maxY - minY) * fit];
        u = (((block.u1 - block.u0) * box.width - w) / 2 + (onRoads[lastRoad] - minX) * fit) / ((block.u1 - block.u0) * box.width);
        v = (((block.v1 - block.v0) * box.height - h) / 2 + (maxY - onRoads[lastRoad + 1]) * fit) / ((block.v1 - block.v0) * box.height);
      }
      inFlight.set([sx, sy, box.left + (block.u0 + (block.u1 - block.u0) * u) * box.width, box.top + (block.v0 + (block.v1 - block.v0) * v) * box.height, depart, block.from === "roads" ? (random() - 0.5) * 30 : (random() - 0.5) * 120, Math.max(0, index)], i * 7);
    }
    const landed = new Uint8Array(COUNT);
    let shown = 0;
    let landedCount = 0;
    let frame = 0;
    const started = performance.now();
    let flew = 0;
    const flying = "#6fd7f2";
    const paint = (now: number) => {
      const elapsed = (now - started) / 1000;
      const real = latest.current.ready ? 1 : latest.current.share;
      // It follows the work, and takes long enough to be seen when the work is quick.
      shown += (Math.min(real, elapsed / MIN_S) - shown) * 0.12;
      if (latest.current.ready && elapsed > MIN_S) shown = Math.max(shown, Math.min(1, elapsed / MIN_S));
      if (fill.current) fill.current.style.transform = `translateX(${shown * 100 - 100}%)`;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.fillStyle = flying;
      for (let i = 0; i < COUNT; i++) {
        if (landed[i]) continue;
        const at = i * 7;
        const leaves = inFlight[at + 4];
        if (shown < leaves) continue;
        // Each has its own clock, started by the progress reaching it.
        const t = Math.min(1, (shown - leaves) / 0.16 + (elapsed - leaves * MIN_S) / (FLIGHT_S * 3));
        if (t >= 1) {
          landed[i] = 1;
          landedCount += 1;
          ink.fillStyle = PAGE[inFlight[at + 6]].ink;
          ink.fillRect(inFlight[at + 2] - box.left, inFlight[at + 3] - box.top, 1.4, 1.4);
          continue;
        }
        const e = ease(t);
        const x = inFlight[at] + (inFlight[at + 2] - inFlight[at]) * e;
        const y = inFlight[at + 1] + (inFlight[at + 3] - inFlight[at + 1]) * e + Math.sin(t * Math.PI) * inFlight[at + 5];
        ctx.globalAlpha = Math.min(1, t * 8);
        ctx.fillRect(x, y, 1.6, 1.6);
      }
      ctx.globalAlpha = 1;
      // Everything has landed: the sheet goes to the button and the file saves as it arrives.
      if (latest.current.ready && landedCount >= COUNT * 0.995 && !flew) {
        flew = now;
        const to = target();
        const [dx, dy] = to ? [to.left + to.width / 2 - (box.left + box.width / 2), to.top + to.height / 2 - (box.top + box.height / 2)] : [0, 200];
        holder.style.setProperty("--fly", `translate(${dx}px, ${dy}px) scale(0.06)`);
        holder.classList.add("flying");
        window.setTimeout(() => latest.current.onDone(), 640);
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [reduceMotion, roads, target]);

  // Without the film, the file saves as soon as it is ready.
  useEffect(() => {
    if (reduceMotion && ready) onDone();
  }, [reduceMotion, ready, onDone]);

  return (
    <div className={`report-film${reduceMotion ? " still" : ""}`} role="status" aria-live="polite">
      <div className="report-sheet" ref={sheet} aria-hidden="true">
        <canvas ref={page} />
      </div>
      <div className="report-film-label">
        <strong>{label}</strong>
        <span className="report-film-bar" aria-hidden="true"><i ref={fill} style={reduceMotion ? { transform: `translateX(${share * 100 - 100}%)` } : undefined} /></span>
      </div>
      <canvas ref={air} className="report-film-air" aria-hidden="true" />
    </div>
  );
}
