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
    /** The next city is fetched while a world runs, so that the next one is ready in seconds. */
    dynamic_fastboot: boolean;
    /** The film plans its scenes from the server's estimate of how long the world will take. */
    dynamic_particles: boolean;
    demo: boolean;
    /** Demo Mode's scenes, by id, in the order to play them. Absent: all, in the film's order. */
    demo_scenes?: string[];
    music: boolean;
    fullscreen: boolean;
    music_volume: number;
    /** The server plays a file of the operator's own, rather than the written score. */
    music_track?: boolean;
    /** Frames a second for the map's continuous animation: 60, 30, or 0 to let the map decide by how it's coping. */
    map_fps: number;
    /** The most canvas pixels per CSS pixel the map draws at. */
    render_scale: number;
    /** How many particles the film has. */
    film_particles: number;
    /** A new world keeps the last one's notification history (the launcher's worlds.keep_history). Absent: it doesn't. */
    keep_history?: boolean;
  };
}

export const DEFAULT_FEATURES: Features = {
  applications: true,
  legacy_api: true,
  presentation: { webfabric: true, force_animate: true, fast_boot: false, dynamic_fastboot: true, dynamic_particles: true, demo: false, music: false, fullscreen: false, music_volume: 0.6, map_fps: 0, render_scale: 2, film_particles: 32000 },
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

/** The features as they stand, for code that reads them each frame rather than rendering with them. */
export function currentFeatures(): Features {
  ask();
  return current;
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
