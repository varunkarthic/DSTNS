import { useRef, useState } from "react";
import { Tooltip } from "./Tooltip";
import type { Clock, Lifecycle } from "./types";

/**
 * Rate multipliers offered to the operator. The core accepts up to 50x; past
 * that the map animates faster than it can be read and the render budget is
 * spent on motion nobody can follow.
 */
const RATES = [0.25, 0.5, 1, 2, 5, 10, 20, 35, 50];
const STEP_SECONDS = 60;

type Props = {
  clock: Clock | undefined;
  lifecycle: Lifecycle;
  enabled: boolean;
  pending: boolean;
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
  onPlayPause,
  onSeek,
  onRate,
  onReset,
}: Props) {
  const [hour12, setHour12] = useState(false);
  const scrubber = useRef<HTMLDivElement>(null);
  const rateTrack = useRef<HTMLDivElement>(null);

  const paused = lifecycle === "PAUSED";
  const virtual = clock?.virtual_day_seconds ?? 0;
  const percent = Math.min(100, Math.max(0, (virtual / 86400) * 100));
  const rate = clock?.tick_rate ?? 1;
  // Position the rate handle by index so the widely spaced multipliers stay legible.
  const rateIndex = Math.max(
    0,
    RATES.findIndex((r) => r >= rate),
  );
  const ratePercent = (rateIndex / (RATES.length - 1)) * 100;

  const seekFromPointer = (clientX: number) => {
    const el = scrubber.current;
    if (!el || !enabled) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onSeek(Math.round(ratio * 86400));
  };

  const rateFromPointer = (clientX: number) => {
    const el = rateTrack.current;
    if (!el || !enabled) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onRate(RATES[Math.round(ratio * (RATES.length - 1))]);
  };

  return (
    <section className="playback-dock" aria-label="Runtime playback">
      <div className="scrubber-row">
        <span className="time">00:00:00</span>
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
        <div className="readout">
          <span className="pct">{percent.toFixed(1)}%</span>
          <span style={{ color: "var(--outline-variant)" }}>•</span>
          <span>24:00:00</span>
        </div>
      </div>

      <div className="dock-row">
        <div className="clock-pod">
          <span className="value">
            {clock
              ? formatClock(clock.virtual_day_seconds, hour12)
              : hour12
                ? "12:00:00 AM"
                : "00:00:00"}
          </span>
          <div className="meta">
            <span className="eyebrow">Virtual time</span>
            <div className="segmented">
              <button
                type="button"
                aria-pressed={hour12}
                onClick={() => setHour12(true)}
              >
                12h
              </button>
              <button
                type="button"
                aria-pressed={!hour12}
                onClick={() => setHour12(false)}
              >
                24h
              </button>
            </div>
          </div>
        </div>

        <div className="dock-divider" aria-hidden="true" />

        <div className="rate-pod">
          <div className="head">
            <span className="name">Rate Multiplier</span>
            <span className="value">{rate}×</span>
          </div>
          <div
            ref={rateTrack}
            className="rate-slider"
            role="slider"
            tabIndex={enabled ? 0 : -1}
            aria-label="Simulation rate multiplier"
            aria-valuemin={RATES[0]}
            aria-valuemax={RATES[RATES.length - 1]}
            aria-valuenow={rate}
            aria-valuetext={`${rate} times real time`}
            aria-disabled={!enabled}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              rateFromPointer(e.clientX);
            }}
            onPointerMove={(e) => {
              if (e.buttons === 1) rateFromPointer(e.clientX);
            }}
            onKeyDown={(e) => {
              if (!enabled) return;
              const step =
                e.key === "ArrowRight" || e.key === "ArrowUp"
                  ? 1
                  : e.key === "ArrowLeft" || e.key === "ArrowDown"
                    ? -1
                    : 0;
              if (!step) return;
              e.preventDefault();
              onRate(
                RATES[
                  Math.min(RATES.length - 1, Math.max(0, rateIndex + step))
                ],
              );
            }}
          >
            <div className="rail">
              <i style={{ width: `${ratePercent}%` }} />
            </div>
            <div className="head" style={{ left: `${ratePercent}%` }} />
          </div>
          <div className="ticks">
            <span>1×</span>
            <span>5×</span>
            <span>20×</span>
            <span>50×</span>
          </div>
        </div>

        <div className="dock-divider" aria-hidden="true" />

        <div className="transport">
          <Tooltip
            info={{
              title: "Step back one minute",
              category: "Runtime control",
            }}
          >
            <button
              type="button"
              aria-label="Step back one virtual minute"
              disabled={!enabled || pending}
              onClick={() => onSeek(Math.max(0, virtual - STEP_SECONDS))}
            >
              ⏮
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
              disabled={
                !enabled || pending || !["RUNNING", "PAUSED"].includes(lifecycle)
              }
              onClick={onPlayPause}
            >
              {paused ? "▶" : "❚❚"}
            </button>
          </Tooltip>
          <Tooltip
            info={{
              title: "Step forward one minute",
              category: "Runtime control",
            }}
          >
            <button
              type="button"
              aria-label="Step forward one virtual minute"
              disabled={!enabled || pending}
              onClick={() => onSeek(Math.min(86400, virtual + STEP_SECONDS))}
            >
              ⏭
            </button>
          </Tooltip>
          <Tooltip
            info={{
              title: "Reset playback head",
              category: "Runtime control",
              description:
                "Returns the run to 00:00:00. The scenario and its seed are unchanged.",
            }}
          >
            <button
              type="button"
              className="stop"
              aria-label="Reset simulation to the start of the day"
              disabled={!enabled || pending}
              onClick={onReset}
            >
              ■
            </button>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}
