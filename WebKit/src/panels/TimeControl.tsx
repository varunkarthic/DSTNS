// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Icon } from "../components/Icons";
import { Floating, useDismiss } from "../components/Popover";
import { useTimeFormat } from "../core/preferences";
import { Segmented } from "../components/settingsControls";
import { DAY_SECONDS, formatDuration } from "../core/timeFormat";
import { useSettle } from "../CoreMotion/settle";

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

/** What a time of day is, in a word or two, for the scrubber's caption. */
export function partOfDay(seconds: number): string {
  const h = seconds / 3600;
  if (h < 5) return "Night";
  if (h < 7) return "Dawn";
  if (h < 10) return "Morning peak";
  if (h < 12) return "Late morning";
  if (h < 14) return "Midday";
  if (h < 16.5) return "Afternoon";
  if (h < 19) return "Evening peak";
  if (h < 22) return "Evening";
  return "Night";
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
 * A click opens Time Control: the day as a line to put a finger on, the time it would land at said before it is
 * chosen, the hours typed if that is easier, quick jumps either way, and the clock's own format. Holding the clock
 * switches 12- and 24-hour time straight away.
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
  useSettle(open, () => setOpen(false));
  useEffect(() => () => clearTimeout(press.current.timer), []);

  // Where the finger is: starts at now each time it opens, and stays put while the clock runs on.
  const now = clampDay(seconds);
  const [pick, setPick] = useState(now);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPick(now);
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const shown = touched ? pick : now;
  const hour24 = Math.floor(shown / 3600) % 24;
  const minute = Math.floor((shown % 3600) / 60);
  const pm = hour24 >= 12;
  const hour = time.hour12 ? hour24 % 12 || 12 : hour24;
  const choose = (at: number) => {
    setPick(clampDay(at));
    setTouched(true);
  };
  const go = (to: number) => {
    if (disabled || Math.abs(to - now) < 1) return;
    setOpen(false);
    onSeekTo(to);
  };
  const delta = shown - now;

  const presets: [string, number][] = [["Start", 0], [time.hour12 ? "6 AM" : "06:00", 6 * 3600], ["Noon", 12 * 3600], [time.hour12 ? "6 PM" : "18:00", 18 * 3600], ["End", DAY_SECONDS]];
  const jumps: [string, number][] = [["1 h earlier", -3600], ["15 min earlier", -900], ["15 min later", 900], ["1 h later", 3600]];

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
          <div className="time-menu-now">
            <span className="time-menu-eyebrow">{touched ? "Going to" : "Now"}</span>
            <strong className="mono">{time.time(shown, { seconds: false })}</strong>
            <span className="time-menu-part">{partOfDay(shown)}{touched ? ` · ${describeDistance(delta)}` : paused ? " · Paused" : ` · ${percent.toFixed(0)}% of the day`}</span>
          </div>
          <button type="button" className="icon-btn small" aria-label="Close Time Control" onClick={() => setOpen(false)}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <DayScrubber now={now} pick={shown} hour12={time.hour12} disabled={disabled} onPick={choose} onGo={go} />

        <div className="time-menu-row time-menu-go">
          <TimePill
            hour={hour}
            minute={minute}
            hour12={time.hour12}
            pm={pm}
            canGo={!disabled && Math.abs(shown - now) >= 1}
            onChange={(h, m, p) => choose(fromFields(h, m, time.hour12, p))}
            onGo={() => go(shown)}
          />
          <span className="time-menu-distance">{touched ? describeDistance(delta) : "Type a time, or choose one above."}</span>
        </div>

        <div className="time-presets" role="group" aria-label="Times of day">
          {presets.map(([name, at]) => (
            <button key={name} type="button" className={at === shown ? "on" : ""} disabled={disabled} onClick={() => choose(at)}>{name}</button>
          ))}
        </div>

        <div className="time-menu-jumps" role="group" aria-label="Jump from now">
          {jumps.map(([name, by]) => (
            <button key={name} type="button" className="time-jump" aria-label={name} disabled={disabled || jumpTarget(now, by < 0 ? -1 : 1, 0, Math.abs(by) / 60) === now} onClick={() => go(jumpTarget(now, by < 0 ? -1 : 1, 0, Math.abs(by) / 60))}>
              {by < 0 && <Icon name="back" size={13} />}
              {Math.abs(by) >= 3600 ? "1 h" : "15 min"}
              {by > 0 && <Icon name="forward" size={13} />}
            </button>
          ))}
        </div>

        <footer className="time-menu-foot">
          <Segmented label="Clock format" value={time.hour12 ? "12" : "24"} options={[{ value: "24", label: "24-hour" }, { value: "12", label: "12-hour" }]} onChange={(v) => (v === "12") !== time.hour12 && time.toggle()} />
          <small className="time-menu-tip">Or hold the clock</small>
        </footer>
      </Floating>
    </>
  );
}

