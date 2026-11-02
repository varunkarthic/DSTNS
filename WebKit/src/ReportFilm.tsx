// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { sequence } from "./bootScenes";
import { paintCover } from "./reportMap";
import type { Snapshot, Topology } from "./types";

/**
 * The report being printed, out of what is on screen.
 *
 * The screen blurs back, and a sheet grows out of the button that asked for it. Streams of particles
 * leave the map and the panels, curve round to the sheet's edges and run in along a line of light, and
 * as that line moves down the sheet it leaves the page behind it. These are the report's real pages, in
 * miniature, with this run's own figures: its cover, its summary, its day and its map. A finished page
 * tucks in behind the next, and the deck goes back along the way it came as the file saves.
 *
 * Its pace follows the worker building the file, so this cannot run ahead of it, and it takes long
 * enough to follow when the work is quick. Only what is in the air costs anything each frame: a page
 * is drawn once, and revealed by copying the strip the line has just passed over.
 */

export interface ReportPreview {
  city: string;
  country: string;
  seed: string;
  generated: string;
  /** Four figures from this run. */
  figures: { label: string; value: string; tone: string }[];
  /** The congestion index across the day, oldest first. */
  day: number[];
  topology: Topology;
  snapshot: Snapshot;
}

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
// Seconds, at the least, for the whole report.
const MIN_S = 4.4;
const GROW_MS = 760;
// Particles a second, and how long each is in the air.
const FEED = 620;
const FLIGHT_S = 0.95;
const INK = "#0f1d27";
const DIM = "#4b5c68";
const RULE = "#dfe5ea";
const ACCENT = "#0a7f9e";

type Paint = (g: CanvasRenderingContext2D, w: number, h: number) => void;

