// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { formatBytes } from "../core/units";
import { useEffect, useRef, useState } from "react";
import { api } from "../core/api";
import type { Backpressure } from "../core/types";

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
  /** Just back from another tab, and catching up. That is expected, and is said so. */
  catchingUp: boolean;
}

/** How long a page gets to catch up, after being away or after a heavy moment of its own. */
const GRACE_MS = 6000;
let graceUntil = 0;

/** Something normal is about to look like falling behind, such as making a report. */
export function excuseBackpressure(ms = GRACE_MS): void {
  graceUntil = Math.max(graceUntil, performance.now() + ms);
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
  const finite = (key: string) => typeof v[key] === "number" && Number.isFinite(v[key]);
  return (
    (v.state === "NORMAL" || v.state === "RESTRICTED" || v.state === "ASYNC") &&
    ["score", "applied_tick_rate", "requested_tick_rate", "rate_cap", "stressed_for_s", "state_for_s"].every(finite) &&
    ["synced", "gui_suspended", "rate_locked", "motion_locked", "rate_capped"].every(key => typeof v[key] === "boolean") &&
    !!throughput && Number.isFinite(throughput.snapshots_per_s) && Number.isFinite(throughput.bytes_per_s) &&
    Array.isArray(v.actions) && v.actions.every(a => a && typeof a.action === "string" && Number.isFinite(a.at_s))
  );
}

export function useBackpressure(options: {
  enabled: boolean;
  intervalMs: number;
  /** Virtual second the interface is currently displaying. */
  renderedVirtualSecond: number;
  /** Virtual second the core reports it is at. */
  coreVirtualSecond: number;
  /**
   * When the observer last received fresh simulation data, as a
   * `performance.now()` timestamp. This is the staleness signal: an interface
   * whose data has stopped arriving is desynchronized by definition, which is
   * exactly the case ASB exists to catch.
   */
  lastDataAt: number;
  /**
   * Whether there is a run to synchronize with. Deliberately *not* "is the
   * data currently valid": reporting must continue while data is stale, or
   * backpressure would switch itself off in the one situation it is for.
   */
  active: boolean;
  runId?: string;
}): BackpressureClient {
  const { enabled, intervalMs, renderedVirtualSecond, coreVirtualSecond, lastDataAt, active, runId } =
    options;
  const [asb, setAsb] = useState<Backpressure | null>(IDLE);
  const [resetToken, setResetToken] = useState(0);
  const [catchingUp, setCatchingUp] = useState(false);

  // Rolling frame cost, sampled from animation frames the browser is already
  // producing. A starved tab reports long frames even when its lag looks small.
  const frameCost = useRef(0.016);
  // Inputs are read inside the interval, so they must not restart it.
  const lag = useRef(0);
  lag.current = Math.max(0, coreVirtualSecond - renderedVirtualSecond);
  const freshAt = useRef(lastDataAt);
  freshAt.current = lastDataAt;

  useEffect(() => {
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A frame is sampled four times a second. Asking for every frame would itself keep the
    // main thread producing frames, which is the thing this is here to measure.
    const sample = () => {
      const asked = performance.now();
      raf = requestAnimationFrame((first) => {
        raf = requestAnimationFrame((second) => {
          const delta = Math.max(second - first, first - asked) / 1000;
          // Exponential mean: responsive to a sustained stall, unmoved by one
          // slow frame caused by something outside the app.
          if (delta > 0) frameCost.current = frameCost.current * 0.7 + Math.min(delta, 30) * 0.3;
          timer = setTimeout(sample, 250);
        });
      });
    };
    sample();
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, []);

  // A hidden page draws nothing and has its timers throttled, which looks exactly like a
  // failing one. So it says it is away, reports nothing meanwhile, and on its return has a
  // moment to catch up before it is judged again. The spike on coming back is expected.
  useEffect(() => {
    let awayAt = 0;
    let over: ReturnType<typeof setTimeout> | undefined;
    const seen = () => {
      if (document.hidden) {
        awayAt = performance.now();
        void api.backpressure(0, 0, 0, true).catch(() => undefined);
        return;
      }
      frameCost.current = 0.016;
      excuseBackpressure();
      void api.backpressure(0, 0.016, 0, false).catch(() => undefined);
      // A glance elsewhere needs no explaining; only a real absence does.
      if (awayAt && performance.now() - awayAt > 4000) {
        setCatchingUp(true);
        clearTimeout(over);
        over = setTimeout(() => setCatchingUp(false), GRACE_MS);
      }
      awayAt = 0;
    };
    document.addEventListener("visibilitychange", seen);
    return () => {
      document.removeEventListener("visibilitychange", seen);
      clearTimeout(over);
    };
  }, []);

  // A soft restart is requested once per default-state action, not on every
  // poll that happens to still be reporting it.
  const lastAction = useRef<number>(-1);

  useEffect(() => {
    lastAction.current = -1;
    setAsb(IDLE);
    if (!enabled || !active) {
      setAsb(IDLE);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const report = async () => {
      if (document.hidden) {
        timer = setTimeout(report, intervalMs);
        return;
      }
      // Seconds since fresh simulation data last arrived. Measured against the
      // data feed, not against this reporter's own success: backpressure POSTs
      // can keep succeeding long after snapshots have stopped.
      const sinceData = Math.max(0, (performance.now() - freshAt.current) / 1000);
      try {
        const excused = performance.now() < graceUntil;
        const next = excused ? await api.backpressure(0, 0.016, 0) : await api.backpressure(lag.current, frameCost.current, sinceData);
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
  }, [enabled, active, intervalMs, runId]);

  return { asb, resetToken, catchingUp };
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
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "No data";
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Stable helper so the shell and its tests agree on what "suspended" means. */
export function isSuspended(asb: Backpressure | null): boolean {
  return asb?.gui_suspended === true;
}
