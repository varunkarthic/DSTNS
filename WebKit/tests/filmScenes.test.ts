// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic
import { describe, expect, it } from "vitest";
import { FILM_CHAPTERS, nextFilmScene } from "../src/film/BootScene";

const at = (id: string) => FILM_CHAPTERS.findIndex((c) => c.id === id);
const always = () => true;
/** Every scene a round plays, in order, as the film would pick them. */
function round(choices: Parameters<typeof nextFilmScene>[1]) {
  const seen = new Set<number>();
  const order: string[] = [];
  for (;;) {
    const pick = nextFilmScene(seen, choices, always);
    if (!pick) return order;
    seen.add(pick);
    order.push(FILM_CHAPTERS[pick].id);
  }
}

describe("the start-up film's scenes", () => {
  it("play every scene once by default, WebFabric last", () => {
    const order = round({});
    expect(order).toHaveLength(FILM_CHAPTERS.length - 1);
    expect(order.at(-1)).toBe("webfabric");
    expect(new Set(order).size).toBe(order.length);
  });
  it("play only the scenes turned on, the first one first and the last one last", () => {
    const order = round({ allowed: ["streets", "weather", "cities", "signals"], first: "cities", last: "streets" });
    expect(order[0]).toBe("cities");
    expect(order.at(-1)).toBe("streets");
    expect([...order].sort()).toEqual(["cities", "signals", "streets", "weather"]);
  });
  it("ignore a first or last that is turned off, and with none, keep nothing back", () => {
    const order = round({ allowed: ["streets", "signals"], first: "weather", last: "none" });
    expect([...order].sort()).toEqual(["signals", "streets"]);
  });
  it("play nothing that does not fit the wait", () => {
    expect(nextFilmScene(new Set(), {}, () => false)).toBe(0);
    expect(nextFilmScene(new Set(), { first: "incidents" }, (i) => i === at("incidents"))).toBe(at("incidents"));
  });
});
