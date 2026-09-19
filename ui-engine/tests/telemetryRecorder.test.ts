import { describe, expect, it } from "vitest";
import {
  TelemetryRecorder,
  intervals,
  measureSnapshot,
  runtimeStatus,
  sampleFrom,
} from "../src/telemetryRecorder";
import type { Backpressure, Snapshot } from "../src/types";

const snapshot = {
  edges: [
    { id: 0, vehicle_count: 10, halting_count: 2, mean_speed_mps: 10, flood: 0, closed: false, incident_closed: false },
    { id: 1, vehicle_count: 30, halting_count: 6, mean_speed_mps: 5, flood: 0.4, closed: false, incident_closed: false },
    { id: 2, vehicle_count: 0, halting_count: 0, mean_speed_mps: 0, flood: 0, closed: true, incident_closed: false },
  ],
  active_weather: [
    { id: 1, x_m: 0, y_m: 0, radius_m: 1000, intensity: 0.4 },
    { id: 2, x_m: 0, y_m: 0, radius_m: 500, intensity: 0.9 },
  ],
  active_incidents: [{ edge_id: 2 }],
  congestion: { current: 37.5 },
} as unknown as Snapshot;

const asb = (over: Partial<Backpressure> = {}) =>
  ({
    state: "NORMAL", score: 0.1, synced: true, rate_capped: false,
    throughput: { bytes_per_s: 2048, snapshots_per_s: 1 },
    ...over,
  }) as Backpressure;

describe("measureSnapshot", () => {
  it("derives network measures without estimation", () => {
    const m = measureSnapshot(snapshot);
    expect(m.vehicles).toBe(40);
    expect(m.halting).toBe(8);
    // Vehicle weighted: (10*10 + 5*30) / 40 = 6.25 m/s = 22.5 km/h.
    expect(m.mean_speed_kmh).toBeCloseTo(22.5);
    expect(m.active_edges).toBe(2);
    expect(m.flooded_edges).toBe(1);
    expect(m.closed_edges).toBe(1);
    expect(m.weather_cells).toBe(2);
    expect(m.rain_peak).toBe(0.9);
    expect(m.rain_area_km2).toBeCloseTo(Math.PI * 1.25);
    expect(m.incidents).toBe(1);
    expect(m.congestion).toBe(37.5);
  });
  it("reports zero speed for an empty network", () => {
    expect(measureSnapshot({ ...snapshot, edges: [], active_weather: [] } as Snapshot).mean_speed_kmh).toBe(0);
  });
});

