import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Icon } from "./Icons";
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
export const RATES = [0.25, 0.5, 1, 2, 3, 5] as const;

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

/**
 * Fractional position of any rate along the offered steps. An offered rate
 * lands exactly on its step; a rate between two steps (which backpressure can
 * apply) lands proportionally between them, so the highlight glides rather
 * than jumping when the applied rate changes.
 */
export function ratePosition(rate: number): number {
  if (!Number.isFinite(rate) || rate <= RATES[0]) return 0;
  if (rate >= RATES[RATES.length - 1]) return RATES.length - 1;
  const upper = RATES.findIndex((r) => r >= rate);
  const lower = upper - 1;
  return lower + (rate - RATES[lower]) / (RATES[upper] - RATES[lower]);
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

/** "0x5089050192221083c848bf3e12e22a4f" becomes "50890501…2a4f". */
export function shortSeed(seed: string): string {
  const hex = seed.replace(/^0x/i, "");
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
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
  const step = formatDuration(props.stepSeconds);

  return (
    <section className="rail" aria-label="Simulation controls">
      <div className="rail-group transport" data-tutorial="transport" role="group" aria-label="Playback">
        <Tooltip label="Reset to 00:00" detail="Replays the same scenario from the start of the day. Asks first.">
          <button type="button" className="rail-btn" aria-label="Reset simulation to the start of the day" disabled={!live || lifecycle === "IDLE"} onClick={props.onReset}>
            <Icon name="reset" size={16} />
          </button>
        </Tooltip>
        <span className="rail-sep" aria-hidden="true" />
        <Tooltip label={`Back ${skip}`} detail="Restores the nearest checkpoint and replays deterministically.">
          <button type="button" className="rail-btn" aria-label={`Back ${skip}`} disabled={!live || virtual <= 0} onClick={props.onBack}>
            <Icon name="back" size={18} />
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
          <button type="button" className="rail-btn" aria-label={`Forward ${skip}`} disabled={!live || virtual >= DAY_SECONDS} onClick={props.onForward}>
            <Icon name="forward" size={18} />
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
      />

      <SpeedControl
        rate={clock?.tick_rate ?? 1}
        requested={props.requestedRate}
        disabled={!live || props.rateLocked}
        locked={props.rateLocked}
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

function TimeControl({
  seconds,
  hasClock,
  percent,
  paused,
  reduceMotion,
  label,
  hour12,
  onToggle,
}: {
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
        <path className="ring-fill" d={d} pathLength={100} style={{ strokeDasharray: `${percent} 100` }} />
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
  onRate,
}: {
  rate: number;
  requested?: number;
  disabled: boolean;
  locked: boolean;
  onRate: (rate: number) => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const index = rateIndexOf(rate);
  const position = ratePosition(rate);
  const governed = requested !== undefined && Math.abs(requested - rate) > 1e-6;
  const requestedIndex = governed ? rateIndexOf(requested!) : -1;

  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    const target = e.key === "Home" ? 0 : e.key === "End" ? RATES.length - 1 : delta ? i + delta : -1;
    if (target < 0 || target >= RATES.length || disabled) return;
    e.preventDefault();
    onRate(RATES[target]);
    group.current?.querySelectorAll<HTMLButtonElement>("[role='radio']")[target]?.focus();
  };

  const detail = locked
    ? "Held at 1× by Adaptive Simulation Backpressure until the interface is back in sync."
    : governed
      ? `Requested ${rateLabel(requested!)}. Applied ${rateLabel(rate)} while the interface catches up.`
      : `Current speed ${rateLabel(rate)}.`;

  return (
    <Tooltip label="Simulation speed" detail={detail}>
      <div
        ref={group}
        className={`speed${locked ? " locked" : ""}${governed ? " governed" : ""}`}
        role="radiogroup"
        aria-label="Simulation speed"
        aria-disabled={disabled}
        data-tutorial="rate"
        style={{ ["--pos" as string]: position, ["--count" as string]: RATES.length }}
      >
        <span className="speed-pill" aria-hidden="true" />
        {RATES.map((value, i) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={i === index}
            aria-label={`${value} times speed`}
            tabIndex={i === index ? 0 : -1}
            disabled={disabled}
            className={`${i === index ? "on" : ""}${i === requestedIndex ? " requested" : ""}`}
            onClick={() => onRate(value)}
            onKeyDown={(e) => move(e, i)}
          >
            {rateLabel(value)}
          </button>
        ))}
        {locked && (
          <span className="speed-lock" aria-hidden="true">
            <Icon name="lock" size={14} />
          </span>
        )}
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