/** The pages, as the report lays them out, with real words only where they are large enough to read. */
function pagesFor(preview: ReportPreview, roads: Float32Array | null): Paint[] {
  const heading = (g: CanvasRenderingContext2D, w: number, label: string, title: string) => {
    g.fillStyle = ACCENT;
    g.font = `500 ${w * 0.02}px Inter, system-ui, sans-serif`;
    g.fillText(label, w * 0.08, w * 0.12);
    g.fillStyle = INK;
    g.font = `400 ${w * 0.058}px Inter, system-ui, sans-serif`;
    g.fillText(title, w * 0.08, w * 0.195);
    g.fillStyle = ACCENT;
    g.fillRect(w * 0.08, w * 0.215, w * 0.09, Math.max(1, w * 0.004));
  };
  const lines = (g: CanvasRenderingContext2D, w: number, top: number, count: number) => {
    g.fillStyle = RULE;
    for (let n = 0; n < count; n++) {
      const long = 0.84 - ((n * 37) % 5) * 0.07;
      g.beginPath();
      g.roundRect(w * 0.08, top + n * w * 0.034, w * long, w * 0.012, w * 0.006);
      g.fill();
    }
  };
  return [
    // The cover, painted exactly as the report's own is, only smaller.
    (g, w, h) => {
      g.fillStyle = "#071420";
      g.fillRect(0, 0, w, h);
      // Small, since this runs on the page and the image is soft. The film must not wait for it.
      const city = paintCover(preview.topology, preview.snapshot, Math.min(w, 420));
      if (city) g.drawImage(city as CanvasImageSource, 0, 0, w, h);
      const room = w * 0.84;
      let size = w * 0.135;
      g.font = `400 ${size}px Inter, system-ui, sans-serif`;
      size = Math.min(size, (size * room) / g.measureText(preview.city).width);
      g.font = `400 ${size}px Inter, system-ui, sans-serif`;
      g.fillStyle = "#ffffff";
      g.fillText(preview.city, w * 0.08, h * 0.8);
      g.font = `400 ${w * 0.034}px Inter, system-ui, sans-serif`;
      g.fillStyle = "#9fb4c3";
      g.fillText(preview.country, w * 0.08, h * 0.8 + w * 0.06);
      g.fillStyle = "#5ee3bf";
      g.fillRect(w * 0.08, h * 0.87, w * 0.08, Math.max(1, w * 0.005));
      g.font = `400 ${w * 0.022}px Inter, system-ui, sans-serif`;
      g.fillStyle = "#e6f0f7";
      g.fillText(`Seed ${preview.seed.length > 22 ? `${preview.seed.slice(0, 20)}…` : preview.seed}`, w * 0.08, h * 0.915);
      g.fillText(preview.generated, w * 0.52, h * 0.915);
    },
    // The summary, with its own figures.
    (g, w, h) => {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, w, h);
      heading(g, w, "SECTION 1", "Executive Summary");
      const tile = w * 0.2;
      preview.figures.slice(0, 4).forEach((figure, n) => {
        const x = w * 0.08 + n * (tile + w * 0.013);
        g.fillStyle = "#f2f5f7";
        g.beginPath();
        g.roundRect(x, w * 0.27, tile, w * 0.15, w * 0.015);
        g.fill();
        g.fillStyle = "#7b8a95";
        g.font = `500 ${w * 0.017}px Inter, system-ui, sans-serif`;
        g.fillText(figure.label.toUpperCase(), x + w * 0.016, w * 0.305);
        g.fillStyle = figure.tone;
        g.font = `400 ${w * 0.038}px Inter, system-ui, sans-serif`;
        g.fillText(figure.value, x + w * 0.016, w * 0.365, tile - w * 0.03);
      });
      lines(g, w, w * 0.49, 7);
      g.fillStyle = INK;
      g.font = `500 ${w * 0.03}px Inter, system-ui, sans-serif`;
      g.fillText("Key observations", w * 0.08, w * 0.82);
      lines(g, w, w * 0.86, 9);
    },
    // The day, from this run's own history.
    (g, w, h) => {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, w, h);
      heading(g, w, "SECTION 5", "Traffic Analysis");
      const [left, top, width, tall] = [w * 0.08, w * 0.3, w * 0.84, w * 0.4];
      g.strokeStyle = RULE;
      g.lineWidth = 1;
      for (let n = 0; n <= 4; n++) {
        g.beginPath();
        g.moveTo(left, top + (n / 4) * tall);
        g.lineTo(left + width, top + (n / 4) * tall);
        g.stroke();
      }
      const day = preview.day.length > 1 ? preview.day : [8, 12, 34, 72, 44, 30, 36, 58, 90, 62, 28, 14];
      const most = Math.max(1, ...day);
      const at = (n: number) => [left + (n / (day.length - 1)) * width, top + tall - (day[n] / most) * tall * 0.92] as const;
      g.beginPath();
      day.forEach((_, n) => (n ? g.lineTo(...at(n)) : g.moveTo(...at(n))));
      g.lineTo(left + width, top + tall);
      g.lineTo(left, top + tall);
      g.closePath();
      g.fillStyle = "rgba(10, 127, 158, 0.12)";
      g.fill();
      g.beginPath();
      day.forEach((_, n) => (n ? g.lineTo(...at(n)) : g.moveTo(...at(n))));
      g.strokeStyle = ACCENT;
      g.lineWidth = Math.max(1.5, w * 0.005);
      g.lineJoin = "round";
      g.stroke();
      g.fillStyle = DIM;
      g.font = `500 ${w * 0.03}px Inter, system-ui, sans-serif`;
      g.fillStyle = INK;
      g.fillText("Most congested roads", w * 0.08, w * 0.8);
      for (let n = 0; n < 10; n++) {
        g.fillStyle = n % 2 ? "#ffffff" : "#f2f5f7";
        g.fillRect(w * 0.08, w * (0.83 + n * 0.04), w * 0.84, w * 0.04);
        g.fillStyle = RULE;
        g.beginPath();
        g.roundRect(w * 0.1, w * (0.845 + n * 0.04), w * (0.34 - ((n * 13) % 7) * 0.02), w * 0.011, w * 0.005);
        g.roundRect(w * 0.72, w * (0.845 + n * 0.04), w * 0.16, w * 0.011, w * 0.005);
        g.fill();
      }
    },
    // The map, in print colours, from the roads on screen.
    (g, w, h) => {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, w, h);
      heading(g, w, "SECTION 13", "Map at Export");
      const box = { x: w * 0.08, y: w * 0.28, w: w * 0.84, h: h - w * 0.28 - w * 0.2 };
      g.fillStyle = "#f6f8fa";
      g.beginPath();
      g.roundRect(box.x, box.y, box.w, box.h, w * 0.015);
      g.fill();
      if (roads?.length) {
        let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
        for (let at = 0; at < roads.length; at += 4) {
          minX = Math.min(minX, roads[at]);
          maxX = Math.max(maxX, roads[at]);
          minY = Math.min(minY, roads[at + 1]);
          maxY = Math.max(maxY, roads[at + 1]);
        }
        const aspect = window.innerWidth / window.innerHeight;
        const fit = Math.min((box.w * 0.92) / ((maxX - minX) * aspect), (box.h * 0.92) / (maxY - minY));
        const [ox, oy] = [box.x + (box.w - (maxX - minX) * aspect * fit) / 2, box.y + (box.h - (maxY - minY) * fit) / 2];
        g.fillStyle = "#2fa98a";
        const dot = Math.max(0.7, w * 0.0028);
        for (let at = 0; at < roads.length; at += 4) g.fillRect(ox + (roads[at] - minX) * aspect * fit, oy + (maxY - roads[at + 1]) * fit, dot, dot);
      }
      lines(g, w, h - w * 0.14, 3);
    },
  ];
}

