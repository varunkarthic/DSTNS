// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { MapTransform } from "../NetworkMap";
import { animate, SPRINGS, stepSpring } from "../motion";
import type { SpringPreset } from "../motion";
import { useSlot } from "./store";
import type { OverlayFeature, Tone } from "./store";

export interface FabricOverlayHandle {
  /** Redraw for a camera position; called every frame of a move, outside React. */
  draw: (view: MapTransform) => void;
}

const TONE_TOKENS: Record<Tone, string> = { neutral: "--text-dim", accent: "--accent", ok: "--ok", warn: "--warn", danger: "--danger" };

/** Draws applications' overlays above the map. Applications name a tone or a series; the palette stays DSTNS's. */
export function paintOverlay(ctx: CanvasRenderingContext2D, features: OverlayFeature[], view: MapTransform, colour: (feature: OverlayFeature) => string, glide?: (feature: OverlayFeature) => [number, number] | null) {
  const X = (x: number) => view.x + x * view.scale;
  const Y = (y: number) => view.y - y * view.scale;
  ctx.font = "11px Inter, sans-serif";
  for (const feature of features) {
    const c = colour(feature);
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = typeof feature.width === "number" ? Math.min(12, Math.max(0.5, feature.width)) : 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(feature.dash ? [5, 6] : []);
    if ((feature.type === "line" || feature.type === "polygon") && Array.isArray(feature.points) && feature.points.length) {
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
  ctx.setLineDash([]);
}

export const FabricOverlay = forwardRef<FabricOverlayHandle>(function FabricOverlay(_, handle) {
  const { items } = useSlot("overlay");
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<MapTransform | null>(null);
  const features = useRef<OverlayFeature[]>([]);
  features.current = items.flatMap((item) => (Array.isArray(item.element.features) ? item.element.features : []));

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
      (feature) => (typeof feature.series === "number" ? token(`--series-${Math.abs(Math.trunc(feature.series)) % 8}`) : token(TONE_TOKENS[feature.tone ?? "accent"] ?? TONE_TOKENS.accent)) || "#37d7ff",
      (feature) => {
        const glider = feature.id ? gliders.current.get(feature.id) : undefined;
        return glider ? [glider.x, glider.y] : null;
      },
    );
  }, []);

  const startGliding = useCallback(() => {
    if (document.querySelector(".reduce-motion")) {
      gliders.current.clear();
      return;
    }
    const named = features.current.filter((f): f is OverlayFeature & { id: string; x_m: number; y_m: number } => !!f.id && typeof f.x_m === "number" && typeof f.y_m === "number");
    const live = new Set(named.map((f) => f.id));
    for (const key of gliders.current.keys()) if (!live.has(key)) gliders.current.delete(key);
    for (const f of named) if (!gliders.current.has(f.id)) gliders.current.set(f.id, { x: f.x_m, y: f.y_m, vx: 0, vy: 0 });
    if (motion.current || !named.length) return;
    motion.current = animate((dt) => {
      let moving = false;
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
  }, [draw]);
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
