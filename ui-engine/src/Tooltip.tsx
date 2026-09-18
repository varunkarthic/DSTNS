import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import type { Inspection } from "./types";
export function InfoCard({
  info,
  id,
  x,
  y,
}: {
  info: Inspection;
  id?: string;
  x: number;
  y: number;
}) {
  return createPortal(
    <div
      id={id}
      className="tooltip glass"
      role="tooltip"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - 304)),
        top: Math.max(8, Math.min(y, window.innerHeight - 285)),
      }}
    >
      <span className="eyebrow">{info.category}</span>
      <strong>{info.title}</strong>
      {info.status && <span className="tooltip-status">{info.status}</span>}
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
}: {
  info: Inspection;
  children: ReactNode;
}) {
  const id = useId(),
    ref = useRef<HTMLSpanElement>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const close = () => {
    clearTimeout(timer.current);
    setPoint(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const open = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPoint({ x: r.left, y: r.bottom + 10 });
    }, 280);
  };
  return (
    <span
      ref={ref}
      className="tooltip-anchor"
      onPointerEnter={open}
      onPointerLeave={close}
      onFocus={open}
      onBlur={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
      aria-describedby={point ? id : undefined}
    >
      {children}
      {point && <InfoCard id={id} info={info} {...point} />}
    </span>
  );
}
