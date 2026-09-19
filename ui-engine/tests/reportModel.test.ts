import { describe, expect, it } from "vitest";
import {
  bytesTransferred,
  congestionPeriods,
  formatBytes,
  incidentRecords,
  latestByVirtual,
  networkStats,
  pearson,
  rainEvents,
  stats,
  throughputUnit,
  timeline,
} from "../src/reportModel";
import { DAY_TICKS, niceTicks, wallTicks } from "../src/pdfLayout";
import type { News, Topology } from "../src/types";
import type { TelemetrySample } from "../src/telemetryRecorder";

let id = 1;
const news = (p: Partial<News>): News => ({
  news_id: id++, event_id: 0, virtual_day_s: 0, simulated_current_time: "", category: "system",
  severity: "info", template_id: "", message: "", data: {}, ...p,
});

describe("rainEvents", () => {
  it("joins start, peak and end by cell", () => {
    const out = rainEvents([
      news({ template_id: "DWS_RAIN_STARTED", event_id: 3, virtual_day_s: 1000, data: { radius_m: 400, intensity: 0.7, epicenter: 9 } }),
      news({ template_id: "DWS_RAIN_PEAK", event_id: 50003, virtual_day_s: 2000 }),
      news({ template_id: "DWS_RAIN_ENDED", event_id: 100003, virtual_day_s: 3000 }),
      news({ template_id: "DWS_RAIN_STARTED", event_id: 1, virtual_day_s: 500, data: { radius_m: 200 } }),
    ]);
    expect(out.map((r) => r.id)).toEqual([1, 3]);
    expect(out[1]).toEqual({ id: 3, start: 1000, peak: 2000, end: 3000, radius_m: 400, intensity: 0.7, epicenter: 9 });
    expect(out[0].end).toBeNull();
  });
});

describe("incidentRecords", () => {
  it("joins activation and resolution and keeps the effects", () => {
    const out = incidentRecords([
      news({
        template_id: "INCIDENT_ACTIVATED", severity: "alert", virtual_day_s: 100,
        message: "[00:01:40] Emergency road closure: through-traffic prohibited on Edge #5 near Node #2. (HIGH SEVERITY)",
        data: { incident_id: 7, type: "road_closure", edge_id: 5, node_id: 2, closed: true, speed_multiplier: 0.1, capacity_multiplier: 0, end_virtual_s: 900 },
      }),
      news({ template_id: "INCIDENT_RESOLVED", virtual_day_s: 900, data: { incident_id: 7, type: "road_closure", edge_id: 5 } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 7, type: "road_closure", severity: "alert", start: 100, end: 900, plannedEnd: 900, edge: 5, node: 2, closed: true, speed: 0.1, capacity: 0 });
    expect(out[0].description).toBe("Emergency road closure: through-traffic prohibited");
  });
});

describe("timeline", () => {
  it("keeps significant events in order and folds flood bursts", () => {
    const rows = timeline([
      news({ template_id: "FLOOD_STARTED", category: "flooding", virtual_day_s: 500 }),
      news({ template_id: "FLOOD_STARTED", category: "flooding", virtual_day_s: 530 }),
      news({ template_id: "FLOOD_STARTED", category: "flooding", virtual_day_s: 560 }),
      news({ template_id: "FLOOD_STARTED", category: "flooding", virtual_day_s: 900 }),
      news({ template_id: "DWS_RAIN_STARTED", category: "weather", virtual_day_s: 100, message: "[00:01:40] Rain storm initiated" }),
      news({ template_id: "DEMAND_CHANGED", category: "demand", virtual_day_s: 200, message: "Retail · Mall" }),
      news({ template_id: "DEMAND_CHANGED", category: "demand", virtual_day_s: 300, message: "Retail peak · Mall" }),
      news({ template_id: "PHYSICS_ENGINE_ACTIVE", virtual_day_s: 0 }),
    ]);
    expect(rows.map((r) => [r.time, r.text])).toEqual([
      [100, "Rain storm initiated"],
      [300, "Retail peak · Mall"],
      [500, "Flooding detected on 3 roads"],
      [900, "Flooding detected on 1 road"],
    ]);
  });
});

describe("congestionPeriods", () => {
  it("finds spans at or above the threshold with their peaks", () => {
    const h = [10, 40, 50, 20, 36, 36].map((current, i) => ({ virtual_s: i * 60, current, average: 0 }));
    expect(congestionPeriods(h, 35)).toEqual([
      { from: 60, to: 120, peak: 50, peakAt: 120 },
      { from: 240, to: 300, peak: 36, peakAt: 240 },
    ]);
    expect(congestionPeriods([], 35)).toEqual([]);
  });
});

describe("statistics", () => {
  it("computes correlation only when it is meaningful", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearson([1, 2], [1, 2])).toBeNull();
  });
  it("summarizes a series", () => {
    expect(stats([4, 1, 3, 2, 5])).toMatchObject({ min: 1, max: 5, mean: 3, median: 3, count: 5 });
    expect(stats([])).toBeNull();
  });
  it("produces readable axis ticks", () => {
    expect(niceTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 7, 4)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(5, 5).length).toBeGreaterThan(1);
  });
  it("uses clock-friendly ticks for time axes", () => {
    expect(DAY_TICKS).toEqual([0, 10800, 21600, 32400, 43200, 54000, 64800, 75600, 86400]);
    expect(wallTicks(400)).toEqual([0, 60, 120, 180, 240, 300, 360]);
    expect(wallTicks(45)).toEqual([0, 10, 20, 30, 40]);
    expect(wallTicks(4 * 3600).length).toBeLessThanOrEqual(8);
  });
});

