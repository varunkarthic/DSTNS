// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { settleTime, Spring, springEasing, springProgress, SPRINGS, stepSpring } from "../src/motion";

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