/**
 * The time to go to, as one capsule: hours, minutes, and Go. Touched, it divides into a capsule for each part, the
 * way the parts of a duration are pulled apart to be edited, and joins again when let go. Each part takes typing,
 * arrow keys and the scroll wheel; Enter goes.
 */
function TimePill({ hour, minute, hour12, pm, canGo, onChange, onGo }: { hour: number; minute: number; hour12: boolean; pm: boolean; canGo: boolean; onChange: (hour: number, minute: number, pm: boolean) => void; onGo: () => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <div
      className={`time-pill${editing ? " editing" : ""}`}
      role="group"
      aria-label="Target time"
      onFocus={() => setEditing(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEditing(false);
      }}
    >
      <label className="time-seg">
        <NumberField label="Hour" value={hour} min={hour12 ? 1 : 0} max={hour12 ? 12 : 23} onChange={(h) => onChange(h, minute, pm)} onEnter={onGo} />
        <span className="time-unit">h</span>
      </label>
      <label className="time-seg">
        <NumberField label="Minute" value={minute} min={0} max={59} onChange={(m) => onChange(hour, m, pm)} onEnter={onGo} />
        <span className="time-unit">m</span>
      </label>
      {hour12 && (
        <button type="button" className="time-seg time-half" aria-label={pm ? "PM, switch to AM" : "AM, switch to PM"} onClick={() => onChange(hour, minute, !pm)}>
          {pm ? "PM" : "AM"}
        </button>
      )}
      <button type="button" className="time-seg time-go" aria-label="Go" disabled={!canGo} onClick={onGo}>
        <span>Go</span>
        <Icon name="forward" size={14} />
      </button>
    </div>
  );
}

/**
 * The day as a line: now is marked on it, and a press or drag anywhere puts the finger at that time, snapped to five
 * minutes, with the knob following. Arrow keys move it; Enter goes there.
 */
function DayScrubber({ now, pick, hour12, disabled, onPick, onGo }: { now: number; pick: number; hour12: boolean; disabled: boolean; onPick: (at: number) => void; onGo: (at: number) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const at = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return pick;
    const share = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return Math.round((share * DAY_SECONDS) / 300) * 300;
  };
  const hours = hour12 ? ["12 AM", "6 AM", "Noon", "6 PM", "12 AM"] : ["00", "06", "12", "18", "24"];
  return (
    <div className="time-scrub" style={{ "--now": now / DAY_SECONDS, "--pick": pick / DAY_SECONDS } as CSSProperties}>
      <div
        ref={track}
        className={`time-scrub-track${disabled ? " disabled" : ""}`}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Time of day"
        aria-valuemin={0}
        aria-valuemax={DAY_SECONDS}
        aria-valuenow={pick}
        aria-valuetext={`${Math.floor(pick / 3600)}:${String(Math.floor((pick % 3600) / 60)).padStart(2, "0")}`}
        onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
          if (disabled || e.button !== 0) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          onPick(at(e.clientX));
        }}
        onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
          if (dragging.current) onPick(at(e.clientX));
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          const by = e.shiftKey ? 3600 : 300;
          if (e.key === "ArrowRight" || e.key === "ArrowUp") (e.preventDefault(), onPick(pick + by));
          else if (e.key === "ArrowLeft" || e.key === "ArrowDown") (e.preventDefault(), onPick(pick - by));
          else if (e.key === "Home") (e.preventDefault(), onPick(0));
          else if (e.key === "End") (e.preventDefault(), onPick(DAY_SECONDS));
          else if (e.key === "Enter") (e.preventDefault(), onGo(pick));
        }}
      >
        <i className="time-scrub-line" />
        <i className="time-scrub-span" />
        {Array.from({ length: 25 }, (_, h) => (
          <i key={h} className={`time-scrub-tick${h % 6 === 0 ? " major" : ""}`} style={{ left: `${(h / 24) * 100}%` }} />
        ))}
        <i className="time-scrub-now" />
        <i className="time-scrub-knob" />
      </div>
      <div className="time-scrub-hours" aria-hidden="true">
        {hours.map((label, i) => (
          <span key={i}>{label}</span>
        ))}
      </div>
    </div>
  );
}
