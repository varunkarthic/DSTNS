// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { autoSeries, contrast, dashOf, heldOver, legibleColour, PERSON_HOLDS_CAMERA_MS, releaseKey, viewDeclined, viewTarget } from "../src/webfabric/direction";
import type { Held } from "../src/webfabric/direction";

const held = (app: string, revision: number, layers: Record<string, boolean>, places: Record<string, boolean> = {}): Held => ({ app, name: app.toUpperCase(), revision, layers, places });

describe("what applications hold", () => {
  const own = { traffic: true, weather: false };
  it("lays it over a person's choice, and does not change that choice", () => {
    const mine = { ...own };
    const { shown, holders } = heldOver(mine, [held("a", 1, { traffic: false, weather: true })], "layers", new Map(), false);
    expect(shown).toEqual({ traffic: false, weather: true });
    expect(holders).toEqual({ traffic: "A", weather: "A" });
    expect(mine).toEqual(own);
  });
  it("gives the same result each time: the later application wins", () => {
    const { shown, holders } = heldOver(own, [held("a", 1, { traffic: false }), held("b", 2, { traffic: true })], "layers", new Map(), false);
    expect(shown.traffic).toBe(true);
    expect(holders.traffic).toBe("B");
  });
  it("lets a person take a layer back, until the application asks again", () => {
    const released = new Map([[releaseKey("a", "layers", "traffic"), 1]]);
    expect(heldOver(own, [held("a", 1, { traffic: false })], "layers", released, false).shown.traffic).toBe(true);
    expect(heldOver(own, [held("a", 2, { traffic: false })], "layers", released, false).shown.traffic).toBe(false);
  });
  it("does not let it bring back what was cut to keep up", () => {
    const { shown, holders } = heldOver(own, [held("a", 1, { weather: true, traffic: false })], "layers", new Map(), true);
    expect(shown).toEqual({ traffic: false, weather: false });
    expect(holders.weather).toBeUndefined();
  });
  it("treats a place not mentioned as shown, as a person's own places do", () => {
    const places = {} as Record<string, boolean>;
    expect(heldOver(places, [held("a", 1, {}, { school: true })], "places", new Map(), true, true).shown.school).toBe(true);
    expect(heldOver(places, [held("a", 1, {}, { school: false })], "places", new Map(), false, true).shown.school).toBe(false);
  });
});

describe("a request to move the map", () => {
  it("gives way to a person, then is allowed again", () => {
    expect(viewDeclined(1000, 0, null)).toBe("person_moved_the_map");
    expect(viewDeclined(PERSON_HOLDS_CAMERA_MS + 1, 0, null)).toBeNull();
  });
  it("gives way to whatever is on screen", () => {
    expect(viewDeclined(1e9, 0, "tutorial")).toBe("tutorial");
  });
});

describe("where a request means", () => {
  const world = {
    nodes: [{ id: 3, position: { x_m: 10, y_m: 20 } }],
    edges: [{ id: 5, geometry: [{ x_m: 0, y_m: 0 }, { x_m: 100, y_m: 40 }] }],
  };
  it("finds a junction and a road, in the world on screen", () => {
    expect(viewTarget({ action: "node", node: 3, span_m: 200 }, world)).toEqual({ x_m: 10, y_m: 20, span_m: 200 });
    expect(viewTarget({ action: "edge", edge: 5 }, world)).toEqual({ bounds: { minX: 0, maxX: 100, minY: 0, maxY: 40 } });
    expect(viewTarget({ action: "edge", edge: 5, span_m: 50 }, world)).toEqual({ x_m: 50, y_m: 20, span_m: 50 });
  });
  it("has nothing to offer for what is no longer there", () => {
    expect(viewTarget({ action: "node", node: 99 }, world)).toBeNull();
    expect(viewTarget({ action: "edge", edge: 99 }, world)).toBeNull();
    expect(viewTarget({ action: "node", node: 3 }, null)).toBeNull();
  });
  it("needs no world for the rest", () => {
    expect(viewTarget({ action: "fit" }, null)).toEqual({ whole: true });
    expect(viewTarget({ action: "zoom", factor: 2 }, null)).toEqual({ zoomBy: 2 });
    expect(viewTarget({ action: "bounds", min_x_m: 1, min_y_m: 2, max_x_m: 3, max_y_m: 4 }, null)).toEqual({ bounds: { minX: 1, maxX: 3, minY: 2, maxY: 4 } });
  });
});

describe("colour", () => {
  const dark = "#0b1620";
  const light = "#eef2f5";
  it("is the same every time for the same mark, and in range", () => {
    expect(autoSeries("com.a", "x")).toBe(autoSeries("com.a", "x"));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(autoSeries("com.a", `route-${i}`));
    expect(seen.size).toBe(8);
    expect([...seen].every((n) => n >= 0 && n < 8)).toBe(true);
  });
  it("leaves alone a colour that can already be seen", () => {
    expect(legibleColour("#37d7ff", dark)).toBe("#37d7ff");
  });
  it("moves a colour that cannot be seen, in either theme, by as little as it takes", () => {
    for (const [colour, ground] of [["#101820", dark], ["#000000", dark], ["#f0f0f0", light], ["#ffffff", light], ["#808080", "#808080"]]) {
      const drawn = legibleColour(colour, ground);
      expect(contrast(drawn, ground), `${colour} on ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });
  it("gives way to a colour vision mode", () => {
    const series = ["#56b4e9", "#e69f00", "#009e73"];
    expect(legibleColour("#ff0000", dark, series)).toBe("#e69f00");
    expect(series).toContain(legibleColour("#123456", dark, series));
  });
  it("has a dash for each style", () => {
    expect(dashOf("solid")).toEqual([]);
    expect(dashOf(undefined, true)).toEqual([5, 6]);
    expect(dashOf("flow").length).toBe(2);
    expect(dashOf("dotted")[0]).toBeLessThan(1);
  });
});
