// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { createVelocityTracker, projectSnap, Spring, SPRINGS } from "./motion";
import { resistClamp } from "./resistance";

/**
 * A slider that only rests on labelled stops. It is thrown rather than placed: the
 * thumb follows the pointer, resists past either end, and settles on the stop its
 * momentum reaches. Every stop is labelled and can be clicked directly.
 */
export function QuantizedSlider({
  labels,
  index,
  applied,
  onSelect,
  label,
  valueText,
  disabled = false,
  reduceMotion = false,
  className = "",
  tutorial,
}: {
  labels: readonly string[];
  index: number;
  /** A stop below `index` that is actually in force, when something is holding it back. */
  applied?: number;
  onSelect: (index: number) => void;
  label: string;
  valueText: (index: number) => string;
  disabled?: boolean;
  reduceMotion?: boolean;
  className?: string;
  tutorial?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const spring = useRef<Spring | null>(null);
  const tracker = useRef(createVelocityTracker());
  const dragging = useRef(false);
  const [width, setWidth] = useState(0);
  const [held, setHeld] = useState(false);
  const stops = labels.map((_, i) => (i / Math.max(1, labels.length - 1)) * width);

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!width) return;
    spring.current ??= new Spring(stops[index], SPRINGS.expressiveFast, (x) => root.current?.style.setProperty("--thumb-x", `${x.toFixed(2)}px`), 0.1);
    if (dragging.current) return;
    if (reduceMotion) spring.current.jump(stops[index]);
    else spring.current.set(stops[index]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, width, reduceMotion]);
  useEffect(() => () => spring.current?.stop(), []);

  const at = (clientX: number) => clientX - track.current!.getBoundingClientRect().left;
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || !width) return;
    dragging.current = true;
    setHeld(true);
    tracker.current.reset();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const x = at(e.clientX);
    tracker.current.add(x, e.timeStamp);
    spring.current?.set(Math.max(0, Math.min(width, x)));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const x = at(e.clientX);
    tracker.current.add(x, e.timeStamp);
    spring.current?.jump(resistClamp(x, 0, width, 12));
  };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setHeld(false);
    const value = spring.current?.value ?? stops[index];
    const velocity = tracker.current.velocity();
    const landed = projectSnap(Math.max(0, Math.min(width, value)), velocity, stops);
    if (reduceMotion) spring.current?.jump(landed);
    else spring.current?.set(landed, velocity);
    const next = stops.indexOf(landed);
    if (next !== index) onSelect(next);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    const target = e.key === "Home" ? 0 : e.key === "End" ? labels.length - 1 : delta ? index + delta : -1;
    if (target < 0 || target >= labels.length || disabled) return;
    e.preventDefault();
    onSelect(target);
  };

  return (
    <div ref={root} className={`qslider${held ? " held" : ""}${disabled ? " disabled" : ""}${applied !== undefined ? " capped" : ""} ${className}`.trim()} data-tutorial={tutorial} data-tip-avoid>
      <div
        ref={track}
        className="qslider-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={labels.length - 1}
        aria-valuenow={index}
        aria-valuetext={valueText(index)}
        aria-disabled={disabled}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
      >
        <span className="qslider-line" aria-hidden="true" />
        <span className="qslider-fill" aria-hidden="true" />
        {labels.map((text, i) => (
          <i key={text} className={`qslider-stop${i <= index ? " passed" : ""}`} style={{ left: `${(i / Math.max(1, labels.length - 1)) * 100}%` }} aria-hidden="true" />
        ))}
        {applied !== undefined && (
          <span className="qslider-applied" aria-hidden="true" style={{ left: `${(applied / Math.max(1, labels.length - 1)) * 100}%` }} />
        )}
        <span className="qslider-thumb" aria-hidden="true" />
      </div>
      <div className="qslider-labels" aria-hidden="true">
        {labels.map((text, i) => (
          <button key={text} type="button" tabIndex={-1} disabled={disabled} className={i === applied ? "applied" : i === index ? "on" : ""} style={{ left: `${(i / Math.max(1, labels.length - 1)) * 100}%` }} onClick={() => i !== index && onSelect(i)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
