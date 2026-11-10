// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * How fast the link to the simulation server is, measured only from what the interface downloads anyway: the browser's
 * Resource Timing entries for its own API responses. It sends nothing of its own, so it costs nothing and can't add
 * load. Small responses are skipped, since their time is mostly waiting rather than transfer.
 *
 * `linkEstimate()` is null until something large enough has arrived, and every caller must work without it.
 */

export interface LinkSample {
  /** Bytes on the wire. */
  bytes: number;
  /** Milliseconds from the first byte to the last. */
  transferMs: number;
  /** Milliseconds from the request to the first byte. */
  waitMs: number;
}

export interface LinkEstimate {
  bytesPerSecond: number;
  latencyMs: number;
  samples: number;
}

const SMALLEST = 16 * 1024;
/** How much each new sample counts, against what came before. */
const WEIGHT = 0.3;

/** Folds samples into an estimate, newest weighted most. Pure, so it can be checked. */
export function foldLink(previous: LinkEstimate | null, sample: LinkSample): LinkEstimate | null {
  if (sample.bytes < SMALLEST || sample.transferMs <= 0) return previous;
  const rate = (sample.bytes * 1000) / Math.max(1, sample.transferMs);
  if (!previous) return { bytesPerSecond: rate, latencyMs: Math.max(0, sample.waitMs), samples: 1 };
  return {
    bytesPerSecond: previous.bytesPerSecond + (rate - previous.bytesPerSecond) * WEIGHT,
    latencyMs: previous.latencyMs + (Math.max(0, sample.waitMs) - previous.latencyMs) * WEIGHT,
    samples: previous.samples + 1,
  };
}

let current: LinkEstimate | null = null;
let largest = 0;
let watching = false;

function watch() {
  if (watching || typeof PerformanceObserver === "undefined") return;
  watching = true;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        if (!entry.name.includes("/api/") || !entry.transferSize) continue;
        largest = Math.max(largest, entry.transferSize);
        current = foldLink(current, { bytes: entry.transferSize, transferMs: entry.responseEnd - entry.responseStart, waitMs: entry.responseStart - entry.requestStart });
      }
    }).observe({ type: "resource", buffered: true });
  } catch {
    /* Without Resource Timing there is simply no estimate. */
  }
}

export function linkEstimate(): LinkEstimate | null {
  watch();
  return current;
}

/**
 * Roughly how many seconds the largest response seen so far (the map, in practice) would take again, or null without
 * a measurement. Rounded up to whole seconds, since it is an estimate.
 */
export function reloadSeconds(): number | null {
  const estimate = linkEstimate();
  if (!estimate || !largest) return null;
  return Math.max(1, Math.ceil(largest / estimate.bytesPerSecond + estimate.latencyMs / 1000));
}
