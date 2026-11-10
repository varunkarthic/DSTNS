// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { FlowTraffic } from "../src/map/flowTraffic";
import type { RoadFlow } from "../src/map/flowTraffic";
import type { TopologyEdge } from "../src/core/types";

function road(id: number, from: number, to: number, a: [number, number], b: [number, number], twin = -1): TopologyEdge {
  const length_m = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return { id, from, to, reverse_twin: twin, synthetic_reverse: false, name: "", road_class: "residential", length_m, lanes: 1, free_speed_mps: 10, geometry: [{ x_m: a[0], y_m: a[1] }, { x_m: b[0], y_m: b[1] }] } as TopologyEdge;
}
const everywhere = () => true;
const flow = (count: number, speed = 10, signal = 1, closed = false): RoadFlow => ({ count, speed, signal, closed });
const seeded = () => {
  let state = 7;
  return () => (state = (state * 48271) % 2147483647) / 2147483647;
};
const run = (traffic: FlowTraffic, flows: Map<number, RoadFlow>, seconds: number, each?: () => void) => {
  for (let t = 0; t < seconds; t += 0.05) {
    traffic.step(0.05, 0.05, flows, everywhere, 100);
    each?.();
  }
};

describe("traffic on the map", () => {
  it("carries on into the next road instead of vanishing at the end of an edge", () => {
    const edges = [road(0, 0, 1, [0, 0], [100, 0]), road(1, 1, 2, [100, 0], [200, 0]), road(2, 2, 3, [200, 0], [300, 0])];
    const traffic = new FlowTraffic(edges, seeded());
    const flows = new Map([[0, flow(1)], [1, flow(0)], [2, flow(0)]]);
    run(traffic, flows, 1);
    const marker = traffic.markers[0];
    flows.set(0, flow(0));
    flows.set(1, flow(1));
    run(traffic, flows, 12);
    expect(marker.edge).toBeGreaterThan(0);
    expect(traffic.markers).toContain(marker);
  });

  it("moves without jumps, across a junction too", () => {
    const edges = [road(0, 0, 1, [0, 0], [60, 0]), road(1, 1, 2, [60, 0], [120, 0])];
    const traffic = new FlowTraffic(edges, seeded());
    const flows = new Map([[0, flow(1, 8)], [1, flow(1, 8)]]);
    traffic.step(0.05, 0.05, flows, everywhere, 1);
    const marker = traffic.markers[0];
    let last = { x: marker.x, y: marker.y };
    run(traffic, flows, 8, () => {
      if (!traffic.markers.includes(marker)) return;
      expect(Math.hypot(marker.x - last.x, marker.y - last.y)).toBeLessThan(2);
      last = { x: marker.x, y: marker.y };
    });
  });

  it("follows the shape of the road, not the line between its ends", () => {
    const bend = road(0, 0, 1, [0, 0], [100, 0]);
    bend.geometry = [{ x_m: 0, y_m: 0 }, { x_m: 50, y_m: 50 }, { x_m: 100, y_m: 0 }] as TopologyEdge["geometry"];
    const traffic = new FlowTraffic([bend], seeded());
    const flows = new Map([[0, flow(6)]]);
    let off = 0;
    run(traffic, flows, 3, () => {
      for (const m of traffic.markers) off = Math.max(off, m.y);
    });
    expect(off).toBeGreaterThan(20);
  });

  it("queues at a red light with room between, and goes on green", () => {
    const edges = [road(0, 0, 1, [0, 0], [200, 0]), road(1, 1, 2, [200, 0], [400, 0])];
    const traffic = new FlowTraffic(edges, seeded());
    const flows = new Map([[0, flow(8, 10, 0.08)], [1, flow(0)]]);
    run(traffic, flows, 40);
    const held = traffic.markers.filter((m) => m.edge === 0).sort((a, b) => b.s - a.s);
    expect(held.length).toBeGreaterThan(3);
    expect(held[0].s).toBeLessThan(200);
    expect(held[0].s).toBeGreaterThan(190);
    expect(held[0].v).toBeLessThan(0.3);
    expect(held[0].braking).toBe(true);
    for (let i = 1; i < held.length; i++) expect(held[i - 1].s - held[i].s).toBeGreaterThan(4.6);
    flows.set(0, flow(8, 10, 1));
    run(traffic, flows, 10);
    expect(traffic.markers.some((m) => m.edge === 1)).toBe(true);
  });

  it("never lets one drive through the one ahead, at any playback rate", () => {
    const edges = [road(0, 0, 1, [0, 0], [300, 0], 1), road(1, 1, 0, [300, 0], [0, 0], 0)];
    const traffic = new FlowTraffic(edges, seeded());
    const flows = new Map([[0, flow(10, 12)], [1, flow(10, 12)]]);
    for (let t = 0; t < 60; t++) {
      traffic.step(1, 0.05, flows, everywhere, 100);
      for (const id of [0, 1]) {
        const here = traffic.markers.filter((m) => m.edge === id && !m.leaving).sort((a, b) => b.s - a.s);
        for (let i = 1; i < here.length; i++) expect(here[i - 1].s).toBeGreaterThanOrEqual(here[i].s);
      }
    }
  });

  it("fades in and out when the numbers change, rather than popping", () => {
    const edges = [road(0, 0, 1, [0, 0], [500, 0], 1), road(1, 1, 0, [500, 0], [0, 0], 0)];
    const traffic = new FlowTraffic(edges, seeded());
    const flows = new Map([[0, flow(6)], [1, flow(0)]]);
    traffic.step(0.05, 0.05, flows, everywhere, 100);
    expect(traffic.markers.length).toBeGreaterThan(0);
    expect(Math.max(...traffic.markers.map((m) => m.alpha))).toBeLessThan(0.3);
    run(traffic, flows, 1);
    expect(Math.min(...traffic.markers.map((m) => m.alpha))).toBe(1);
    flows.set(0, flow(0));
    traffic.step(0.05, 0.05, flows, everywhere, 100);
    expect(traffic.markers.filter((m) => m.leaving).length).toBeGreaterThan(0);
    run(traffic, flows, 2);
    expect(traffic.markers.filter((m) => m.edge === 0 && m.s < 400).length).toBeLessThanOrEqual(1);
  });

  it("stays within its budget, and drops what has gone off screen", () => {
    const edges = Array.from({ length: 10 }, (_, i) => road(i, i, i + 100, [0, i * 50], [500, i * 50]));
    const traffic = new FlowTraffic(edges, seeded());
    const flows = new Map(edges.map((e) => [e.id, flow(12)]));
    run(traffic, flows, 2);
    expect(traffic.markers.length).toBeLessThanOrEqual(100);
    traffic.step(0.05, 0.05, flows, (e) => e.id === 0, 100);
    expect(traffic.markers.every((m) => m.edge === 0)).toBe(true);
  });

  it("stands still while paused", () => {
    const traffic = new FlowTraffic([road(0, 0, 1, [0, 0], [500, 0])], seeded());
    const flows = new Map([[0, flow(4)]]);
    run(traffic, flows, 1);
    const before = traffic.markers.map((m) => m.s);
    traffic.step(0, 0, flows, everywhere, 100);
    expect(traffic.markers.map((m) => m.s)).toEqual(before);
  });
});
