// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { expect, it } from "vitest";
import { localName, localiseNames } from "../src/core/labelLanguage";
import { BUILT_IN, mergeConfig } from "../src/core/uiConfig";
import type { Topology } from "../src/core/types";

it("names a road or place in the chosen language where the map has it, and as the map names it otherwise", () => {
  const tags = { name: "Mumbai Central", "name:hi": "मुंबई सेंट्रल" };
  expect(localName(tags, "Mumbai Central", "hi")).toBe("मुंबई सेंट्रल");
  expect(localName(tags, "Mumbai Central", "fr")).toBe("Mumbai Central");
  expect(localName(tags, "Mumbai Central", "local")).toBe("Mumbai Central");
  expect(localName({ "name:en": "  " }, "Straße", "en")).toBe("Straße");
});

it("changes only names, and nothing at all for local", () => {
  const topology = {
    edges: [{ id: 1, name: "Unter den Linden", tags: { "name:en": "Under the Lindens" } }, { id: 2, name: "B2", tags: {} }],
    features: [{ id: "p", name: "Rotes Rathaus", tags: { "name:en": "Red City Hall" } }],
    graph_hash: "h",
  } as unknown as Topology;
  expect(localiseNames(topology, "local")).toBe(topology);
  const english = localiseNames(topology, "en");
  expect(english.edges.map((e) => e.name)).toEqual(["Under the Lindens", "B2"]);
  expect(english.edges[1]).toBe(topology.edges[1]);
  expect(english.features[0].name).toBe("Red City Hall");
  expect(english.graph_hash).toBe("h");
});

it("reads the setting from ui-config, keeping local for anything it does not know", () => {
  expect(mergeConfig(BUILT_IN, { display: { label_language: "ja" } }).display.label_language).toBe("ja");
  expect(mergeConfig(BUILT_IN, { display: { label_language: "klingon" } }).display.label_language).toBe("local");
});