export function ReportFilm({ label, share, ready, preview, roads, target, reduceMotion, onDone }: {
  label: string;
  /** How far the worker has got, 0 to 1. */
  share: number;
  /** The file is finished. */
  ready: boolean;
  preview: ReportPreview;
  /** The map's roads, as points on the page in clip space, four numbers each. */
  roads: () => Float32Array | null;
  /** The button it comes out of and goes back to. */
  target: () => DOMRect | null;
  reduceMotion: boolean;
  onDone: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const air = useRef<HTMLCanvasElement>(null);
  const deck = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLElement>(null);
  const fill = useRef<HTMLElement>(null);
  const words = useRef<HTMLElement>(null);
  const latest = useRef({ share, ready, onDone, preview });
  latest.current = { share, ready, onDone, preview };
  // The words keep pace with what is seen, not with the worker, which is usually ahead of it.
  const said = useRef<{ share: number; label: string }[]>([]);
  if (said.current[said.current.length - 1]?.label !== label && label !== "Done") said.current.push({ share, label });

  useEffect(() => {
    if (reduceMotion) return;
    const canvas = air.current;
    const holder = deck.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !holder || !ctx) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = window.innerWidth * ratio;
    canvas.height = window.innerHeight * ratio;
    ctx.scale(ratio, ratio);
    const box = holder.getBoundingClientRect();
    const onRoads = roads();
    const paints = pagesFor(latest.current.preview, onRoads);
    // Each page: what is shown, and the whole of it, drawn once and copied across as the line passes.
    const sheets = [...holder.querySelectorAll<HTMLCanvasElement>("canvas")].map((shown, n) => {
      shown.width = box.width * ratio;
      shown.height = box.height * ratio;
      const whole = document.createElement("canvas");
      [whole.width, whole.height] = [shown.width, shown.height];
      paints[n](whole.getContext("2d")!, whole.width, whole.height);
      const g = shown.getContext("2d")!;
      // The sheet itself is there before the line reaches it.
      g.fillStyle = n === 0 ? "#071420" : "#ffffff";
      g.fillRect(0, 0, shown.width, shown.height);
      return { shown, g, whole, copied: 0 };
    });
    const place = (active: number) => sheets.forEach(({ shown }, n) => {
      shown.style.setProperty("--back", String(Math.max(0, active - n)));
      shown.style.zIndex = String(n > active ? 0 : 10 - (active - n));
      shown.classList.toggle("waiting", n > active);
    });
    place(0);

    // Out of the button, along a curve: the same path it will go back by.
    const button = target();
    const [dx, dy] = button ? [button.left + button.width / 2 - (box.left + box.width / 2), button.top + button.height / 2 - (box.top + box.height / 2)] : [0, 240];
    const small = `translate(${dx}px, ${dy}px) scale(0.05)`;
    const middle = `translate(${dx * 0.42}px, ${dy * 0.18}px) scale(0.5)`;
    holder.animate([{ transform: small, opacity: 0, offset: 0 }, { opacity: 1, offset: 0.25 }, { transform: middle, offset: 0.55 }, { transform: "none", opacity: 1, offset: 1 }], { duration: GROW_MS, easing: "cubic-bezier(0.3, 0, 0.1, 1)", fill: "both" });

    const random = sequence(4077);
    const panels = [...document.querySelectorAll(".metric, .stream-card, .rail, .map-dock, .hud-group, .capsule, .tab-row")].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const source = (): [number, number] => {
      if (onRoads?.length && (random() < 0.62 || !panels.length)) {
        const at = Math.floor(random() * (onRoads.length / 4)) * 4;
        return [((onRoads[at] + 1) / 2) * window.innerWidth, ((1 - onRoads[at + 1]) / 2) * window.innerHeight];
      }
      const panel = panels[Math.floor(random() * panels.length)];
      return panel ? [panel.left + random() * panel.width, panel.top + random() * panel.height] : [random() * window.innerWidth, random() * window.innerHeight];
    };
    // from x y, through x y, to x y, born, lives
    const MAX = Math.ceil(FEED * FLIGHT_S * 1.5);
    const flying = new Float32Array(MAX * 8);
    let head = 0;
    let owed = 0;
    let shown = 0;
    let previous = performance.now();
    const started = previous + GROW_MS * 0.7;
    let active = 0;
    let frame = 0;
    let flew = false;
    const accent = document.documentElement.dataset.theme === "light" ? "#0a7f9e" : "#6fe3ff";
    const paint = (now: number) => {
      const dt = Math.min(0.05, (now - previous) / 1000);
      previous = now;
      const elapsed = Math.max(0, (now - started) / 1000);
      const real = latest.current.ready ? 1 : latest.current.share;
      // Follows the work, smoothly, and never faster than can be followed.
      shown += (Math.min(real, elapsed / MIN_S) - shown) * Math.min(1, dt * 5);
      if (latest.current.ready && elapsed > MIN_S) shown = Math.min(1, Math.max(shown, shown + dt * 0.5));
      if (fill.current) fill.current.style.transform = `translateX(${Math.min(1, shown) * 100 - 100}%)`;
      if (words.current) {
        const now_ = shown >= 0.995 ? "Done" : [...said.current].reverse().find((step) => step.share <= shown)?.label ?? said.current[0]?.label ?? "";
        if (words.current.textContent !== now_) words.current.textContent = now_;
      }
      // Which page, and how far down it the line has got.
      const reach = Math.min(sheets.length - 0.0001, shown * sheets.length);
      const page = Math.floor(reach);
      if (page !== active) {
        // Whatever is left of the page just finished, in one go.
        const done = sheets[active];
        done.g.drawImage(done.whole, 0, done.copied, done.whole.width, done.whole.height - done.copied, 0, done.copied, done.whole.width, done.whole.height - done.copied);
        done.copied = done.whole.height;
        active = page;
        place(active);
      }
      const sheet = sheets[active];
      const down = ease(Math.min(1, (reach - page) * 1.06));
      const to = Math.floor(down * sheet.whole.height);
      if (to > sheet.copied) {
        sheet.g.drawImage(sheet.whole, 0, sheet.copied, sheet.whole.width, to - sheet.copied, 0, sheet.copied, sheet.whole.width, to - sheet.copied);
        sheet.copied = to;
      }
      const lineY = box.top + down * box.height;
      if (line.current) {
        line.current.style.transform = `translateY(${down * box.height}px)`;
        line.current.style.opacity = !flew && now > started && shown < 0.995 ? String(Math.min(1, Math.sin(Math.min(1, reach - page) * Math.PI) * 6)) : "0";
      }
      // The streams: from the screen, round to the sheet's edges, and in along the line.
      if (!flew && now > started && shown < 0.985) {
        owed += FEED * dt;
        while (owed >= 1) {
          owed -= 1;
          const [sx, sy] = source();
          const side = sx < box.left + box.width / 2 ? -1 : 1;
          const edge = side < 0 ? box.left - 28 - random() * 60 : box.left + box.width + 28 + random() * 60;
          flying.set([sx, sy, edge, lineY + (sy - lineY) * 0.16, box.left + box.width * (side < 0 ? random() * 0.62 : 0.38 + random() * 0.62), lineY, now, FLIGHT_S * (0.8 + random() * 0.4)], head * 8);
          head = (head + 1) % MAX;
        }
      }
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.lineCap = "round";
      ctx.lineWidth = 1.15;
      ctx.strokeStyle = accent;
      for (const [from, to_, alpha] of [[0, 0.2, 0.38], [0.2, 0.75, 0.72], [0.75, 1, 0.46]]) {
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        for (let i = 0; i < MAX; i++) {
          const at = i * 8;
          const age = flying[at + 7] ? (now - flying[at + 6]) / 1000 / flying[at + 7] : -1;
          if (age < from || age >= to_ || age >= 1) continue;
          const point = (t: number) => {
            const e = t * t * (3 - 2 * t);
            const u = 1 - e;
            return [u * u * flying[at] + 2 * u * e * flying[at + 2] + e * e * flying[at + 4], u * u * flying[at + 1] + 2 * u * e * flying[at + 3] + e * e * flying[at + 5]] as const;
          };
          const [ax, ay] = point(Math.max(0, age - 0.03));
          const [bx, by] = point(age);
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // All of it printed: the deck squares up, and goes back to the button by the way it came.
      if (latest.current.ready && shown >= 0.999 && !flew) {
        flew = true;
        for (const done of sheets) done.g.drawImage(done.whole, 0, 0);
        place(0);
        for (const { shown: page_ } of sheets) page_.style.setProperty("--back", "0");
        sheets.forEach(({ shown: page_ }, n) => (page_.style.zIndex = String(10 - n)));
        root.current?.classList.add("leaving");
        holder.animate([{ transform: "none", opacity: 1 }, { transform: middle, opacity: 1, offset: 0.5 }, { transform: small, opacity: 0.1 }], { duration: 680, delay: 340, easing: "cubic-bezier(0.6, 0, 0.3, 1)", fill: "forwards" });
        const home = document.querySelector("[data-report-button]");
        window.setTimeout(() => home?.animate([{ transform: "scale(1)" }, { transform: "scale(1.09)", offset: 0.4 }, { transform: "scale(1)" }], { duration: 420, easing: "cubic-bezier(0.3, 0, 0.1, 1)" }), 880);
        window.setTimeout(() => latest.current.onDone(), 1040);
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
      <div className="report-stack" ref={deck} aria-hidden="true">
        <canvas /><canvas /><canvas /><canvas />
        <i className="report-line" ref={line} />
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
