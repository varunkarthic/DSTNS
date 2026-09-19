import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Backpressure } from "./types";

/**
 * The observer's half of Adaptive Simulation Backpressure.
 *
 * Each interval this measures three things the core cannot see for itself -
 * how stale the rendered snapshot is, how long this browser's frames are
 * taking, and how long since it managed to poll at all - and reports them. The
 * response is the authoritative backpressure state, which the interface then
 * obeys.
 *
 * Measurement is deliberately passive: it observes frames that were going to
 * happen anyway and never drives rendering itself.
 */

export interface BackpressureClient {
  asb: Backpressure | null;
  /** Soft restart counter: incremented when ASB asks for a presentation reset. */
  resetToken: number;
}

const IDLE: Backpressure | null = null;

/**
 * Accept a backpressure report only if it is actually one.
 *
 * The endpoint is the core's, but the observer must not crash on an old core,
 * a proxy error page, or a truncated body. An unrecognised shape is treated as
 * "no report", which is exactly how being offline is already handled.
 */
export function isBackpressure(value: unknown): value is Backpressure {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const throughput = v.throughput as Record<string, unknown> | undefined;
  return (
    (v.state === "NORMAL" || v.state === "RESTRICTED" || v.state === "ASYNC") &&
    typeof v.score === "number" &&
    typeof v.gui_suspended === "boolean" &&
    typeof v.rate_locked === "boolean" &&
    typeof v.applied_tick_rate === "number" &&
    !!throughput &&
    typeof throughput.snapshots_per_s === "number" &&
    typeof throughput.bytes_per_s === "number" &&
    Array.isArray(v.actions)
  );
}

export function useBackpressure(options: {
  enabled: boolean;
  intervalMs: number;
  /** Virtual second the interface is currently displaying. */
  renderedVirtualSecond: number;
  /** Virtual second the core reports it is at. */
  coreVirtualSecond: number;
  /** Whether a run is live; there is nothing to synchronize otherwise. */
  active: boolean;
}): BackpressureClient {
  const { enabled, intervalMs, renderedVirtualSecond, coreVirtualSecond, active } = options;
  const [asb, setAsb] = useState<Backpressure | null>(IDLE);
  const [resetToken, setResetToken] = useState(0);

  // Rolling frame cost, sampled from animation frames the browser is already
  // producing. A starved tab reports long frames even when its lag looks small.
  const frameCost = useRef(0.016);
  const lastPoll = useRef(performance.now());
  // Inputs are read inside the interval, so they must not restart it.
  const lag = useRef(0);
  lag.current = Math.max(0, coreVirtualSecond - renderedVirtualSecond);

  useEffect(() => {
    let raf = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = (now - previous) / 1000;
      previous = now;
      // Exponential mean: responsive to a sustained stall, unmoved by one
      // slow frame caused by something outside the app.
      if (delta > 0 && delta < 5) frameCost.current = frameCost.current * 0.85 + delta * 0.15;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // A soft restart is requested once per default-state action, not on every
  // poll that happens to still be reporting it.
  const lastAction = useRef<number>(-1);

  useEffect(() => {
    if (!enabled || !active) {
      setAsb(IDLE);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const report = async () => {
      const now = performance.now();
      const sincePoll = (now - lastPoll.current) / 1000;
      try {
        const next = await api.backpressure(lag.current, frameCost.current, sincePoll);
        lastPoll.current = performance.now();
        if (cancelled) return;
        if (!isBackpressure(next)) return;
        setAsb(next);
        const forced = [...next.actions].reverse().find((a) => a.action === "default_state");
        if (forced && forced.at_s !== lastAction.current) {
          lastAction.current = forced.at_s;
          setResetToken((t) => t + 1);
        }
      } catch {
        // The core being unreachable is itself desynchronization; the next
        // successful report carries a large since_poll_s and says so.
        if (!cancelled) setAsb((prev) => prev);
      } finally {
        if (!cancelled) timer = setTimeout(report, intervalMs);
      }
    };

    timer = setTimeout(report, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, active, intervalMs]);

  return { asb, resetToken };
}

/** Human phrasing for a backpressure state, for the status strip. */
export function describeAsb(asb: Backpressure | null): {
  label: string;
  tone: "ok" | "warn" | "bad";
  detail: string;
} {
  if (!asb) return { label: "", tone: "ok", detail: "" };
  switch (asb.state) {
    case "RESTRICTED":
      return {
        label: "ASB · Restricted",
        tone: "warn",
        detail:
          "The interface fell behind the simulation. Speed is locked at 1× and reduced motion is on until synchronization holds.",
      };
    case "ASYNC":
      return {
        label: "ASB · Async",
        tone: "bad",
        detail:
          "The interface could not resynchronize, so it has been suspended. The simulation is still running and still streaming.",
      };
    default:
      return asb.rate_capped
        ? {
            label: "ASB · Throttling",
            tone: "warn",
            detail: `Rate held at ${asb.applied_tick_rate}× while the interface catches up.`,
          }
        : { label: "ASB · Normal", tone: "ok", detail: "Interface and simulation are in step." };
  }
}

/** Format a byte rate for the throughput readout. */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  const mb = bytesPerSecond / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MiB/s`;
  return `${(bytesPerSecond / 1024).toFixed(0)} KiB/s`;
}

/** Stable helper so the shell and its tests agree on what "suspended" means. */
export function isSuspended(asb: Backpressure | null): boolean {
  return asb?.gui_suspended === true;
}
