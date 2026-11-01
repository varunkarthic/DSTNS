// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { expect, it } from "vitest";
import { FILM_CHAPTERS, landingPoints } from "../src/BootScene";
import { sunHeight } from "../src/CommandRail";
import { BUILT_IN } from "../src/uiConfig";
import { filterPlaces, PLACE_FILTERS } from "../src/mapModel";

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

it("keeps every headline to one or two words, and nothing has a comma", () => {
  for (const chapter of FILM_CHAPTERS) {
    expect(chapter.title.split(" ").length).toBeLessThanOrEqual(2);
    expect(`${chapter.label}${chapter.title}${chapter.text}`).not.toContain(",");
    // It is a simulation: nothing may read as if it were happening now, or for real.
    expect(`${chapter.title} ${chapter.text}`).not.toMatch(/\b(real|live|realtime|real-time)\b/i);
  }
});

it("puts the sun on the horizon at six, highest at noon, lowest at midnight", () => {
  expect(sunHeight(0.25)).toBeCloseTo(0);
  expect(sunHeight(0.5)).toBeCloseTo(1);
  expect(sunHeight(0.75)).toBeCloseTo(0);
  expect(sunHeight(0)).toBeCloseTo(-1);
});

it("follows the device's appearance out of the box", () => {
  expect(BUILT_IN.accessibility.theme).toBe("system");
});

it("filters places, with modelled ones meaning those the core gives demand", () => {
  const place = (name: string, category: string, demand_type: string | null = null) => ({ id: name, name, category, polygon: false, tags: {}, demand_type }) as never;
  const modelled = PLACE_FILTERS.find((f) => f.id === "modelled")!;
  const school = place("Hill School", "school", "school");
  const cafe = place("Cafe", "restaurant");
  expect(modelled.test(school)).toBe(true);
  expect(modelled.test(cafe)).toBe(false);
  expect(PLACE_FILTERS.find((f) => f.id === "education")!.test(school)).toBe(true);
  expect(filterPlaces([place("B", "school"), place("A", "school"), place("A", "school")]).map((f: { name: string }) => f.name)).toEqual(["A", "B"]);
});
