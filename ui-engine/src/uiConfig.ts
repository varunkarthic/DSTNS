import { defaultLayers, defaultPlaceVisibility } from "./types";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_SEVERITIES } from "./notificationModel";
import type { Layers, PlaceVisibility } from "./types";

// ---------------------------------------------------------------------------
// Observer configuration
//
// Three layers, innermost first:
//
//   1. BUILT_IN        - compiled into the bundle, so the interface always has
//                        a complete, valid configuration even with no server.
//   2. config/ui-config.json - the operator's defaults, served by the core.
//   3. localStorage    - this viewer's own choices, which win.
//
// Every value is presentation only. Nothing here is sent to the simulation or
// changes what it computes.
// ---------------------------------------------------------------------------

const NOTIFICATION_CATEGORY_IDS = NOTIFICATION_CATEGORIES.map((c) => c.id as string);
const NOTIFICATION_SEVERITY_IDS = NOTIFICATION_SEVERITIES.map((c) => c.id as string);
/** Intervals offered for Back, Forward and Step, in virtual seconds. */
export const SKIP_OPTIONS = [60, 300, 900, 3600] as const;
export const STEP_OPTIONS = [1, 10, 60, 300] as const;

export type ReduceMotionSetting = "auto" | "on" | "off";
export type AutoFocusMode = "disable" | "enable" | "enable-force";
export type AutoFocusStrategy = "round-robin" | "latest";

export interface UiConfig {
  layers: Layers;
  /** Which place kinds are drawn. Absent means shown. */
  places: PlaceVisibility;
  reduce_motion: ReduceMotionSetting;
  auto_focus: {
    mode: AutoFocusMode;
    strategy: AutoFocusStrategy;
    dwell_seconds: number;
    zoom: number;
  };
  notifications: {
    enabled: boolean;
    dnd: boolean;
    /** Categories silenced while Do Not Disturb is on. */
    dnd_categories: string[];
    /** Severities silenced while Do Not Disturb is on. */
    dnd_severities: string[];
    max_visible: number;
    dwell_ms: number;
  };
  playback: {
    /** Back and Forward jump by this many virtual seconds. */
    skip_seconds: number;
    /** Step advances by this many virtual seconds and holds. */
    step_seconds: number;
  };
  tutorial: { enabled: boolean; show_on_startup: boolean };
  clock: { hour12: boolean };
  asb: { enabled: boolean; report_interval_ms: number };
}

export const BUILT_IN: UiConfig = {
  layers: { ...defaultLayers },
  places: { ...defaultPlaceVisibility },
  reduce_motion: "auto",
  auto_focus: {
    mode: "enable-force",
    strategy: "round-robin",
    dwell_seconds: 9,
    zoom: 1.6,
  },
  notifications: {
    enabled: true,
    dnd: false,
    dnd_categories: [...NOTIFICATION_CATEGORY_IDS],
    dnd_severities: [],
    max_visible: 3,
    dwell_ms: 7000,
  },
  playback: { skip_seconds: 900, step_seconds: 60 },
  tutorial: { enabled: true, show_on_startup: false },
  clock: { hour12: false },
  asb: { enabled: true, report_interval_ms: 1000 },
};

const REDUCE_MOTION: ReduceMotionSetting[] = ["auto", "on", "off"];
const MODES: AutoFocusMode[] = ["disable", "enable", "enable-force"];
const STRATEGIES: AutoFocusStrategy[] = ["round-robin", "latest"];

/** Accept a value only if it is one of the permitted literals. */
function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && (allowed as string[]).includes(value)
    ? (value as T)
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Keep only permitted, unique values, in the permitted order. */
function subset(value: unknown, allowed: string[], fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return allowed.filter((a) => value.includes(a));
}

