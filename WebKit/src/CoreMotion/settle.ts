// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect } from "react";

/**
 * Before something that takes the whole screen (a dialog that asks, a new world, the end of a session), whatever is
 * open is put away first, and only once it has gone does the next thing begin. Every open surface listens, closes
 * itself, and says how long its leaving takes; `settle` resolves once the slowest has left.
 */

const EVENT = "dstns:settle";
type Detail = { wait: (ms: number) => void };

export function settle(): Promise<void> {
  let longest = 0;
  document.dispatchEvent(new CustomEvent<Detail>(EVENT, { detail: { wait: (ms) => (longest = Math.max(longest, ms)) } }));
  return new Promise((resolve) => setTimeout(resolve, longest ? longest + 40 : 0));
}

/** While `open`, this surface closes when the interface is asked to settle, and says it takes `ms` to leave. */
export function useSettle(open: boolean, close: () => void, ms = 700): void {
  useEffect(() => {
    if (!open) return;
    const on = (event: Event) => {
      (event as CustomEvent<Detail>).detail.wait(document.documentElement.classList.contains("reduce-motion") ? 0 : ms);
      close();
    };
    document.addEventListener(EVENT, on);
    return () => document.removeEventListener(EVENT, on);
  }, [open, close, ms]);
}
