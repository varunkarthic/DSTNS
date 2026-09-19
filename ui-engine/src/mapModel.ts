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
    title: e.name || `Unnamed ${e.road_class} road`,
    category: `Road · E-${e.id}`,
    status: s ? roadState(s) : "State unavailable",
    description: causes.join(" · ") || "No active effects recorded.",
    metrics: [
      ["Speed", s ? `${(s.mean_speed_mps * 3.6).toFixed(1)} km/h` : "—"],
      ["Free flow", `${(e.free_speed_mps * 3.6).toFixed(1)} km/h`],
      ["Congestion", s ? `${(s.congestion * 100).toFixed(0)}%` : "—"],
      ["Vehicles", String(s?.vehicle_count ?? "—")],
      ["Demand", s ? `${s.demand_vph.toFixed(0)} veh/h` : "—"],
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
// human name and a consistent glyph, and means an unnamed building reads as
// "School" rather than "Unnamed kindergarten".
// ---------------------------------------------------------------------------

export interface PlaceKind {
  label: string;
  icon: string;
  /** Places whose demand is modelled; only these take the demand colour ramp. */
  demand: boolean;
}

const PLACE_KINDS: [RegExp, PlaceKind][] = [
  [/^(school|kindergarten|childcare)$/, { label: "School", icon: "S", demand: true }],
  [/^(university|college)$/, { label: "University", icon: "U", demand: true }],
  [/^(hospital|clinic|doctors)$/, { label: "Hospital", icon: "H", demand: true }],
  [/^(mall|shopping_centre|shopping_center|marketplace|department_store)$/,
    { label: "Shopping Mall", icon: "M", demand: true }],
  [/^(supermarket|convenience|retail)$/, { label: "Shops", icon: "R", demand: true }],
  [/^(office|offices|company|commercial|government|bank|townhall|courthouse)$/,
    { label: "Office", icon: "O", demand: true }],
  [/^(station|bus_station|railway|train_station|subway|halt|platform)$/,
    { label: "Transport Hub", icon: "T", demand: true }],
  [/^(restaurant|cafe|fast_food|bar|pub|food_court)$/, { label: "Food & Drink", icon: "F", demand: true }],
  [/^(hotel|hostel|guest_house)$/, { label: "Hotel", icon: "L", demand: true }],
  [/^(park|garden|playground|pitch|recreation_ground|grass|forest)$/,
    { label: "Park", icon: "P", demand: false }],
  [/^(stadium|sports_centre|sports_center|arena)$/, { label: "Stadium", icon: "A", demand: true }],
  [/^(church|place_of_worship|mosque|synagogue|temple)$/, { label: "Place of Worship", icon: "W", demand: false }],
  [/^(museum|library|theatre|cinema|arts_centre|gallery)$/, { label: "Culture", icon: "C", demand: true }],
  [/^(pharmacy|chemist)$/, { label: "Pharmacy", icon: "R", demand: true }],
  [/^(parking|garage|garages|fuel)$/, { label: "Parking", icon: "K", demand: false }],
  [/^(industrial|warehouse|works|factory)$/, { label: "Industrial", icon: "I", demand: true }],
  [/^(residential|apartments|house|detached|dormitory|terrace)$/,
    { label: "Residential", icon: "·", demand: false }],
];

const GENERIC = new Set(["building", "yes", "", "landuse", "leisure", "amenity"]);

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
    for (const [pattern, kind] of PLACE_KINDS)
      if (pattern.test(value)) return kind;
  }
  return { label: "Building", icon: "•", demand: false };
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
