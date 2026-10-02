// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import type {
  Envelope,
  Status,
  Topology,
  Snapshot,
  News,
  EventPage,
  Congestion,
  Backpressure,
  WorldStatus,
  ComputeInfo,
  SeedMetadata,
  SeedLocation,
  EnvironmentInfo,
  DrainageView,
  WindView,
} from "./types";
import type { FieldRaster } from "./fields";

const base =
  (import.meta.env.VITE_DSTNS_API_URL as string | undefined)?.replace(
    /\/$/,
    "",
  ) ?? "";
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, {
      ...init,
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new Error("Simulator unavailable. Waiting to reconnect…");
  }
  let result;
  try {
    result = await response.json();
  } catch {
    // A proxy or the server's own 404 may answer an error without JSON; the
    // status says more about that than the body does.
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    throw new Error("The simulator returned an unreadable response.");
  }
  if (!response.ok)
    throw new Error(
      result?.error?.message ?? `Request failed (${response.status})`,
    );
  if (
    path.includes("/view/") ||
    path.endsWith("/playback/status") ||
    path.startsWith("/api/v1/news")
  ) {
    if (
      !result ||
      typeof result.run_id !== "string" ||
      !result.clock ||
      !result.data
    )
      throw new Error("Incomplete simulation state received.");
  }
  return result as T;
}
export type PlaybackGuard = { expected_run_id?: string; expected_playback_revision?: number; require_asb_normal?: boolean };
export const api = {
  systemInfo: () => request<{version?: string; build?: {compiler?: string; cpp_standard?: number}; sumo?: {available?: boolean; version?: string};
    compute?: Pick<ComputeInfo, "active_backend" | "requested_backend" | "device" | "fallback_reason">}>("/api/v1/system/info"),
  compute: () => request<{ data: ComputeInfo }>("/api/v1/system/compute"),
  status: () => request<Envelope<Status>>("/api/v1/playback/status"),
  topology: () => request<Envelope<Topology>>("/api/v1/view/topology"),
  snapshot: () => request<Envelope<Snapshot>>("/api/v1/view/snapshot"),
  news: (since = 0) =>
    request<Envelope<{ items: News[] }>>(
      `/api/v1/news?since_news_id=${since}&limit=100`,
    ),
  events: (view = "future", category = "all", offset = 0) =>
    request<Envelope<EventPage>>(
      `/api/v1/view/event-queue?view=${encodeURIComponent(view)}&category=${encodeURIComponent(category)}&offset=${offset}&limit=30`,
    ),
  congestion: () => request<Envelope<Congestion>>("/api/v1/view/congestion"),
  pause: (guard: PlaybackGuard = {}) =>
    request<{ changed: boolean; playback_revision: number; run_id: string }>("/api/v1/playback/pause", { method: "POST", body: JSON.stringify(guard) }),
  play: (guard: PlaybackGuard = {}) => request("/api/v1/playback/play", { method: "POST", body: JSON.stringify(guard) }),
  tick: (tick_rate: number) =>
    request("/api/v1/control/tick-rate", {
      method: "PUT",
      body: JSON.stringify({ tick_rate }),
    }),
  // target_time is virtual seconds into the day, or "HH:MM:SS".
  seek: (target_time: number | string, play = false) =>
    request("/api/v1/playback/seek", {
      method: "POST",
      body: JSON.stringify({ target_time, play }),
    }),
  // Advance a fixed number of virtual seconds and hold paused.
  step: (seconds: number) =>
    request<{ simulated_seconds: number; stepped_seconds: number; lifecycle: string }>("/api/v1/playback/step", {
      method: "POST",
      body: JSON.stringify({ seconds }),
    }),
  // Ask the core for a new world, from a fresh seed or a named one. Progress is polled.
  regenerateWorld: (expected_run_id?: string, seed?: string) =>
    request<{ data: WorldStatus }>("/api/v1/world/regenerate", {
      method: "POST",
      body: JSON.stringify({ ...(expected_run_id ? { expected_run_id } : {}), ...(seed ? { seed } : {}) }),
    }),
  /** Terrain provenance and the environment's modules and fields. */
  environment: () => request<Envelope<EnvironmentInfo>>("/api/v1/view/environment"),
  /** One environmental field, reduced so neither side exceeds max_side cells. */
  field: (name: string, max_side = 192) =>
    request<Envelope<FieldRaster>>(`/api/v1/view/fields/${encodeURIComponent(name)}?max_side=${max_side}`),
  /** The synthetic drainage network and its flows. */
  drainage: () => request<Envelope<DrainageView>>("/api/v1/view/drainage"),
  /** The near-surface wind vectors on the atmosphere's lattice. */
  wind: () => request<Envelope<WindView>>("/api/v1/view/wind"),
  /** The location catalogue a seed draws from. */
  seedLocations: () => request<{ data: { items: SeedLocation[]; count: number } }>("/api/v1/seeds/locations"),
  /** What a seed resolves to: location, month and day type. */
  describeSeed: (seed: string) =>
    request<{ data: SeedMetadata }>(`/api/v1/seeds/describe?seed=${encodeURIComponent(seed)}`),
  /** A fresh seed whose own location, month and day type are those asked for ("auto": any). */
  generateSeed: (constraints: { location: string; month: string; day_type: string }) =>
    request<{ data: SeedMetadata }>("/api/v1/seeds/generate", { method: "POST", body: JSON.stringify(constraints) }),
  worldStatus: () => request<{ data: WorldStatus }>("/api/v1/world/status"),
  /** Every news item recorded for the run, paged in core-sized requests. */
  allNews: async (runId: string, max = 20000): Promise<News[]> => {
    const out: News[] = [];
    let since = 0;
    while (out.length < max) {
      const page = await request<Envelope<{ items: News[] }>>(
        `/api/v1/news?since_news_id=${since}&limit=500`,
      );
      if (page.run_id !== runId) throw new Error("The simulation changed while its history was being read.");
      const items = page.data.items.filter((n) => n.news_id > since);
      if (!items.length) break;
      out.push(...items);
      since = Math.max(...items.map((n) => n.news_id));
      if (page.data.items.length < 500) break;
    }
    return out.sort((a, b) => a.news_id - b.news_id);
  },
  reset: () =>
    request("/api/v1/playback/reset", { method: "POST", body: "{}" }),
  terminate: () =>
    request("/api/v1/system/terminate", { method: "POST", body: "{}" }),
  // ASB: report how far behind this observer is and receive the resulting
  // backpressure state in the same round trip.
  backpressure: (
    virtual_lag_s: number,
    client_frame_s: number,
    since_poll_s: number,
  ) =>
    request<Backpressure>("/api/v1/system/backpressure", {
      method: "POST",
      body: JSON.stringify({ virtual_lag_s, client_frame_s, since_poll_s }),
    }),
};
