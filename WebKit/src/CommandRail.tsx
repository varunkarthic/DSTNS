// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { animate, SPRINGS, stepSpring } from "./motion";
import { QuantizedSlider } from "./QuantizedSlider";
import { Floating, useDismiss } from "./Popover";
import { TimeControl } from "./TimeControl";
import { SKIP_OPTIONS } from "./uiConfig";
import { Icon, ActionIcon } from "./Icons";
import { Tooltip } from "./Tooltip";
import { useTimeFormat } from "./preferences";
import { DAY_SECONDS, formatDuration } from "./timeFormat";
import type { RuntimeStatus } from "./telemetryRecorder";
import type { Clock, Lifecycle } from "./types";

/**
 * The simulation command rail.
 *
 * One compact floating bar: transport, the time, the day, speed, the seed, runtime
 * status and Terminate. The day takes whatever room is left, so no width is wasted.
 */

/** Speeds offered, as multiples of the configured playback pace. */
// The rates the operator may choose. 10x is the ceiling the core enforces. Above 5x
// a second of real time spans more simulated time than one snapshot shows, so the
// picture moves in larger steps; results do not change.
export const RATES = [0.25, 0.5, 1, 2, 3, 5, 10] as const;

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
  fineControl: boolean;
  onBack: (seconds?: number) => void;
  onForward: (seconds?: number) => void;
  /** Go to a time of day, earlier or later: Time Control. */
  onSeekTo: (target: number) => void;
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
  const step = formatDuration(props.stepSeconds);
  const progress = useSmoothProgress(percent, lifecycle === "RUNNING" ? clock?.tick_rate ?? 1 : 0, props.reduceMotion);

  return (
    <section className="rail" aria-label="Simulation controls">
      <div className="rail-group transport" data-tutorial="transport" role="group" aria-label="Playback">
        <Tooltip label="Start over" detail="Returns to the beginning of the day and replays the same scenario. You will be asked first.">
          <button type="button" className="rail-btn" aria-label="Reset simulation to the start of the day" disabled={!live || lifecycle === "IDLE"} onClick={props.onReset}>
            <Icon name="reset" size={16} />
          </button>
        </Tooltip>
        <span className="rail-sep" aria-hidden="true" />
        <SkipButton direction="back" label={skip} fine={props.fineControl} disabled={!live || virtual <= 0} reduceMotion={props.reduceMotion} onSkip={props.onBack} />
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
        <SkipButton direction="forward" label={skip} fine={props.fineControl} disabled={!live || virtual >= DAY_SECONDS} reduceMotion={props.reduceMotion} onSkip={props.onForward} />
      </div>

      <TimeControl seconds={virtual} hasClock={!!clock} percent={percent} paused={paused} disabled={!live || lifecycle === "IDLE"} onSeekTo={props.onSeekTo} />

      <DayTimeline track={progress} hour12={time.hour12} paused={paused} />

      <SpeedControl
        rate={clock?.tick_rate ?? 1}
        requested={props.requestedRate}
        disabled={!live || props.rateLocked}
        locked={props.rateLocked}
        reduceMotion={props.reduceMotion}
        onRate={props.onRate}
      />

      <SeedControl seed={props.seed} canRegenerate={props.canRegenerate && !pending} onRegenerate={props.onRegenerate} />

      <Tooltip label={`Runtime ${STATUS_LABEL[props.status]}`} detail={props.statusDetail.length ? props.statusDetail.join(" · ") : undefined}>
        <span className={`runtime runtime-${props.status}`} data-tutorial="status" data-tutorial-fit role="status" aria-label={`Runtime status ${STATUS_LABEL[props.status]}`}>
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
 * Drives the progress line every frame. Between polls it advances at the running
 * rate, so even at 10x it moves rather than jumps; a seek or skip arrives as a new
 * target for a spring, so it travels there rather than teleporting.
 */
export function useSmoothProgress(percent: number, ratePerSecond: number, reduceMotion: boolean) {
  const bar = useRef<HTMLElement>(null);
  const goal = useRef({ percent, at: 0, rate: ratePerSecond });
  const state = useRef({ x: percent, v: 0, cancel: null as (() => void) | null });
  const painted = useRef(-1);
  const paint = (value: number) => {
    const el = bar.current;
    if (!el) return;
    const day = Math.max(0, Math.min(100, value)) / 100;
    // Too small a change to see costs nothing.
    if (Math.abs(day - painted.current) < 0.0002) return;
    painted.current = day;
    const height = sunHeight(day);
    el.style.setProperty("--day", day.toFixed(5));
    el.style.setProperty("--sky", `${(ARC_HORIZON - ARC_RISE * height).toFixed(2)}px`);
    el.style.setProperty("--night", height < 0 ? "1" : "0");
  };
  const wake = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
    const target = () => goal.current.percent + (goal.current.rate * (performance.now() - goal.current.at)) / 864000;
    // A jump, such as a seek, travels on a spring. Otherwise the day moves far less than a
    // pixel a second, so nothing runs per frame: it is just brought up to date now and then.
    const run = () => {
      clearTimeout(wake.current);
      if (Math.abs(s.x - target()) < 0.02 && Math.abs(s.v) < 0.01) {
        s.x = target();
        paint(s.x);
        if (goal.current.rate) wake.current = setTimeout(run, 1000);
        return;
      }
      s.cancel ??= animate((dt) => {
        [s.x, s.v] = stepSpring(s.x, s.v, target(), SPRINGS.spatialSlow, dt);
        paint(s.x);
        if (Math.abs(s.x - target()) < 0.02 && Math.abs(s.v) < 0.01) {
          s.cancel = null;
          if (goal.current.rate) wake.current = setTimeout(run, 1000);
          return false;
        }
        return true;
      });
    };
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [percent, ratePerSecond, reduceMotion]);
  useEffect(() => {
    const s = state.current;
    return () => {
      s.cancel?.();
      s.cancel = null;
      clearTimeout(wake.current);
    };
  }, []);
  return bar;
}

