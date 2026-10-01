// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * Simulation time presentation.
 *
 * Every simulation timestamp the interface shows passes through this module.
 * State always holds canonical virtual seconds (0 to 86400); the 12 hour or
 * 24 hour choice is applied only here, at the moment of display, so a single
 * preference change re-renders every clock, event row and notification
 * consistently.
 */

export const DAY_SECONDS = 86400;

export interface TimeFormatOptions {
  /** Include seconds. Defaults to true. */
  seconds?: boolean;
}

/** Split canonical virtual seconds into clock fields. 86400 is end of day. */
function fields(total: number) {
  const s = Math.max(0, Math.min(DAY_SECONDS, Math.floor(Number.isFinite(total) ? total : 0)));
  return {
    end: s >= DAY_SECONDS,
    h: Math.floor(s / 3600) % 24,
    m: Math.floor((s % 3600) / 60),
    s: s % 60,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Format virtual seconds for display.
 *
 * 24 hour: "08:42:17". 12 hour: "8:42:17 AM". The end of the day is shown as
 * "24:00:00" in 24 hour mode and "12:00:00 AM" in 12 hour mode, matching how
 * each convention writes midnight at the close of a day.
 */
export function formatSimulationTime(
  seconds: number,
  hour12: boolean,
  options: TimeFormatOptions = {},
): string {
  const withSeconds = options.seconds ?? true;
  const t = fields(seconds);
  if (!hour12) {
    const h = t.end ? 24 : t.h;
    return withSeconds ? `${pad(h)}:${pad(t.m)}:${pad(t.s)}` : `${pad(h)}:${pad(t.m)}`;
  }
  const hour = t.h % 12 === 0 ? 12 : t.h % 12;
  const suffix = t.end || t.h < 12 ? "AM" : "PM";
  return withSeconds
    ? `${hour}:${pad(t.m)}:${pad(t.s)} ${suffix}`
    : `${hour}:${pad(t.m)} ${suffix}`;
}

/** Parse "HH:MM" or "HH:MM:SS" into virtual seconds, or null. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3] ?? 0);
  if (h > 24 || min > 59 || s > 59 || (h === 24 && (min || s))) return null;
  return h * 3600 + min * 60 + s;
}

/**
 * Timestamp of an event record. Prefers the canonical virtual second and
 * falls back to the core's preformatted "HH:MM:SS" string.
 */
export function formatEventTime(
  item: { virtual_day_s?: number; virtual_s?: number; simulated_current_time?: string },
  hour12: boolean,
  options: TimeFormatOptions = {},
): string {
  const canonical = item.virtual_day_s ?? item.virtual_s;
  if (typeof canonical === "number" && Number.isFinite(canonical))
    return formatSimulationTime(canonical, hour12, options);
  const parsed = item.simulated_current_time ? parseClock(item.simulated_current_time) : null;
  return parsed === null ? "" : formatSimulationTime(parsed, hour12, options);
}

/**
 * Rewrite clock times embedded in free text, such as "scheduled at 14:30:00",
 * so messages composed by the core follow the same preference as every other
 * timestamp. Text that is not a valid clock time is left alone.
 */
export function localizeTimes(text: string, hour12: boolean): string {
  if (!hour12) return text;
  return text.replace(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g, (match, _h, _m, sec) => {
    const value = parseClock(match);
    if (value === null) return match;
    return formatSimulationTime(value, true, { seconds: sec !== undefined });
  });
}

/** Human duration: "45 s", "12 min", "2 h 05 min". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (m === 60) return `${h + 1} h 00 min`;
  return `${h} h ${pad(m)} min`;
}

/** Wall-clock duration from milliseconds, for runtime statistics. */
export function formatWallDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h} h ${pad(m)} min ${pad(r)} s`;
  if (m) return `${m} min ${pad(r)} s`;
  return `${r} s`;
}
