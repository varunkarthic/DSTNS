// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { sequence } from "./bootScenes";

/**
 * The report being put together, out of what is on screen.
 *
 * It is one unbroken movement. The interface blurs back, and a blank sheet grows out of the button
 * that asked for it, along a curve. The map's roads lift off in their own shape and stream round on
 * to the sheet, becoming the dark cover. The panels then stream on to a second page behind a turned
 * cover. The pages close up into one, and go back along the curve they came by, into the button, as
 * the file saves. Each particle leaves when the worker's real progress reaches it, so this cannot run
 * ahead of the work, and what has landed is painted once on to its page, so only what is in the air
 * costs anything.
 */

interface Block { u0: number; v0: number; u1: number; v1: number; ink: string; share: number; from: "roads" | "panels" }
interface Page { paper: string; flying: string; blocks: Block[]; from: number; to: number }

const lines = (top: number, count: number, ink: string, share: number): Block[] =>
  Array.from({ length: count }, (_, n) => ({ u0: 0.08, v0: top + n * 0.024, u1: 0.92 - ((n * 37) % 5) * 0.07, v1: top + 0.006 + n * 0.024, ink, share, from: "panels" as const }));

// The two pages, laid out as the report lays them out, as shares of their width and height.
const PAGES: Page[] = [
  {
    paper: "#071420",
    flying: "#6fe0c0",
    from: 0,
    to: 0.5,
    blocks: [
      { u0: 0.08, v0: 0.05, u1: 0.92, v1: 0.66, ink: "#35c8a0", share: 1.5, from: "roads" },
      { u0: 0.08, v0: 0.71, u1: 0.56, v1: 0.765, ink: "#ffffff", share: 0.09, from: "panels" },
      ...[0, 1, 2, 3].map((n) => ({ u0: 0.08 + n * 0.215, v0: 0.82, u1: 0.25 + n * 0.215, v1: 0.84, ink: "#cfe2ee", share: 0.018, from: "panels" as const })),
      ...[0, 1, 2, 3].map((n) => ({ u0: 0.08 + n * 0.215, v0: 0.87, u1: 0.25 + n * 0.215, v1: 0.89, ink: "#cfe2ee", share: 0.018, from: "panels" as const })),
    ],
  },
  {
    paper: "#ffffff",
    flying: "#6fd7f2",
    from: 0.5,
    to: 1,
    blocks: [
      { u0: 0.08, v0: 0.07, u1: 0.5, v1: 0.1, ink: "#0f1d27", share: 0.08, from: "panels" },
      ...[0, 1, 2, 3].map((n) => ({ u0: 0.08 + n * 0.215, v0: 0.14, u1: 0.27 + n * 0.215, v1: 0.215, ink: ["#0a7f9e", "#b86e00", "#c0303a", "#0d8f6b"][n], share: 0.07, from: "panels" as const })),
      ...lines(0.25, 5, "#4b5c68", 0.02),
      ...[0.3, 0.5, 0.85, 0.62, 1, 0.74, 0.46, 0.58, 0.9, 0.7, 0.4, 0.28].map((tall, n) => ({ u0: 0.08 + n * 0.071, v0: 0.57 - tall * 0.2, u1: 0.13 + n * 0.071, v1: 0.57, ink: tall > 0.8 ? "#b86e00" : "#0a7f9e", share: 0.022, from: "panels" as const })),
      ...lines(0.62, 6, "#4b5c68", 0.02),
      { u0: 0.08, v0: 0.79, u1: 0.92, v1: 0.93, ink: "#0a7f9e", share: 0.1, from: "panels" },
    ],
  },
];
const COUNT = 13000;
// Seconds, at the least: long enough to follow, whatever the worker's own speed.
const MIN_S = 3.1;
const FLIGHT_S = 0.95;
const GROW_MS = 760;

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

