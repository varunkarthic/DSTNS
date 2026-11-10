// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { roadState } from "../core/mapModel";
import type { Layers, Snapshot, Topology } from "../core/types";

const PRINT_ROADS: Record<string, string> = Object.assign(Object.create(null), { clear: "#2fa98a", moderate: "#d98a12", severe: "#cf3442", blocked: "#7a1f2b", flooded: "#2f6fc0" });
const WEIGHTS: Record<string, number> = Object.assign(Object.create(null), { motorway: 7, trunk: 6.4, primary: 5.4, secondary: 4.2, tertiary: 3.2, residential: 1.9, service: 1.3 });

export type Sheet = OffscreenCanvas | HTMLCanvasElement;
export type Pen = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export const sheet = (width: number, height: number): Sheet => (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height }));
export const penOf = (canvas: Sheet) => canvas.getContext("2d") as Pen | null;

export async function encoded(canvas: Sheet, type: string, quality?: number): Promise<string> {
  const blob = await ("convertToBlob" in canvas ? canvas.convertToBlob({ type, quality }) : new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The map could not be encoded."))), type, quality)));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
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
