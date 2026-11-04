// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef, useState } from "react";
import { useTimeFormat } from "./preferences";
import { formatDuration } from "./timeFormat";

/** A jump through the day, while the server works it out: which way, how far, and from and to when. */
export interface Seek {
  direction: 1 | -1;
  seconds: number;
  from?: number;
  to?: number;
}

/** A jump that answers sooner than this shows nothing, so that a quick one does not flash. */
const SHOW_AFTER_MS = 180;
const FADE_MS = 420;
/** Long enough for the stream to slow to a stop once the jump has landed. */
const SETTLE_MS = 900;
/** How quickly the stream gathers speed, and how quickly it slows. */
const RISE_S = 0.22;
const FALL_S = 0.3;
/** How quickly the clock runs towards where the jump lands while it is worked out. */
const ROLL_S = 0.9;

/** The clock while a jump is worked out: most of the way at first, and never quite there until it has landed. */
export function rollingTime(from: number, to: number, elapsedS: number, landed: boolean): number {
  if (landed) return to;
  return from + (to - from) * 0.92 * (1 - Math.exp(-elapsedS / ROLL_S));
}

/**
 * Faint particles streaming across the map while a jump is worked out, the way it goes, and the clock running with
 * them. A minute is a light drift; an hour, which takes longest, is a denser, faster stream with longer trails. The
 * stream gathers speed as it starts and slows to a stop once the jump has landed, so it never starts or stops dead.
 */
export function SeekFilm({ seek, reduceMotion }: { seek: Seek | null; reduceMotion: boolean }) {
  const time = useTimeFormat();
  const format = useRef(time.time);
  format.current = time.time;
  const canvas = useRef<HTMLCanvasElement>(null);
  const clock = useRef<HTMLElement>(null);
  const [shown, setShown] = useState<Seek | null>(null);
  const [visible, setVisible] = useState(false);
  /** Still being worked out: the stream keeps its speed. Landed: it slows to a stop. */
  const live = useRef(false);
  useEffect(() => {
    if (seek) {
      live.current = true;
      const t = setTimeout(() => {
        setShown(seek);
        setVisible(true);
      }, SHOW_AFTER_MS);
      return () => clearTimeout(t);
    }
    live.current = false;
    setVisible(false);
    const t = setTimeout(() => setShown(null), reduceMotion ? FADE_MS : SETTLE_MS);
    return () => clearTimeout(t);
  }, [seek, reduceMotion]);

  useEffect(() => {
    const element = canvas.current;
    if (!shown || !element || reduceMotion) return;
    const context = element.getContext("2d");
    if (!context) return;
    // 0 for a minute, 1 for an hour, on a log scale between.
    const reach = Math.max(0, Math.min(1, Math.log(Math.max(60, shown.seconds) / 60) / Math.log(60)));
    const count = Math.round(70 + 230 * reach);
    const speed = 260 + 900 * reach; // px a second, at full flow
    const trail = 10 + 60 * reach;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      element.width = Math.round(element.clientWidth * ratio);
      element.height = Math.round(element.clientHeight * ratio);
    };
    resize();
    const accent = getComputedStyle(element).getPropertyValue("--accent").trim() || "#37d7ff";
    const particles = Array.from({ length: count }, () => ({
      x: Math.random(),
      lane: Math.random(),
      pace: 0.45 + Math.random() * 0.9,
      size: 0.9 + Math.random() * 1.3,
      glow: 0.25 + Math.random() * 0.75,
      // A long, slow wave across the map, each on its own, so the stream flows rather than ruling lines.
      wave: 1 + Math.random() * 2.5,
      phase: Math.random() * Math.PI * 2,
      swell: 0.004 + Math.random() * 0.012,
    }));
    const started = performance.now();
    let flow = 0;
    let last = started;
    let frame = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // The stream's strength, on its way up or down, by the same law each frame whatever the frame rate.
      const want = live.current ? 1 : 0;
      flow += (want - flow) * (1 - Math.exp(-dt / (want > flow ? RISE_S : FALL_S)));
      const width = element.clientWidth, height = element.clientHeight;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.lineCap = "round";
      for (const p of particles) {
        p.x += (shown.direction * speed * p.pace * flow * dt) / width;
        if (p.x > 1.05) (p.x = -0.05), (p.lane = Math.random());
        if (p.x < -0.05) (p.x = 1.05), (p.lane = Math.random());
        const y = p.lane + Math.sin(p.x * Math.PI * 2 * p.wave + p.phase) * p.swell;
        // Thicker toward the middle of the map, where the eye is, and gone at its edges.
        const edge = Math.sin(Math.PI * Math.max(0, Math.min(1, p.x))) * Math.sin(Math.PI * Math.max(0, Math.min(1, y)));
        const alpha = 0.55 * p.glow * edge * flow;
        if (alpha < 0.01) continue;
        const x = p.x * width, py = y * height;
        // The trail shortens as the stream slows, and fades to nothing behind its head.
        const tail = x - shown.direction * trail * p.pace * (0.25 + 0.75 * flow);
        const gradient = context.createLinearGradient(tail, py, x, py);
        gradient.addColorStop(0, "transparent");
        gradient.addColorStop(1, accent);
        context.globalAlpha = alpha;
        context.strokeStyle = gradient;
        context.lineWidth = p.size;
        context.beginPath();
        context.moveTo(tail, py);
        context.lineTo(x, py);
        context.stroke();
      }
      if (clock.current && shown.from !== undefined && shown.to !== undefined)
        clock.current.textContent = format.current(rollingTime(shown.from, shown.to, (now - started) / 1000, !live.current), { seconds: false });
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
  const hasClock = shown.from !== undefined && shown.to !== undefined;
  return (
    <div className={`seek-film${visible ? " visible" : ""}`} aria-hidden="true">
      {!reduceMotion && <canvas ref={canvas} />}
      <span className="seek-film-label">
        {shown.direction > 0 ? "Fast-forward" : "Rewind"} <b>{formatDuration(shown.seconds)}</b>
        {hasClock && (
          <span className="seek-film-clock mono" ref={clock}>
            {time.time(reduceMotion ? shown.to! : shown.from!, { seconds: false })}
          </span>
        )}
      </span>
    </div>
  );
}
