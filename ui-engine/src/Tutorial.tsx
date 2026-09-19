import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tutorialSteps } from "./tutorialSteps";

type Rect = { left: number; top: number; width: number; height: number };
const GAP = 12;
export function placeTutorialCard(target: Rect | null, card: { width: number; height: number }, viewport: { width: number; height: number }) {
  const clamp = (v: number, max: number) => Math.max(GAP, Math.min(v, max - GAP));
  const width = Math.min(card.width, viewport.width - GAP * 2);
  const height = Math.min(card.height, viewport.height - GAP * 2);
  const centre = { left: (viewport.width - width) / 2, top: (viewport.height - height) / 2 };
  if (!target) return centre;
  const below = target.top + target.height + GAP;
  const above = target.top - height - GAP;
  const right = target.left + target.width + GAP;
  const left = target.left - width - GAP;
  if (below + height <= viewport.height - GAP) return { left: clamp(target.left, viewport.width - width), top: below };
  if (above >= GAP) return { left: clamp(target.left, viewport.width - width), top: above };
  if (right + width <= viewport.width - GAP) return { left: right, top: clamp(target.top, viewport.height - height) };
  if (left >= GAP) return { left, top: clamp(target.top, viewport.height - height) };
  // A full-map target leaves no outside region; keep the entire card readable.
  return { left: centre.left, top: clamp(viewport.height - height - GAP, viewport.height - height) };
}

export function Tutorial({ onClose, reduceMotion, onTarget }: {
  onClose: () => void; reduceMotion: boolean; onTarget: (target: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const step = tutorialSteps[index];
  const [rect, setRect] = useState<Rect | null>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const panel = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => { onTarget(step.target); }, [onTarget, step.target]);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    next.current?.focus();
    return () => { if (prior?.isConnected) prior.focus(); };
  }, []);

  useLayoutEffect(() => {
    let frame = 0;
    let previous = "";
    const measure = () => {
      const target = document.querySelector<HTMLElement>(`[data-tutorial="${step.target}"]`);
      const box = target?.getBoundingClientRect();
      const w = window.innerWidth, h = window.innerHeight;
      let visible: Rect | null = null;
      if (box && box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < h && box.left < w) {
        const left = Math.max(4, box.left - 5), top = Math.max(4, box.top - 5);
        visible = { left, top, width: Math.max(0, Math.min(w - 4, box.right + 5) - left), height: Math.max(0, Math.min(h - 4, box.bottom + 5) - top) };
      }
      const card = panel.current?.getBoundingClientRect();
      const placement = placeTutorialCard(visible, { width: card?.width || 360, height: card?.height || 300 }, { width: w, height: h });
      const signature = JSON.stringify([visible, placement]);
      if (signature !== previous) { previous = signature; setRect(visible); setPosition(placement); }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [step.target]);

  const move = (delta: number) => setIndex((i) => Math.max(0, Math.min(tutorialSteps.length - 1, i + delta)));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
      else if (e.key === "Tab") {
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  return createPortal(
    <div className={`tutorial-overlay${reduceMotion ? " reduce-motion" : ""}`} data-tutorial-step={step.target}>
      {rect ? <>
        <div className="tutorial-shade" style={{ inset: `0 0 auto 0`, height: rect.top }} />
        <div className="tutorial-shade" style={{ left: 0, top: rect.top, width: rect.left, height: rect.height }} />
        <div className="tutorial-shade" style={{ left: rect.left + rect.width, right: 0, top: rect.top, height: rect.height }} />
        <div className="tutorial-shade" style={{ inset: `${rect.top + rect.height}px 0 0 0` }} />
        <div className="tutorial-spotlight" aria-hidden="true" style={rect} />
      </> : <div className="tutorial-shade" style={{ inset: 0 }} />}
      <div ref={panel} className="tutorial-card glass" role="dialog" aria-modal="true" aria-labelledby="tutorial-title" aria-describedby="tutorial-body" tabIndex={-1} style={position}>
        <span className="eyebrow">Tutorial · {index + 1} of {tutorialSteps.length} · Time paused</span>
        <div aria-live="polite" aria-atomic="true">
          <h2 id="tutorial-title">{step.title}</h2>
          <p id="tutorial-body">{step.body}</p>
          {!rect && <p className="tutorial-unavailable">This area is currently hidden in this layout. You can continue the tour.</p>}
        </div>
        <div className="tutorial-actions">
          <button className="btn" onClick={() => close.current()}>Skip tour</button>
          <button className="btn" disabled={index === 0} onClick={() => move(-1)}>Back</button>
          <button ref={next} className="btn primary" onClick={() => index === tutorialSteps.length - 1 ? close.current() : move(1)}>{index === tutorialSteps.length - 1 ? "Finish" : "Next"}</button>
        </div>
        <small>← / → navigate · Escape closes</small>
      </div>
    </div>, document.body,
  );
}