/** Where the sun is at this share of the day, from -1 at midnight to 1 at noon. */
export function sunHeight(day: number): number {
  return Math.sin(2 * Math.PI * (day - 0.25));
}

const ARC_WIDTH = 240;
const ARC_HEIGHT = 28;
const ARC_HORIZON = 13;
const ARC_RISE = 9;
const ARC_PATH = Array.from({ length: 49 }, (_, i) => `${i ? "L" : "M"}${(i / 48) * ARC_WIDTH} ${(ARC_HORIZON - ARC_RISE * sunHeight(i / 48)).toFixed(2)}`).join(" ");

/**
 * The day as the sun's path: up over the horizon at six, highest at noon, down at six
 * and on under the horizon through the night. What has passed is lit, and the sun or the
 * moon stands at now. It reports time and does not set it: moving through the day is
 * what Back, Forward and Step are for, because moving replays the model.
 */
function DayTimeline({ track, hour12, paused }: { track: RefObject<HTMLElement | null>; hour12: boolean; paused: boolean }) {
  const hours = hour12 ? ["12a", "6a", "12p", "6p", "12a"] : ["00", "06", "12", "18", "24"];
  return (
    <div className={`day-timeline${paused ? " paused" : ""}`} aria-hidden="true">
      <span className="day-track" ref={track}>
        <svg viewBox={`0 0 ${ARC_WIDTH} ${ARC_HEIGHT}`} preserveAspectRatio="none">
          <line className="day-horizon" x1="0" x2={ARC_WIDTH} y1={ARC_HORIZON} y2={ARC_HORIZON} vectorEffect="non-scaling-stroke" />
          <path className="day-path" d={ARC_PATH} vectorEffect="non-scaling-stroke" />
          <path className="day-passed" d={ARC_PATH} vectorEffect="non-scaling-stroke" />
        </svg>
        <i className="day-head" />
      </span>
      <span className="day-hours">
        {hours.map((hour, i) => (
          <span key={i}>{hour}</span>
        ))}
      </span>
    </div>
  );
}

