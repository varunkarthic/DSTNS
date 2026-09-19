import { describe, expect, it } from "vitest";
import {
  MIN_SPAN_M,
  boundsOf,
  chooseTarget,
  floodClusters,
  focusTargets,
  framingSignature,
  networkBounds,
  viewportFor,
  withMinimumSpan,
} from "../src/autoFocus";
import type { FocusTarget } from "../src/autoFocus";
import type { Snapshot, Topology } from "../src/types";

const viewport = { width: 1200, height: 800, insets: { top: 60, right: 420, bottom: 120, left: 60 } };

describe("geometry bounds", () => {
  it("computes bounds for every geometry kind", () => {
    expect(boundsOf({ kind: "point", x: 5, y: 6 })).toEqual({ minX: 5, maxX: 5, minY: 6, maxY: 6 });
    expect(boundsOf({ kind: "radius", x: 0, y: 0, r: 500 })).toEqual({ minX: -500, maxX: 500, minY: -500, maxY: 500 });
    expect(boundsOf({ kind: "line", points: [{ x: 0, y: 3 }, { x: 10, y: -2 }] })).toEqual({ minX: 0, maxX: 10, minY: -2, maxY: 3 });
    expect(boundsOf({ kind: "polygon", points: [{ x: 1, y: 1 }, { x: -1, y: 4 }, { x: 3, y: 0 }] })).toEqual({ minX: -1, maxX: 3, minY: 0, maxY: 4 });
    expect(boundsOf({ kind: "bbox", minX: 1, maxX: 2, minY: 3, maxY: 4 })).toEqual({ minX: 1, maxX: 2, minY: 3, maxY: 4 });
  });

  it("enforces a minimum span around a point", () => {
    const b = withMinimumSpan({ minX: 10, maxX: 10, minY: 20, maxY: 20 });
    expect(b.maxX - b.minX).toBe(MIN_SPAN_M);
    expect((b.minX + b.maxX) / 2).toBe(10);
  });
});

describe("viewportFor", () => {
  it("fits the footprint inside the unobscured area with padding", () => {
    const r = 1000;
    const v = viewportFor(boundsOf({ kind: "radius", x: 200, y: -100, r }), viewport, { maxScale: 10 });
    const usableW = 1200 - 60 - 420;
    const usableH = 800 - 60 - 120;
    // The whole disc plus padding fits both dimensions.
    expect(2 * r * v.scale).toBeLessThanOrEqual(usableW);
    expect(2 * r * v.scale).toBeLessThanOrEqual(usableH);
    // And it is fitted, not merely shrunk: the tighter axis is nearly filled.
    expect(2 * r * v.scale * 1.36).toBeCloseTo(Math.min(usableW, usableH), 0);
    expect(v.centre).toEqual({ x: 200, y: -100 });
    expect(v.screen).toEqual({ x: 60 + usableW / 2, y: 60 + usableH / 2 });
  });

  it("zooms out as a rain footprint grows", () => {
    const small = viewportFor(boundsOf({ kind: "radius", x: 0, y: 0, r: 300 }), viewport);
    const large = viewportFor(boundsOf({ kind: "radius", x: 0, y: 0, r: 1500 }), viewport);
    expect(large.scale).toBeLessThan(small.scale);
    expect(small.scale / large.scale).toBeCloseTo(5, 5);
  });

  it("clamps scale to the configured range", () => {
    // The minimum span alone limits a point's zoom to a readable neighbourhood...
    expect(viewportFor(boundsOf({ kind: "point", x: 0, y: 0 }), viewport).scale).toBeLessThan(1.5);
    // ...and maxScale caps it when the span would allow closer.
    expect(viewportFor(boundsOf({ kind: "point", x: 0, y: 0 }), viewport, { maxScale: 1.5, minSpan: 10 }).scale).toBe(1.5);
    expect(viewportFor(boundsOf({ kind: "radius", x: 0, y: 0, r: 1e7 }), viewport, { minScale: 0.05 }).scale).toBe(0.05);
  });

  it("keeps a usable area on a tiny viewport", () => {
    const v = viewportFor(boundsOf({ kind: "point", x: 0, y: 0 }), { width: 100, height: 100, insets: { top: 90, right: 90, bottom: 90, left: 90 } });
    expect(Number.isFinite(v.scale)).toBe(true);
    expect(v.scale).toBeGreaterThan(0);
  });
});

