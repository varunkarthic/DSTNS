// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { roadState } from "./mapModel";
import type { Layers, Snapshot, Topology } from "./types";

const PRINT_ROADS: Record<string, string> = { clear: "#2fa98a", moderate: "#d98a12", severe: "#cf3442", blocked: "#7a1f2b", flooded: "#2f6fc0" };
const WEIGHTS: Record<string, number> = { motorway: 7, trunk: 6.4, primary: 5.4, secondary: 4.2, tertiary: 3.2, residential: 1.9, service: 1.3 };

type Sheet = OffscreenCanvas | HTMLCanvasElement;
type Pen = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const sheet = (width: number, height: number): Sheet => (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height }));
const penOf = (canvas: Sheet) => canvas.getContext("2d") as Pen | null;

/**
 * Out of focus, in a way every browser can do on a worker: halved and doubled, one step at a time, on
 * a sheet padded so that each halving is exact. At any other ratio a thin line comes back as a row of
 * beads. The result can be larger than the source, and lines up with it at the top left.
 */
function softened(source: Sheet, steps: number): Sheet {
  const whole = 2 ** steps;
  const [width, height] = [Math.ceil(source.width / whole) * whole, Math.ceil(source.height / whole) * whole];
  let current = source;
  const resized = (w: number, h: number, fit: boolean) => {
    const next = sheet(w, h);
    const pen = penOf(next);
    if (!pen) return current;
    if (fit) pen.drawImage(current, 0, 0, w, h);
    else pen.drawImage(current, 0, 0);
    return next;
  };
  current = resized(width, height, false);
  for (let n = 1; n <= steps; n++) current = resized(width / 2 ** n, height / 2 ** n, true);
  for (let n = steps - 1; n >= 0; n--) current = resized(width / 2 ** n, height / 2 ** n, true);
  return current;
}

/**
 * The cover: the city itself, out to every edge of an A4 page, as a photograph fills its frame. The
 * arteries are lit and everything else stays quiet. The head and foot of the page fall out of focus, and
 * the foot falls away into the dark that the title is set on. North stays up, because it is a map.
 */
