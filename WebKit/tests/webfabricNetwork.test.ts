// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { along, networkOf, PathRun, pathSpring, placeFeature, trackOf } from "../src/webfabric/spatial";
import { SPRINGS } from "../src/motion";
import type { Topology } from "../src/types";

const point = (x_m: number, y_m: number) => ({ x_m, y_m, lat: 0, lon: 0 });
// 0 -> 1 -> 2, 100 m each, along a straight road; nothing runs from 2 back to 1.
const topology = {
  nodes: [0, 1, 2].map((id) => ({ id, position: point(id * 100, 0), degree: 2, signal: false, osm_node_id: id })),
  edges: [
    { id: 7, from: 0, to: 1, geometry: [point(0, 0), point(50, 0), point(100, 0)] },
    { id: 8, from: 1, to: 2, geometry: [point(100, 0), point(200, 0)] },
  ],
} as unknown as Topology;
const network = networkOf(topology)!;
const run = (seconds: number, feature: Parameters<PathRun["step"]>[0], path: PathRun) => {
  let going = true;
  for (let t = 0; t < seconds && going; t += 1 / 60) going = path.step(feature, 1 / 60);
  return going;
};

describe("features on the road network", () => {
  it("stands a marker on its junction, and leaves out one that is not there", () => {
    expect(placeFeature({ type: "marker", node: 2 }, network)).toMatchObject({ x_m: 200, y_m: 0 });
    expect(placeFeature({ type: "marker", node: 99 }, network)).toBeNull();
    expect(placeFeature({ type: "marker", node: 2 }, null)).toBeNull();
  });

  it("puts an entity part way along its road, facing the way the road runs", () => {
    expect(placeFeature({ type: "entity", edge: 8, at: 0.25 }, network)).toMatchObject({ x_m: 125, y_m: 0, heading: 0 });
    expect(placeFeature({ type: "entity", edge: 99 }, network)).toBeNull();
  });

  it("follows the roads for a route, and refuses junctions no road joins", () => {
    const line = placeFeature({ type: "route", nodes: [0, 1, 2] }, network)!;
    expect(line.type).toBe("line");
    expect(line.points).toEqual([[0, 0], [50, 0], [100, 0], [200, 0]]);
    expect(placeFeature({ type: "route", nodes: [2, 1] }, network)).toBeNull();
    expect(trackOf([0, 1, 2], network)).toMatchObject({ total: 200, stops: [0, 100, 200] });
  });

  it("finds a place along a track", () => {
    expect(along(trackOf([0, 1, 2], network)!, 150)).toMatchObject({ x: 150, y: 0 });
    expect(along(trackOf([0, 1, 2], network)!, 900)).toMatchObject({ x: 200, y: 0 });
  });

  it("uses a named spring or one of the application's own", () => {
    expect(pathSpring("lively")).toBe(SPRINGS.expressiveDefault);
    expect(pathSpring({ stiffness: 200, damping: 30 })).toEqual({ k: 200, c: 30 });
    expect(pathSpring(undefined)).toBe(SPRINGS.spatialDefault);
  });
});

describe("a path playing", () => {
  const nodes = [0, 1, 2];
  const track = trackOf(nodes, network)!;

  it("travels to the end at its speed, settles there and stops asking for frames", () => {
    const path = new PathRun(track);
    const feature = { type: "path" as const, nodes, speed_mps: 100 };
    run(1, feature, path);
    expect(path.guide).toBeGreaterThan(90);
    expect(path.guide).toBeLessThan(110);
    expect(run(4, feature, path)).toBe(false);
    expect(path.distance).toBeCloseTo(200, 0);
  });

  it("starts over when it loops, without travelling back along the road", () => {
    const path = new PathRun(track);
    const feature = { type: "path" as const, nodes, speed_mps: 100, loop: true };
    run(2.1, feature, path);
    expect(path.finished).toBe(false);
    expect(path.guide).toBeLessThan(40);
  });

  it("turns round at the end when it bounces, and finishes back at the start unless looping", () => {
    const path = new PathRun(track);
    const feature = { type: "path" as const, nodes, speed_mps: 100, bounce: true };
    run(2.5, feature, path);
    expect(path.guide).toBeLessThan(180);
    expect(run(6, feature, path)).toBe(false);
    expect(path.distance).toBeCloseTo(0, 0);
  });

  it("holds at a junction for its dwell, and waits out its delay", () => {
    const path = new PathRun(track, 0.5);
    const feature = { type: "path" as const, nodes, speed_mps: 100, dwell_s: 1 };
    run(0.4, feature, path);
    expect(path.guide).toBe(0);
    run(1.5, feature, path);
    expect(path.guide).toBe(100);
    run(1, feature, path);
    expect(path.guide).toBeGreaterThan(100);
  });

  it("stands still while paused", () => {
    const path = new PathRun(track);
    run(1, { type: "path", nodes, paused: true }, path);
    expect(path.guide).toBe(0);
  });
});
