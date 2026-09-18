import type {
  Envelope,
  Status,
  Topology,
  Snapshot,
  News,
  EventPage,
  Congestion,
} from "./types";
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
    throw new Error("The simulator returned an unreadable response.");
  }
  if (!response.ok)
    throw new Error(
      result?.error?.message ?? `Request failed (${response.status})`,
    );
  if (
    path.includes("/view/") ||
    path.endsWith("/status") ||
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
export const api = {
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
  pause: () =>
    request("/api/v1/playback/pause", { method: "POST", body: "{}" }),
  play: () => request("/api/v1/playback/play", { method: "POST", body: "{}" }),
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
  reset: () =>
    request("/api/v1/playback/reset", { method: "POST", body: "{}" }),
  terminate: () =>
    request("/api/v1/system/terminate", { method: "POST", body: "{}" }),
};
