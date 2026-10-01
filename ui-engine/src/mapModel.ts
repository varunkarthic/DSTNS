// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import type {
  EdgeState,
  Topology,
  Inspection,
  TopologyEdge,
  Point,
} from "./types";
export const stateColors = {
  flooded: "#4ba9ff",
  blocked: "#ff6577",
  severe: "#ff6577",
  moderate: "#ffca66",
  clear: "#57d9b0",
};
export function roadState(s?: EdgeState): keyof typeof stateColors {
  if (!s) return "clear";
  if (s.flood > 0.01) return "flooded";
  if (s.closed) return "blocked";
  if (s.congestion >= 0.7) return "severe";
  if (s.congestion >= 0.35) return "moderate";
  return "clear";
}
/**
 * A road's display name: its real name, else what kind of road it is.
 * "Service road" tells the reader something; "Unnamed service" does not.
 */
export function roadTitle(edge: { name: string; road_class: string }): string {
  if (edge.name?.trim()) return edge.name.trim();
  const kind = edge.road_class.replace(/_/g, " ");
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  return /road|street|link|way/i.test(label) ? label : `${label} road`;
}

export function roadInspection(
  e: TopologyEdge,
  s: EdgeState | undefined,
  t: Topology,
): Inspection {
  const causes: string[] = [];
  if (s?.flood && s.flood > 0.01)
    causes.push(`Flood level ${(s.flood * 100).toFixed(0)}%`);
  if (s?.incident_closed || (s && s.incident_speed_multiplier < 1))
    causes.push("Simulated incident");
  if (s?.rainfall && s.rainfall > 0.01)
    causes.push(`Rain intensity ${(s.rainfall * 100).toFixed(0)}%`);
  if (s && s.signal_multiplier < 1) causes.push("Traffic signal");
  if (s?.demand_causes?.length)
    causes.push(
      "Demand: " +
        s.demand_causes
          .map((id) => t.features.find((f) => f.id === id)?.name || id)
          .slice(0, 3)
          .join(", "),
    );
  return {
    title: roadTitle(e),
    category: `Road · E-${e.id}`,
    status: s ? roadState(s) : "State unavailable",
    description: causes.join(" · ") || "No active effects recorded.",
    metrics: [
      ["Speed", s ? `${(s.mean_speed_mps * 3.6).toFixed(1)} km/h` : "Unavailable"],
      ["Free flow", `${(e.free_speed_mps * 3.6).toFixed(1)} km/h`],
      ["Congestion", s ? `${(s.congestion * 100).toFixed(0)}%` : "Unavailable"],
      ["Vehicles", String(s?.vehicle_count ?? "Unavailable")],
      ["Demand", s ? `${s.demand_vph.toFixed(0)} veh/h` : "Unavailable"],
      ["Length", `${e.length_m.toFixed(0)} m`],
    ],
  };
}
export function distanceToSegment(
  x: number,
  y: number,
  a: number,
  b: number,
  c: number,
  d: number,
) {
  const dx = c - a,
    dy = d - b;
  const p = Math.max(
    0,
    Math.min(1, ((x - a) * dx + (y - b) * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(x - a - p * dx, y - b - p * dy);
}

export function insideFootprint(x: number, y: number, points: Point[]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i],
      b = points[j];
    if (
      -a.y_m > y !== -b.y_m > y &&
      x < ((b.x_m - a.x_m) * (y + a.y_m)) / (a.y_m - b.y_m) + a.x_m
    )
      inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Places
//
// The core reports a feature's `category` as the raw OpenStreetMap tag value,
// which is whatever a mapper happened to type: "company", "retail",
// "apartments", "kindergarten". Normalising it here gives every place a short
// human name and one glyph, so an unnamed building reads as "School" rather
// than "Unnamed kindergarten".
//
// This taxonomy is presentation only. Whether a place has modelled demand is
// decided by the core and reported per feature as `demand_type` (school,
// office, mall or store); it is never inferred from the kind here.
// ---------------------------------------------------------------------------

export interface PlaceKind {
  /** Stable identifier, used by the legend and tests. */
  id: string;
  label: string;
  /** One-character glyph drawn on the map marker. Unique per kind. */
  icon: string;
  /** "other" kinds are drawn as plain dots and sit behind their own layer. */
  group: "place" | "other";
}

/** Kinds in legend order. Each glyph appears exactly once. */
export const PLACE_KINDS: readonly (PlaceKind & { pattern: RegExp })[] = [
  { id: "hospital", label: "Hospital", icon: "H", group: "place", pattern: /^(hospital|clinic|doctors)$/ },
  { id: "school", label: "School", icon: "S", group: "place", pattern: /^(school|kindergarten|childcare)$/ },
  { id: "university", label: "University", icon: "U", group: "place", pattern: /^(university|college)$/ },
  { id: "office", label: "Office", icon: "O", group: "place", pattern: /^(office|offices|company|commercial|government|bank|townhall|courthouse)$/ },
  { id: "mall", label: "Shopping Mall", icon: "M", group: "place", pattern: /^(mall|shopping_centre|shopping_center|marketplace|department_store)$/ },
  { id: "shops", label: "Shops", icon: "R", group: "place", pattern: /^(supermarket|convenience|retail)$/ },
  { id: "food", label: "Food and Drink", icon: "F", group: "place", pattern: /^(restaurant|cafe|fast_food|bar|pub|food_court)$/ },
  { id: "transport", label: "Transport Hub", icon: "T", group: "place", pattern: /^(station|bus_station|railway|train_station|subway|halt|platform)$/ },
  { id: "hotel", label: "Hotel", icon: "L", group: "place", pattern: /^(hotel|hostel|guest_house)$/ },
  { id: "culture", label: "Culture", icon: "C", group: "place", pattern: /^(museum|library|theatre|cinema|arts_centre|gallery)$/ },
  { id: "stadium", label: "Sports Venue", icon: "A", group: "place", pattern: /^(stadium|sports_centre|sports_center|arena)$/ },
  { id: "pharmacy", label: "Pharmacy", icon: "+", group: "place", pattern: /^(pharmacy|chemist)$/ },
  { id: "worship", label: "Place of Worship", icon: "W", group: "place", pattern: /^(church|place_of_worship|mosque|synagogue|temple)$/ },
  { id: "industrial", label: "Industrial", icon: "I", group: "place", pattern: /^(industrial|warehouse|works|factory)$/ },
  { id: "park", label: "Park", icon: "P", group: "place", pattern: /^(park|garden|playground|pitch|recreation_ground|grass|forest)$/ },
  { id: "parking", label: "Parking", icon: "K", group: "place", pattern: /^(parking|garage|garages|fuel)$/ },
  { id: "residential", label: "Residential", icon: "·", group: "other", pattern: /^(residential|apartments|house|detached|dormitory|terrace)$/ },
];

/** OpenStreetMap features with no DSTNS place type: benches, stops, rail lines. */
export const UNCLASSIFIED: PlaceKind = { id: "unclassified", label: "Unclassified", icon: "•", group: "other" };

const GENERIC = new Set(["building", "yes", "", "landuse", "leisure", "amenity"]);
const strip = ({ pattern: _pattern, ...kind }: PlaceKind & { pattern: RegExp }): PlaceKind => kind;

export function placeKind(feature: {
  category: string;
  tags?: Record<string, string>;
}): PlaceKind {
  // The most specific tag wins: a building=yes tagged shop=mall is a mall.
  const candidates = [
    feature.tags?.amenity,
    feature.tags?.shop,
    feature.tags?.office ? "office" : undefined,
    feature.tags?.tourism,
    feature.tags?.railway,
    feature.tags?.public_transport,
    feature.tags?.leisure,
    feature.tags?.landuse,
    feature.tags?.building,
    feature.category,
  ];
  for (const value of candidates) {
    if (!value || GENERIC.has(value)) continue;
    for (const kind of PLACE_KINDS) if (kind.pattern.test(value)) return strip(kind);
  }
  // Any other shop=* value (clothes, bakery, hairdresser) is still a shop.
  const shop = feature.tags?.shop;
  if (shop && !GENERIC.has(shop)) return strip(PLACE_KINDS.find((k) => k.id === "shops")!);
  return UNCLASSIFIED;
}

/**
 * Whether a feature is drawn as a map marker at all. Points and lines are;
 * footprints are drawn as shapes and only carry a marker when the core models
 * demand for them.
 */
export function hasMarker(feature: { polygon: boolean; demand_type?: string | null }): boolean {
  return !feature.polygon || !!feature.demand_type;
}

/** The core's demand types, as the legend names them. */
export const DEMAND_TYPE_LABEL: Record<string, string> = {
  school: "School",
  office: "Office",
  mall: "Retail",
  store: "Commercial",
};

/**
 * What a place's hover card says. The kind and demand wording match the place
 * legend exactly, so the two never disagree.
 */
export function placeInspection(
  feature: { id: string; name: string; category: string; polygon: boolean; tags?: Record<string, string>; demand_type?: string | null },
  demand: { multiplier: number; active: boolean; radius_m: number } | undefined,
): Inspection {
  const kind = placeKind(feature);
  const modelled = feature.demand_type ? DEMAND_TYPE_LABEL[feature.demand_type] ?? feature.demand_type : null;
  return {
    title: placeTitle(feature),
    category: kind.label,
    status: !modelled ? "No modelled demand" : demand?.active ? "Demand raised" : "Baseline demand",
    description: feature.id,
    metrics: modelled
      ? [
          ["Demand model", modelled],
          ["Demand multiplier", `${(demand?.multiplier ?? 1).toFixed(2)}×`],
          ["Influence radius", demand ? `${demand.radius_m} m` : "Unavailable"],
        ]
      : [
          ["OSM tag", feature.category.replace(/_/g, " ")],
          ["Geometry", feature.polygon ? "OSM footprint" : "OSM point"],
        ],
  };
}

/** A place's display title: its real name, else what kind of place it is. */
export function placeTitle(feature: {
  name: string;
  category: string;
  tags?: Record<string, string>;
}): string {
  return feature.name?.trim() || placeKind(feature).label;
}

// Demand colour ramp. A modelled place idles white, warms through amber as
// demand builds, peaks red, then cools back the same way as the window closes.
// Because the underlying multiplier follows a raised cosine, the visible
// progression is white -> orange -> red -> orange -> white on its own.
export function demandColor(multiplier: number): string {
  const t = Math.max(0, Math.min(1, (multiplier - 1) / 0.9));
  if (t <= 0.02) return "#dce8f2";
  const stops: [number, [number, number, number]][] = [
    [0.0, [220, 232, 242]],
    [0.45, [255, 185, 56]],
    [1.0, [255, 91, 101]],
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 1; i < stops.length; i++)
    if (t <= stops[i][0]) { lo = stops[i - 1]; hi = stops[i]; break; }
  const span = hi[0] - lo[0] || 1;
  const k = (t - lo[0]) / span;
  const mix = lo[1].map((c, i) => Math.round(c + (hi[1][i] - c) * k));
  return `rgb(${mix[0]} ${mix[1]} ${mix[2]})`;
}
