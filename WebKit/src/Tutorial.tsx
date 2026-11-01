// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons";
import { tutorialSteps } from "./tutorialSteps";

type Rect = { left: number; top: number; width: number; height: number; radius?: string };
const GAP = 14;
const EDGE = 12;
const MOTES = 56;
const STREAM = 70;

/**
 * Where the tutorial card goes for a target: below, above, right or left of
 * it, in that order, clamped inside the viewport. A target that fills the
 * screen (the map) gets the card in its lower-left area.
 */
export function placeTutorialCard(
  target: Rect | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const width = Math.min(card.width, viewport.width - EDGE * 2);
  const height = Math.min(card.height, viewport.height - EDGE * 2);
  const clampX = (v: number) => Math.max(EDGE, Math.min(v, viewport.width - width - EDGE));
  const clampY = (v: number) => Math.max(EDGE, Math.min(v, viewport.height - height - EDGE));
  if (!target) return { left: (viewport.width - width) / 2, top: (viewport.height - height) / 2 };
  const centreX = target.left + target.width / 2 - width / 2;
  const centreY = target.top + target.height / 2 - height / 2;
  const below = target.top + target.height + GAP;
  const above = target.top - height - GAP;
  const right = target.left + target.width + GAP;
  const left = target.left - width - GAP;
  if (below + height <= viewport.height - EDGE) return { left: clampX(centreX), top: below };
  if (above >= EDGE) return { left: clampX(centreX), top: above };
  if (right + width <= viewport.width - EDGE) return { left: right, top: clampY(centreY) };
  if (left >= EDGE) return { left, top: clampY(centreY) };
  return { left: clampX(target.left + 96), top: clampY(viewport.height - height - 160) };
}

function measureTarget(name: string): Rect | null {
  const el = document.querySelector<HTMLElement>(`[data-tutorial="${name}"]`);
  // A control that reserves room for its longest state is outlined around what it
  // shows now, so the spotlight fits whichever state it is in.
  const fit = el?.hasAttribute("data-tutorial-fit");
  const contents = fit && el ? document.createRange() : null;
  if (contents && el) contents.selectNodeContents(el);
  const box = contents?.getBoundingClientRect() ?? el?.getBoundingClientRect();
  const w = window.innerWidth, h = window.innerHeight;
  if (!box || box.width <= 0 || box.height <= 0 || box.bottom <= 0 || box.right <= 0 || box.top >= h || box.left >= w) return null;
  const pad = fit ? 8 : 4;
  const style = el ? getComputedStyle(el) : null;
  const rawRadius = style?.borderTopLeftRadius || style?.borderRadius || "0";
  const round = fit ? 8 : rawRadius.includes("%") ? box.height * parseFloat(rawRadius) / 100 : parseFloat(rawRadius) || 0;
  const left = Math.max(4, box.left - pad);
  const top = Math.max(4, box.top - pad);
  return {
    left,
    top,
    width: Math.max(0, Math.min(w - 4, box.right + pad) - left),
    height: Math.max(0, Math.min(h - 4, box.bottom + pad) - top),
    radius: `${Math.min(box.width / 2, box.height / 2, round) + pad}px`,
  };
}

/**
 * A hint of the start-up's particles: a few motes drifting about whatever the tour is showing,
 * and a thin stream that carries over to the next thing. It stays well in the background.
 */
