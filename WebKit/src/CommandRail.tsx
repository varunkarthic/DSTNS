// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { animate, createVelocityTracker, projectSnap, Spring, SPRINGS, stepSpring } from "./motion";
import { dlrClamp } from "./dlr";
import { Icon, ActionIcon } from "./Icons";
import { Tooltip } from "./Tooltip";
import { useTimeFormat } from "./preferences";
import { DAY_SECONDS, formatDuration } from "./timeFormat";
import type { RuntimeStatus } from "./telemetryRecorder";
import type { Clock, Lifecycle } from "./types";

/**
 * The simulation command rail.
 *
 * One compact floating bar: transport, the time and progress control, speed,
 * the seed, runtime status and Terminate. Transport, time and speed read as a
 * single playback subsystem; seed, status and Terminate describe the session.
 */

/** Speeds offered, as multiples of the configured playback pace. */
// The rates the operator may choose. 20x is the ceiling the core enforces. Above 5x
// a second of real time spans more simulated time than one snapshot shows, so the
// picture moves in larger steps; results do not change.
export const RATES = [0.25, 0.5, 1, 2, 3, 5, 10, 20] as const;

/** Index of the offered rate nearest to `rate`. */
export function rateIndexOf(rate: number): number {
  let best = 0;
  let distance = Infinity;
  RATES.forEach((value, index) => {
    const d = Math.abs(value - rate);
    if (d < distance) {
      distance = d;
      best = index;
    }
  });
  return best;
}

export function rateLabel(rate: number): string {
  return `${Number.isInteger(rate) ? rate : rate.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}×`;
}

/** Stadium outline starting at top centre and running clockwise. */
export function stadiumPath(width: number, height: number, inset = 1.5): string {
  const x0 = inset, y0 = inset, x1 = width - inset, y1 = height - inset;
  const r = (y1 - y0) / 2;
  return `M ${width / 2} ${y0} H ${x1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1} H ${x0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0} Z`;
}

/**
 * The seed as the rail shows it. Seeds are numbers: a generated one is short
 * enough to show whole, and only a very long typed seed is elided, keeping
 * both ends so it can still be recognised. Copying always yields the whole
 * number.
 */
