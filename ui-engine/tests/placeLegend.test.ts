// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { PLACE_KINDS, UNCLASSIFIED, hasMarker, placeInspection, placeKind } from "../src/mapModel";
import { demandDetail, demandSummary, placeCensus, placeLegend } from "../src/placeLegend";
import type { MapFeature } from "../src/types";

const at = { x_m: 0, y_m: 0, lat: 0, lon: 0 };
let n = 0;
function feature(category: string, tags: Record<string, string>, extra: Partial<MapFeature> = {}): MapFeature {
  n += 1;
  return { id: `node/${n}`, name: "", category, polygon: false, position: at, geometry: [at], tags, demand_type: null, ...extra };
}

describe("place taxonomy", () => {
  it("gives every kind a unique glyph", () => {
    const glyphs = [...PLACE_KINDS.map((k) => k.icon), UNCLASSIFIED.icon];
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("classifies from the most specific OpenStreetMap tag", () => {
    expect(placeKind(feature("yes", { building: "yes", shop: "mall" })).id).toBe("mall");
    expect(placeKind(feature("hospital", { amenity: "hospital" })).label).toBe("Hospital");
    expect(placeKind(feature("pharmacy", { amenity: "pharmacy" })).icon).toBe("+");
  });

  it("treats any other shop value as a shop", () => {
    // shop=clothes is demand-modelled by the core as a store.
    expect(placeKind(feature("clothes", { shop: "clothes" })).id).toBe("shops");
    expect(placeKind(feature("bakery", { shop: "bakery" })).id).toBe("shops");
  });

  it("leaves street furniture and transit lines unclassified", () => {
    for (const [category, tags] of [
      ["bench", { amenity: "bench" }],
      ["bicycle_parking", { amenity: "bicycle_parking" }],
      ["stop_position", { public_transport: "stop_position" }],
      ["tram", { railway: "tram" }],
      ["building", { building: "yes" }],
    ] as const)
      expect(placeKind(feature(category, tags)).group, category).toBe("other");
  });

  it("draws markers for points, and for footprints only when demand is modelled", () => {
    expect(hasMarker({ polygon: false })).toBe(true);
    expect(hasMarker({ polygon: true, demand_type: null })).toBe(false);
    expect(hasMarker({ polygon: true, demand_type: "office" })).toBe(true);
  });
});

describe("place legend", () => {
  const features = [
    feature("hospital", { amenity: "hospital" }, { id: "h1", demand_type: "store" }),
    feature("doctors", { amenity: "doctors" }, { id: "h2" }),
    feature("school", { amenity: "school" }, { id: "s1", demand_type: "school" }),
    feature("school", { amenity: "school" }, { id: "s2", demand_type: "school", polygon: true }),
    feature("park", { leisure: "park" }, { id: "p-footprint", polygon: true }),
    feature("bench", { amenity: "bench" }, { id: "b1" }),
    feature("bench", { amenity: "bench" }, { id: "b2" }),
  ];
  const census = placeCensus(features);

  it("lists only kinds that carry a marker, in taxonomy order", () => {
    expect(census.entries.map((e) => e.id)).toEqual(["hospital", "school", "unclassified"]);
    const hospital = census.entries[0];
    expect(hospital).toMatchObject({ count: 2, modelled: 1, demandTypes: ["Commercial"] });
  });

  it("hides unclassified places while their layer is off", () => {
    expect(placeLegend(census, [], false).map((e) => e.id)).toEqual(["hospital", "school"]);
    expect(placeLegend(census, [], true).map((e) => e.id)).toContain("unclassified");
  });

  it("reports the core's multipliers, and nothing for kinds it does not model", () => {
    const legend = placeLegend(
      census,
      [
        { feature_id: "h1", multiplier: 1.15, active: true, radius_m: 400 },
        { feature_id: "s1", multiplier: 1, active: false, radius_m: 400 },
        { feature_id: "s2", multiplier: 1.62, active: true, radius_m: 400 },
      ],
      true,
    );
    const byId = Object.fromEntries(legend.map((e) => [e.id, e]));
    expect(byId.school).toMatchObject({ raised: 1, peak: 1.62 });
    expect(demandSummary(byId.school)).toBe("Peak 1.62×");
    expect(demandSummary(byId.unclassified)).toBe("Not modelled");
    expect(byId.unclassified.peak).toBeNull();
    expect(demandDetail(byId.school)).toMatch(/All 2 have modelled school demand\. 1 currently raised, highest 1\.62×/);
  });

  it("describes modelled places at rest without inventing a figure", () => {
    const legend = placeLegend(census, [{ feature_id: "s1", multiplier: 1, active: false, radius_m: 400 }], false);
    const school = legend.find((e) => e.id === "school")!;
    expect(demandSummary(school)).toBe("At rest");
    expect(demandDetail(school)).toMatch(/base demand \(1\.00×\)/);
  });

  it("agrees with the hover card on kind and demand", () => {
    const school = features[2];
    const card = placeInspection(school, { multiplier: 1.62, active: true, radius_m: 400 });
    expect(card.category).toBe(census.entries.find((e) => e.id === "school")!.label);
    expect(card.status).toBe("Demand raised");
    expect(card.metrics).toContainEqual(["Demand model", "School"]);
    const bench = placeInspection(features[5], undefined);
    expect(bench.status).toBe("No modelled demand");
    expect(bench.category).toBe("Unclassified");
  });
});