export function ReportFilm({ label, share, ready, roads, target, reduceMotion, onDone }: {
  label: string;
  /** How far the worker has got, 0 to 1. */
  share: number;
  /** The file is finished. */
  ready: boolean;
  /** The map's roads, as points on the page in clip space, four numbers each. */
  roads: () => Float32Array | null;
  /** The button it comes out of and goes back to. */
  target: () => DOMRect | null;
  reduceMotion: boolean;
  onDone: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const air = useRef<HTMLCanvasElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const cover = useRef<HTMLCanvasElement>(null);
  const inner = useRef<HTMLCanvasElement>(null);
  const fill = useRef<HTMLElement>(null);
  const words = useRef<HTMLElement>(null);
  const latest = useRef({ share, ready, onDone });
  latest.current = { share, ready, onDone };
  // The words keep pace with what is seen, not with the worker, which is usually ahead of it.
  const said = useRef<{ share: number; label: string }[]>([]);
  if (said.current[said.current.length - 1]?.label !== label && label !== "Done") said.current.push({ share, label });

  useEffect(() => {
    if (reduceMotion) return;
    const canvas = air.current;
    const holder = stack.current;
    const papers = [cover.current, inner.current];
    const ctx = canvas?.getContext("2d");
    const inks = papers.map((p) => p?.getContext("2d") ?? null);
    if (!canvas || !holder || !ctx || !inks[0] || !inks[1]) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = window.innerWidth * ratio;
    canvas.height = window.innerHeight * ratio;
    const box = holder.getBoundingClientRect();
    papers.forEach((paper, n) => {
      if (!paper) return;
      paper.width = box.width * ratio;
      paper.height = box.height * ratio;
      const ink = inks[n]!;
      ink.scale(ratio, ratio);
      ink.fillStyle = PAGES[n].paper;
      ink.fillRect(0, 0, box.width, box.height);
    });
    ctx.scale(ratio, ratio);

    // Out of the button, along a curve: the same path it will go back by.
    const button = target();
    const [dx, dy] = button ? [button.left + button.width / 2 - (box.left + box.width / 2), button.top + button.height / 2 - (box.top + box.height / 2)] : [0, 240];
    const small = `translate(${dx}px, ${dy}px) scale(0.05)`;
    const middle = `translate(${dx * 0.42}px, ${dy * 0.18}px) scale(0.5)`;
    holder.animate([{ transform: small, opacity: 0, offset: 0 }, { opacity: 1, offset: 0.25 }, { transform: middle, offset: 0.55 }, { transform: "none", opacity: 1, offset: 1 }], { duration: GROW_MS, easing: "cubic-bezier(0.3, 0, 0.1, 1)", fill: "both" });

    const random = sequence(4077);
    const onRoads = roads();
    const rects = [...document.querySelectorAll(".metric, .stream-card, .rail, .map-dock, .hud-group, .capsule, .app-header, .tab-row")].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    if (onRoads) {
      for (let at = 0; at < onRoads.length; at += 4) {
        minX = Math.min(minX, onRoads[at]);
        maxX = Math.max(maxX, onRoads[at]);
        minY = Math.min(minY, onRoads[at + 1]);
        maxY = Math.max(maxY, onRoads[at + 1]);
      }
    }
    const aspect = window.innerWidth / window.innerHeight;
    // from x y, to x y, leaves, curve, page, block
    const air8 = new Float32Array(COUNT * 8);
    const blocks = PAGES.flatMap((page, p) => page.blocks.map((block) => ({ block, p, page })));
    const totals = blocks.map(({ block, page }) => block.share * (page.to - page.from));
    const sum = totals.reduce((a, b) => a + b, 0);
    for (let i = 0; i < COUNT; i++) {
      let pick = random() * sum;
      let index = 0;
      while (pick > totals[index] && index < totals.length - 1) pick -= totals[index++];
      const { block, p, page } = blocks[index];
      let [sx, sy, u, v] = [0, 0, random(), random()];
      if (block.from === "roads" && onRoads?.length) {
        const at = Math.floor(random() * (onRoads.length / 4)) * 4;
        sx = ((onRoads[at] + 1) / 2) * window.innerWidth;
        sy = ((1 - onRoads[at + 1]) / 2) * window.innerHeight;
        // Where this point of road falls on the cover, keeping the map's proportions, whole.
        const [w, h] = [(block.u1 - block.u0) * box.width, (block.v1 - block.v0) * box.height];
        const fit = Math.min(w / ((maxX - minX) * aspect), h / (maxY - minY));
        u = ((w - (maxX - minX) * aspect * fit) / 2 + (onRoads[at] - minX) * aspect * fit) / w;
        v = ((h - (maxY - minY) * fit) / 2 + (maxY - onRoads[at + 1]) * fit) / h;
      } else {
        const r = rects[Math.floor(random() * rects.length)];
        [sx, sy] = r ? [r.left + random() * r.width, r.top + random() * r.height] : [random() * window.innerWidth, random() * window.innerHeight];
      }
      // Each page fills downwards, as a page is read.
      const down = block.v0 * 0.86 + random() * 0.14;
      air8.set([sx, sy, box.left + (block.u0 + (block.u1 - block.u0) * u) * box.width, box.top + (block.v0 + (block.v1 - block.v0) * v) * box.height, page.from + down * (page.to - page.from) * 0.92, 0.16 + random() * 0.16, p, index], i * 8);
    }
    const landed = new Uint8Array(COUNT);
    let landedCount = 0;
    let shown = 0;
    let frame = 0;
    let flew = 0;
    let turned = false;
    const started = performance.now() + GROW_MS * 0.5;
    const paint = (now: number) => {
      const elapsed = Math.max(0, (now - started) / 1000);
      const real = latest.current.ready ? 1 : latest.current.share;
      // It follows the work, and takes long enough to be followed when the work is quick.
      const aim = Math.min(real, elapsed / MIN_S);
      shown += (aim - shown) * 0.1;
      if (latest.current.ready && aim >= 1) shown = Math.max(shown, 0.999);
      if (fill.current) fill.current.style.transform = `translateX(${Math.min(1, shown / 0.97) * 100 - 100}%)`;
      if (words.current) {
        const now_ = shown >= 0.985 ? "Done" : [...said.current].reverse().find((step) => step.share <= shown)?.label ?? said.current[0]?.label ?? "";
        if (words.current.textContent !== now_) words.current.textContent = now_;
      }
      // With the cover done, it turns aside, and the inner page takes the front.
      if (!turned && shown > 0.5) {
        turned = true;
        holder.classList.add("turned");
      }
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.lineWidth = 1;
      ctx.lineCap = "round";
      ctx.globalAlpha = 0.85;
      for (const pass of [0, 1]) {
        // On a light screen they need the weight that the dark one gives them for nothing.
        ctx.strokeStyle = document.documentElement.dataset.theme === "light" ? ["#0d8f6b", "#0a7f9e"][pass] : PAGES[pass].flying;
        ctx.beginPath();
        for (let i = 0; i < COUNT; i++) {
          const at = i * 8;
          if (landed[i] || air8[at + 6] !== pass || shown < air8[at + 4]) continue;
          const t = (shown - air8[at + 4]) / 0.14 + (elapsed - air8[at + 4] * MIN_S) / (FLIGHT_S * 4);
          if (t >= 1) {
            landed[i] = 1;
            landedCount += 1;
            const ink = inks[pass]!;
            ink.fillStyle = blocks[air8[at + 7]].block.ink;
            ink.fillRect(air8[at + 2] - box.left, air8[at + 3] - box.top, 1.3, 1.3);
            continue;
          }
          // All of them round the same way, so that it reads as one flow.
          const position = (time: number) => {
            const e = ease(Math.max(0, time));
            const [fx, fy, tx, ty] = [air8[at], air8[at + 1], air8[at + 2], air8[at + 3]];
            const bend = Math.sin(e * Math.PI) * air8[at + 5];
            return [fx + (tx - fx) * e - (ty - fy) * bend, fy + (ty - fy) * e + (tx - fx) * bend];
          };
          const [x0, y0] = position(t - 0.014);
          const [x1, y1] = position(t);
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
        }
        ctx.stroke();
      }
      // Everything has landed: the pages close up, and go back to the button by the way they came.
      if (latest.current.ready && landedCount >= COUNT * 0.995 && !flew) {
        flew = now;
        holder.classList.remove("turned");
        root.current?.classList.add("leaving");
        holder.animate([{ transform: "none", opacity: 1 }, { transform: middle, opacity: 1, offset: 0.5 }, { transform: small, opacity: 0.2 }], { duration: 620, delay: 120, easing: "cubic-bezier(0.6, 0, 0.3, 1)", fill: "forwards" });
        window.setTimeout(() => latest.current.onDone(), 760);
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [reduceMotion, roads, target]);

  // Without the film, the file saves as soon as it is ready.
  useEffect(() => {
    if (reduceMotion && ready) onDone();
  }, [reduceMotion, ready, onDone]);

  // On the page itself, because a blur can only see what its own ancestors let it.
  return createPortal(
    <div ref={root} className={`report-film${reduceMotion ? " still" : ""}`} role="status" aria-live="polite">
      <div className="report-stack" ref={stack} aria-hidden="true">
        <canvas ref={inner} className="report-page inner" />
        <canvas ref={cover} className="report-page cover" />
      </div>
      <div className="report-film-label">
        <strong ref={words}>{reduceMotion ? label : said.current[0]?.label}</strong>
        <span className="report-film-bar" aria-hidden="true"><i ref={fill} style={reduceMotion ? { transform: `translateX(${share * 100 - 100}%)` } : undefined} /></span>
      </div>
      <canvas ref={air} className="report-film-air" aria-hidden="true" />
    </div>,
    document.body,
  );
}
