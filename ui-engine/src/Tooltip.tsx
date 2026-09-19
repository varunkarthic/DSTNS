import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { computePlacement } from "./tooltipPlacement";
import type { Placement, Rect, Side } from "./tooltipPlacement";
import type { Inspection } from "./types";

/**
 * Tooltips and map inspection cards.
 *
 * Both are measured before they are shown and placed by computePlacement,
 * which tries each side of the anchor and picks the one that clips least and
 * covers the fewest neighbouring controls. Regions marked `data-tip-avoid`
 * (the legend, the notification capsule, the time control, destructive
 * buttons, the tutorial card) are avoided when another side is free.
 */

const toRect = (r: DOMRect): Rect => ({ left: r.left, top: r.top, width: r.width, height: r.height });

/** Regions a tooltip anchored at `anchor` should try not to cover. */
export function avoidRegions(anchor: Element | null, reach = 220): Rect[] {
  if (typeof document === "undefined") return [];
  const a = anchor?.getBoundingClientRect();
  const out: Rect[] = [];
  for (const el of document.querySelectorAll("[data-tip-avoid], button, [role='slider'], [role='radio'], input, select")) {
    if (!(el instanceof HTMLElement) || el === anchor || el.contains(anchor) || anchor?.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // Only neighbours close enough for the tooltip to reach matter.
    if (a && (r.right < a.left - reach || r.left > a.right + reach || r.bottom < a.top - reach || r.top > a.bottom + reach)) continue;
    // Covering a control costs more than covering a readout: a hidden button
    // blocks an action, a hidden label only delays reading it.
    const interactive = el.matches("button, [role='slider'], [role='radio'], input, select");
    out.push({ ...toRect(r), weight: interactive ? 10 : 1 });
  }
  return out;
}

function useMeasuredPlacement(
  open: boolean,
  anchorRect: () => Rect | null,
  anchorEl: () => Element | null,
  preferred: Side[] | undefined,
  deps: unknown[],
) {
  const tip = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const measure = useCallback(() => {
    const el = tip.current;
    const anchor = anchorRect();
    if (!el || !anchor) return;
    const size = el.getBoundingClientRect();
    setPlace(
      computePlacement({
        anchor,
        tip: { width: size.width, height: size.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        avoid: avoidRegions(anchorEl()),
        preferred,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    measure();
  }, [open, measure]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, measure]);
  return { tip, place };
}

export function Tooltip({
  label,
  detail,
  children,
  side,
  delay = 380,
  disabled = false,
}: {
  label: string;
  detail?: ReactNode;
  children: ReactNode;
  /** Preferred sides, in order. */
  side?: Side[];
  delay?: number;
  disabled?: boolean;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
  }, []);
  const show = (wait: number) => {
    if (disabled) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), wait);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    // A tooltip never outlives scrolling or a click elsewhere.
    const close = () => hide();
    window.addEventListener("scroll", close, true);
    window.addEventListener("pointerdown", close, true);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("pointerdown", close, true);
    };
  }, [open, hide]);

  const target = () => (anchor.current?.firstElementChild as HTMLElement | null) ?? anchor.current;
  const { tip, place } = useMeasuredPlacement(
    open,
    () => {
      const el = target();
      return el ? toRect(el.getBoundingClientRect()) : null;
    },
    target,
    side,
    [label, detail, side],
  );

  return (
    <span
      ref={anchor}
      className="tooltip-anchor"
      onPointerEnter={(e) => e.pointerType === "mouse" && show(delay)}
      onPointerLeave={hide}
      onFocus={(e) => {
        // Keyboard focus only; a click that also focuses should not pop a tip.
        let keyboard = false;
        try {
          keyboard = (e.target as HTMLElement).matches(":focus-visible");
        } catch {
          /* Engines without :focus-visible show no focus tooltip. */
        }
        if (keyboard) show(120);
      }}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === "Escape") hide();
      }}
      aria-describedby={open && detail ? id : undefined}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={tip}
            id={id}
            role="tooltip"
            className={`tip tip-${place?.side ?? "top"}${place ? " shown" : ""}`}
            style={{
              left: place?.left ?? -9999,
              top: place?.top ?? -9999,
              ["--arrow" as string]: `${place?.arrow ?? 0}px`,
            }}
          >
            <span className="tip-label">{label}</span>
            {detail && <span className="tip-detail">{detail}</span>}
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * Map inspection card, anchored at a pointer position. Richer than a tooltip:
 * a title, a status, a sentence and a short table of live metrics.
 */
export function InfoCard({
  info,
  x,
  y,
  id,
}: {
  info: Inspection;
  x: number;
  y: number;
  id?: string;
  anchorWidth?: number;
  tone?: "default" | "alert";
}) {
  const { tip, place } = useMeasuredPlacement(
    true,
    () => ({ left: x - 14, top: y - 14, width: 28, height: 28 }),
    () => null,
    ["bottom", "right", "top", "left"],
    [x, y, info],
  );
  return createPortal(
    <div
      ref={tip}
      id={id}
      role="tooltip"
      className={`inspect-card${place ? " shown" : ""}`}
      style={{ left: place?.left ?? -9999, top: place?.top ?? -9999 }}
    >
      <div className="inspect-head">
        <span className="inspect-kind">{info.category}</span>
        {info.status && <span className={`inspect-status s-${info.status.toLowerCase().replace(/\s+/g, "-")}`}>{info.status}</span>}
      </div>
      <strong className="inspect-title">{info.title}</strong>
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
