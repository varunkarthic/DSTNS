// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { expect, it } from "vitest";
import { landingPoints } from "../src/BootScene";

const road = (...points: [number, number][]) => points.map(([x_m, y_m]) => ({ x_m, y_m }));

it("lands the particles on the roads, where the map has drawn them", () => {
  // One road along y = 0, drawn by the map from (100, 200) to (300, 200) in a 400 by 400 window.
  const points = landingPoints([road([0, 0], [100, 0], [200, 0])], { x: 100, y: 200, scale: 1 }, { left: 0, top: 0 }, 400, 400, 50)!;
  for (let i = 0; i < 50; i++) {
    expect(points[i * 3]).toBeGreaterThanOrEqual(-0.5);
    expect(points[i * 3]).toBeLessThanOrEqual(0.5);
    expect(points[i * 3 + 1]).toBeCloseTo(0, 5);
  }
});

it("accounts for where the map sits on the page, and that its y runs up", () => {
  const points = landingPoints([road([0, 100], [1, 100])], { x: 0, y: 200, scale: 1 }, { left: 200, top: 0 }, 400, 400, 1)!;
  expect(points[0]).toBeCloseTo(0, 1);
  expect(points[1]).toBeCloseTo(0.5, 5);
});

it("gives longer roads more particles, and spreads them along every piece", () => {
  const points = landingPoints([road([0, 0], [10, 0]), road([0, 10], [50, 10], [90, 10])], { x: 0, y: 0, scale: 1 }, { left: 0, top: 0 }, 100, 100, 100)!;
  let onLong = 0;
  for (let i = 0; i < 100; i++) if (points[i * 3 + 1] !== 1) onLong++;
  expect(onLong).toBe(90);
  expect(Math.max(...Array.from({ length: 100 }, (_, i) => points[i * 3]))).toBeGreaterThan(0.7);
});

it("has nowhere to land without roads or a window", () => {
  expect(landingPoints([], { x: 0, y: 0, scale: 1 }, { left: 0, top: 0 }, 100, 100)).toBeNull();
  expect(landingPoints([road([0, 0], [1, 0])], { x: 0, y: 0, scale: 1 }, { left: 0, top: 0 }, 0, 100)).toBeNull();
});
