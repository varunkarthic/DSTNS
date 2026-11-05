// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef, useState } from "react";
import type { RuntimeStatus } from "./telemetryRecorder";

// How long a reading has to hold before the status says so. Recovery has to be believed
// for longer than trouble, or a run near the threshold flips back and forth.
export const DEGRADE_AFTER_MS = 4000;
export const RECOVER_AFTER_MS = 10000;

/** How long `next` must hold before replacing `shown`. Losing the server is shown at once. */
export function holdFor(shown: RuntimeStatus, next: RuntimeStatus): number {
  // Coming up from nothing is not a recovery to be doubted.
  // Restricted is the server's own decision, so it is believed at once, and so is its end.
  if (next === shown || next === "offline" || shown === "offline" || next === "restricted" || shown === "restricted") return 0;
  return next === "degraded" ? DEGRADE_AFTER_MS : RECOVER_AFTER_MS;
}

export function useSteadyStatus(reading: RuntimeStatus): RuntimeStatus {
  const [shown, setShown] = useState(reading);
  const latest = useRef(reading);
  latest.current = reading;
  useEffect(() => {
    const wait = holdFor(shown, reading);
    if (reading === shown) return;
    if (!wait) {
      // Just arrived: a first reading of trouble has to hold like any other before it is believed.
      setShown(shown === "offline" && reading === "degraded" ? "online" : reading);
      return;
    }
    const timer = setTimeout(() => setShown(latest.current), wait);
    return () => clearTimeout(timer);
  }, [reading, shown]);
  return shown;
}
