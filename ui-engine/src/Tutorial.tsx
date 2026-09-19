import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tutorialSteps } from "./tutorialSteps";

type Rect = { left: number; top: number; width: number; height: number };
const GAP = 14;
const EDGE = 12;

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
  const box = el?.getBoundingClientRect();
  const w = window.innerWidth, h = window.innerHeight;
  if (!box || box.width <= 0 || box.height <= 0 || box.bottom <= 0 || box.right <= 0 || box.top >= h || box.left >= w) return null;
  const pad = 6;
  const left = Math.max(4, box.left - pad);
  const top = Math.max(4, box.top - pad);
  return {
    left,
    top,
    width: Math.max(0, Math.min(w - 4, box.right + pad) - left),
    height: Math.max(0, Math.min(h - 4, box.bottom + pad) - top),
  };
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        actions.current.onSkip();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowLeft") {
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
        style={{ transform: `translate(${spot.left}px, ${spot.top}px)`, width: spot.width, height: spot.height }}
      />
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
        <div className="tour-progress" aria-hidden="true">
          {tutorialSteps.map((s, i) => (
            <i key={s.target} className={i < index ? "done" : i === index ? "on" : ""} />
          ))}
        </div>
        <span className="tour-count">
          Step {index + 1} of {tutorialSteps.length} · Simulation time paused
        </span>
        <div className="tour-copy" key={index} aria-live="polite" aria-atomic="true">
          <h2 id="tour-title">{step.title}</h2>
          <p id="tour-body">{step.body}</p>
          {!rect && <p className="tour-missing">This control is not visible at the current window size. The tour can continue.</p>}
        </div>
        <div className="tour-actions">
          <button className="btn ghost" onClick={() => actions.current.onSkip()}>
            Skip tour
          </button>
          <span className="tour-spacer" />
          <button className="btn" disabled={index === 0} onClick={() => move(-1)}>
            Back
          </button>
          <button ref={primary} className="btn primary" onClick={() => (last ? actions.current.onStart() : move(1))}>
            {last ? "Start Simulation" : "Next"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
