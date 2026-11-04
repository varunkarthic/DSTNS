// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Icon } from "./Icons";
import { Floating, useDismiss } from "./Popover";
import { useTimeFormat } from "./preferences";
import { Segmented } from "./settingsControls";
import { DAY_SECONDS, formatDuration } from "./timeFormat";

/** Holding the clock this long switches between 12- and 24-hour time, rather than opening Time Control. */
export const LONG_PRESS_MS = 550;

const clampDay = (s: number) => Math.max(0, Math.min(DAY_SECONDS, Math.round(s)));

/** Where a jump of `sign` × `hours` and `minutes` from `from` lands, within the day. */
export function jumpTarget(from: number, sign: 1 | -1, hours: number, minutes: number): number {
  return clampDay(from + sign * (hours * 3600 + minutes * 60));
}

/** A time of day from what is typed: 24-hour, or 12-hour with its half of the day. */
export function fromFields(hour: number, minute: number, hour12: boolean, pm: boolean): number {
  const h = hour12 ? (hour % 12) + (pm ? 12 : 0) : hour;
  return clampDay(h * 3600 + minute * 60);
}

/** How far a target is from now, in words. */
export function describeDistance(delta: number): string {
  if (Math.abs(delta) < 30) return "That is now.";
  return `${formatDuration(Math.abs(delta))} ${delta > 0 ? "later than now" : "earlier than now"}.`;
}

function NumberField({ value, min, max, label, onChange, onEnter }: { value: number; min: number; max: number; label: string; onChange: (v: number) => void; onEnter: () => void }) {
  const [text, setText] = useState(String(value).padStart(2, "0"));
  useEffect(() => setText(String(value).padStart(2, "0")), [value]);
  const step = (by: number) => {
    const span = max - min + 1;
    onChange(((value - min + by + span) % span) + min);
  };
  return (
    <input
      className="time-field mono"
      type="text"
      inputMode="numeric"
      aria-label={label}
      value={text}
      maxLength={2}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        const digits = e.currentTarget.value.replace(/\D/g, "").slice(0, 2);
        setText(digits);
        if (digits) onChange(Math.max(min, Math.min(max, Number(digits))));
      }}
      onBlur={() => setText(String(value).padStart(2, "0"))}
      onWheel={(e) => {
        // Scrolling over a focused field steps it, as the arrow keys do.
        if (document.activeElement !== e.currentTarget || !e.deltaY) return;
        step(e.deltaY < 0 ? 1 : -1);
      }}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowUp") (e.preventDefault(), step(1));
        else if (e.key === "ArrowDown") (e.preventDefault(), step(-1));
        else if (e.key === "Enter") (e.preventDefault(), onEnter());
      }}
    />
  );
}

/**
 * The clock, and Time Control behind it.
 *
 * A click opens Time Control: go to a time earlier or later in the day, jump by any number of hours and minutes, and
 * choose 12- or 24-hour time. Holding the clock switches 12- and 24-hour time straight away.
 */