describe("framingSignature", () => {
  const rain = (r: number, x = 0): FocusTarget => ({
    key: "weather-1", kind: "weather", label: "Rain", rank: 3, geometry: { kind: "radius", x, y: 0, r },
  });
  it("is stable for small changes", () => {
    expect(framingSignature(rain(1000))).toBe(framingSignature(rain(1030)));
    expect(framingSignature(rain(1000))).toBe(framingSignature(rain(1000, 50)));
  });
  it("changes as the footprint grows or drifts materially", () => {
    expect(framingSignature(rain(1000))).not.toBe(framingSignature(rain(1300)));
    expect(framingSignature(rain(1000))).not.toBe(framingSignature(rain(1000, 900)));
  });
});

describe("floodClusters", () => {
  it("separates distant floods and merges neighbouring ones", () => {
    const seg = (x: number, y: number) => [{ x, y }, { x: x + 20, y }];
    const clusters = floodClusters([seg(0, 0), seg(650, 10), seg(5000, 5000)]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].points).toHaveLength(4);
    expect(clusters[1].points).toHaveLength(2);
  });
  it("handles no flooding", () => {
    expect(floodClusters([])).toEqual([]);
  });
});

const topology = {
  nodes: [
    { id: 0, position: { x_m: 0, y_m: 0 } },
    { id: 1, position: { x_m: 3000, y_m: 2000 } },
  ],
  edges: [
    { id: 0, name: "Main Street", road_class: "primary", synthetic_reverse: false,
      geometry: [{ x_m: 0, y_m: 0 }, { x_m: 400, y_m: 0 }] },
    { id: 1, name: "", road_class: "service", synthetic_reverse: false,
      geometry: [{ x_m: 2000, y_m: 2000 }, { x_m: 2100, y_m: 2000 }] },
  ],
  features: [],
} as unknown as Topology;

const snapshot = (over: Partial<Snapshot> = {}) =>
  ({
    edges: [
      { id: 0, flood: 0 },
      { id: 1, flood: 0.3 },
    ],
    active_incidents: [{ incident_id: 9, edge_id: 0, type: "accident", closed: true, flood: 0 }],
    active_weather: [{ id: 4, x_m: 1000, y_m: 500, radius_m: 800, intensity: 0.8 }],
    ...over,
  }) as unknown as Snapshot;

describe("focusTargets", () => {
  it("derives targets with real geometry, most important first", () => {
    const t = focusTargets(snapshot(), topology);
    expect(t.map((x) => x.key)).toEqual(["flood-0", "incident-9", "weather-4"]);
    expect(t[1].label).toBe("Collision on Main Street");
    expect(t[1].geometry).toEqual({ kind: "line", points: [{ x: 0, y: 0 }, { x: 400, y: 0 }] });
    expect(t[2].geometry).toEqual({ kind: "radius", x: 1000, y: 500, r: 800 });
    expect(t[2].label).toBe("Heavy rain");
  });
  it("returns nothing without data", () => {
    expect(focusTargets(null, topology)).toEqual([]);
    expect(focusTargets(snapshot({ active_incidents: [], active_weather: [], edges: [] }), topology)).toEqual([]);
  });
  it("computes network bounds for the idle framing", () => {
    expect(networkBounds(topology)).toEqual({ minX: 0, maxX: 3000, minY: 0, maxY: 2000 });
    expect(networkBounds(null)).toBeNull();
  });
});

describe("chooseTarget", () => {
  const t = (key: string, rank = 1): FocusTarget => ({ key, rank, kind: "incident", label: key, geometry: { kind: "point", x: 0, y: 0 } });
  const list = [t("a"), t("b"), t("c")];
  it("rotates through targets in Round-Robin", () => {
    expect(chooseTarget(list, "round-robin", 0, new Map())?.key).toBe("a");
    expect(chooseTarget(list, "round-robin", 4, new Map())?.key).toBe("b");
    expect(chooseTarget(list, "round-robin", -1, new Map())?.key).toBe("c");
  });
  it("follows the most recently appeared target in Latest", () => {
    const seen = new Map([["a", 100], ["b", 900], ["c", 400]]);
    expect(chooseTarget(list, "latest", 0, seen)?.key).toBe("b");
  });
  it("returns nothing when there is nothing to follow", () => {
    expect(chooseTarget([], "latest", 0, new Map())).toBeUndefined();
  });
});
