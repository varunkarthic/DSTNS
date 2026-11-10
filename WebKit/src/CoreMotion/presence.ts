// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef, useState } from "react";

/**
 * Keeps a surface mounted for its exit transition. Returns whether to render
 * it and whether it is on its way out.
 */
export function usePresence(visible: boolean, exitMs: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    if (visible) {
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      timer.current = setTimeout(() => {
        setMounted(false);
        setClosing(false);
      }, exitMs);
    }
    return () => clearTimeout(timer.current);
    // `mounted` is read, not tracked: only visibility drives the transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, exitMs]);
  return { mounted, closing };
}
