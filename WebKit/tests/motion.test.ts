// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { createVelocityTracker, projectSnap, PURPOSES, settleTime, Spring, springEasing, springProgress, SPRINGS, stepSpring } from "../src/CoreMotion/motion";
import { stepRainCells } from "../src/core/mapModel";

const peak = (preset: { k: number; c: number }) => {
  let most = 0;
  for (let t = 0; t < 3; t += 1 / 500) most = Math.max(most, springProgress(preset, t));
  return most;
};

describe("springs", () => {
  it("starts at rest at 0 and ends at 1", () => {
    for (const preset of Object.values(SPRINGS)) {
      expect(springProgress(preset, 0)).toBeCloseTo(0, 6);
      expect(springProgress(preset, 5)).toBeCloseTo(1, 3);
    }
  });

  it("never overshoots on effects, and stays quiet on spatial springs", () => {
    for (const name of ["effectsFast", "effectsDefault", "effectsSlow"] as const) expect(peak(SPRINGS[name])).toBeLessThanOrEqual(1.0000001);
    for (const name of ["spatialFast", "spatialDefault", "spatialSlow"] as const) expect(peak(SPRINGS[name])).toBeLessThan(1.002);
    // Over 5% would need a written reason; the livelier spring stays under it.
    expect(peak(SPRINGS.lively)).toBeLessThan(1.05);
    expect(peak(SPRINGS.lively)).toBeGreaterThan(1.01);
  });

  it("the map camera never overshoots where it is going", () => {
    expect(peak(SPRINGS.camera)).toBeLessThanOrEqual(1.0005);
    expect(peak(SPRINGS.cameraZoom)).toBeLessThanOrEqual(1.0005);
  });

  it("orders fast, default and slow by how long they take", () => {
    expect(settleTime(SPRINGS.spatialFast)).toBeLessThan(settleTime(SPRINGS.spatialDefault));
    expect(settleTime(SPRINGS.spatialDefault)).toBeLessThan(settleTime(SPRINGS.spatialSlow));
  });

  it("samples into a valid CSS easing that ends exactly on the target", () => {
    const easing = springEasing(SPRINGS.lively);
    expect(easing).toMatch(/^linear\(0, /);
    expect(easing).toMatch(/, 1\)$/);
  });

  it("the integrated spring agrees with the analytic one", () => {
    let [x, v] = [0, 0];
    for (let i = 0; i < 60; i++) [x, v] = stepSpring(x, v, 1, SPRINGS.spatialDefault, 1 / 240);
    expect(x).toBeCloseTo(springProgress(SPRINGS.spatialDefault, 0.25), 2);
    expect(v).toBeGreaterThan(0);
  });

  it("is stable however long a frame takes", () => {
    const [x] = stepSpring(0, 0, 1, SPRINGS.effectsFast, 1 / 20);
    expect(Number.isFinite(x)).toBe(true);
    expect(Math.abs(x)).toBeLessThan(2);
  });

  it("an interrupted spring keeps its velocity and turns round smoothly", () => {
    const seen: number[] = [];
    const spring = new Spring(0, SPRINGS.spatialDefault, (value) => seen.push(value));
    spring.value = 50;
    spring.velocity = 800;
    spring.set(0);
    expect(spring.velocity).toBe(800);
    spring.stop();
    spring.jump(10);
    expect(spring.value).toBe(10);
    expect(spring.velocity).toBe(0);
    expect(seen.at(-1)).toBe(10);
  });
});

describe("gesture helpers", () => {
  it("tracks velocity over its recent window", () => {
    const tracker = createVelocityTracker();
    tracker.add(0, 0);
    tracker.add(50, 50);
    tracker.add(100, 100);
    expect(tracker.velocity()).toBeCloseTo(1000);
    tracker.reset();
    expect(tracker.velocity()).toBe(0);
  });

  it("settles on the nearest stop at rest, and carries momentum past it when thrown", () => {
    const stops = [0, 20, 40, 60, 80, 100];
    expect(projectSnap(22, 0, stops)).toBe(20);
    expect(projectSnap(22, 400, stops)).toBeGreaterThan(20);
    expect(projectSnap(90, 99999, stops)).toBe(100);
  });

  it("the expressive scheme stays under its 12% ceiling", () => {
    for (const name of ["expressiveFast", "expressiveDefault", "expressiveSlow"] as const) expect(peak(SPRINGS[name])).toBeLessThan(1.12);
  });

  it("every purpose names a real spring", () => {
    for (const name of Object.values(PURPOSES)) expect(SPRINGS[name]).toBeDefined();
  });
});

describe("rain cells", () => {
  const cell = (over = {}) => ({ id: 1, x_m: 100, y_m: 0, radius_m: 300, intensity: 0.5, ...over });
  it("open from nothing, chase the core's position, and fade out when gone", () => {
    const cells = new Map();
    let drawn = stepRainCells(cells, [cell()], 1 / 60);
    expect(drawn[0].radius_m).toBeLessThan(50);
    expect(drawn[0].moving).toBe(true);
    for (let i = 0; i < 300; i++) drawn = stepRainCells(cells, [cell()], 1 / 60);
    expect(drawn[0].radius_m).toBeCloseTo(300, 0);
    drawn = stepRainCells(cells, [cell({ x_m: 500 })], 1 / 60);
    expect(drawn[0].x_m).toBeLessThan(120);
    for (let i = 0; i < 300; i++) drawn = stepRainCells(cells, [], 1 / 60);
    expect(drawn).toHaveLength(0);
    expect(cells.size).toBe(0);
  });
  it("go straight to their place under reduced motion", () => {
    const drawn = stepRainCells(new Map(), [cell()], 1000);
    expect(drawn[0]).toMatchObject({ radius_m: 300, alpha: 1, moving: false });
  });
});