export function paintCover(topology: Topology, snapshot: Snapshot, width: number): Sheet | null {
  const edges = topology.edges.filter((e) => !e.synthetic_reverse && e.geometry.length > 1);
  if (!edges.length) return null;
  let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const edge of edges) {
    for (const p of edge.geometry) {
      minX = Math.min(minX, p.x_m);
      maxX = Math.max(maxX, p.x_m);
      minY = Math.min(minY, p.y_m);
      maxY = Math.max(maxY, p.y_m);
    }
  }
  const height = Math.round((width * 297) / 210);
  const unit = width / 1654;
  const scale = Math.max(width / (maxX - minX), height / (maxY - minY)) * 1.04;
  const X = (x: number) => width / 2 + (x - (minX + maxX) / 2) * scale;
  // Above the middle, since the lower part of the page is the title's.
  const Y = (y: number) => height * 0.45 - (y - (minY + maxY) / 2) * scale;
  const page = sheet(width, height);
  const lit = sheet(width, height);
  const [ground, light] = [penOf(page), penOf(lit)];
  if (!ground || !light) return null;
  const trace = (pen: Pen, points: { x_m: number; y_m: number }[], close = false) => {
    points.forEach((p, i) => (i ? pen.lineTo(X(p.x_m), Y(p.y_m)) : pen.moveTo(X(p.x_m), Y(p.y_m))));
    if (close) pen.closePath();
  };
  const fall = ground.createLinearGradient(0, 0, 0, height);
  fall.addColorStop(0, "#0c2233");
  fall.addColorStop(1, "#071420");
  ground.fillStyle = fall;
  ground.fillRect(0, 0, width, height);
  // Land, in three quiet tones, each one path so that thousands of them cost little.
  const lands: [string, (category: string) => boolean][] = [
    ["#0f2a3b", (c) => c === "building"],
    ["#0d2d2e", (c) => ["park", "grass", "forest", "recreation_ground"].includes(c)],
    ["#0d3247", (c) => ["water", "river", "lake", "riverbank", "wetland"].includes(c)],
  ];
  for (const [ink, belongs] of lands) {
    ground.fillStyle = ink;
    ground.beginPath();
    for (const feature of topology.features) if (feature.polygon && feature.geometry.length > 2 && belongs(feature.category)) trace(ground, feature.geometry, true);
    ground.fill();
  }
  ground.lineCap = ground.lineJoin = light.lineCap = light.lineJoin = "round";
  // The streets are one tone, and the arteries a gradient across the page, unless a road is in trouble.
  const states = new Map(snapshot.edges.map((e) => [e.id, e]));
  const across = light.createLinearGradient(0, 0, width, height);
  across.addColorStop(0, "#37d7ff");
  across.addColorStop(1, "#5ee3bf");
  const trouble: Record<string, string> = { moderate: "#f0aa2e", severe: "#ef5a64", blocked: "#ef5a64", flooded: "#4f93e6" };
  const ordered = [...edges].sort((a, b) => (WEIGHTS[a.road_class] ?? 1.5) - (WEIGHTS[b.road_class] ?? 1.5));
  for (const edge of ordered) {
    const weight = WEIGHTS[edge.road_class] ?? 1.5;
    const ink = trouble[roadState(states.get(edge.id))];
    if (weight >= 4 || ink) {
      light.strokeStyle = ink ?? across;
      light.lineWidth = Math.max(3.4, weight) * 0.72 * unit;
      light.beginPath();
      trace(light, edge.geometry);
      light.stroke();
    } else {
      ground.strokeStyle = weight >= 3 ? "#347f88" : "#235a69";
      ground.lineWidth = weight * 0.8 * unit;
      ground.beginPath();
      trace(ground, edge.geometry);
      ground.stroke();
    }
  }
  // The light of the arteries spreads, far and faintly, then near and strongly, with the line on top.
  ground.globalCompositeOperation = "lighter";
  ground.globalAlpha = 0.5;
  ground.drawImage(softened(lit, 5), 0, 0);
  ground.globalAlpha = 0.5;
  ground.drawImage(softened(lit, 3), 0, 0);
  ground.globalCompositeOperation = "source-over";
  ground.globalAlpha = 1;
  ground.drawImage(lit, 0, 0);
  // Sharp through the middle of the page, as with a long lens, and soft toward the head and foot.
  const soft = softened(page, 3);
  const blurred = sheet(width, height);
  const mask = penOf(blurred);
  if (mask) {
    mask.drawImage(soft, 0, 0);
    const focus = mask.createLinearGradient(0, 0, 0, height);
    [[0, 1], [0.1, 0.8], [0.27, 0], [0.5, 0], [0.68, 1], [1, 1]].forEach(([at, alpha]) => focus.addColorStop(at, `rgba(0,0,0,${alpha})`));
    mask.globalCompositeOperation = "destination-in";
    mask.fillStyle = focus;
    mask.fillRect(0, 0, width, height);
    ground.drawImage(blurred, 0, 0);
  }
  // A colder light from high on one side and a greener one from low on the other.
  ground.globalCompositeOperation = "lighter";
  const wash = (x: number, y: number, radius: number, colour: string) => {
    const glow = ground.createRadialGradient(x, y, 0, x, y, radius);
    glow.addColorStop(0, colour);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ground.fillStyle = glow;
    ground.fillRect(0, 0, width, height);
  };
  wash(width * 0.8, height * 0.14, width * 0.95, "rgba(40,150,210,0.2)");
  wash(width * 0.08, height * 0.62, width * 0.8, "rgba(50,190,150,0.11)");
  ground.globalCompositeOperation = "source-over";
  // The dark the words stand on, with enough stops that no edge can be seen where it begins.
  const scrim = (from: number, to: number, stops: [number, number][]) => {
    const dark = ground.createLinearGradient(0, from * height, 0, to * height);
    stops.forEach(([at, alpha]) => dark.addColorStop(at, `rgba(7,20,32,${alpha})`));
    ground.fillStyle = dark;
    ground.fillRect(0, from * height, width, (to - from) * height);
  };
  scrim(0, 0.17, [[0, 0.82], [0.45, 0.42], [1, 0]]);
  scrim(0.46, 1, [[0, 0], [0.18, 0.1], [0.36, 0.42], [0.52, 0.8], [0.68, 0.97], [1, 1]]);
  const edge = ground.createRadialGradient(width / 2, height * 0.4, width * 0.42, width / 2, height * 0.4, height * 0.72);
  edge.addColorStop(0, "rgba(7,20,32,0)");
  edge.addColorStop(1, "rgba(7,20,32,0.72)");
  ground.fillStyle = edge;
  ground.fillRect(0, 0, width, height);
  return page;
}

