import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import type { Inspection } from "./types";

/**
 * Hover help and map inspection, in the same visual language as the rest of the
 * interface: a glass card with an accent rail, a caret pointing at its anchor,
 * and an entry transition so nothing appears abruptly.
 *
 * Placement is measured rather than assumed. The card is rendered invisibly,
 * its real size read, and only then positioned - flipping above the anchor when
 * there is no room below and sliding along the edge rather than overflowing it.
 */

type Placement = { left: number; top: number; caret: number; above: boolean };

const GAP = 10;
const MARGIN = 8;

export function InfoCard({
  info,
  id,
  x,
  y,
  anchorWidth = 0,
  tone,
}: {
  info: Inspection;
  id?: string;
  x: number;
  y: number;
  anchorWidth?: number;
  tone?: "default" | "alert";
}) {
  const card = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer below the anchor; flip above when that would run off screen.
    const above = y + GAP + height > vh - MARGIN && y - GAP - height > MARGIN;
    const top = above ? y - height - GAP : y + GAP;

    // Centre on the anchor, then slide back inside the viewport.
    const ideal = x + anchorWidth / 2 - width / 2;
    const left = Math.max(MARGIN, Math.min(ideal, vw - width - MARGIN));

    // The caret stays over the anchor even after the card has been slid.
    const caret = Math.max(14, Math.min(x + anchorWidth / 2 - left, width - 14));
    setPlace({ left, top, caret, above });
  }, [x, y, anchorWidth, info]);

  return createPortal(
    <div
      ref={card}
      id={id}
      className={`tooltip glass${place?.above ? " above" : ""}${tone === "alert" ? " alert" : ""}`}
      role="tooltip"
      style={{
        left: place?.left ?? -9999,
        top: place?.top ?? -9999,
        // Hidden until measured, so it never flashes at the wrong place.
        visibility: place ? "visible" : "hidden",
      }}
    >
      <i className="tooltip-caret" style={{ left: place?.caret ?? 0 }} aria-hidden="true" />
      <span className="eyebrow">{info.category}</span>
      <strong>{info.title}</strong>
      {info.status && <span className={`tooltip-status s-${info.status}`}>{info.status}</span>}
      {info.description && <p>{info.description}</p>}
      {info.metrics && (
        <dl>
          {info.metrics.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>,
    document.body,
  );
}

export function Tooltip({
  info,
  children,
  delay = 260,
  tone,
}: {
  info: Inspection;
  children: ReactNode;
  delay?: number;
  tone?: "default" | "alert";
}) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number } | null>(null);

  const close = () => {
    clearTimeout(timer.current);
    setAnchor(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const open = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setAnchor({ x: r.left, y: r.bottom, w: r.width });
    }, delay);
  };

  return (
    <span
      ref={ref}
      className="tooltip-anchor"
      onPointerEnter={open}
      onPointerLeave={close}
      onPointerDown={close}
      onFocus={open}
      onBlur={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
      aria-describedby={anchor ? id : undefined}
    >
      {children}
      {anchor && (
        <InfoCard
          id={id}
          info={info}
          x={anchor.x}
          y={anchor.y}
          anchorWidth={anchor.w}
          tone={tone}
        />
      )}
    </span>
  );
}
