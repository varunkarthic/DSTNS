// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import source from "../src/bootScenes.ts?raw";
import { describe, expect, it } from "vitest";
import { DEMO_CHAPTERS, FILM_CHAPTERS, landingPoints, LANDING_MS, MAP_AT_MS, PANELS_AT_MS } from "../src/BootScene";
import { buildDemoFormations, buildFormations, COUNT, KIND, onLand, STRIDE } from "../src/bootScenes";
import { sunHeight } from "../src/CommandRail";
import { BUILT_IN } from "../src/uiConfig";
import { filterPlaces, PLACE_FILTERS } from "../src/mapModel";

const road = (...points: [number, number][]) => points.map(([x_m, y_m]) => ({ x_m, y_m }));

it("lands the particles on the roads, where the map has drawn them", () => {
  // One road along y = 0, drawn by the map from (100, 200) to (300, 200) in a 400 by 400 window.
  const points = landingPoints([road([0, 0], [100, 0], [200, 0])], { x: 100, y: 200, scale: 1 }, { left: 0, top: 0 }, 400, 400, 50)!;
  for (let i = 0; i < 50; i++) {
    expect(points[i * 4]).toBeGreaterThanOrEqual(-0.5);
    expect(points[i * 4]).toBeLessThanOrEqual(0.5);
    expect(points[i * 4 + 1]).toBeCloseTo(0, 5);
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
  for (let i = 0; i < 100; i++) if (points[i * 4 + 1] !== 1) onLong++;
  expect(onLong).toBe(90);
  expect(Math.max(...Array.from({ length: 100 }, (_, i) => points[i * 4]))).toBeGreaterThan(0.7);
});

it("builds the roads from the middle of the network outward", () => {
  const points = landingPoints([road([-100, 0], [100, 0])], { x: 200, y: 200, scale: 1 }, { left: 0, top: 0 }, 400, 400, 200)!;
  const at = (i: number) => ({ x: Math.abs(points[i * 4]), order: points[i * 4 + 3] });
  const middle = at(100);
  const end = at(0);
  expect(middle.x).toBeLessThan(end.x);
  expect(middle.order).toBeLessThan(0.15);
  expect(end.order).toBeGreaterThan(0.85);
});

it("arrives in order: the roads, then the map, then the panels", () => {
  expect(MAP_AT_MS).toBeLessThan(PANELS_AT_MS);
  expect(PANELS_AT_MS).toBeLessThan(LANDING_MS);
});

describe("the film's scenes", () => {
  // The film, then Demo Mode's scenes after it, which must be as distinct.
  const scenes = [...buildFormations(), ...buildDemoFormations()];
  // How a scene's particles are spread through space, at 1/6 of a unit.
  const field = (scene: Float32Array) => {
    const cells = new Map<string, number>();
    for (let i = 0; i < COUNT; i++) {
      const at = i * STRIDE;
      // These are placed by the shader, so where they start says nothing about the scene.
      if (scene[at + 7] === KIND.lane || scene[at + 7] === KIND.ridge || scene[at + 7] === KIND.sweep || scene[at + 7] === KIND.queue || scene[at + 7] === KIND.trip || scene[at + 7] === KIND.orb || scene[at + 7] === KIND.strand) continue;
      const key = `${Math.round(scene[at] * 6)},${Math.round(scene[at + 1] * 6)},${Math.round(scene[at + 2] * 6)}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    return cells;
  };
  const similar = (a: Map<string, number>, b: Map<string, number>) => {
    let both = 0;
    let lengthA = 0;
    let lengthB = 0;
    for (const [key, value] of a) {
      lengthA += value * value;
      both += value * (b.get(key) ?? 0);
    }
    for (const value of b.values()) lengthB += value * value;
    return both / Math.sqrt(lengthA * lengthB);
  };
  it("has a scene for each chapter, and fills every particle with a finite position", () => {
    expect(scenes).toHaveLength(FILM_CHAPTERS.length + DEMO_CHAPTERS.length);
    for (const scene of scenes) {
      expect(scene).toHaveLength(COUNT * STRIDE);
      for (let i = 0; i < scene.length; i++) if (!Number.isFinite(scene[i])) throw new Error(`bad value at ${i}`);
    }
  });
  it("never repeats a layout", () => {
    const fields = scenes.map(field);
    for (let a = 1; a < fields.length; a++)
      for (let b = a + 1; b < fields.length; b++) expect(similar(fields[a], fields[b]), `scenes ${a} and ${b}`).toBeLessThan(0.7);
  });
  it("keeps every scene moving while it holds", () => {
    for (const scene of scenes.slice(1)) {
      const kinds = new Set<number>();
      for (let i = 0; i < COUNT; i++) kinds.add(scene[i * STRIDE + 7]);
      kinds.delete(KIND.rest);
      expect(kinds.size).toBeGreaterThan(0);
    }
  });
  it("draws no words or numbers: the name is the only text the particles ever form", () => {
    expect(source).not.toMatch(/fillText|strokeText|measureText/);
  });
  it("knows land from sea", () => {
    expect(onLand(10, 50)).toBe(true);
    expect(onLand(-100, 40)).toBe(true);
    expect(onLand(-30, 30)).toBe(false);
    expect(onLand(-150, 0)).toBe(false);
  });
});

it("has nowhere to land without roads or a window", () => {
  expect(landingPoints([], { x: 0, y: 0, scale: 1 }, { left: 0, top: 0 }, 100, 100)).toBeNull();
  expect(landingPoints([road([0, 0], [1, 0])], { x: 0, y: 0, scale: 1 }, { left: 0, top: 0 }, 0, 100)).toBeNull();
});

it("keeps every headline to one or two words, and nothing has a comma", () => {
  for (const chapter of [...FILM_CHAPTERS, ...DEMO_CHAPTERS]) {
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
