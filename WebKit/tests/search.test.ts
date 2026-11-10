// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { placeInspection, popularPlaces, searchPlaces } from "../src/core/mapModel";
import { formatBytes, rateUnit, setByteUnits } from "../src/core/units";
import { budFrame, budShape } from "../src/CoreMotion/bud";

const place = (id: string, name: string, amenity: string) => ({ id, name, category: amenity, polygon: false, tags: { amenity }, position: { x_m: 0, y_m: 0 } });
const world = [
  place("1", "Central Hospital", "hospital"),
  place("2", "North Hospital", "hospital"),
  place("3", "West Hospital", "hospital"),
  place("4", "Humboldt University", "university"),
  place("5", "Central School", "school"),
  place("6", "", "hospital"),
  place("7", "Corner Bench", "bench"),
];

describe("popular places", () => {
  const popular = popularPlaces(world);
  it("are named, and only a few of each kind", () => {
    expect(popular.every((p) => p.name)).toBe(true);
    expect(popular.filter((p) => p.tags.amenity === "hospital")).toHaveLength(2);
  });
  it("lead with what people look for", () => {
    expect(popular[0].tags.amenity).toBe("hospital");
    expect(popular.map((p) => p.name)).not.toContain("Corner Bench");
  });
});

describe("live search", () => {
  it("ranks a name's start, then a word's start, then anywhere", () => {
    const names = (q: string) => searchPlaces([place("a", "Mid Central", "school"), place("b", "Central Park", "park"), place("c", "Decentral", "school")], q).map((p) => p.name);
    expect(names("central")).toEqual(["Central Park", "Mid Central", "Decentral"]);
  });
  it("finds places by kind, ignores case and edge spaces, and is empty for nothing", () => {
    expect(searchPlaces(world, "  HOSPITAL ").map((p) => p.name)).toContain("North Hospital");
    expect(searchPlaces(world, "   ")).toEqual([]);
    expect(searchPlaces(world, "zzz")).toEqual([]);
  });
});

describe("the hover card", () => {
  it("says what a place is and how busy, without identifiers up front", () => {
    const card = placeInspection({ ...place("way/3453", "Central School", "school"), demand_type: "school" } as never, { multiplier: 1.7, active: true, radius_m: 400 });
    expect(card).toMatchObject({ title: "Central School", category: "School", description: "Very busy right now" });
    expect(card.level).toBeCloseTo(0.7);
    expect(card.description).not.toMatch(/way\//);
    expect(card.technical?.find(([k]) => k === "Identifier")?.[1]).toBe("way/3453");
  });
});

describe("data sizes", () => {
  it("default to base 10, and can be base 2", () => {
    setByteUnits("decimal");
    expect(formatBytes(5_000_000)).toBe("5.0 MB");
    expect(rateUnit(5_000_000).unit).toBe("MB/s");
    setByteUnits("binary");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(rateUnit(5 * 1024 * 1024)).toEqual({ unit: "MiB/s", divisor: 1024 * 1024 });
    setByteUnits("decimal");
  });
});

describe("a panel dividing from its parent", () => {
  const U = 392, V = 430, A = 300, GAP = 12, R = 24;
  const at = (t: number) => budFrame(t, U, V, A, GAP, R);
  it("starts as a bead inside the parent's edge, at the control", () => {
    const f = at(0);
    expect(f.body.u1).toBeLessThanOrEqual(0);
    expect(f.body.v1 - f.body.v0).toBeCloseTo(44, 0);
    expect((f.body.v0 + f.body.v1) / 2).toBeCloseTo(A, 5);
    expect(f.content).toBe(0);
  });
  it("is joined by a neck that thins, parts, and is drawn back in", () => {
    const joined = at(0.25);
    expect(joined.neck.waist).toBeGreaterThan(0);
    expect(joined.neck.tipParent).toBe(joined.neck.tipDrop);
    const parted = at(0.6);
    expect(parted.neck.waist).toBe(0);
    expect(parted.neck.tipDrop).toBeGreaterThan(parted.neck.tipParent);
    expect(at(0.8).neck.gone).toBe(true);
  });
  it("only ever grows, and ends as the whole panel", () => {
    let last = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const { body } = at(t);
      expect(body.u1).toBeGreaterThanOrEqual(last - 1e-9);
      expect(body.v0).toBeGreaterThanOrEqual(-1e-9);
      expect(body.v1).toBeLessThanOrEqual(V + 1e-9);
      last = body.u1;
    }
    const end = at(1);
    expect([end.body.u0, end.body.u1, end.body.v0, end.body.v1, end.body.r]).toEqual([GAP, GAP + U, 0, V, R]);
    expect(end.content).toBe(1);
  });
  it("draws the same shape in every direction, with no broken numbers", () => {
    for (const dir of ["right", "left", "up", "down"] as const) {
      for (let t = 0.01; t < 1; t += 0.03) {
        const shape = budShape(t, { dir, wall: 500, anchor: 300, rect: { left: 512, top: 100, width: 300, height: 400 }, radius: R }, GAP);
        expect(shape.d).not.toMatch(/NaN|Infinity/);
        expect(shape.clip).not.toMatch(/NaN|-\d/);
      }
    }
  });
});