describe("TelemetryRecorder", () => {
  const base = (virtual_s: number, over: Record<string, unknown> = {}) => ({
    ...sampleFrom({ snapshot, virtual_s, lifecycle: "RUNNING", tick_rate: 1, asb: asb(), latency_ms: 12, status: "online" }),
    ...over,
  });

  it("records one sample per distinct state", () => {
    let t = 0;
    const r = new TelemetryRecorder(100, () => t);
    r.reset("run_a");
    r.sample(base(10));
    t = 200;
    r.sample(base(10)); // same state delivered twice
    t = 1200;
    r.sample(base(20));
    expect(r.export().samples.map((s) => s.virtual_s)).toEqual([10, 20]);
    expect(r.export().samples[0].bytes_per_s).toBe(2048);
  });

  it("records transitions only when a value changes", () => {
    let t = 0;
    const r = new TelemetryRecorder(100, () => t);
    r.reset("run_a");
    r.sample(base(10));
    t = 1000;
    r.sample(base(20, { lifecycle: "PAUSED" }));
    t = 2000;
    r.sample(base(20, { lifecycle: "PAUSED", asb_state: "RESTRICTED", status: "degraded" }));
    const tr = r.export().transitions;
    expect(tr.filter((x) => x.kind === "lifecycle").map((x) => x.to)).toEqual(["RUNNING", "PAUSED"]);
    expect(tr.filter((x) => x.kind === "asb").map((x) => `${x.from}>${x.to}`)).toEqual([">NORMAL", "NORMAL>RESTRICTED"]);
    expect(tr.filter((x) => x.kind === "status").map((x) => x.to)).toEqual(["online", "degraded"]);
  });

  it("stays bounded while preserving the whole session", () => {
    let t = 0;
    const r = new TelemetryRecorder(100, () => t);
    r.reset("run_a");
    for (let i = 0; i < 1000; i++) {
      t += 1000;
      r.sample(base(i * 10));
    }
    const samples = r.export().samples;
    expect(samples.length).toBeLessThanOrEqual(100);
    // The first and last samples survive thinning.
    expect(samples[0].virtual_s).toBe(0);
    expect(samples[samples.length - 1].virtual_s).toBe(9990);
    // Order is preserved.
    for (let i = 1; i < samples.length; i++) expect(samples[i].virtual_s).toBeGreaterThan(samples[i - 1].virtual_s);
  });

  it("starts a new log for a new run and ignores a repeated reset", () => {
    const r = new TelemetryRecorder();
    r.reset("run_a");
    r.sample(base(1));
    r.control("pause", "", 1);
    r.reset("run_a");
    expect(r.export().samples).toHaveLength(1);
    r.reset("run_b");
    expect(r.export()).toMatchObject({ runId: "run_b", samples: [], controls: [], transitions: [] });
  });

  it("logs operator controls", () => {
    let t = 5;
    const r = new TelemetryRecorder(100, () => t);
    r.reset("run_a");
    r.control("rate", "2x", 3600);
    t = 9;
    r.control("pause", "", 3700);
    expect(r.export().controls).toEqual([
      { wall_ms: 5, virtual_s: 3600, action: "rate", detail: "2x" },
      { wall_ms: 9, virtual_s: 3700, action: "pause", detail: "" },
    ]);
  });

  it("returns copies so callers cannot mutate the log", () => {
    const r = new TelemetryRecorder();
    r.reset("x");
    r.export().samples.push({} as never);
    expect(r.export().samples).toHaveLength(0);
  });
});

describe("intervals", () => {
  it("pairs matching states with the transition that ends them", () => {
    const tr = [
      { wall_ms: 0, virtual_s: 0, kind: "asb" as const, from: "", to: "NORMAL" },
      { wall_ms: 10, virtual_s: 100, kind: "asb" as const, from: "NORMAL", to: "RESTRICTED" },
      { wall_ms: 25, virtual_s: 130, kind: "asb" as const, from: "RESTRICTED", to: "ASYNC" },
      { wall_ms: 40, virtual_s: 170, kind: "asb" as const, from: "ASYNC", to: "NORMAL" },
      { wall_ms: 50, virtual_s: 200, kind: "status" as const, from: "online", to: "offline" },
      { wall_ms: 60, virtual_s: 220, kind: "asb" as const, from: "NORMAL", to: "RESTRICTED" },
    ];
    expect(intervals(tr, "asb", (v) => v !== "NORMAL", 100)).toEqual([
      { from_ms: 10, to_ms: 25, value: "RESTRICTED", virtual_from: 100, virtual_to: 130 },
      { from_ms: 25, to_ms: 40, value: "ASYNC", virtual_from: 130, virtual_to: 170 },
      { from_ms: 60, to_ms: 100, value: "RESTRICTED", virtual_from: 220, virtual_to: null },
    ]);
  });
});

describe("runtimeStatus", () => {
  it("is offline without a connection", () => {
    expect(runtimeStatus({ connected: false, stale: false, error: false, asb: null })).toBe("offline");
    expect(runtimeStatus({ connected: true, stale: false, error: true, asb: null })).toBe("offline");
  });
  it("is degraded when data is stale or ASB is intervening", () => {
    expect(runtimeStatus({ connected: true, stale: true, error: false, asb: null })).toBe("degraded");
    expect(runtimeStatus({ connected: true, stale: false, error: false, asb: asb({ state: "RESTRICTED" }) })).toBe("degraded");
    expect(runtimeStatus({ connected: true, stale: false, error: false, asb: asb({ rate_capped: true }) })).toBe("degraded");
    expect(runtimeStatus({ connected: true, stale: false, error: false, asb: asb({ synced: false }) })).toBe("degraded");
  });
  it("is online otherwise", () => {
    expect(runtimeStatus({ connected: true, stale: false, error: false, asb: asb() })).toBe("online");
    expect(runtimeStatus({ connected: true, stale: false, error: false, asb: null })).toBe("online");
  });
});
