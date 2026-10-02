// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { advect, particleBudget, sampleWind, spawn, windBounds } from "../src/windParticles";
import type { WindView } from "../src/types";

const wind = (u: number[], v: number[], width = 2, height = 2): WindView => ({
  enabled: true,
  solved: true,
  updated_s: 60,
  width,
  height,
  origin_x_m: 0,
  origin_y_m: 0,
  cell_m: 100,
  height_m: 10,
  background: { speed_mps: 3, from_deg: 270 },
  max_mps: 5,
  u,
  v,
});

describe("wind particles", () => {
  it("samples the wind at column centres and between them", () => {
    const w = wind([0, 4, 0, 4], [1, 1, 3, 3]);
    expect(sampleWind(w, 50, 50)).toEqual([0, 1]);
    expect(sampleWind(w, 150, 150)).toEqual([4, 3]);
    expect(sampleWind(w, 100, 100)).toEqual([2, 2]);
  });

  it("clamps to the edge outside the lattice", () => {
    const w = wind([0, 4, 0, 4], [1, 1, 3, 3]);
    expect(sampleWind(w, -500, 50)).toEqual([0, 1]);
    expect(sampleWind(w, 900, 900)).toEqual([4, 3]);
  });

  it("carries particles downwind", () => {
    const w = wind([2, 2, 2, 2], [0, 0, 0, 0]);
    const p = [{ x: 50, y: 100, age: 0, life: 100 }];
    const previous = advect(p, w, 0.5, 10);
    expect(previous[0]).toEqual([50, 100]);
    expect(p[0].x).toBeCloseTo(60);
    expect(p[0].y).toBeCloseTo(100);
  });

  it("reseeds particles that leave the lattice or grow old", () => {
    const w = wind([50, 50, 50, 50], [0, 0, 0, 0]);
    const p = [
      { x: 195, y: 100, age: 0, life: 100 },
      { x: 50, y: 50, age: 10, life: 10 },
    ];
    let n = 0;
    const random = () => [0.25, 0.75, 0.5, 0.5, 0.5, 0.5][n++ % 6];
    const previous = advect(p, w, 1, 1, random);
    const [x0, y0, x1, y1] = windBounds(w);
    for (const q of p) {
      expect(q.age).toBe(0);
      expect(q.x).toBeGreaterThanOrEqual(x0);
      expect(q.x).toBeLessThanOrEqual(x1);
      expect(q.y).toBeGreaterThanOrEqual(y0);
      expect(q.y).toBeLessThanOrEqual(y1);
    }
    // A reseeded particle starts its trail where it now is, not across the map.
    expect(previous[0]).toEqual([p[0].x, p[0].y]);
  });

  it("spawns inside the bounds and sizes the swarm to the viewport", () => {
    const s = spawn([0, 0, 200, 100], () => 0.5);
    expect(s.x).toBe(100);
    expect(s.y).toBe(50);
    expect(particleBudget(100)).toBe(200);
    expect(particleBudget(1600 * 1000)).toBeGreaterThan(1000);
    expect(particleBudget(1e9)).toBe(1400);
  });
});
