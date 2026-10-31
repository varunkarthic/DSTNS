// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { placeInspection, popularPlaces, searchPlaces } from "../src/mapModel";
import { formatBytes, rateUnit, setByteUnits } from "../src/units";
import { fluidFrame } from "../src/FluidPanel";

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

describe("the fluid panel's shape", () => {
  const H = 430, W = 392, Y = 400;
  it("starts as a bead at the icon, inside the dock's edge", () => {
    const f = fluidFrame(0, H, W, Y);
    expect(f.shiftX).toBeLessThan(0);
    expect(H - f.top - f.bottom).toBeCloseTo(42, 0);
    expect(W - f.right).toBeCloseTo(42, 0);
    expect(f.content).toBe(0);
  });
  it("has a neck while it is leaving, and has let go by the time it is big", () => {
    expect(fluidFrame(0.2, H, W, Y).neck).toBeGreaterThan(0);
    expect(fluidFrame(0.7, H, W, Y).neck).toBe(0);
  });
  it("grows from the bottom up, and ends as the whole panel", () => {
    const mid = fluidFrame(0.4, H, W, Y);
    expect(mid.top).toBeGreaterThan(mid.bottom);
    const end = fluidFrame(1, H, W, Y);
    expect([end.top, end.bottom, end.right, end.shiftX]).toEqual([0, 0, 0, 0]);
    expect(end.content).toBe(1);
  });
  it("tolerates overshoot past the end", () => {
    const over = fluidFrame(1.04, H, W, Y);
    expect(over.top).toBe(0);
    expect(over.right).toBe(0);
  });
});
