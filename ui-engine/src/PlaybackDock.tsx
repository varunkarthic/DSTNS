import { useEffect, useRef, useState } from "react";
import { Tooltip } from "./Tooltip";
import type { Clock, Lifecycle } from "./types";

/**
 * Rate multipliers offered to the operator.
 *
 * The slider is indexed, not linear: the handle sits at the index of the value,
 * and the tick labels below are drawn from this same array at the same
 * positions. Deriving both from one source is what keeps the label under the
 * handle equal to the value the handle sets.
 */
export const RATES = [0.25, 0.5, 1, 2, 5, 10, 20, 35, 50] as const;
const STEP_SECONDS = 60;

/** Index of the entry a rate corresponds to, snapping to the nearest offered value. */
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

/** Position of an index along the track, as a percentage. */
export function rateOffset(index: number): number {
  return (index / (RATES.length - 1)) * 100;
}

type Props = {
  clock: Clock | undefined;
  lifecycle: Lifecycle;
  enabled: boolean;
  pending: boolean;
  hour12: boolean;
  onHour12: (value: boolean) => void;
  rateLocked: boolean;
  onPlayPause: () => void;
  onSeek: (virtualSeconds: number) => void;
  onRate: (rate: number) => void;
  onReset: () => void;
};

function formatClock(seconds: number, hour12: boolean) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600) % 24;
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  if (!hour12) return `${String(h).padStart(2, "0")}:${mm}:${ss}`;
  const suffix = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour).padStart(2, "0")}:${mm}:${ss} ${suffix}`;
}

export function PlaybackDock({
  clock,
  lifecycle,
  enabled,
  pending,
  hour12,
  onHour12,
  rateLocked,
  onPlayPause,
  onSeek,
  onRate,
  onReset,
}: Props) {
  const scrubber = useRef<HTMLDivElement>(null);
  const rateTrack = useRef<HTMLDivElement>(null);

  const paused = lifecycle === "PAUSED";
  const virtual = clock?.virtual_day_seconds ?? 0;
  const percent = Math.min(100, Math.max(0, (virtual / 86400) * 100));
  const rate = clock?.tick_rate ?? 1;
  const index = rateIndexOf(rate);

  // Item 16: when ASB pulls the rate down the handle must travel, not teleport.
  // The target is eased towards over a few frames, so a governed change reads as
  // deceleration rather than a jump.
  const [shownOffset, setShownOffset] = useState(() => rateOffset(index));
  const target = rateOffset(index);
  const raf = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    const step = () => {
      setShownOffset((current) => {
        const delta = target - current;
        if (Math.abs(delta) < 0.25) return target;
        raf.current = requestAnimationFrame(step);
        // Ease-out: quick at first, settling gently onto the mark.
        return current + delta * 0.18;
      });
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target]);

  const seekFromPointer = (clientX: number) => {
    const el = scrubber.current;
    if (!el || !enabled) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onSeek(Math.round(ratio * 86400));
  };

  const rateFromPointer = (clientX: number) => {
    const el = rateTrack.current;
    if (!el || !enabled || rateLocked) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onRate(RATES[Math.round(ratio * (RATES.length - 1))]);
  };

  return (
    <section className="playback-dock" aria-label="Runtime playback">
      {/* Tier 1: the day scrubber. */}
      <div className="scrubber-row">
        <span className="time mono">00:00</span>
        <div
          ref={scrubber}
          className="scrubber"
          role="slider"
          tabIndex={enabled ? 0 : -1}
          aria-label="Virtual day position"
          aria-valuemin={0}
          aria-valuemax={86400}
          aria-valuenow={Math.round(virtual)}
          aria-valuetext={formatClock(virtual, hour12)}
          aria-disabled={!enabled}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromPointer(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.buttons === 1) seekFromPointer(e.clientX);
          }}
          onKeyDown={(e) => {
            if (!enabled) return;
            const delta =
              e.key === "ArrowRight" || e.key === "ArrowUp"
                ? STEP_SECONDS
                : e.key === "ArrowLeft" || e.key === "ArrowDown"
                  ? -STEP_SECONDS
                  : e.key === "Home"
                    ? -virtual
                    : e.key === "End"
                      ? 86400 - virtual
                      : 0;
            if (!delta) return;
            e.preventDefault();
            onSeek(Math.min(86400, Math.max(0, virtual + delta)));
          }}
        >
          <div className="rail">
            <i style={{ width: `${percent}%` }} />
          </div>
          <div className="head" style={{ left: `${percent}%` }}>
            <i />
          </div>
        </div>
        <span className="time mono pct">{percent.toFixed(1)}%</span>
        <span className="time mono">24:00</span>
      </div>

      {/* Tier 2: clock, rate, transport - one compact row. */}
      <div className="dock-row">
        <button
          className="clock-pod"
          onClick={() => onHour12(!hour12)}
          aria-label={`Virtual time, ${hour12 ? "12" : "24"} hour clock. Activate to switch.`}
        >
          <span className="value mono">
            {clock ? formatClock(clock.virtual_day_seconds, hour12) : "00:00:00"}
          </span>
          <span className="eyebrow">
            Virtual time <b>{hour12 ? "12h" : "24h"}</b>
          </span>
        </button>

        <div className="dock-divider" aria-hidden="true" />

        <div className={`rate-pod${rateLocked ? " locked" : ""}`}>
          <div className="head">
            <span className="name">Rate</span>
            <span className="value mono">{rate}×</span>
          </div>
          <div
            ref={rateTrack}
            className="rate-slider"
            role="slider"
            tabIndex={enabled && !rateLocked ? 0 : -1}
            aria-label="Simulation rate multiplier"
            aria-valuemin={RATES[0]}
            aria-valuemax={RATES[RATES.length - 1]}
            aria-valuenow={rate}
            aria-valuetext={`${rate} times real time`}
            aria-disabled={!enabled || rateLocked}
            onPointerDown={(e) => {
              if (rateLocked) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              rateFromPointer(e.clientX);
            }}
            onPointerMove={(e) => {
              if (e.buttons === 1) rateFromPointer(e.clientX);
            }}
            onKeyDown={(e) => {
              if (!enabled || rateLocked) return;
              const step =
                e.key === "ArrowRight" || e.key === "ArrowUp"
                  ? 1
                  : e.key === "ArrowLeft" || e.key === "ArrowDown"
                    ? -1
                    : 0;
              if (!step) return;
              e.preventDefault();
              onRate(RATES[Math.min(RATES.length - 1, Math.max(0, index + step))]);
            }}
          >
            <div className="rail">
              <i style={{ width: `${shownOffset}%` }} />
            </div>
            <div className="head" style={{ left: `${shownOffset}%` }} />
          </div>
          {/* Ticks are drawn from RATES at their own offsets, so every label
              sits exactly where selecting it puts the handle. */}
          <div className="ticks" aria-hidden="true">
            {RATES.map((value, i) => (
              <button
                key={value}
                className={i === index ? "current" : ""}
                style={{ left: `${rateOffset(i)}%` }}
                tabIndex={-1}
                disabled={!enabled || rateLocked}
                onClick={() => onRate(value)}
              >
                {value}×
              </button>
            ))}
          </div>
        </div>

        <div className="dock-divider" aria-hidden="true" />

        <div className="transport">
          <Tooltip info={{ title: "Back one minute", category: "Runtime control" }}>
            <button
              type="button"
              aria-label="Step back one virtual minute"
              disabled={!enabled || pending}
              onClick={() => onSeek(Math.max(0, virtual - STEP_SECONDS))}
            >
              <span aria-hidden="true">⏮</span>
            </button>
          </Tooltip>
          <Tooltip
            info={{
              title: paused ? "Resume" : "Pause",
              category: "Runtime control",
              description: "New simulations are started from the CLI.",
            }}
          >
            <button
              type="button"
              className="play"
              aria-label={paused ? "Resume simulation" : "Pause simulation"}
              disabled={!enabled || pending || !["RUNNING", "PAUSED"].includes(lifecycle)}
              onClick={onPlayPause}
            >
              <span aria-hidden="true">{paused ? "▶" : "❚❚"}</span>
            </button>
          </Tooltip>
          <Tooltip info={{ title: "Forward one minute", category: "Runtime control" }}>
            <button
              type="button"
              aria-label="Step forward one virtual minute"
              disabled={!enabled || pending}
              onClick={() => onSeek(Math.min(86400, virtual + STEP_SECONDS))}
            >
              <span aria-hidden="true">⏭</span>
            </button>
          </Tooltip>
          {/* Item 12: a rewind glyph rather than a stop square, and the click
              only opens a confirmation - it never resets on its own. */}
          <Tooltip
            info={{
              title: "Reset to start of day",
              category: "Runtime control",
              description:
                "Returns the run to 00:00:00. The scenario and its seed are unchanged. You will be asked to confirm.",
            }}
          >
            <button
              type="button"
              className="reset"
              aria-label="Reset simulation to the start of the day"
              disabled={!enabled || pending}
              onClick={onReset}
            >
              <span aria-hidden="true">↺</span>
            </button>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}
