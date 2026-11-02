// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useSyncExternalStore } from "react";

/**
 * What the operator turned on and off when the server started, and how the observer should present itself.
 * Read once: it can't change while the server runs. Until it arrives, everything is as it is out of the box.
 */
export interface Features {
  applications: boolean;
  legacy_api: boolean;
  presentation: {
    webfabric: boolean;
    force_animate: boolean;
    fast_boot: boolean;
    demo: boolean;
    music: boolean;
    fullscreen: boolean;
    music_volume: number;
  };
}

export const DEFAULT_FEATURES: Features = {
  applications: true,
  legacy_api: true,
  presentation: { webfabric: true, force_animate: true, fast_boot: false, demo: false, music: false, fullscreen: false, music_volume: 0.6 },
};

let current = DEFAULT_FEATURES;
let asked = false;
const listeners = new Set<() => void>();

function ask() {
  if (asked) return;
  asked = true;
  fetch("/api/v1/system/features")
    .then((response) => (response.ok ? response.json() : null))
    .then((body) => {
      const data = body?.data;
      if (!data || typeof data !== "object") return;
      current = { ...DEFAULT_FEATURES, ...data, presentation: { ...DEFAULT_FEATURES.presentation, ...(data.presentation ?? {}) } };
      for (const listener of listeners) listener();
    })
    // An older server says nothing, and the defaults stand.
    .catch(() => undefined);
}

export function useFeatures(): Features {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      ask();
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
