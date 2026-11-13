// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef } from "react";

/**
 * The particles of the unstable-engine gate. "gather": they come in from across the screen and settle on the outline
 * of the box, which forms where they land. "scatter": the box gives way to them, and they drift out and fade. One
 * canvas over everything, ignoring the pointer; nothing at all under reduced motion.
 */
export function GateParticles({ target, mode, tone, onDone }: {
  /** The box the particles gather onto or leave from. */
  target: () => DOMRect | null;
  mode: "gather" | "scatter";
  tone: "alpha" | "beta";
  onDone?: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const element = canvas.current;
    const rect = target();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("reduce-motion");
    const context = element?.getContext?.("2d");
    if (!element || !rect || !context || reduce) {
      done.current?.();
      return;
    }
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    element.width = window.innerWidth * scale;
    element.height = window.innerHeight * scale;
    context.scale(scale, scale);
    const colours = tone === "alpha" ? ["#f97316", "#ef4444", "#fb923c", "#dc2626"] : ["#facc15", "#eab308", "#fde047"];
    // Points along the box's rounded outline, evenly spaced.
    const perimeter = 2 * (rect.width + rect.height);
    const count = Math.round(Math.min(900, Math.max(320, perimeter / 3)));
    const onOutline = (t: number) => {
      let d = t * perimeter;
      if (d < rect.width) return [rect.left + d, rect.top];
      d -= rect.width;
      if (d < rect.height) return [rect.right, rect.top + d];
      d -= rect.height;
      if (d < rect.width) return [rect.right - d, rect.bottom];
      d -= rect.width;
      return [rect.left, rect.bottom - d];
    };
    const particles = Array.from({ length: count }, (_, i) => {
      const [ox, oy] = onOutline((i + Math.random() * 0.6) / count);
      const angle = Math.random() * Math.PI * 2;
      const far = Math.max(window.innerWidth, window.innerHeight) * (0.35 + Math.random() * 0.5);
      const fx = ox + Math.cos(angle) * far, fy = oy + Math.sin(angle) * far;
      return {
        from: mode === "gather" ? [fx, fy] : [ox + (Math.random() - 0.5) * 6, oy + (Math.random() - 0.5) * 6],
        to: mode === "gather" ? [ox, oy] : [ox + Math.cos(angle) * far * 0.45, oy + Math.sin(angle) * far * 0.45],
        delay: Math.random() * (mode === "gather" ? 260 : 120),
        size: 0.8 + Math.random() * 1.8,
        colour: colours[i % colours.length],
      };
    });
    const length = mode === "gather" ? 900 : 760;
    const start = performance.now();
    let frame = 0;
    const ease = (t: number) => (mode === "gather" ? 1 - Math.pow(1 - t, 3) : t * t);
    const draw = (now: number) => {
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);
      let alive = false;
      for (const p of particles) {
        const t = Math.min(1, Math.max(0, (now - start - p.delay) / (length - p.delay)));
        if (t < 1) alive = true;
        const k = ease(t);
        const x = p.from[0] + (p.to[0] - p.from[0]) * k;
        const y = p.from[1] + (p.to[1] - p.from[1]) * k;
        context.globalAlpha = mode === "gather" ? Math.min(1, t * 1.6) * (t > 0.92 ? (1 - t) / 0.08 : 1) : 1 - t;
        context.fillStyle = p.colour;
        context.beginPath();
        context.arc(x, y, p.size, 0, Math.PI * 2);
        context.fill();
      }
      if (alive) frame = requestAnimationFrame(draw);
      else {
        context.clearRect(0, 0, window.innerWidth, window.innerHeight);
        done.current?.();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [mode, tone]); // eslint-disable-line react-hooks/exhaustive-deps

  return <canvas ref={canvas} className="engine-gate-particles" aria-hidden="true" />;
}
