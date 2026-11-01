// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { along, DriveRun, networkOf, PathRun, pathSpring, placeFeature, trackOf } from "../src/webfabric/spatial";
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

describe("driving a path", () => {
  const edges = [
    { id: 0, from: 0, to: 1, geometry: [{ x_m: 0, y_m: 0 }, { x_m: 300, y_m: 0 }] },
    { id: 1, from: 1, to: 2, geometry: [{ x_m: 300, y_m: 0 }, { x_m: 600, y_m: 0 }] },
    { id: 2, from: 2, to: 3, geometry: [{ x_m: 600, y_m: 0 }, { x_m: 900, y_m: 0 }] },
  ];
  const drivenNetwork = networkOf({ nodes: [0, 1, 2, 3].map((id) => ({ id, position: { x_m: id * 300, y_m: 0 } })), edges } as never)!;
  const track = trackOf([0, 1, 2, 3], drivenNetwork)!;
  const go = (run: DriveRun, feature: Parameters<DriveRun["step"]>[0], seconds: number, signal?: (road: number) => number) => {
    for (let t = 0; t < seconds; t += 1 / 60) run.step(feature, 1 / 60, signal);
  };
  const feature: Parameters<DriveRun["step"]>[0] = { type: "path", id: "c", nodes: [0, 1, 2, 3], drive: true, speed_mps: 30 };

  it("pulls away rather than sliding off at full speed", () => {
    const run = new DriveRun(track, feature);
    go(run, feature, 0.2);
    expect(run.fleet[0].v).toBeGreaterThan(0);
    expect(run.fleet[0].v).toBeLessThan(20);
    go(run, feature, 4);
    expect(run.fleet[0].v).toBeGreaterThan(24);
  });

  it("stops short of a red signal with its brake lights on, and goes on green", () => {
    const run = new DriveRun(track, feature);
    let red = true;
    const signal = (road: number) => (road === 0 && red ? 0.08 : 1);
    go(run, feature, 20, signal);
    expect(run.fleet[0].distance).toBeLessThan(300);
    expect(run.fleet[0].distance).toBeGreaterThan(285);
    expect(run.fleet[0].v).toBeLessThan(1);
    expect(run.fleet[0].braking).toBe(true);
    red = false;
    go(run, feature, 3, signal);
    expect(run.fleet[0].distance).toBeGreaterThan(300);
  });

  it("ignores signals only when asked to", () => {
    const free = { ...feature, obey_signals: false };
    const run = new DriveRun(track, free);
    go(run, free, 20, () => 0.08);
    expect(run.fleet[0].distance).toBeGreaterThan(400);
  });

  it("keeps a convoy apart and in order, stopped or moving", () => {
    const convoy = { ...feature, count: 4, spacing_m: 20 };
    const run = new DriveRun(track, convoy);
    for (let t = 0; t < 22; t += 1 / 60) {
      run.step(convoy, 1 / 60, (road) => (road === 1 ? 0.08 : 1));
      for (let i = 1; i < 4; i++) expect(run.fleet[i - 1].distance - run.fleet[i].distance).toBeGreaterThan(4.6);
    }
    expect(run.fleet[0].distance).toBeLessThan(600);
  });

  it("comes to rest at the end of a path, and goes round again on a loop", () => {
    const run = new DriveRun(track, feature);
    go(run, feature, 60);
    expect(run.fleet[0].distance).toBeGreaterThan(880);
    expect(run.finished).toBe(true);
    const looping = { ...feature, loop: true };
    const round = new DriveRun(track, looping);
    go(round, looping, 60);
    expect(round.fleet[0].lap).toBeGreaterThan(0);
    expect(round.finished).toBe(false);
  });
});

describe("drawing along the road", () => {
  it("draws a route over the time asked for, and fits the speed to its length", () => {
    const placed = placeFeature({ type: "route", nodes: [0, 1, 2], draw_s: 2 }, network)!;
    expect(placed.type).toBe("path");
    expect(placed.shape).toBe("none");
    expect(placed.speed_mps).toBeCloseTo(100);
  });
  it("leaves out a sequence whose junctions are not adjacent, rather than drawing part of it", () => {
    expect(placeFeature({ type: "route", nodes: [0, 2], draw_s: 2 }, network)).toBeNull();
    expect(placeFeature({ type: "path", id: "x", nodes: [0, 1, 99] }, network)).toBeNull();
  });
});
