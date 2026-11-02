// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { appearance } from "../appearance";
import type { MapTransform } from "../NetworkMap";
import { animate, SPRINGS, stepSpring } from "../motion";
import type { SpringPreset } from "../motion";
import type { Snapshot, Topology } from "../types";
import { autoSeries, dashOf, legibleColour } from "./direction";
import { along, DriveRun, networkOf, PathRun, placeFeature, trackOf } from "./spatial";
import type { AnyRun } from "./spatial";
import { useSlot } from "./store";
import type { OverlayFeature, Tone } from "./store";

export interface FabricOverlayHandle {
  /** Redraw for a camera position; called every frame of a move, outside React. */
  draw: (view: MapTransform) => void;
}

const TONE_TOKENS: Record<Tone, string> = { neutral: "--text-dim", accent: "--accent", ok: "--ok", warn: "--warn", danger: "--danger" };

function roundedBox(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

/** A name beside something on the map, on the same surface as the rest of the interface. */
function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, surface: string, ink: string) {
  const label = text.slice(0, 60);
  const width = ctx.measureText(label).width + 12;
  ctx.fillStyle = surface;
  roundedBox(ctx, x, y - 9, width, 18, 6);
  ctx.fill();
  ctx.fillStyle = ink;
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + 6, y + 0.5);
  ctx.textBaseline = "alphabetic";
}