export function shortSeed(seed: string): string {
  const text = seed.trim();
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Fall through to the selection-based copy. */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

const STATUS_LABEL: Record<RuntimeStatus, string> = {
  online: "Online",
  degraded: "Degraded",
  offline: "Offline",
};

export interface CommandRailProps {
  clock: Clock | undefined;
  lifecycle: Lifecycle;
  /** Data is current and the interface is not suspended. */
  enabled: boolean;
  pending: boolean;
  rateLocked: boolean;
  requestedRate?: number;
  reduceMotion: boolean;
  seed: string;
  status: RuntimeStatus;
  statusDetail: string[];
  skipSeconds: number;
  stepSeconds: number;
  canRegenerate: boolean;
  onPlayPause: () => void;
  onBack: () => void;
  onForward: () => void;
  onStep: () => void;
  onRate: (rate: number) => void;
  onReset: () => void;
  onRegenerate: () => void;
  onTerminate: () => void;
}

export function CommandRail(props: CommandRailProps) {
  const time = useTimeFormat();
  const { clock, lifecycle, enabled, pending } = props;
  const virtual = clock?.virtual_day_seconds ?? 0;
  const fraction = Math.min(1, Math.max(0, clock ? clock.simulation_percentage ?? virtual / DAY_SECONDS : 0));
  const percent = Math.round(fraction * 1000) / 10;
  const paused = lifecycle === "PAUSED";
  const completed = lifecycle === "COMPLETED";
  const live = enabled && !pending;
  const playable = live && (lifecycle === "RUNNING" || lifecycle === "PAUSED");
  const skip = formatDuration(props.skipSeconds);
  // Back and forward do not latch, so there is no state to watch: count the
  // presses instead. The clock will not do - it moves on its own while the
  // simulation runs, which would leave both arrows twitching all the way
  // through a playback.
  const [pressed, setPressed] = useState({ back: 0, forward: 0 });
  const step = formatDuration(props.stepSeconds);

  return (
    <section className="rail" aria-label="Simulation controls">
      <div className="rail-group transport" data-tutorial="transport" role="group" aria-label="Playback">
        <Tooltip label="Start over" detail="Returns to the beginning of the day and replays the same scenario. You will be asked first.">
          <button type="button" className="rail-btn" aria-label="Reset simulation to the start of the day" disabled={!live || lifecycle === "IDLE"} onClick={props.onReset}>
            <Icon name="reset" size={16} />
          </button>
        </Tooltip>
        <span className="rail-sep" aria-hidden="true" />
        <Tooltip label={`Back ${skip}`} detail="Restores the nearest checkpoint and replays deterministically.">
          <button type="button" className="rail-btn" aria-label={`Back ${skip}`} disabled={!live || virtual <= 0} onClick={() => { setPressed((p) => ({ ...p, back: p.back + 1 })); props.onBack(); }}>
            <ActionIcon name="back" size={18} signal={pressed.back} motion="back" reduceMotion={props.reduceMotion} />
          </button>
        </Tooltip>
        <Tooltip label={`Step ${step}`} detail="Advances by one step and holds, so each change can be inspected.">
          <button type="button" className="rail-btn" aria-label={`Step ${step}`} disabled={!live || virtual >= DAY_SECONDS || completed} onClick={props.onStep}>
            <Icon name="step" size={16} />
          </button>
        </Tooltip>
        <Tooltip label={paused ? "Resume" : "Pause"}>
          <button
            type="button"
            className={`rail-btn play${paused ? " is-paused" : ""}`}
            aria-label={paused ? "Resume simulation" : "Pause simulation"}
            disabled={!playable}
            onClick={props.onPlayPause}
          >
            <span className="play-glyph" key={paused ? "play" : "pause"}>
              <Icon name={paused ? "play" : "pause"} size={18} />
            </span>
          </button>
        </Tooltip>
        <Tooltip label={`Forward ${skip}`} detail="Advances the model by the skip interval.">
          <button type="button" className="rail-btn" aria-label={`Forward ${skip}`} disabled={!live || virtual >= DAY_SECONDS} onClick={() => { setPressed((p) => ({ ...p, forward: p.forward + 1 })); props.onForward(); }}>
            <ActionIcon name="forward" size={18} signal={pressed.forward} motion="forward" reduceMotion={props.reduceMotion} />
          </button>
        </Tooltip>
      </div>

      <TimeControl
        seconds={virtual}
        hasClock={!!clock}
        percent={percent}
        paused={paused}
        reduceMotion={props.reduceMotion}
        label={time.time(virtual)}
        hour12={time.hour12}
        onToggle={time.toggle}
        running={lifecycle === "RUNNING"}
        tickRate={clock?.tick_rate ?? 1}
      />

      <SpeedControl
        rate={clock?.tick_rate ?? 1}
        requested={props.requestedRate}
        disabled={!live || props.rateLocked}
        locked={props.rateLocked}
        reduceMotion={props.reduceMotion}
        onRate={props.onRate}
      />

      <span className="rail-divider" aria-hidden="true" />

      <SeedControl seed={props.seed} canRegenerate={props.canRegenerate && !pending} onRegenerate={props.onRegenerate} />

      <Tooltip label={`Runtime ${STATUS_LABEL[props.status]}`} detail={props.statusDetail.length ? props.statusDetail.join(" · ") : undefined}>
        <span className={`runtime runtime-${props.status}`} data-tutorial="status" role="status" aria-label={`Runtime status ${STATUS_LABEL[props.status]}`}>
          <i aria-hidden="true" />
          {STATUS_LABEL[props.status]}
        </span>
      </Tooltip>

      <Tooltip label="Terminate session" detail="Stops the run and shuts the simulation server down. Asks first.">
        <button type="button" className="rail-terminate" data-tip-avoid onClick={props.onTerminate} disabled={pending || lifecycle === "IDLE"} aria-label="Terminate">
          <Icon name="power" size={14} />
          <span>Terminate</span>
        </button>
      </Tooltip>
    </section>
  );
}

/**
 * Drives the progress ring every frame. Between polls it advances at the running
 * rate, so even at 20x it moves rather than jumps; a seek or skip arrives as a new
 * target for a spring, so it travels there rather than teleporting.
 */
export function useSmoothProgress(percent: number, ratePerSecond: number, reduceMotion: boolean) {
  const path = useRef<SVGPathElement>(null);
  const goal = useRef({ percent, at: 0, rate: ratePerSecond });
  const state = useRef({ x: percent, v: 0, cancel: null as (() => void) | null });
  const paint = (value: number) => path.current?.style.setProperty("stroke-dasharray", `${Math.max(0, Math.min(100, value)).toFixed(3)} 100`);
  useLayoutEffect(() => {
    goal.current = { percent, at: performance.now(), rate: ratePerSecond };
    const s = state.current;
    if (reduceMotion || typeof requestAnimationFrame !== "function") {
      s.cancel?.();
      s.cancel = null;
      s.x = percent;
      paint(percent);
      return;
    }
    s.cancel ??= animate((dt) => {
      const g = goal.current;
      const target = g.percent + (g.rate * (performance.now() - g.at)) / 864000;
      [s.x, s.v] = stepSpring(s.x, s.v, target, SPRINGS.spatialSlow, dt);
      paint(s.x);
      if (!g.rate && Math.abs(s.x - target) < 0.005 && Math.abs(s.v) < 0.01) {
        s.cancel = null;
        return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [percent, ratePerSecond, reduceMotion]);
  useEffect(() => {
    const s = state.current;
    return () => {
      s.cancel?.();
      s.cancel = null;
    };
  }, []);
  return path;
}

function TimeControl({
  seconds,
  hasClock,
  percent,
  paused,
  reduceMotion,
  label,
  hour12,
  onToggle,
  running,
  tickRate,
}: {
  running: boolean;
  tickRate: number;
  seconds: number;
  hasClock: boolean;
  percent: number;
  paused: boolean;
  reduceMotion: boolean;
  label: string;
  hour12: boolean;
  onToggle: () => void;
}) {
  const W = 132, H = 40;
  const d = stadiumPath(W, H);
  const fill = useSmoothProgress(percent, running ? tickRate : 0, reduceMotion);
  return (
    <button
      type="button"
      className={`time-control${paused ? " paused" : ""}${reduceMotion ? " still" : ""}`}
      data-tutorial="clock"
      data-tip-avoid
      onClick={onToggle}
      aria-label={`Simulation time ${hasClock ? label : "unavailable"}, ${percent.toFixed(0)} percent complete${paused ? ", paused" : ""}. Activate to switch to ${hour12 ? "24" : "12"} hour time.`}
      data-seconds={Math.round(seconds)}
    >
      <svg className="time-ring" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
        <path className="ring-track" d={d} pathLength={100} />
        <path ref={fill} className="ring-fill" d={d} pathLength={100} />
      </svg>
      <span className="time-value mono">{hasClock ? label : "--:--:--"}</span>
      <span className="time-hint" aria-hidden="true">
        {percent.toFixed(0)}% complete
      </span>
    </button>
  );
}

function SpeedControl({
  rate,
  requested,
  disabled,
  locked,
  reduceMotion,
  onRate,
}: {
  rate: number;
  requested?: number;
  disabled: boolean;
  locked: boolean;
  reduceMotion: boolean;
  onRate: (rate: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const spring = useRef<Spring | null>(null);
  const tracker = useRef(createVelocityTracker());
  const dragging = useRef(false);
  const [width, setWidth] = useState(0);
  const [choice, setChoice] = useState<number | null>(null);
  const [held, setHeld] = useState(false);
  // The chosen stop shows at once; the core's answer follows on the next poll.
  const index = choice ?? rateIndexOf(rate);
  const governed = requested !== undefined && Math.abs(requested - rate) > 1e-6;
  const stops = RATES.map((_, i) => (i / (RATES.length - 1)) * width);

  useEffect(() => {
    if (choice !== null && rateIndexOf(rate) === choice) setChoice(null);
    if (choice === null) return;
    const timer = setTimeout(() => setChoice(null), 2500);
    return () => clearTimeout(timer);
  }, [choice, rate]);

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

  // The thumb is a spring, so a stop is reached with the momentum of the gesture.
  useEffect(() => {
    if (!thumb.current || !width) return;
    const target = stops[index];
    spring.current ??= new Spring(target, SPRINGS.expressiveFast, (x) => thumb.current?.parentElement?.style.setProperty("--speed-x", `${x.toFixed(2)}px`), 0.1);
    if (dragging.current) return;
    if (reduceMotion) spring.current.jump(target);
    else spring.current.set(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, width, reduceMotion]);
  useEffect(() => () => spring.current?.stop(), []);

  const choose = (next: number) => {
    if (next === rateIndexOf(rate) && choice === null) return;
    setChoice(next);
    onRate(RATES[next]);
  };
  const place = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    return clientX - rect.left - track.current!.clientLeft;
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || !width) return;
    dragging.current = true;
    setHeld(true);
    tracker.current.reset();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const x = place(e.clientX);
    tracker.current.add(x, e.timeStamp);
    spring.current?.set(Math.max(0, Math.min(width, x)));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const x = place(e.clientX);
    tracker.current.add(x, e.timeStamp);
    // Past either end it gives a little and no further.
    spring.current?.jump(dlrClamp(x, 0, width, 12));
  };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setHeld(false);
    const value = spring.current?.value ?? stops[index];
    const velocity = tracker.current.velocity();
    const landed = projectSnap(Math.max(0, Math.min(width, value)), velocity, stops);
    const next = stops.indexOf(landed);
    if (reduceMotion) spring.current?.jump(landed);
    else spring.current?.set(landed, velocity);
    choose(next);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    const target = e.key === "Home" ? 0 : e.key === "End" ? RATES.length - 1 : delta ? index + delta : -1;
    if (target < 0 || target >= RATES.length || disabled) return;
    e.preventDefault();
    choose(target);
  };

  const detail = locked
    ? "Held at 1× by Adaptive Simulation Backpressure until the interface is back in sync."
    : governed
      ? `Requested ${rateLabel(requested!)}. Applied ${rateLabel(rate)} while the interface catches up.`
      : "Drag, or use the arrow keys. It settles on the nearest stop.";

  return (
    <Tooltip label="Simulation speed" detail={detail} disabled={held}>
      <div className={`speed${locked ? " locked" : ""}${governed ? " governed" : ""}${held ? " held" : ""}${disabled ? " disabled" : ""}`} data-tutorial="rate" data-tip-avoid>
        <div
          ref={track}
          className="speed-track"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Simulation speed"
          aria-valuemin={0}
          aria-valuemax={RATES.length - 1}
          aria-valuenow={index}
          aria-valuetext={`${RATES[index]} times speed`}
          aria-disabled={disabled}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onKey}
        >
          <span className="speed-line" aria-hidden="true" />
          <span className="speed-fill" aria-hidden="true" />
          {RATES.map((value, i) => (
            <i key={value} className={`speed-stop${i <= index ? " passed" : ""}`} style={{ left: `${(i / (RATES.length - 1)) * 100}%` }} aria-hidden="true" />
          ))}
          <div ref={thumb} className="speed-thumb" aria-hidden="true">
            {held && <span className="speed-bubble mono">{rateLabel(RATES[index])}</span>}
          </div>
        </div>
        <span className="speed-value mono" key={index} aria-hidden="true">
          {locked ? <Icon name="lock" size={14} /> : rateLabel(RATES[index])}
        </span>
      </div>
    </Tooltip>
  );
}

function SeedControl({ seed, canRegenerate, onRegenerate }: { seed: string; canRegenerate: boolean; onRegenerate: () => void }) {
  const [feedback, setFeedback] = useState<"" | "copied" | "failed">("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    if (!seed) return;
    const ok = await copyText(seed);
    setFeedback(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback(""), 1600);
  };
  return (
    <div className="seed" data-tutorial="seed">
      <Tooltip label={feedback === "copied" ? "Copied" : "Copy seed"} detail={seed ? <span className="mono">{seed}</span> : undefined}>
        <button type="button" className="seed-value" onClick={copy} disabled={!seed} aria-label={seed ? `Copy seed ${seed}` : "No seed"}>
          <span className="seed-key">Seed</span>
          <span className="mono">{seed ? shortSeed(seed) : "None"}</span>
          <span className={`seed-feedback${feedback ? ` ${feedback}` : ""}`} aria-live="polite">
            {feedback === "copied" ? (
              <>
                <Icon name="check" size={14} /> Copied
              </>
            ) : feedback === "failed" ? (
              "Copy failed"
            ) : null}
          </span>
        </button>
      </Tooltip>
      <Tooltip label="Generate new world" detail="A new seed selects a new district. The current run is replaced. Asks first.">
        <button
          type="button"
          className="rail-btn reroll"
          data-tutorial="regenerate"
          aria-label="Generate new world"
          onClick={onRegenerate}
          disabled={!canRegenerate}
        >
          <Icon name="reroll" size={16} />
        </button>
      </Tooltip>
    </div>
  );
}