export function TimeControl({
  seconds,
  hasClock,
  percent,
  paused,
  disabled,
  onSeekTo,
}: {
  seconds: number;
  hasClock: boolean;
  percent: number;
  paused: boolean;
  /** Going somewhere is not possible now; the clock's format still is. */
  disabled: boolean;
  onSeekTo: (target: number) => void;
}) {
  const time = useTimeFormat();
  const [open, setOpen] = useState(false);
  const [switched, setSwitched] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; long: boolean }>({ long: false });
  useDismiss(open, () => setOpen(false), [trigger, panel]);
  useEffect(() => () => clearTimeout(press.current.timer), []);

  // What is typed starts at now, each time the menu opens.
  const now = clampDay(seconds);
  const [hour, setHour] = useState(0);
  const [minute, setMinute] = useState(0);
  const [pm, setPm] = useState(false);
  const [sign, setSign] = useState<1 | -1>(1);
  const [jumpHours, setJumpHours] = useState(1);
  const [jumpMinutes, setJumpMinutes] = useState(0);
  useEffect(() => {
    if (!open) return;
    const h = Math.floor(now / 3600) % 24;
    setHour(time.hour12 ? h % 12 || 12 : h);
    setMinute(Math.floor((now % 3600) / 60));
    setPm(h >= 12);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // The fields follow the clock's format when it changes while open.
  const wasHour12 = useRef(time.hour12);
  useEffect(() => {
    if (wasHour12.current === time.hour12) return;
    wasHour12.current = time.hour12;
    setHour((h) => (time.hour12 ? (h % 12 || 12) : (h % 12) + (pm ? 12 : 0)));
  }, [time.hour12, pm]);

  const target = fromFields(hour, minute, time.hour12, pm);
  const landing = jumpTarget(now, sign, jumpHours, jumpMinutes);
  const go = (to: number) => {
    if (disabled || Math.abs(to - now) < 1) return;
    setOpen(false);
    onSeekTo(to);
  };

  const presets: [string, number][] = [["Start", 0], [time.hour12 ? "6 AM" : "06:00", 6 * 3600], ["Noon", 12 * 3600], [time.hour12 ? "6 PM" : "18:00", 18 * 3600], ["End", DAY_SECONDS]];

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`time-control${paused ? " paused" : ""}${open ? " active" : ""}`}
        data-tutorial="clock"
        data-tip-avoid
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Simulation time ${hasClock ? time.time(seconds) : "unavailable"}, ${percent.toFixed(0)} percent complete${paused ? ", paused" : ""}. Activate for Time Control; hold to switch to ${time.hour12 ? "24" : "12"} hour time.`}
        data-seconds={Math.round(seconds)}
        onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
          if (e.button !== 0) return;
          press.current.long = false;
          clearTimeout(press.current.timer);
          press.current.timer = setTimeout(() => {
            press.current.long = true;
            time.toggle();
            setSwitched((n) => n + 1);
          }, LONG_PRESS_MS);
        }}
        onPointerUp={() => clearTimeout(press.current.timer)}
        onPointerLeave={() => clearTimeout(press.current.timer)}
        onPointerCancel={() => clearTimeout(press.current.timer)}
        onClick={() => {
          if (press.current.long) {
            press.current.long = false;
            return;
          }
          setOpen((v) => !v);
        }}
      >
        <span className="time-value mono" key={switched}>{hasClock ? time.time(seconds) : "--:--:--"}</span>
        <span className="time-hint">{paused ? "Paused" : `${percent.toFixed(0)}% of day`}</span>
      </button>
      <Floating anchor={trigger} open={open} preferred={["top"]} only className="time-menu" panelRef={panel} role="dialog" label="Time Control">
        <header className="time-menu-head">
          <div>
            <h3>Time Control</h3>
            <span className="mono">{hasClock ? time.time(seconds) : "--:--:--"} · {percent.toFixed(0)}% of the day</span>
          </div>
          <button type="button" className="icon-btn small" aria-label="Close Time Control" onClick={() => setOpen(false)}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <section className="time-menu-section" aria-label="Go to a time">
          <h4>Go to</h4>
          <div className="time-menu-row">
            <div className="time-fields" role="group" aria-label="Target time">
              <NumberField label="Hour" value={hour} min={time.hour12 ? 1 : 0} max={time.hour12 ? 12 : 23} onChange={setHour} onEnter={() => go(target)} />
              <span aria-hidden="true">:</span>
              <NumberField label="Minute" value={minute} min={0} max={59} onChange={setMinute} onEnter={() => go(target)} />
            </div>
            {time.hour12 && <Segmented label="Half of the day" value={pm ? "pm" : "am"} options={[{ value: "am", label: "AM" }, { value: "pm", label: "PM" }]} onChange={(v) => setPm(v === "pm")} />}
            <button type="button" className="btn primary" disabled={disabled || Math.abs(target - now) < 1} onClick={() => go(target)}>Go</button>
          </div>
          <span className="time-menu-note">{describeDistance(target - now)}</span>
          <div className="time-presets" role="group" aria-label="Times of day">
            {presets.map(([name, at]) => (
              <button key={name} type="button" disabled={disabled || at === now} onClick={() => go(at)}>{name}</button>
            ))}
          </div>
        </section>

        <section className="time-menu-section" aria-label="Jump by">
          <h4>Jump by</h4>
          <div className="time-menu-row">
            <Segmented label="Which way" value={sign} options={[{ value: -1, label: "Back" }, { value: 1, label: "Forward" }]} onChange={setSign} />
            <div className="time-fields" role="group" aria-label="How far">
              <NumberField label="Hours" value={jumpHours} min={0} max={23} onChange={setJumpHours} onEnter={() => go(landing)} />
              <small>h</small>
              <NumberField label="Minutes" value={jumpMinutes} min={0} max={59} onChange={setJumpMinutes} onEnter={() => go(landing)} />
              <small>m</small>
            </div>
            <button type="button" className="btn" disabled={disabled || landing === now} onClick={() => go(landing)}>Jump</button>
          </div>
          <span className="time-menu-note">
            Lands at <b className="mono">{time.time(landing, { seconds: false })}</b>
            {landing !== now + sign * (jumpHours * 3600 + jumpMinutes * 60) && ", the day's edge"}
          </span>
        </section>

        <section className="time-menu-section" aria-label="Clock">
          <h4>Clock</h4>
          <Segmented label="Clock format" value={time.hour12 ? "12" : "24"} options={[{ value: "24", label: "24-hour" }, { value: "12", label: "12-hour" }]} onChange={(v) => (v === "12") !== time.hour12 && time.toggle()} />
          <small className="time-menu-tip">Hold the clock to switch at any time.</small>
        </section>
      </Floating>
    </>
  );
}