function TourMotes({ rect }: { rect: Rect | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(rect);
  latest.current = rect;
  useEffect(() => {
    const element = canvas.current;
    const ctx = typeof Path2D === "undefined" ? null : element?.getContext("2d");
    if (!element || !ctx) return;
    const [r, g, b] = getComputedStyle(element).getPropertyValue("--accent-rgb").trim().split(/\s+/).map(Number);
    const colour = (alpha: number) => `rgba(${r || 55},${g || 215},${b || 255},${alpha})`;
    const motes = Array.from({ length: MOTES }, () => ({ along: Math.random(), speed: (Math.random() - 0.5) * 0.024, out: 5 + Math.random() * 22, phase: Math.random() * 6.28, size: 0.6 + Math.random() * 0.9 }));
    let stream: { from: [number, number]; to: [number, number]; at: number }[] = [];
    let centre: [number, number] | null = null;
    let frame = 0;
    let last = performance.now();
    // A point on the outline of a rectangle, `along` the way round it, `out` beyond it.
    const onOutline = (box: Rect, along: number, out: number): [number, number] => {
      const perimeter = 2 * (box.width + box.height);
      let d = (((along % 1) + 1) % 1) * perimeter;
      if (d < box.width) return [box.left + d, box.top - out];
      d -= box.width;
      if (d < box.height) return [box.left + box.width + out, box.top + d];
      d -= box.height;
      if (d < box.width) return [box.left + box.width - d, box.top + box.height + out];
      d -= box.width;
      return [box.left - out, box.top + box.height - d];
    };
    const paint = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (element.width !== Math.round(width * ratio)) {
        element.width = Math.round(width * ratio);
        element.height = Math.round(height * ratio);
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const box = latest.current;
      if (box) {
        const next: [number, number] = [box.left + box.width / 2, box.top + box.height / 2];
        // The tour has moved on: a thin stream follows it there.
        if (centre && Math.hypot(next[0] - centre[0], next[1] - centre[1]) > 24) {
          const from = centre;
          stream = Array.from({ length: STREAM }, () => ({ from: [from[0] + (Math.random() - 0.5) * 40, from[1] + (Math.random() - 0.5) * 40] as [number, number], to: onOutline(box, Math.random(), 4 + Math.random() * 10), at: now + Math.random() * 180 }));
        }
        centre = next;
        for (const mote of motes) {
          mote.along += mote.speed * dt;
          const [x, y] = onOutline(box, mote.along, mote.out + Math.sin(now / 900 + mote.phase) * 3);
          ctx.fillStyle = colour(0.1 + 0.2 * (0.5 + 0.5 * Math.sin(now / 700 + mote.phase)));
          ctx.beginPath();
          ctx.arc(x, y, mote.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      for (const p of stream) {
        const t = (now - p.at) / 620;
        if (t < 0 || t > 1) continue;
        const e = t * t * (3 - 2 * t);
        const lift = Math.sin(t * Math.PI) * 26;
        ctx.fillStyle = colour(0.42 * Math.sin(t * Math.PI));
        ctx.beginPath();
        ctx.arc(p.from[0] + (p.to[0] - p.from[0]) * e, p.from[1] + (p.to[1] - p.from[1]) * e - lift, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <canvas ref={canvas} className="tour-motes" aria-hidden="true" />;
}

/**
 * The guided tour. One card and one spotlight persist for the whole tour and
 * glide between targets, so the tour reads as one continuous guide. Only
 * simulation time is paused while it runs; the interface keeps animating.
 */
export function Tutorial({
  onSkip,
  onStart,
  reduceMotion,
  onTarget,
}: {
  /** Close the tour, restoring playback as it was. */
  onSkip: () => void;
  /** Close the tour and start the simulation. */
  onStart: () => void;
  reduceMotion: boolean;
  onTarget: (target: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const step = tutorialSteps[index];
  const last = index === tutorialSteps.length - 1;
  const [rect, setRect] = useState<Rect | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const actions = useRef({ onSkip, onStart });
  actions.current = { onSkip, onStart };

  useEffect(() => onTarget(step.target), [onTarget, step.target]);
  useEffect(() => () => onTarget(""), [onTarget]);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    return () => {
      if (prior?.isConnected) prior.focus();
    };
  }, []);
  useEffect(() => {
    primary.current?.focus({ preventScroll: true });
  }, [index]);

  // Follow the target through layout changes (resize, zoom, panels opening).
  useLayoutEffect(() => {
    let frame = 0;
    let previous = "";
    const measure = () => {
      const target = measureTarget(step.target);
      const card = panel.current?.getBoundingClientRect();
      const place = placeTutorialCard(target, { width: card?.width || 340, height: card?.height || 220 }, { width: window.innerWidth, height: window.innerHeight });
      const signature = JSON.stringify([target, place]);
      if (signature !== previous) {
        previous = signature;
        setRect(target);
        setPosition(place);
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [step.target]);

  const move = (delta: number) => setIndex((i) => Math.max(0, Math.min(tutorialSteps.length - 1, i + delta)));
  const lastRef = useRef(last);
  lastRef.current = last;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        actions.current.onSkip();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        // The last step's forward is its button: starting the simulation. Holding the key
        // down to get through the tour must not also set it off.
        if (lastRef.current) {
          if (!e.repeat) actions.current.onStart();
        } else move(1);
      } else if (e.key === "ArrowLeft") {
        e.stopPropagation();
        e.preventDefault();
        move(-1);
      } else if (e.key === "Tab") {
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const first = buttons[0], lastButton = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          lastButton?.focus();
        } else if (!e.shiftKey && document.activeElement === lastButton) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const spot = rect ?? { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0 };
  return createPortal(
    <div className={`tour${reduceMotion ? " still" : ""}`} data-tutorial-step={step.target}>
      <div
        className={`tour-spotlight${rect ? "" : " none"}`}
        aria-hidden="true"
        style={{ transform: `translate(${spot.left}px, ${spot.top}px)`, width: spot.width, height: spot.height, borderRadius: rect?.radius ?? "0" }}
      >
        {/* Replayed for each step, a soft ring going out as the spotlight arrives. */}
        {rect && !reduceMotion && <span key={index} className="tour-ping" />}
      </div>
      {!reduceMotion && <TourMotes rect={rect} />}
      <div
        ref={panel}
        className={`tour-card${position ? " placed" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        data-tip-avoid
        style={{ transform: position ? `translate(${position.left}px, ${position.top}px)` : undefined }}
      >
        <header className="tour-head">
          <span className="tour-chapter">{step.chapter}</span>
          <span className="tour-count mono" aria-label={`Step ${index + 1} of ${tutorialSteps.length}`}>{index + 1} / {tutorialSteps.length}</span>
          <button type="button" className="icon-btn" aria-label="Skip tour" onClick={() => actions.current.onSkip()}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="tour-copy" key={index} aria-live="polite" aria-atomic="true">
          <h2 id="tour-title">{step.title}</h2>
          <p id="tour-body">{step.body}</p>
          {!rect && <p className="tour-missing">This control is not visible at the current window size. The tutorial can continue.</p>}
        </div>
        <span className="tour-progress" aria-hidden="true"><i style={{ transform: `scaleX(${(index + 1) / tutorialSteps.length})` }} /></span>
        <footer className="tour-actions">
          <span className="tour-note">Time is paused · ← → to move</span>
          <button className="btn" disabled={index === 0} onClick={() => move(-1)}>
            Back
          </button>
          <button ref={primary} className="btn primary" onClick={() => (last ? actions.current.onStart() : move(1))}>
            {last ? "Start Simulation" : "Next"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
