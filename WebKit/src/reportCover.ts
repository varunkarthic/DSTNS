// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { roadState } from "./mapModel";
import { encoded, penOf, sheet } from "./reportMap";
import type { Pen, Sheet } from "./reportMap";
import type { Snapshot, Topology } from "./types";

const WEIGHTS: Record<string, number> = { motorway: 7, trunk: 6.4, primary: 5.4, secondary: 4.2, tertiary: 3.2, residential: 1.9, service: 1.3 };
const TROUBLE: Record<string, string> = { moderate: "#ffb547", severe: "#ff5f6d", blocked: "#ff5f6d", flooded: "#5aa2ff" };

/**
 * Out of focus, in a way every browser can do on a worker: halved and doubled, one step at a time, on
 * a sheet padded so that each halving is exact. At any other ratio a thin line comes back as a row of
 * beads. The result can be larger than the source, and lines up with it at the top left.
 */
export function softened(source: Sheet, steps: number): Sheet {
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

/** The tint of the paper at the simulated hour: pale, and only a hint of what time of day the report was made. */
function tintAt(virtualS: number): string {
  const keys: [number, number[]][] = [
    [0, [72, 110, 190]],
    [5.2, [72, 110, 190]],
    [7, [240, 150, 90]],
    [9.5, [55, 190, 225]],
    [16.2, [55, 190, 225]],
    [18.4, [226, 104, 132]],
    [20.6, [72, 110, 190]],
    [24, [72, 110, 190]],
  ];
  const hour = (((virtualS % 86400) + 86400) % 86400) / 3600;
  const next = Math.max(1, keys.findIndex(([at]) => at >= hour));
  const [from, to] = [keys[next - 1], keys[next]];
  const t = (hour - from[0]) / Math.max(1e-6, to[0] - from[0]);
  return from[1].map((v, i) => Math.round(v + (to[1][i] - v) * t)).join(",");
}

/**
 * The cover's picture: this run's own city on a dark page, set behind the words like a watermark, only with
 * more to say. It's a drawing and not a photograph. The main roads run up the page at a slant, in colour;
 * streets are brighter where the core has more vehicles on them; roads in trouble show as they are at this
 * moment. It's in focus through the upper middle of the page, softens away from there, and dissolves
 * into the dark above the words.
 */
export function paintCover(topology: Topology, snapshot: Snapshot, virtualS: number, width: number, quick = false): Sheet | null {
  const edges = topology.edges.filter((e) => !e.synthetic_reverse && e.geometry.length > 1);
  if (!edges.length) return null;
  const height = Math.round((width * 297) / 210);
  const unit = width / 2480;

  // Where the roads are thickest, and which way the main ones run.
  let [sum, cx, cy, c2, s2] = [0, 0, 0, 0, 0];
  for (const edge of edges) {
    const main = (WEIGHTS[edge.road_class] ?? 1.5) >= 4;
    for (let i = 1; i < edge.geometry.length; i++) {
      const [a, b] = [edge.geometry[i - 1], edge.geometry[i]];
      const [dx, dy] = [b.x_m - a.x_m, b.y_m - a.y_m];
      const length = Math.hypot(dx, dy);
      sum += length;
      cx += length * (a.x_m + b.x_m) * 0.5;
      cy += length * (a.y_m + b.y_m) * 0.5;
      if (main) {
        const angle = Math.atan2(dy, dx);
        c2 += length * Math.cos(2 * angle);
        s2 += length * Math.sin(2 * angle);
      }
    }
  }
  cx /= sum;
  cy /= sum;
  const turn = 0.5 * Math.atan2(s2, c2) - Math.PI / 2 + 0.42;
  const [cosT, sinT] = [Math.cos(turn), Math.sin(turn)];
  const U = (x: number, y: number) => (x - cx) * cosT + (y - cy) * sinT;
  const V = (x: number, y: number) => -(x - cx) * sinT + (y - cy) * cosT;
  let [minU, maxU, minV, maxV] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const edge of edges) {
    for (const p of edge.geometry) {
      const [u, v] = [U(p.x_m, p.y_m), V(p.x_m, p.y_m)];
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }
  // To every side of the page, and past them: being cut off by the page is what makes it a picture and not a plan.
  const scale = Math.max(width / (maxU - minU), (height * 0.67) / (maxV - minV)) * 1.12;
  // Thickest a little right of the middle, unless that would leave part of the band with no city in it.
  const between = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  const left = between(width * 0.54, width - maxU * scale, -minU * scale);
  const top = between(height * 0.36, height * 0.7 + minV * scale, height * 0.03 + maxV * scale);
  const X = (x: number, y: number) => left + U(x, y) * scale;
  const Y = (x: number, y: number) => top - V(x, y) * scale;
  const trace = (pen: Pen, points: readonly { x_m: number; y_m: number }[], close = false) => {
    points.forEach((p, i) => (i ? pen.lineTo(X(p.x_m, p.y_m), Y(p.x_m, p.y_m)) : pen.moveTo(X(p.x_m, p.y_m), Y(p.x_m, p.y_m))));
    if (close) pen.closePath();
  };

  const page = sheet(width, height);
  const drawing = sheet(width, height);
  const lit = sheet(width, height);
  const [paper, map, main] = [penOf(page), penOf(drawing), penOf(lit)];
  if (!paper || !map || !main) return null;
  map.lineCap = map.lineJoin = main.lineCap = main.lineJoin = "round";

  // The dark of the page, with a little of the hour in it, and a little of the observer's mint.
  const fall = paper.createLinearGradient(0, 0, 0, height);
  fall.addColorStop(0, "#0b2030");
  fall.addColorStop(0.6, "#081826");
  fall.addColorStop(1, "#071420");
  paper.fillStyle = fall;
  paper.fillRect(0, 0, width, height);
  const wash = (x: number, y: number, radius: number, colour: string, strength: number) => {
    const glow = paper.createRadialGradient(x, y, 0, x, y, radius);
    glow.addColorStop(0, `rgba(${colour},${strength})`);
    glow.addColorStop(1, `rgba(${colour},0)`);
    paper.fillStyle = glow;
    paper.fillRect(0, 0, width, height);
  };
  wash(width * 0.94, height * 0.06, width * 1.05, tintAt(virtualS), 0.3);
  wash(width * 0.02, height * 0.56, width * 0.9, "94,227,191", 0.09);

  const lands: [string, (feature: Topology["features"][number]) => boolean][] = [
    ["rgba(130,205,235,0.075)", (f) => f.category === "building"],
    ["rgba(70,210,170,0.13)", (f) => ["park", "grass", "forest", "recreation_ground"].includes(f.category)],
    ["rgba(70,140,215,0.2)", (f) => ["water", "river", "lake", "riverbank", "wetland"].includes(f.category)],
  ];
  // Small and in passing, buildings can't be told apart, and there are tens of thousands of them.
  for (const [ink, belongs] of quick ? lands.slice(1) : lands) {
    map.fillStyle = ink;
    map.beginPath();
    for (const feature of topology.features) if (feature.polygon && feature.geometry.length > 2 && belongs(feature)) trace(map, feature.geometry, true);
    map.fill();
  }

  const states = new Map(snapshot.edges.map((e) => [e.id, e]));
  const flow = main.createLinearGradient(0, height, width, 0);
  flow.addColorStop(0, "#5ee3bf");
  flow.addColorStop(0.5, "#37d7ff");
  flow.addColorStop(1, "#8fe0ff");
  const ordered = [...edges].sort((a, b) => (WEIGHTS[a.road_class] ?? 1.5) - (WEIGHTS[b.road_class] ?? 1.5));
  for (const edge of ordered) {
    const weight = WEIGHTS[edge.road_class] ?? 1.5;
    const state = states.get(edge.id);
    const trouble = TROUBLE[roadState(state)];
    const pen: Pen = weight >= 4 || trouble ? main : map;
    if (pen === main) {
      pen.strokeStyle = trouble ?? flow;
      pen.lineWidth = Math.max(weight, 3.6) * 1.35 * unit;
    } else {
      const busy = Math.min(1, (state?.vehicle_count ?? 0) / Math.max(4, edge.length_m / 18));
      pen.strokeStyle = `rgba(120,205,225,${0.2 + 0.42 * busy})`;
      pen.lineWidth = weight * 1.35 * unit;
    }
    pen.beginPath();
    trace(pen, edge.geometry);
    pen.stroke();
  }
  // Places that draw people, and anything happening now.
  map.fillStyle = "rgba(150,230,245,0.6)";
  map.beginPath();
  for (const feature of topology.features) {
    if (!feature.demand_type) continue;
    const [x, y] = [X(feature.position.x_m, feature.position.y_m), Y(feature.position.x_m, feature.position.y_m)];
    map.moveTo(x + 6 * unit, y);
    map.arc(x, y, 6 * unit, 0, Math.PI * 2);
  }
  map.fill();
  for (const cell of snapshot.active_weather) {
    const [x, y, radius] = [X(cell.x_m, cell.y_m), Y(cell.x_m, cell.y_m), cell.radius_m * scale];
    const rain = map.createRadialGradient(x, y, 0, x, y, radius);
    rain.addColorStop(0, "rgba(90,162,255,0.22)");
    rain.addColorStop(1, "rgba(90,162,255,0)");
    map.fillStyle = rain;
    map.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  // The light of the main roads spreads a little, with the line itself on top.
  map.globalCompositeOperation = "lighter";
  map.globalAlpha = 0.34;
  map.drawImage(softened(lit, 5), 0, 0);
  map.globalAlpha = 0.5;
  map.drawImage(softened(lit, 3), 0, 0);
  map.globalAlpha = 1;
  map.drawImage(lit, 0, 0);
  map.globalCompositeOperation = "destination-in";
  const shape = (stops: number[][]) => {
    const fade = map.createLinearGradient(0, 0, 0, height);
    stops.forEach(([at, alpha]) => fade.addColorStop(at, `rgba(0,0,0,${alpha})`));
    return fade;
  };
  // Dissolved into the dark above the words, and at the head of the page.
  map.fillStyle = shape([[0, 0.1], [0.14, 0.72], [0.24, 1], [0.48, 1], [0.6, 0.5], [0.69, 0], [1, 0]]);
  map.fillRect(0, 0, width, height);
  map.globalCompositeOperation = "source-over";

  // In focus through the upper middle of the page, and softening away from it.
  const out = softened(drawing, 3);
  const outPen = penOf(out);
  const focus = [[0, 1], [0.13, 0.85], [0.26, 0], [0.42, 0], [0.56, 1], [1, 1]];
  if (outPen) {
    outPen.globalCompositeOperation = "destination-in";
    const keep = outPen.createLinearGradient(0, 0, 0, height);
    focus.forEach(([at, alpha]) => keep.addColorStop(at, `rgba(0,0,0,${alpha})`));
    outPen.fillStyle = keep;
    outPen.fillRect(0, 0, out.width, out.height);
    map.globalCompositeOperation = "destination-out";
    map.fillStyle = shape(focus);
    map.fillRect(0, 0, width, height);
    map.globalCompositeOperation = "source-over";
    paper.drawImage(out, 0, 0);
  }
  paper.drawImage(drawing, 0, 0);
  return page;
}

/** The cover, ready for a page. 300 pixels to the inch, the standard for print. */
export async function coverMap(topology: Topology, snapshot: Snapshot, virtualS: number): Promise<string | null> {
  const page = paintCover(topology, snapshot, virtualS, 2480);
  return page ? encoded(page, "image/jpeg", 0.94) : null;
}