async function encoded(canvas: Sheet, type: string, quality?: number): Promise<string> {
  const blob = await ("convertToBlob" in canvas ? canvas.convertToBlob({ type, quality }) : new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The map could not be encoded."))), type, quality)));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}

/** The cover, ready for a page. About 200 pixels to the inch, which is plenty for something this soft. */
export async function coverMap(topology: Topology, snapshot: Snapshot): Promise<string | null> {
  const page = paintCover(topology, snapshot, 1654);
  return page ? encoded(page, "image/jpeg", 0.9) : null;
}

/**
 * The network on white, for a page. The screen's map is dark, and a screenshot of it sits badly
 * on paper, so this draws the same things afresh in print colours, the whole network and not
 * just what was in view. Runs on a worker or the page, whichever has it.
 */
export async function printMap(topology: Topology, snapshot: Snapshot, layers: Layers, width = 2000): Promise<{ dataUrl: string; aspect: number } | null> {
  const edges = topology.edges.filter((e) => !e.synthetic_reverse && e.geometry.length > 1);
  if (!edges.length) return null;
  let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const edge of edges) {
    for (const p of edge.geometry) {
      minX = Math.min(minX, p.x_m);
      maxX = Math.max(maxX, p.x_m);
      minY = Math.min(minY, p.y_m);
      maxY = Math.max(maxY, p.y_m);
    }
  }
  const margin = 64;
  const scale = (width - margin * 2) / (maxX - minX);
  const height = Math.round((maxY - minY) * scale + margin * 2);
  const canvas = sheet(width, height);
  const ctx = penOf(canvas);
  if (!ctx) return null;
  const X = (x: number) => margin + (x - minX) * scale;
  const Y = (y: number) => margin + (maxY - y) * scale;
  const trace = (points: { x_m: number; y_m: number }[], close = false) => {
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(X(p.x_m), Y(p.y_m)) : ctx.moveTo(X(p.x_m), Y(p.y_m))));
    if (close) ctx.closePath();
  };
  ctx.fillStyle = "#f6f8fa";
  ctx.fillRect(0, 0, width, height);
  if (layers.buildings) {
    for (const feature of topology.features) {
      if (!feature.polygon || feature.geometry.length < 3) continue;
      const green = ["park", "grass", "forest", "recreation_ground"].includes(feature.category);
      const water = ["water", "river", "lake", "riverbank", "wetland"].includes(feature.category);
      ctx.fillStyle = water ? "#d3e5f3" : green ? "#dcedd9" : feature.category === "building" ? "#e2e6ea" : "#eef1f3";
      trace(feature.geometry, true);
      ctx.fill();
    }
  }
  const states = new Map(snapshot.edges.map((e) => [e.id, e]));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const ordered = [...edges].sort((a, b) => (WEIGHTS[a.road_class] ?? 1.5) - (WEIGHTS[b.road_class] ?? 1.5));
  for (const edge of ordered) {
    const state = roadState(states.get(edge.id));
    const weight = WEIGHTS[edge.road_class] ?? 1.5;
    ctx.strokeStyle = state === "clear" && weight < 3 ? "#a9c6bc" : PRINT_ROADS[state] ?? PRINT_ROADS.clear;
    ctx.lineWidth = weight;
    trace(edge.geometry);
    ctx.stroke();
  }
  // Signals, and what is happening now, over the roads.
  ctx.fillStyle = "#0f1d27";
  for (const signal of snapshot.signals) {
    const node = topology.nodes[signal.junction_id];
    if (!node) continue;
    ctx.beginPath();
    ctx.arc(X(node.position.x_m), Y(node.position.y_m), 7, 0, Math.PI * 2);
    ctx.fill();
  }
  // A scale bar, because a map on paper has nothing else to measure by.
  const metres = [100, 200, 500, 1000, 2000, 5000].find((m) => m * scale > width / 8) ?? 5000;
  const [bar, y] = [metres * scale, height - margin + 18];
  ctx.fillStyle = "#0f1d27";
  ctx.fillRect(margin, y, bar, 5);
  ctx.font = "30px sans-serif";
  ctx.textBaseline = "bottom";
  ctx.fillText(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, margin, y - 6);
  return { dataUrl: await encoded(canvas, "image/png"), aspect: width / height };
}
