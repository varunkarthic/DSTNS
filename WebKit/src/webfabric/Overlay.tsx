// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { MapTransform } from "../NetworkMap";
import { useSlot } from "./store";
import type { OverlayFeature, Tone } from "./store";

export interface FabricOverlayHandle {
  /** Redraw for a camera position; called every frame of a move, outside React. */
  draw: (view: MapTransform) => void;
}

const TONE_TOKENS: Record<Tone, string> = { neutral: "--text-dim", accent: "--accent", ok: "--ok", warn: "--warn", danger: "--danger" };

/** Draws applications' overlays above the map. Applications name a tone; the palette stays DSTNS's. */
export function paintOverlay(ctx: CanvasRenderingContext2D, features: OverlayFeature[], view: MapTransform, colour: (tone: Tone) => string) {
  const X = (x: number) => view.x + x * view.scale;
  const Y = (y: number) => view.y - y * view.scale;
  ctx.lineWidth = 2;
  ctx.font = "11px Inter, sans-serif";
  for (const feature of features) {
    const c = colour(feature.tone ?? "accent");
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
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
      const radius = feature.type === "circle" ? Math.max(3, (feature.radius_m ?? 50) * view.scale) : 4;
      ctx.beginPath();
      ctx.arc(X(feature.x_m), Y(feature.y_m), radius, 0, Math.PI * 2);
      ctx.globalAlpha = feature.type === "circle" ? 0.16 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (feature.type === "circle") ctx.stroke();
      if (feature.label) ctx.fillText(String(feature.label).slice(0, 60), X(feature.x_m) + radius + 4, Y(feature.y_m) + 4);
    }
  }
}

export const FabricOverlay = forwardRef<FabricOverlayHandle>(function FabricOverlay(_, handle) {
  const { items } = useSlot("overlay");
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<MapTransform | null>(null);
  const features = useRef<OverlayFeature[]>([]);
  features.current = items.flatMap((item) => (Array.isArray(item.element.features) ? item.element.features : []));

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
    paintOverlay(context, features.current, view.current, (tone) => style.getPropertyValue(TONE_TOKENS[tone] ?? TONE_TOKENS.accent).trim() || "#37d7ff");
  }, []);

  useImperativeHandle(handle, () => ({
    draw: (next) => {
      view.current = next;
      if (features.current.length) draw();
    },
  }), [draw]);
  useEffect(draw, [draw, items]);

  return <canvas ref={canvas} className="fabric-overlay" aria-hidden="true" />;
});
