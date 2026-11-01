// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { appearance } from "./appearance";
import { SPRINGS, stepSpring } from "./motion";
import type {
  EdgeState,
  Topology,
  Inspection,
  TopologyEdge,
  WeatherState,
  Point,
} from "./types";
export const stateColors = {
  get flooded() { return appearance.meaning.flooded; },
  get blocked() { return appearance.meaning.severe; },
  get severe() { return appearance.meaning.severe; },
  get moderate() { return appearance.meaning.moderate; },
  get clear() { return appearance.meaning.clear; },
};

export interface RainCell { x: number; y: number; r: number; alpha: number; vx: number; vy: number; vr: number; va: number; live: boolean; intensity: number; source: WeatherState }
export type RainCells = Map<number, RainCell>;
const RAIN_SPRING = { k: 48, c: 14 };

/**
 * Rain cells as they are drawn. The core publishes a position and radius once a
 * second; each cell chases them on a spring, opens from nothing when it starts and
 * fades as it ends. `dt` of 1000 means no animation: reduced motion.
 */
export function stepRainCells(cells: RainCells, weather: readonly WeatherState[], dt: number) {
  const seen = new Set<number>();
  for (const w of weather) {
    seen.add(w.id);
    const cell = cells.get(w.id);
    if (cell) {
      cell.live = true;
      cell.source = w;
      cell.intensity = w.intensity;
    } else {
      cells.set(w.id, { x: w.x_m, y: w.y_m, r: 0, alpha: 0, vx: 0, vy: 0, vr: 0, va: 0, live: true, intensity: w.intensity, source: w });
    }
  }
  const drawn: (WeatherState & { alpha: number; moving: boolean })[] = [];
  for (const [id, cell] of cells) {
    if (!seen.has(id)) cell.live = false;
    const s = cell.source;
    const goalR = cell.live ? s.radius_m : s.radius_m * 1.06;
    const goalA = cell.live ? 1 : 0;
    if (dt >= 1000) {
      cell.x = s.x_m; cell.y = s.y_m; cell.r = goalR; cell.alpha = goalA;
    } else {
      [cell.x, cell.vx] = stepSpring(cell.x, cell.vx, s.x_m, RAIN_SPRING, dt);
      [cell.y, cell.vy] = stepSpring(cell.y, cell.vy, s.y_m, RAIN_SPRING, dt);
      [cell.r, cell.vr] = stepSpring(cell.r, cell.vr, goalR, RAIN_SPRING, dt);
      [cell.alpha, cell.va] = stepSpring(cell.alpha, cell.va, goalA, SPRINGS.effectsSlow, dt);
    }
    if (!cell.live && cell.alpha < 0.01) {
      cells.delete(id);
      continue;
    }
    const moving = dt < 1000 && (Math.abs(cell.vx) + Math.abs(cell.vy) + Math.abs(cell.vr) > 0.5 || Math.abs(cell.va) > 0.01 || Math.abs(cell.r - goalR) > 0.5);
    drawn.push({ ...s, x_m: cell.x, y_m: cell.y, radius_m: Math.max(1, cell.r), intensity: cell.intensity, alpha: Math.max(0, Math.min(1, cell.alpha)), moving });
  }
  return drawn;
}
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
          .map((id) => t.features.find((f) => f.id === id)?.name || "an unnamed place")
          .slice(0, 3)
          .join(", "),
    );
  return {
    title: roadTitle(e),
    category: "Road",
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
  const multiplier = demand?.multiplier ?? 1;
  const busy = multiplier >= 1.6 ? "Very busy right now" : multiplier >= 1.25 ? "Busier than usual right now" : multiplier > 1.03 ? "A little busy right now" : "Quiet right now";
  return {
    title: placeTitle(feature),
    category: kind.label,
    kind: kind.id,
    status: modelled ? (demand?.active ? "Demand raised" : "Normal") : undefined,
    description: modelled ? busy : undefined,
    level: modelled ? Math.max(0, Math.min(1, multiplier - 1)) : undefined,
    metrics: modelled
      ? [
          ["Demand model", modelled],
          ["Demand multiplier", `${multiplier.toFixed(2)}×`],
          ["Influence radius", demand ? `${demand.radius_m} m` : "Unavailable"],
        ]
      : undefined,
    technical: [
      ["Identifier", feature.id],
      ["OSM tag", feature.category.replace(/_/g, " ")],
      ["Geometry", feature.polygon ? "OSM footprint" : "OSM point"],
    ],
  };
}