const SPEED_LABELS = RATES.map((rate) => String(rate));

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
  const [choice, setChoice] = useState<number | null>(null);
  const governed = requested !== undefined && Math.abs(requested - rate) > 1e-6;
  // The chosen stop shows at once. While ASB holds the speed lower, the thumb travels to
  // what is being applied, and a line stays on what was asked for.
  const target = governed ? requested : rate;
  const index = choice ?? rateIndexOf(rate);
  useEffect(() => {
    if (choice === null) return;
    if (rateIndexOf(target) === choice) {
      setChoice(null);
      return;
    }
    const timer = setTimeout(() => setChoice(null), 2500);
    return () => clearTimeout(timer);
  }, [choice, target]);
  const detail = locked
    ? `Target ${rateLabel(target)}. Held at ${rateLabel(rate)} by Adaptive Simulation Backpressure until the interface is back in sync.`
    : governed
      ? `Target ${rateLabel(requested!)}. Reduced to ${rateLabel(rate)} by Adaptive Simulation Backpressure while the interface catches up.`
      : "How fast simulated time passes. Drag, click a speed, or use the arrow keys.";
  return (
    <Tooltip label="Simulation speed" detail={detail}>
      <div className={`speed${locked ? " locked" : ""}${governed ? " governed" : ""}`}>
        {governed || locked ? (
          <span className="rail-label reduced" role="status" aria-label={`Speed reduced by Adaptive Simulation Backpressure: target ${rateLabel(target)}, applied ${rateLabel(rate)}`}>
            <span>ASB {locked && <Icon name="lock" size={10} />}</span>
            <strong className="mono">{rateLabel(rate)}<small>/{rateLabel(target)}</small></strong>
          </span>
        ) : (
          <span className="rail-label">Speed</span>
        )}
        <QuantizedSlider
          tutorial="rate"
          label="Simulation speed"
          labels={SPEED_LABELS}
          index={index}
          target={governed && choice === null ? rateIndexOf(requested) : undefined}
          disabled={disabled}
          reduceMotion={reduceMotion}
          valueText={(i) => `${RATES[i]} times speed${governed ? `, target ${requested} times` : ""}`}
          onSelect={(i) => {
            setChoice(i);
            onRate(RATES[i]);
          }}
        />
      </div>
    </Tooltip>
  );
}

/** Back or Forward. With fine control on, a press asks how far. */
function SkipButton({ direction, label, fine, disabled, reduceMotion, onSkip }: { direction: "back" | "forward"; label: string; fine: boolean; disabled: boolean; reduceMotion: boolean; onSkip: (seconds?: number) => void }) {
  const [pressed, setPressed] = useState(0);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [trigger, menu]);
  return (
    <>
      <Tooltip label={fine ? (direction === "back" ? "Back by…" : "Forward by…") : `${direction === "back" ? "Back" : "Forward"} ${label}`} detail={direction === "back" ? "Restores the nearest checkpoint and replays deterministically." : "Advances the model by this interval."} disabled={open}>
        <button
          ref={trigger}
          type="button"
          className={`rail-btn${open ? " active" : ""}`}
          aria-label={fine ? (direction === "back" ? "Back by" : "Forward by") : `${direction === "back" ? "Back" : "Forward"} ${label}`}
          aria-haspopup={fine ? "menu" : undefined}
          aria-expanded={fine ? open : undefined}
          disabled={disabled}
          onClick={() => {
            if (fine) setOpen((v) => !v);
            else {
              setPressed((p) => p + 1);
              onSkip();
            }
          }}
        >
          <ActionIcon name={direction} size={18} signal={pressed} motion={direction} reduceMotion={reduceMotion} />
        </button>
      </Tooltip>
      <Floating anchor={trigger} open={open} preferred={["top"]} only className="skip-menu" panelRef={menu} role="menu" label={direction === "back" ? "Go back by" : "Go forward by"}>
        {SKIP_OPTIONS.map((seconds) => (
          <button
            key={seconds}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setPressed((p) => p + 1);
              onSkip(seconds);
            }}
          >
            {seconds < 3600 ? `${seconds / 60}m` : `${seconds / 3600}h`}
          </button>
        ))}
      </Floating>
    </>
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
      <Tooltip label="Copy seed" detail={seed ? <span className="mono">{seed}</span> : undefined} disabled={!!feedback}>
        <button type="button" className={`seed-value${feedback ? ` is-${feedback}` : ""}`} onClick={copy} disabled={!seed} aria-label={seed ? `Copy seed ${seed}` : "No seed"}>
          <span className="seed-face">
            <span className="seed-key">Seed</span>
            <span className="mono">{seed ? shortSeed(seed) : "None"}</span>
          </span>
          <span className={`seed-feedback${feedback ? ` ${feedback}` : ""}`} aria-live="polite">
            {feedback === "copied" ? (
              <>
                <svg className="seed-check" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 8.5l3.2 3.2L13 4.8" pathLength={1} />
                </svg>
                Copied
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