/** A pin, stop, ring or diamond standing on a junction. */
function drawMarker(ctx: CanvasRenderingContext2D, shape: OverlayFeature["shape"], x: number, y: number, colour: string, surface: string, size: number) {
  ctx.fillStyle = colour;
  ctx.strokeStyle = surface;
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  if (shape === "ring") {
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  } else if (shape === "stop") {
    roundedBox(ctx, x - size, y - size, size * 2, size * 2, size * 0.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = surface;
    ctx.beginPath();
    ctx.arc(x, y, size * 0.36, 0, Math.PI * 2);
    ctx.fill();
  } else if (shape === "diamond") {
    ctx.beginPath();
    ctx.moveTo(x, y - size * 1.25);
    ctx.lineTo(x + size * 1.25, y);
    ctx.lineTo(x, y + size * 1.25);
    ctx.lineTo(x - size * 1.25, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    // A pin's point is on the junction.
    ctx.beginPath();
    ctx.arc(x, y - size * 1.7, size, Math.PI * 0.85, Math.PI * 0.15);
    ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = surface;
    ctx.beginPath();
    ctx.arc(x, y - size * 1.7, size * 0.38, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Something on a road, facing along it. Canvas y runs down, the map's up. */
function drawEntity(ctx: CanvasRenderingContext2D, shape: OverlayFeature["shape"], x: number, y: number, heading: number, colour: string, surface: string, size: number, braking = false, brakeLight = "#ff5b65") {
  ctx.setLineDash([]);
  ctx.fillStyle = colour;
  ctx.strokeStyle = surface;
  ctx.lineWidth = 1.5;
  if (shape === "dot") {
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    return;
  }
  const length = shape === "vehicle" ? size * 2.2 : size * 3.4;
  const breadth = shape === "vehicle" ? size * 1.3 : size * 1.7;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-heading);
  roundedBox(ctx, -length / 2, -breadth / 2, length, breadth, breadth * 0.32);
  ctx.fill();
  ctx.stroke();
  // Its front, so direction of travel can be read at a glance.
  ctx.fillStyle = surface;
  ctx.globalAlpha = 0.75;
  roundedBox(ctx, length / 2 - breadth * 0.62, -breadth * 0.3, breadth * 0.38, breadth * 0.6, 1);
  ctx.fill();
  ctx.globalAlpha = 1;
  // Brake lights, as on the map's own vehicles.
  if (braking) {
    ctx.fillStyle = brakeLight;
    ctx.fillRect(-length / 2, -breadth / 2, Math.max(1, length * 0.16), breadth);
  }
  ctx.restore();
}

function drawPath(ctx: CanvasRenderingContext2D, feature: OverlayFeature, run: AnyRun, X: (x: number) => number, Y: (y: number) => number, colour: string, surface: string, ink: string, brakeLight?: string) {
  const { track } = run;
  const spot = along(track, run.distance);
  const line = (points: [number, number][], tail?: [number, number]) => {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    if (tail) ctx.lineTo(X(tail[0]), Y(tail[1]));
    ctx.stroke();
  };
  ctx.strokeStyle = colour;
  ctx.lineWidth = typeof feature.width === "number" ? Math.min(12, Math.max(0.5, feature.width)) : 3;
  ctx.setLineDash(dashOf(feature.style, feature.dash));
  if (feature.trail !== false) {
    ctx.globalAlpha = 0.28;
    line(track.points);
    ctx.globalAlpha = 1;
  }
  if (feature.reveal !== false) line(track.points.slice(0, spot.index + 1), [spot.x, spot.y]);
  ctx.setLineDash([]);
  const shape = feature.shape ?? "bus";
  const size = Math.min(14, feature.size ?? 5);
  if (run instanceof DriveRun) {
    // Each direction keeps to its own side of the road.
    const lane = size + 1;
    for (const car of run.fleet) {
      if (car.distance < 0 || car.alpha <= 0 || Number.isNaN(car.heading)) continue;
      const at = along(track, car.backwards ? track.total - car.distance : car.distance);
      ctx.globalAlpha = car.alpha;
      if (shape !== "none") drawEntity(ctx, shape === "bus" || shape === "dot" ? shape : "vehicle", X(at.x) + Math.sin(car.heading) * lane, Y(at.y) + Math.cos(car.heading) * lane, car.heading, colour, surface, size, car.braking, brakeLight);
      ctx.globalAlpha = 1;
    }
  } else if (shape !== "none") drawEntity(ctx, shape, X(spot.x), Y(spot.y), spot.heading, colour, surface, size);
  else if (feature.reveal !== false && !run.finished) {
    // The point of the pen, while a road is being drawn.
    ctx.fillStyle = colour;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(X(spot.x), Y(spot.y), (ctx.lineWidth || 3) + 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (feature.label) drawLabel(ctx, String(feature.label), X(spot.x) + 14, Y(spot.y), surface, ink);
}

/** Draws applications' overlays above the map. Applications name a tone or a series; the palette stays DSTNS's. */
export function paintOverlay(ctx: CanvasRenderingContext2D, features: OverlayFeature[], view: MapTransform, colour: (feature: OverlayFeature) => string, glide?: (feature: OverlayFeature) => [number, number] | null, surface = "#0b1720", ink = "#e6eef2", runFor?: (feature: OverlayFeature) => AnyRun | undefined, brakeLight?: string) {
  const X = (x: number) => view.x + x * view.scale;
  const Y = (y: number) => view.y - y * view.scale;
  ctx.font = "11px Inter, sans-serif";
  // Dashes that run along a line, at a fixed speed on screen, and still when motion is reduced.
  const flowing = document.querySelector(".reduce-motion") ? 0 : -performance.now() * 0.04;
  for (const feature of features) {
    const c = colour(feature);
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = typeof feature.width === "number" ? Math.min(12, Math.max(0.5, feature.width)) : 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(dashOf(feature.style, feature.dash));
    ctx.lineDashOffset = feature.style === "flow" ? flowing : 0;
    ctx.shadowColor = c;
    ctx.shadowBlur = feature.glow ? 12 : 0;
    if (feature.type === "path") {
      const run = runFor?.(feature);
      if (run) drawPath(ctx, feature, run, X, Y, c, surface, ink, brakeLight);
    } else if ((feature.type === "marker" || feature.type === "entity") && typeof feature.x_m === "number" && typeof feature.y_m === "number") {
      const [mx, my] = glide?.(feature) ?? [feature.x_m, feature.y_m];
      const size = Math.min(14, feature.size ?? 5);
      if (feature.type === "marker") drawMarker(ctx, feature.shape, X(mx), Y(my), c, surface, size);
      else drawEntity(ctx, feature.shape, X(mx), Y(my), feature.heading ?? 0, c, surface, size);
      if (feature.label) drawLabel(ctx, String(feature.label), X(mx) + size + 6, Y(my) - (feature.shape === "pin" || (feature.type === "marker" && !feature.shape) ? size * 1.7 : 0), surface, ink);
    } else if ((feature.type === "line" || feature.type === "polygon") && Array.isArray(feature.points) && feature.points.length) {
      ctx.beginPath();
      feature.points.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      if (feature.type === "polygon") {
        ctx.closePath();
        ctx.globalAlpha = 0.16;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.stroke();
    } else if (typeof feature.x_m === "number" && typeof feature.y_m === "number") {
      const [mx, my] = glide?.(feature) ?? [feature.x_m, feature.y_m];
      const radius = feature.type === "circle" ? Math.max(3, (feature.radius_m ?? 50) * view.scale) : Math.min(14, feature.size ?? 4);
      ctx.beginPath();
      ctx.arc(X(mx), Y(my), radius, 0, Math.PI * 2);
      if (feature.hollow) {
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.globalAlpha = feature.type === "circle" ? 0.16 : 1;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (feature.type === "circle") ctx.stroke();
      }
      if (feature.label) ctx.fillText(String(feature.label).slice(0, 60), X(mx) + radius + 4, Y(my) + 4);
    }
  }
  ctx.shadowBlur = 0;
  ctx.lineDashOffset = 0;
  ctx.setLineDash([]);
}

export const FabricOverlay = forwardRef<FabricOverlayHandle, { topology: Topology | null; snapshot?: Snapshot | null }>(function FabricOverlay({ topology, snapshot }, handle) {
  const { items } = useSlot("overlay");
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<MapTransform | null>(null);
  const features = useRef<OverlayFeature[]>([]);
  const network = useMemo(() => networkOf(topology), [topology]);
  features.current = useMemo(
    () => items.flatMap((item) => (Array.isArray(item.element.features) ? item.element.features : []).map((f) => (f.color === "auto" ? { ...f, series: autoSeries(item.app.id, f.id ?? item.element.id) } : f))).map((f) => placeFeature(f, network)).filter((f): f is OverlayFeature => !!f),
    [items, network],
  );
  const runs = useRef(new Map<string, { key: string; run: AnyRun }>());
  // What the core says each road's signal is, for vehicles that obey it.
  const signals = useRef(new Map<number, number>());
  signals.current = useMemo(() => new Map((snapshot?.edges ?? []).map((edge) => [edge.id, edge.signal_multiplier])), [snapshot]);
  const signalOf = useCallback((road: number) => signals.current.get(road) ?? 1, []);

  // Named points glide between the positions an application reports.
  const gliders = useRef(new Map<string, { x: number; y: number; vx: number; vy: number }>());
  const motion = useRef<(() => void) | null>(null);
  // An application may choose how its markers move, within the guidelines.
  const glide = useRef<SpringPreset>(SPRINGS.camera);
  const chosen = items.map((item) => item.element.motion).find((m): m is { stiffness: number; damping: number } => !!m && typeof m === "object");
  glide.current = chosen ? { k: chosen.stiffness, c: chosen.damping } : SPRINGS.camera;

  const draw = useCallback(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context || !view.current) return;
    const ratio = window.devicePixelRatio || 1;
    const { clientWidth: width, clientHeight: height } = element;
    if (element.width !== width * ratio || element.height !== height * ratio) {
      element.width = width * ratio;
      element.height = height * ratio;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const style = getComputedStyle(element);
    const token = (name: string) => style.getPropertyValue(name).trim();
    paintOverlay(
      context,
      features.current,
      view.current,
      (feature) => (feature.color?.startsWith("#") ? legibleColour(feature.color, appearance.land.land, (document.documentElement.dataset.vision ?? "standard") !== "standard" ? appearance.meaning.series : undefined) : typeof feature.series === "number" ? token(`--series-${Math.abs(Math.trunc(feature.series)) % 8}`) : token(TONE_TOKENS[feature.tone ?? "accent"] ?? TONE_TOKENS.accent)) || "#37d7ff",
      (feature) => {
        const glider = feature.id ? gliders.current.get(feature.id) : undefined;
        return glider ? [glider.x, glider.y] : null;
      },
      token("--surface-solid") || undefined,
      token("--text") || undefined,
      (feature) => (feature.id ? runs.current.get(feature.id)?.run : undefined),
      token("--danger") || undefined,
    );
  }, []);

  const startGliding = useCallback(() => {
    // A path restarts when its route or `run` changes, and otherwise carries on.
    const still = document.querySelector(".reduce-motion") !== null;
    const paths = features.current.filter((f): f is OverlayFeature & { id: string; nodes: number[] } => f.type === "path" && !!f.id && Array.isArray(f.nodes));
    const wanted = new Set(paths.map((f) => f.id));
    for (const key of runs.current.keys()) if (!wanted.has(key)) runs.current.delete(key);
    for (const f of paths) {
      const key = `${f.nodes.join()}/${f.run ?? 0}/${f.drive ? `drive${f.count ?? 1}` : "glide"}`;
      if (runs.current.get(f.id)?.key === key) continue;
      const track = network ? trackOf(f.nodes, network) : null;
      if (!track) {
        runs.current.delete(f.id);
        continue;
      }
      // With motion reduced, the route is shown whole and nothing travels it.
      if (f.drive && !still) {
        runs.current.set(f.id, { key, run: new DriveRun(track, f) });
        continue;
      }
      const run = new PathRun(track, f.delay_s ?? 0);
      if (still) {
        run.distance = run.guide = track.total;
        run.finished = true;
      }
      runs.current.set(f.id, { key, run });
    }
    if (still) {
      gliders.current.clear();
      return;
    }
    const named = features.current.filter((f): f is OverlayFeature & { id: string; x_m: number; y_m: number } => !!f.id && f.type !== "path" && typeof f.x_m === "number" && typeof f.y_m === "number");
    const live = new Set(named.map((f) => f.id));
    for (const key of gliders.current.keys()) if (!live.has(key)) gliders.current.delete(key);
    for (const f of named) if (!gliders.current.has(f.id)) gliders.current.set(f.id, { x: f.x_m, y: f.y_m, vx: 0, vy: 0 });
    const flow = features.current.some((f) => f.style === "flow");
    if (motion.current || (!named.length && !runs.current.size && !flow)) return;
    motion.current = animate((dt) => {
      let moving = features.current.some((f) => f.style === "flow");
      for (const f of features.current) {
        if (f.type !== "path" || !f.id) continue;
        const run = runs.current.get(f.id)?.run;
        if (run instanceof DriveRun ? run.step(f, dt, signalOf) : run?.step(f, dt)) moving = true;
      }
      for (const f of features.current) {
        const g = f.id ? gliders.current.get(f.id) : undefined;
        if (!g || typeof f.x_m !== "number" || typeof f.y_m !== "number") continue;
        [g.x, g.vx] = stepSpring(g.x, g.vx, f.x_m, glide.current, dt);
        [g.y, g.vy] = stepSpring(g.y, g.vy, f.y_m, glide.current, dt);
        if (Math.hypot(g.x - f.x_m, g.y - f.y_m) > 0.05 || Math.hypot(g.vx, g.vy) > 0.05) moving = true;
      }
      draw();
      if (!moving) motion.current = null;
      return moving;
    });
  }, [draw, network, signalOf]);
  useEffect(() => () => motion.current?.(), []);

  useImperativeHandle(handle, () => ({
    draw: (next) => {
      view.current = next;
      if (features.current.length) draw();
    },
  }), [draw]);
  useEffect(() => {
    startGliding();
    draw();
  }, [draw, startGliding, items]);

  return <canvas ref={canvas} className="fabric-overlay" aria-hidden="true" />;
});
