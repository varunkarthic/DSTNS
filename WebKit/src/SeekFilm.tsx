// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef, useState } from "react";
import { formatDuration } from "./timeFormat";

/** A jump through the day, while the server works it out: which way, and how far. */
export interface Seek {
  direction: 1 | -1;
  seconds: number;
}

/** A jump that answers sooner than this shows nothing, so that a quick one does not flash. */
const SHOW_AFTER_MS = 180;
const FADE_MS = 420;

/**
 * Faint particles streaming across the map while a jump is worked out, the way it goes. A minute is a light drift; an
 * hour, which takes longest, is a denser, faster stream with longer trails. Between, it scales with the jump.
 */
export function SeekFilm({ seek, reduceMotion }: { seek: Seek | null; reduceMotion: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [shown, setShown] = useState<Seek | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (seek) {
      const t = setTimeout(() => {
        setShown(seek);
        setVisible(true);
      }, SHOW_AFTER_MS);
      return () => clearTimeout(t);
    }
    setVisible(false);
    const t = setTimeout(() => setShown(null), FADE_MS);
    return () => clearTimeout(t);
  }, [seek]);

  useEffect(() => {
    const element = canvas.current;
    if (!shown || !element || reduceMotion) return;
    const context = element.getContext("2d");
    if (!context) return;
    // 0 for a minute, 1 for an hour, on a log scale between.
    const reach = Math.max(0, Math.min(1, Math.log(shown.seconds / 60) / Math.log(60)));
    const count = Math.round(70 + 230 * reach);
    const speed = 260 + 900 * reach; // px a second
    const trail = 10 + 60 * reach;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      element.width = Math.round(element.clientWidth * ratio);
      element.height = Math.round(element.clientHeight * ratio);
    };
    resize();
    const accent = getComputedStyle(element).getPropertyValue("--accent").trim() || "#37d7ff";
    const particles = Array.from({ length: count }, () => ({ x: Math.random(), y: Math.random(), pace: 0.45 + Math.random() * 0.9, size: 0.9 + Math.random() * 1.3, glow: 0.25 + Math.random() * 0.75 }));
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const width = element.clientWidth, height = element.clientHeight;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.strokeStyle = accent;
      context.lineCap = "round";
      for (const p of particles) {
        p.x += (shown.direction * speed * p.pace * dt) / width;
        if (p.x > 1.05) (p.x = -0.05), (p.y = Math.random());
        if (p.x < -0.05) (p.x = 1.05), (p.y = Math.random());
        // Thicker toward the middle of the map, where the eye is, and gone at its edges.
        const edge = Math.sin(Math.PI * Math.max(0, Math.min(1, p.x))) * Math.sin(Math.PI * p.y);
        context.globalAlpha = 0.55 * p.glow * edge;
        context.lineWidth = p.size;
        const x = p.x * width, y = p.y * height;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x - shown.direction * trail * p.pace, y);
        context.stroke();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [shown, reduceMotion]);

  if (!shown) return null;
  return (
    <div className={`seek-film${visible ? " visible" : ""}`} aria-hidden="true">
      {!reduceMotion && <canvas ref={canvas} />}
      <span className="seek-film-label">
        {shown.direction > 0 ? "Fast-forward" : "Rewind"} <b>{formatDuration(shown.seconds)}</b>
      </span>
    </div>
  );
}