function choice(value: unknown, allowed: readonly number[], fallback: number): number {
  return typeof value === "number" && allowed.includes(value) ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/**
 * Merge an untrusted object over a known-good configuration.
 *
 * Unknown keys are ignored and every value is range-checked, so a hand-edited
 * or partially-written ui-config.json degrades to the defaults for the fields
 * it got wrong rather than breaking the interface.
 */
export function mergeConfig(base: UiConfig, patch: unknown): UiConfig {
  if (!patch || typeof patch !== "object") return base;
  const p = patch as Record<string, unknown>;
  const layersPatch = (p.layers ?? {}) as Record<string, unknown>;
  const focus = (p.auto_focus ?? {}) as Record<string, unknown>;
  const notes = (p.notifications ?? {}) as Record<string, unknown>;
  const clock = (p.clock ?? {}) as Record<string, unknown>;
  const tutorial = (p.tutorial ?? {}) as Record<string, unknown>;
  const asb = (p.asb ?? {}) as Record<string, unknown>;
  const playback = (p.playback ?? {}) as Record<string, unknown>;

  const layers = { ...base.layers };
  for (const key of Object.keys(base.layers) as (keyof Layers)[])
    layers[key] = bool(layersPatch[key], base.layers[key]);

  // Places are open-ended: any key the file names is taken as a kind, because
  // the taxonomy is whatever the loaded district turned out to contain.
  const places = { ...base.places };
  const placesPatch = (p.places ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(placesPatch))
    if (typeof placesPatch[key] === "boolean") places[key] = placesPatch[key] as boolean;

  return {
    layers,
    places,
    reduce_motion: oneOf(p.reduce_motion, REDUCE_MOTION, base.reduce_motion),
    auto_focus: {
      mode: oneOf(focus.mode, MODES, base.auto_focus.mode),
      strategy: oneOf(focus.strategy, STRATEGIES, base.auto_focus.strategy),
      dwell_seconds: num(focus.dwell_seconds, base.auto_focus.dwell_seconds, 2, 120),
      zoom: num(focus.zoom, base.auto_focus.zoom, 0.2, 8),
    },
    notifications: {
      enabled: bool(notes.enabled, base.notifications.enabled),
      dnd: bool(notes.dnd, base.notifications.dnd),
      dnd_categories: subset(notes.dnd_categories, NOTIFICATION_CATEGORY_IDS, base.notifications.dnd_categories),
      dnd_severities: subset(notes.dnd_severities, NOTIFICATION_SEVERITY_IDS, base.notifications.dnd_severities),
      max_visible: Math.round(num(notes.max_visible, base.notifications.max_visible, 1, 8)),
      dwell_ms: num(notes.dwell_ms, base.notifications.dwell_ms, 1000, 60000),
    },
    tutorial: {
      enabled: bool(tutorial.enabled, base.tutorial.enabled),
      show_on_startup: bool(tutorial.show_on_startup, base.tutorial.show_on_startup),
    },
    playback: {
      skip_seconds: choice(playback.skip_seconds, SKIP_OPTIONS, base.playback.skip_seconds),
      step_seconds: choice(playback.step_seconds, STEP_OPTIONS, base.playback.step_seconds),
    },
    clock: { hour12: bool(clock.hour12, base.clock.hour12) },
    asb: {
      enabled: bool(asb.enabled, base.asb.enabled),
      report_interval_ms: num(asb.report_interval_ms, base.asb.report_interval_ms, 250, 10000),
    },
  };
}

const STORE_KEY = "dstns.ui-config.v1";

/** This viewer's overrides, which sit above the operator's defaults. */
export function readOverrides(): unknown {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Store only what this viewer actually changed, relative to the configuration
 * they were given. Storing the whole object would silently pin every field, so
 * a later edit to config/ui-config.json would never reach anyone who had once
 * touched an unrelated toggle.
 */
export function diffConfig(base: UiConfig, next: UiConfig): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const layers: Record<string, boolean> = {};
  for (const key of Object.keys(base.layers) as (keyof Layers)[])
    if (base.layers[key] !== next.layers[key]) layers[key] = next.layers[key];
  if (Object.keys(layers).length) patch.layers = layers;

  const places: Record<string, boolean> = {};
  for (const key of new Set([...Object.keys(base.places), ...Object.keys(next.places)]))
    if ((base.places[key] !== false) !== (next.places[key] !== false)) places[key] = next.places[key] !== false;
  if (Object.keys(places).length) patch.places = places;

  if (base.reduce_motion !== next.reduce_motion) patch.reduce_motion = next.reduce_motion;

  const section = <T extends object>(a: T, b: T) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(a) as (keyof T)[]) {
      const x = a[key];
      const y = b[key];
      // Lists compare by content: a fresh array with the same members is no change.
      const same = Array.isArray(x) && Array.isArray(y) ? JSON.stringify(x) === JSON.stringify(y) : x === y;
      if (!same) out[key as string] = y;
    }
    return out;
  };
  for (const key of ["auto_focus", "notifications", "playback", "clock", "asb", "tutorial"] as const) {
    const changed = section(base[key], next[key]);
    if (Object.keys(changed).length) patch[key] = changed;
  }
  return patch;
}

export function writeOverrides(config: UiConfig, base: UiConfig = BUILT_IN): void {
  try {
    const patch = diffConfig(base, config);
    if (Object.keys(patch).length === 0) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify(patch));
  } catch {
    /* Storage may be disabled; the session simply does not persist. */
  }
}

export function clearOverrides(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* Storage may be disabled. */
  }
}

/**
 * Resolve the effective configuration: built-in, then the operator's file,
 * then this viewer's overrides. A server that is down or serving nonsense
 * leaves the interface on the previous layer rather than failing to start.
 */
export async function loadConfig(
  fetchImpl: typeof fetch = fetch,
): Promise<{ config: UiConfig; operator: UiConfig; source: "built-in" | "server" | "viewer" }> {
  let config = BUILT_IN;
  let source: "built-in" | "server" | "viewer" = "built-in";
  try {
    const response = await fetchImpl("/api/v1/system/ui-config");
    if (response.ok) {
      const body = await response.json();
      if (body?.data && Object.keys(body.data).length) {
        config = mergeConfig(config, body.data);
        source = "server";
      }
    }
  } catch {
    /* Offline or no core: the built-in defaults are already complete. */
  }
  const operator = config;
  const overrides = readOverrides();
  if (overrides) {
    config = mergeConfig(config, overrides);
    source = "viewer";
  }
  return { config, operator, source };
}

/** Whether reduced motion should be on, given the setting and the OS preference. */
export function resolveReduceMotion(setting: ReduceMotionSetting): boolean {
  if (setting === "on") return true;
  if (setting === "off") return false;
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