/** Well-known kinds first: what someone is likeliest to be looking for in a district. */
const POPULAR_ORDER = ["station", "transport", "hospital", "university", "mall", "museum", "culture", "park", "hotel", "school", "worship", "food"];
const popularity = (id: string) => {
  const rank = POPULAR_ORDER.findIndex((name) => id.includes(name));
  return rank < 0 ? POPULAR_ORDER.length : rank;
};

type Searchable = { id: string; name: string; category: string; tags?: Record<string, string> };

/** Places worth offering before anyone has typed: named ones, a few of each kind. */
export function popularPlaces<T extends Searchable>(features: readonly T[], limit = 8): T[] {
  const named = features.filter((f) => f.name?.trim() && placeKind(f).group === "place");
  const perKind = new Map<string, number>();
  const seen = new Set<string>();
  return [...named]
    .sort((a, b) => popularity(placeKind(a).id) - popularity(placeKind(b).id) || a.name.localeCompare(b.name))
    .filter((f) => {
      const key = f.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      const kind = placeKind(f).id;
      const taken = perKind.get(kind) ?? 0;
      if (taken >= 2) return false;
      seen.add(key);
      perKind.set(kind, taken + 1);
      return true;
    })
    .slice(0, limit);
}

type Filterable = Searchable & { demand_type?: string | null };
const ofKinds = (...ids: string[]) => (feature: Filterable) => ids.includes(placeKind(feature).id);

/** The ways the search can be narrowed. Modelled means the core gives it a demand schedule. */
export const PLACE_FILTERS: readonly { id: string; label: string; hint: string; test: (feature: Filterable) => boolean }[] = [
  { id: "all", label: "All", hint: "Every place", test: () => true },
  { id: "modelled", label: "Modelled", hint: "Places that affect traffic in the model", test: (feature) => !!feature.demand_type },
  { id: "health", label: "Health", hint: "Hospitals and pharmacies", test: ofKinds("hospital", "pharmacy") },
  { id: "education", label: "Education", hint: "Schools and universities", test: ofKinds("school", "university") },
  { id: "work", label: "Work", hint: "Offices and industry", test: ofKinds("office", "industrial") },
  { id: "shopping", label: "Shopping", hint: "Malls and shops", test: ofKinds("mall", "shops") },
  { id: "food", label: "Food", hint: "Food and drink", test: ofKinds("food") },
  { id: "transport", label: "Transport", hint: "Transport hubs and parking", test: ofKinds("transport", "parking") },
  { id: "leisure", label: "Leisure", hint: "Culture, sport, parks and hotels", test: ofKinds("culture", "stadium", "park", "hotel") },
];

/** Everything in a filter, named places first. */
export function filterPlaces<T extends Searchable>(features: readonly T[], limit = 60): T[] {
  const seen = new Set<string>();
  const named = [...features]
    .filter((f) => f.name?.trim())
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((f) => {
      const key = f.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return [...named, ...features.filter((f) => !f.name?.trim())].slice(0, limit);
}

/** Live results: names that begin with the query, then words that do, then the rest. */
export function searchPlaces<T extends Searchable>(features: readonly T[], query: string, limit = 60): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const scored: { feature: T; score: number; name: string }[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    const name = feature.name?.trim().toLowerCase() ?? "";
    const kind = placeKind(feature).label.toLowerCase();
    let score = -1;
    if (name.startsWith(needle)) score = 0;
    else if (name.split(/[\s-]+/).some((word) => word.startsWith(needle))) score = 1;
    else if (name.includes(needle)) score = 2;
    else if (name && kind.includes(needle)) score = 3;
    if (score < 0 || seen.has(name)) continue;
    seen.add(name);
    scored.push({ feature, score, name });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((entry) => entry.feature);
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
const rgbOf = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
export function demandColor(multiplier: number): string {
  const t = Math.max(0, Math.min(1, (multiplier - 1) / 0.9));
  if (t <= 0.02) return "#dce8f2";
  const stops: [number, [number, number, number]][] = [
    [0.0, [220, 232, 242]],
    [0.45, rgbOf(appearance.meaning.moderate)],
    [1.0, rgbOf(appearance.meaning.severe)],
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 1; i < stops.length; i++)
    if (t <= stops[i][0]) { lo = stops[i - 1]; hi = stops[i]; break; }
  const span = hi[0] - lo[0] || 1;
  const k = (t - lo[0]) / span;
  const mix = lo[1].map((c, i) => Math.round(c + (hi[1][i] - c) * k));
  return `rgb(${mix[0]} ${mix[1]} ${mix[2]})`;
}
