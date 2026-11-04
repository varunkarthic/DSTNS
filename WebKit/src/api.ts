// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import type { Envelope, Status, Topology, Snapshot, News, EventPage, Congestion, Backpressure, WorldStatus, NewsPage, NarratorStatus } from "./types";
const base =
  (import.meta.env.VITE_DSTNS_API_URL as string | undefined)?.replace(
    /\/$/,
    "",
  ) ?? "";
/** One message from a daemon, as its queue holds it. */
export interface DaemonMessage {
  sequence: number;
  id: string;
  level: "info" | "warning" | "alert" | "emergency";
  queue: string;
  daemon: string;
  title: string;
  text: string;
  data: Record<string, unknown>;
  time_ms: number;
}

/** What the client says when the server does not answer at all, as distinct from answering with an error. */
export const UNREACHABLE = "Simulator unavailable. Waiting to reconnect…";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, {
      ...init,
      signal: AbortSignal.timeout(15000),
      // Says this is the observer: a browser cannot send this for another page without asking first.
      headers: { "Content-Type": "application/json", "X-DSTNS-Host": "observer", ...init?.headers },
    });
  } catch {
    throw new Error(UNREACHABLE);
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
    path.endsWith("/engine/status") ||
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
  systemInfo: () => request<{version?: string; build?: {compiler?: string; cpp_standard?: number}; sumo?: {available?: boolean; version?: string}}>("/api/v1/system/info"),
  status: () => request<Envelope<Status>>("/api/v1/fabric/engine/status"),
  topology: () => request<Envelope<Topology>>("/api/v1/view/topology"),
  // The observer shows three demand causes for a road, and they are most of a snapshot's bytes.
  snapshot: () => request<Envelope<Snapshot>>("/api/v1/view/snapshot?causes=3"),
  /** `realistic` asks for Realistic News narrations; without it the feed is the core's own. */
  news: (since = 0, sinceNarration = 0, realistic = false) =>
    request<Envelope<NewsPage>>(
      `/api/v1/news?since_news_id=${since}&limit=100` +
        (realistic ? `&narration=realistic&since_narration=${sinceNarration}` : ""),
    ),
  narrator: () => request<{ data: NarratorStatus }>("/api/v1/system/narrator"),
  events: (view = "future", category = "all", offset = 0) =>
    request<Envelope<EventPage>>(
      `/api/v1/view/event-queue?view=${encodeURIComponent(view)}&category=${encodeURIComponent(category)}&offset=${offset}&limit=30`,
    ),
  congestion: () => request<Envelope<Congestion>>("/api/v1/view/congestion"),
  pause: (guard: PlaybackGuard = {}) =>
    request<{ changed: boolean; playback_revision: number; run_id: string }>("/api/v1/fabric/engine/pause", { method: "POST", body: JSON.stringify(guard) }),
  play: (guard: PlaybackGuard = {}) => request("/api/v1/fabric/engine/play", { method: "POST", body: JSON.stringify(guard) }),
  tick: (tick_rate: number) =>
    request("/api/v1/fabric/engine/tick-rate", {
      method: "PUT",
      body: JSON.stringify({ tick_rate }),
    }),
  // target_time is virtual seconds into the day, or "HH:MM:SS".
  seek: (target_time: number | string, play = false) =>
    request("/api/v1/fabric/engine/seek", {
      method: "POST",
      body: JSON.stringify({ target_time, play }),
    }),
  // Advance a fixed number of virtual seconds and hold paused.
  step: (seconds: number) =>
    request<{ simulated_seconds: number; stepped_seconds: number; lifecycle: string }>("/api/v1/fabric/engine/step", {
      method: "POST",
      body: JSON.stringify({ seconds }),
    }),
  // Ask the core for a new world from a fresh seed. Progress is polled.
  // With stage, it is prepared without replacing this world, until commitWorld or discardWorld.
  regenerateWorld: (expected_run_id?: string, stage = false) =>
    request<{ data: WorldStatus }>("/api/v1/world/regenerate", {
      method: "POST",
      body: JSON.stringify({ ...(expected_run_id ? { expected_run_id } : {}), ...(stage ? { stage } : {}) }),
    }),
  commitWorld: () => request<{ data: WorldStatus }>("/api/v1/world/regenerate/commit", { method: "POST", body: "{}" }),
  discardWorld: () => request<{ data: WorldStatus }>("/api/v1/world/regenerate/discard", { method: "POST", body: "{}" }),
  worldStatus: () => request<{ data: WorldStatus }>("/api/v1/world/status"),
  observer: (waiting: boolean) =>
    request<unknown>("/api/v1/system/observer", { method: "POST", body: JSON.stringify({ waiting }) }),
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
    request("/api/v1/fabric/engine/reset", { method: "POST", body: "{}" }),
  terminate: () =>
    request("/api/v1/system/terminate", { method: "POST", body: "{}" }),
  // The daemons: whether they run, and their two queues, after a sequence.
  daemons: () => request<{ data: { enabled: boolean; queues: Record<string, { latest_sequence: number }> } }>("/api/v1/daemon"),
  daemonQueue: (queue: "emergency" | "notification", since: number) =>
    request<{ data: { items: DaemonMessage[]; latest_sequence: number } }>(`/api/v1/daemon/${queue}-queue?since=${since}`),
  // ASB: report how far behind this observer is and receive the resulting
  // backpressure state in the same round trip.
  backpressure: (
    virtual_lag_s: number,
    client_frame_s: number,
    since_poll_s: number,
    away = false,
  ) =>
    request<Backpressure>("/api/v1/system/backpressure", {
      method: "POST",
      body: JSON.stringify({ virtual_lag_s, client_frame_s, since_poll_s, away }),
    }),
};
