// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef } from "react";

/**
 * Before something that takes the whole screen (a dialog that asks, a new world, the end of a session, a report being
 * made), whatever is open is put away first, and only once it has gone does the next thing begin. Every open surface
 * listens, closes itself, and says how long its leaving takes and, if it can, how to come back. `settle` resolves once
 * the slowest has left, with a function that brings back what it put away, for when the moment is over.
 */

const EVENT = "dstns:settle";
type Detail = { wait: (ms: number, reopen?: () => void) => void };

export function settle(): Promise<() => void> {
  let longest = 0;
  const reopen: (() => void)[] = [];
  document.dispatchEvent(
    new CustomEvent<Detail>(EVENT, {
      detail: {
        wait: (ms, back) => {
          longest = Math.max(longest, ms);
          if (back) reopen.push(back);
        },
      },
    }),
  );
  return new Promise((resolve) => setTimeout(() => resolve(() => reopen.forEach((back) => back())), longest ? longest + 40 : 0));
}

/**
 * While `open`, this surface closes when the interface is asked to settle, and says it takes `ms` to leave. With
 * `reopen`, it can be brought back afterwards.
 */
export function useSettle(open: boolean, close: () => void, ms = 700, reopen?: () => void): void {
  const back = useRef(reopen);
  back.current = reopen;
  useEffect(() => {
    if (!open) return;
    const on = (event: Event) => {
      const still = document.documentElement.classList.contains("reduce-motion");
      (event as CustomEvent<Detail>).detail.wait(still ? 0 : ms, back.current ? () => back.current?.() : undefined);
      close();
    };
    document.addEventListener(EVENT, on);
    return () => document.removeEventListener(EVENT, on);
  }, [open, close, ms]);
}
