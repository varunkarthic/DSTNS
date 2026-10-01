// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { roadState, distanceToSegment, insideFootprint } from "../src/mapModel";
import type { EdgeState, Point } from "../src/types";
afterEach(() => vi.restoreAllMocks());
describe("Observer transport", () => {
  it("has no simulation creation or world manipulation methods", () => {
    for (const key of [
      "start",
      "prepare",
      "setDay",
      "overrideEdge",
      "weather",
      "triggerSurge",
      "validateTransitRoute",
    ])
      expect(api).not.toHaveProperty(key);
  });
  it("uses pause endpoint", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    await api.pause();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/playback/pause",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("reports API errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad tick" } }), {
        status: 400,
      }),
    );
    await expect(api.tick(0)).rejects.toThrow("bad tick");
  });
  it("reports the status of an error that has no JSON body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    await expect(api.status()).rejects.toThrow("Request failed (502)");
  });
  it("rejects malformed responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>"));
    await expect(api.snapshot()).rejects.toThrow("unreadable");
  });
  it("rejects missing state envelopes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await expect(api.snapshot()).rejects.toThrow("Incomplete");
  });
  it("limits and encodes event requests", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ run_id: "r", clock: {}, data: { items: [] } }),
        ),
      );
    await api.events("history", "signals", 30);
    expect(fetch.mock.calls[0][0]).toBe(
      "/api/v1/view/event-queue?view=history&category=signals&offset=30&limit=30",
    );
  });
});
describe("Road semantics", () => {
  const state = (fields: Partial<EdgeState>) =>
    ({ congestion: 0, flood: 0, closed: false, ...fields }) as EdgeState;
  it("distinguishes flood even when blocked and severely congested", () =>
    expect(roadState(state({ flood: 0.1, closed: true, congestion: 1 }))).toBe(
      "flooded",
    ));
  it("does not colour rain as severe congestion", () =>
    expect(roadState(state({ rainfall: 1 }))).toBe("clear"));
  it("maps thresholds and closures", () => {
    expect(roadState(state({ closed: true }))).toBe("blocked");
    expect(roadState(state({ congestion: 0.7 }))).toBe("severe");
    expect(roadState(state({ congestion: 0.35 }))).toBe("moderate");
    expect(roadState(state({ congestion: 0.34 }))).toBe("clear");
  });
  it("handles degenerate road segments in hit testing", () =>
    expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBe(5));
});

describe("Footprint inspection", () => {
  it("does not capture empty space in a concave footprint bounding box", () => {
    const points = [
      [0, 0],
      [4, 0],
      [4, 1],
      [1, 1],
      [1, 4],
      [0, 4],
    ].map(([x, y]) => ({ x_m: x, y_m: -y }) as Point);
    expect(insideFootprint(0.5, 3, points)).toBe(true);
    expect(insideFootprint(3, 3, points)).toBe(false);
  });
});

describe("world endpoints", () => {
  it("accepts world status, which is not a simulation envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ api_version: "1.0", data: { state: "generating", stage: "building" } }), { headers: { "Content-Type": "application/json" } }),
    );
    await expect(api.worldStatus()).resolves.toMatchObject({ data: { stage: "building" } });
    vi.restoreAllMocks();
  });
});
