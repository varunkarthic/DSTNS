// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it, vi } from "vitest";
import { buildTiles, placeNameShows, sizeTier, streetNameShows, tierShows, tileOnScreen } from "../src/map/mapTiles";

class FakePath {
  added = 0;
  addPath() {
    this.added++;
  }
}
vi.stubGlobal("Path2D", FakePath);

const geo = (x: number, y: number, size = 10) => ({ path: new FakePath() as unknown as Path2D, minX: x, minY: y, maxX: x + size, maxY: y + size });

describe("tiles", () => {
  it("groups by place and style, so a screenful is a few strokes", () => {
    const items = Array.from({ length: 400 }, (_, i) => geo((i % 20) * 50, Math.floor(i / 20) * 50));
    const tiles = buildTiles(items, (g) => g, (_, i) => (i % 2 ? "a" : "b"));
    expect(tiles.length).toBeLessThanOrEqual(64);
    const added = tiles.flatMap((t) => [...t.batches.values()]).reduce((n, p) => n + (p as unknown as FakePath).added, 0);
    expect(added).toBe(400);
    expect(tiles.flatMap((t) => [...t.batches.keys()]).length).toBeLessThanOrEqual(128);
  });

  it("leaves out what has no style", () => {
    expect(buildTiles([geo(0, 0)], (g) => g, () => null)).toEqual([]);
  });

  it("knows what is on screen", () => {
    const tile = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(tileOnScreen(tile, { x: 0, y: 0, scale: 1 }, 500, 500)).toBe(true);
    expect(tileOnScreen(tile, { x: 1000, y: 0, scale: 1 }, 500, 500)).toBe(false);
  });
});

describe("detail by zoom", () => {
  it("leaves out buildings too small to see", () => {
    expect(sizeTier(geo(0, 0, 8))).toBe("small");
    expect(tierShows("small", 0.05)).toBe(false);
    expect(tierShows("large", 0.05)).toBe(true);
    expect(tierShows("small", 1)).toBe(true);
  });

  it("names important roads first as you zoom in", () => {
    expect(streetNameShows("primary", 0.2)).toBe(false);
    expect(streetNameShows("primary", 0.4)).toBe(true);
    expect(streetNameShows("residential", 0.4)).toBe(false);
    expect(streetNameShows("residential", 1)).toBe(true);
  });

  it("names landmarks before other places", () => {
    expect(placeNameShows(true, 1)).toBe(true);
    expect(placeNameShows(false, 1)).toBe(false);
    expect(placeNameShows(false, 1.5)).toBe(true);
  });
});
