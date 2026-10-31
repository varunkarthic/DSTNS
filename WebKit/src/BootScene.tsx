// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef } from "react";
import { stepSpring } from "./motion";

/**
 * A living street network behind the start-up screen.
 *
 * Every junction is on a spring to its home position, so the network gives way
 * under the pointer and rings when clicked. It lights up with the real stages:
 * `progress` comes from what the core reports, never from a timer, so the scene is
 * something to play with during a slow download without pretending to measure it.
 */

interface Junction { hx: number; hy: number; x: number; y: number; vx: number; vy: number; order: number }
const REACH = 170;
const SPRING = { k: 46, c: 7.5 };

function build(width: number, height: number): { nodes: Junction[]; edges: [number, number][] } {
  const cell = Math.max(84, Math.min(width, height) / 7);
  const nodes: Junction[] = [];
  // A fixed sequence, so the network is the same one each time it is seen.
  let seed = 48271;
  const random = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let y = -cell / 2; y < height + cell; y += cell)
    for (let x = -cell / 2; x < width + cell; x += cell) {
      const hx = x + (random() - 0.5) * cell * 0.62;
      const hy = y + (random() - 0.5) * cell * 0.62;
      const distance = Math.hypot(hx - width / 2, hy - height / 2) / Math.hypot(width / 2, height / 2);
      nodes.push({ hx, hy, x: hx, y: hy, vx: 0, vy: 0, order: distance });
    }
  const edges: [number, number][] = [];
  nodes.forEach((a, i) => {
    nodes
      .map((b, j) => [Math.hypot(a.hx - b.hx, a.hy - b.hy), j] as const)
      .filter(([d, j]) => j > i && d < cell * 1.5)
      .sort((p, q) => p[0] - q[0])
      .slice(0, 2)
      .forEach(([, j]) => edges.push([i, j]));
  });
  return { nodes, edges };
}

export function BootScene({ progress, step = 0, idle, closing = false, reduceMotion }: { progress: number; step?: number; idle: boolean; closing?: boolean; reduceMotion: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const target = useRef(progress);
  target.current = progress;
  const idleRef = useRef(idle);
  idleRef.current = idle;
  // Each stage reached sends a ring out from the centre, through the network.
  const pulse = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (step > 0) pulse.current?.();
  }, [step]);
  const closingRef = useRef(closing);
  closingRef.current = closing;

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    let { nodes, edges } = build(window.innerWidth, window.innerHeight);
    let frame = 0;
    let last = performance.now();
    let lit = 0;
    let litVelocity = 0;
    let rings: { x: number; y: number; r: number; alpha: number }[] = [];
    let drift = { x: 0, y: 0 };
    const ring = (x: number, y: number) => rings.push({ x, y, r: 0, alpha: 0.55 });
    pulse.current = () => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      ring(cx, cy);
      for (const node of nodes) {
        const dx = node.x - cx;
        const dy = node.y - cy;
        const distance = Math.hypot(dx, dy) || 1;
        const strength = Math.max(0, 1 - distance / 700) * 240;
        node.vx += (dx / distance) * strength;
        node.vy += (dy / distance) * strength;
      }
    };
    const pointer = { x: -9999, y: -9999 };
    const size = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      element.width = window.innerWidth * ratio;
      element.height = window.innerHeight * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ({ nodes, edges } = build(window.innerWidth, window.innerHeight));
    };
    const paint = (now: number) => {
      const style = getComputedStyle(element);
      const accent = style.getPropertyValue("--accent-rgb").trim() || "55 215 255";
      const line = style.getPropertyValue("--line-rgb").trim() || "178 235 255";
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.save();
      ctx.translate(drift.x, drift.y);
      for (const r of rings) {
        ctx.strokeStyle = `rgb(${accent} / ${(r.alpha * 100).toFixed(1)}%)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      for (const [a, b] of edges) {
        const p = nodes[a];
        const q = nodes[b];
        const on = Math.max(p.order, q.order) <= lit;
        ctx.strokeStyle = on ? `rgb(${accent} / 22%)` : `rgb(${line} / 7%)`;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
        // A vehicle on each lit road, so a wait has something moving in it.
        if (on && !reduceMotion && (a + b) % 3 === 0) {
          const t = ((now / 3600 + (a * 0.137) % 1) % 1);
          ctx.fillStyle = `rgb(${accent} / 70%)`;
          ctx.beginPath();
          ctx.arc(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      for (const node of nodes) {
        const on = node.order <= lit;
        const near = Math.max(0, 1 - Math.hypot(node.x - pointer.x, node.y - pointer.y) / REACH);
        ctx.fillStyle = on || near > 0 ? `rgb(${accent} / ${30 + near * 60}%)` : `rgb(${line} / 14%)`;
        ctx.beginPath();
        ctx.arc(node.x, node.y, 1.6 + near * 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const goal = idleRef.current ? 0.2 : 0.18 + target.current * 0.95;
      [lit, litVelocity] = stepSpring(lit, litVelocity, goal, SPRING, dt);
      for (const node of nodes) {
        const dx = node.x - pointer.x;
        const dy = node.y - pointer.y;
        const distance = Math.hypot(dx, dy) || 1;
        if (distance < REACH) {
          const push = (1 - distance / REACH) * 780 * dt;
          node.vx += (dx / distance) * push;
          node.vy += (dy / distance) * push;
        }
        [node.x, node.vx] = stepSpring(node.x, node.vx, node.hx, SPRING, dt);
        [node.y, node.vy] = stepSpring(node.y, node.vy, node.hy, SPRING, dt);
      }
      rings = rings.filter((r) => r.alpha > 0.01);
      for (const r of rings) {
        r.r += 520 * dt;
        r.alpha *= Math.exp(-1.9 * dt);
      }
      // The whole network leans a little towards the pointer, for depth.
      const wantX = pointer.x < -999 ? 0 : (pointer.x - window.innerWidth / 2) * -0.018;
      const wantY = pointer.y < -999 ? 0 : (pointer.y - window.innerHeight / 2) * -0.018;
      drift = { x: drift.x + (wantX - drift.x) * Math.min(1, dt * 4), y: drift.y + (wantY - drift.y) * Math.min(1, dt * 4) };
      paint(now);
      frame = requestAnimationFrame(tick);
    };
    const onMove = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    };
    const onLeave = () => {
      pointer.x = pointer.y = -9999;
    };
    const onRipple = (event: PointerEvent) => {
      ring(event.clientX, event.clientY);
      for (const node of nodes) {
        const dx = node.x - event.clientX;
        const dy = node.y - event.clientY;
        const distance = Math.hypot(dx, dy) || 1;
        if (distance < 420) {
          const strength = (1 - distance / 420) * 520;
          node.vx += (dx / distance) * strength;
          node.vy += (dy / distance) * strength;
        }
      }
    };
    size();
    window.addEventListener("resize", size);
    if (reduceMotion) {
      lit = idleRef.current ? 0.2 : 0.18 + target.current * 0.95;
      paint(0);
    } else {
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerdown", onRipple);
      document.addEventListener("pointerleave", onLeave);
      frame = requestAnimationFrame(tick);
    }
    return () => {
      pulse.current = null;
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", size);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onRipple);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, [reduceMotion]);

  return <canvas ref={canvas} className="boot-scene" aria-hidden="true" />;
}