const sample = (wall_ms: number, virtual_s: number, bytes: number | null): TelemetrySample =>
  ({ wall_ms, virtual_s, bytes_per_s: bytes }) as TelemetrySample;

describe("telemetry reductions", () => {
  it("keeps the latest pass when the day was replayed", () => {
    const out = latestByVirtual([sample(0, 0, 1), sample(1, 60, 1), sample(2, 0, 2), sample(3, 120, 1)]);
    expect(out.map((s) => [s.virtual_s, s.wall_ms])).toEqual([[0, 2], [60, 1], [120, 3]]);
  });
  it("integrates delivered bytes and skips gaps", () => {
    expect(bytesTransferred([sample(0, 0, 1000), sample(1000, 0, 3000), sample(2000, 0, 3000)])).toBe(5000);
    // A 60 second gap is a stall, not delivery.
    expect(bytesTransferred([sample(0, 0, 1000), sample(60000, 0, 1000)])).toBe(0);
    expect(bytesTransferred([sample(0, 0, null)])).toBeNull();
  });
  it("formats sizes and picks throughput units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(throughputUnit(500 * 1024).unit).toBe("KiB/s");
    expect(throughputUnit(3 * 1024 * 1024).unit).toBe("MiB/s");
  });
});

describe("networkStats", () => {
  it("summarizes the network", () => {
    const topo = {
      nodes: [
        { id: 0, degree: 1, signal: false },
        { id: 1, degree: 3, signal: true },
        { id: 2, degree: 2, signal: false },
      ],
      edges: [
        { id: 0, road_class: "primary", length_m: 1000, lanes: 2, free_speed_mps: 10, synthetic_reverse: false },
        { id: 1, road_class: "primary", length_m: 500, lanes: 2, free_speed_mps: 20, synthetic_reverse: false },
        { id: 2, road_class: "service", length_m: 100, lanes: 1, free_speed_mps: 5, synthetic_reverse: true },
      ],
      features: [],
    } as unknown as Topology;
    const s = networkStats(topo);
    expect(s).toMatchObject({ nodes: 3, directions: 2, syntheticReverse: 1, km: 1.5, intersections: 1, deadEnds: 1, signals: 1 });
    expect(s.meanDegree).toBe(2);
    expect(s.classes).toEqual([{ name: "primary", count: 2, km: 1.5, lanes: 2, speed: 54 }]);
  });
});
