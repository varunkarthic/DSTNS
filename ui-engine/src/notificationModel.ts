// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { groupNotifications } from "./notificationGroups";
import { roadTitle } from "./mapModel";
import { formatSimulationTime, localizeTimes } from "./timeFormat";
import type { News, Topology } from "./types";

/**
 * Structured notifications.
 *
 * The core emits news as terse technical messages ("Rain storm initiated at
 * Node 412 (Radius: 380m, Intensity: 83%)"). This module turns each one into an
 * operator-facing record: a plain-language title and summary first, then the
 * measured details, then the raw technical fields. It also owns the Do Not
 * Disturb decision, so every surface that shows a notification applies the
 * same rule.
 */

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/** Categories as the core emits them, with "control" folded into "system". */
export type NotificationCategory =
  | "weather"
  | "flooding"
  | "incident"
  | "traffic"
  | "demand"
  | "signals"
  | "system";
export type NotificationSeverity = "info" | "warning" | "alert";

export const NOTIFICATION_CATEGORIES: { id: NotificationCategory; label: string; hint: string }[] = [
  { id: "weather", label: "Weather updates", hint: "Rain starting, peaking and clearing" },
  { id: "flooding", label: "Flooding", hint: "Roads becoming flood affected" },
  { id: "incident", label: "Incidents", hint: "Collisions, closures, breakdowns and spills" },
  { id: "traffic", label: "Traffic updates", hint: "Demand surges and traffic model changes" },
  { id: "demand", label: "Demand changes", hint: "Schools, offices and retail peaks" },
  { id: "signals", label: "Signals", hint: "Signal controller changes" },
  { id: "system", label: "System messages", hint: "Scenario and runtime messages" },
];

export const NOTIFICATION_SEVERITIES: { id: NotificationSeverity; label: string }[] = [
  { id: "info", label: "Information" },
  { id: "warning", label: "Warnings" },
  { id: "alert", label: "Alerts" },
];

/** News templates significant enough to surface as a notification. */
export const NOTIFY_TEMPLATES = new Set([
  "DWS_RAIN_STARTED",
  "DWS_RAIN_PEAK",
  "DWS_RAIN_ENDED",
  "FLOOD_STARTED",
  "INCIDENT_ACTIVATED",
  "INCIDENT_RESOLVED",
  "DEMAND_CHANGED",
  "TRAFFIC_SURGE_ACTIVE",
]);

export function categoryOf(raw: string): NotificationCategory {
  const c = raw.toLowerCase();
  if (c === "control") return "system";
  return (NOTIFICATION_CATEGORIES.some((x) => x.id === c) ? c : "system") as NotificationCategory;
}

export function severityOf(raw: string): NotificationSeverity {
  return raw === "alert" || raw === "warning" ? raw : "info";
}

export const SEVERITY_LABEL: Record<NotificationSeverity, string> = {
  info: "Low",
  warning: "Moderate",
  alert: "High",
};

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface UiNotification {
  /** Stable identity: the group key, or the focus target key. */
  id: string;
  newsIds: number[];
  type: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  /** Virtual second of the newest member. */
  timestamp: number;
  /** Virtual second of the oldest member. */
  startedAt: number;
  title: string;
  summary: string;
  /** Operator-level facts, shown when expanded. Times are canonical seconds. */
  details: { label: string; value: string; time?: number }[];
  /** Raw fields for diagnosis. */
  technical: { label: string; value: string }[];
  location?: string;
  coordinates?: { x_m: number; y_m: number };
  /** Auto-focus target this notification describes, as a key prefix. */
  focusKey?: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Geography helpers
// ---------------------------------------------------------------------------

type Place = { x_m: number; y_m: number };

const namedRoadByNode = new WeakMap<Topology, Map<number, string>>();

/** A readable road name touching a junction, preferring real street names. */
export function roadNearNode(topology: Topology | null, node: number): string | undefined {
  if (!topology) return undefined;
  let index = namedRoadByNode.get(topology);
  if (!index) {
    index = new Map();
    for (const e of topology.edges) {
      if (!e.name?.trim()) continue;
      if (!index.has(e.from)) index.set(e.from, e.name.trim());
      if (!index.has(e.to)) index.set(e.to, e.name.trim());
    }
    namedRoadByNode.set(topology, index);
  }
  return index.get(node);
}

function networkExtent(topology: Topology) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of topology.nodes) {
    minX = Math.min(minX, n.position.x_m);
    maxX = Math.max(maxX, n.position.x_m);
    minY = Math.min(minY, n.position.y_m);
    maxY = Math.max(maxY, n.position.y_m);
  }
  return { minX, maxX, minY, maxY };
}
const extents = new WeakMap<Topology, ReturnType<typeof networkExtent>>();

/**
 * Which part of the network a point lies in: "the central district", "the
 * north-east district". Positions are metres with y pointing north.
 */
export function districtOf(topology: Topology | null, p: Place): string | undefined {
  if (!topology?.nodes.length) return undefined;
  let e = extents.get(topology);
  if (!e) {
    e = networkExtent(topology);
    extents.set(topology, e);
  }
  const cx = (e.minX + e.maxX) / 2;
  const cy = (e.minY + e.maxY) / 2;
  const dx = (p.x_m - cx) / Math.max(1, (e.maxX - e.minX) / 2);
  const dy = (p.y_m - cy) / Math.max(1, (e.maxY - e.minY) / 2);
  if (Math.hypot(dx, dy) < 0.34) return "the central district";
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI; // 0 = east, 90 = north
  const names = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];
  const index = Math.round(((angle + 360) % 360) / 45) % 8;
  return `the ${names[index]} district`;
}

function nodePlace(topology: Topology | null, id: unknown): Place | undefined {
  if (!topology || typeof id !== "number") return undefined;
  const n = topology.nodes[id];
  return n ? { x_m: n.position.x_m, y_m: n.position.y_m } : undefined;
}

function edgeMidpoint(topology: Topology | null, id: unknown): Place | undefined {
  if (!topology || typeof id !== "number") return undefined;
  const e = topology.edges[id];
  if (!e?.geometry.length) return undefined;
  const mid = e.geometry[Math.floor(e.geometry.length / 2)];
  return { x_m: mid.x_m, y_m: mid.y_m };
}

function edgeName(topology: Topology | null, id: unknown): string | undefined {
  if (!topology || typeof id !== "number") return undefined;
  const e = topology.edges[id];
  return e ? roadTitle(e) : undefined;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const INCIDENT_TITLES: Record<string, string> = {
  road_closure: "Road closure",
  accident: "Collision",
  congestion: "Congestion bottleneck",
  vehicle_breakdown: "Vehicle breakdown",
  hazard_spill: "Hazard spill",
};

const pct = (v: unknown) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "");
const km = (m: unknown) =>
  typeof m === "number" ? (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`) : "";
const capital = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const sentence = (s: string) => {
  const t = s.trim();
  return t && !/[.!?]$/.test(t) ? `${t}.` : t;
};

/** Message text without its "[HH:MM:SS]" prefix. */
export function stripPrefix(message: string): string {
  return message.replace(/^\[.*?\]\s*/, "");
}

/** The incident description the core embeds before " on Edge #". */
function incidentDescription(message: string): string {
  return stripPrefix(message).replace(/\s+on Edge #\d+.*$/, "").trim();
}

/** Rain event id from the news event id (peak and end are offset). */
function weatherId(item: News): number {
  if (item.template_id === "DWS_RAIN_PEAK") return item.event_id - 50000;
  if (item.template_id === "DWS_RAIN_ENDED") return item.event_id - 100000;
  return item.event_id;
}

interface Described {
  title: string;
  summary: string;
  details: UiNotification["details"];
  technical: UiNotification["technical"];
  location?: string;
  coordinates?: Place;
  focusKey?: string;
}

/** Describe a single news item in operator language. */
export function describeNews(item: News, topology: Topology | null): Described {
  const d = (item.data ?? {}) as Record<string, unknown>;
  const technical: Described["technical"] = [
    ["Event ID", String(item.event_id)],
    ["News ID", String(item.news_id)],
    ["Template", item.template_id],
    ...Object.entries(d).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)] as [string, string]),
  ].map(([label, value]) => ({ label, value }));

  switch (item.template_id) {
    case "DWS_RAIN_STARTED":
    case "DWS_RAIN_PEAK":
    case "DWS_RAIN_ENDED": {
      const place = nodePlace(topology, d.epicenter);
      const district = place ? districtOf(topology, place) : undefined;
      const road = typeof d.epicenter === "number" ? roadNearNode(topology, d.epicenter) : undefined;
      const where = district ?? "the network";
      const near = road ? ` near ${road}` : "";
      const intensity = typeof d.intensity === "number" ? d.intensity : undefined;
      const heavy = intensity !== undefined && intensity > 0.6;
      const details: Described["details"] = [];
      if (intensity !== undefined) details.push({ label: "Intensity", value: `${pct(intensity)}${heavy ? " (heavy)" : ""}` });
      if (typeof d.radius_m === "number") details.push({ label: "Affected radius", value: km(d.radius_m) });
      if (road) details.push({ label: "Nearest road", value: road });
      const copy =
        item.template_id === "DWS_RAIN_STARTED"
          ? { title: heavy ? "Heavy rain" : "Rain started", summary: `${heavy ? "Heavy rainfall" : "Rainfall"} has developed over ${where}${near}.` }
          : item.template_id === "DWS_RAIN_PEAK"
            ? { title: "Rain at peak", summary: `Rainfall has reached peak intensity over ${where}${near}. Road friction is reduced.` }
            : { title: "Rain cleared", summary: `Rain has cleared over ${where}. Roads are returning to normal conditions.` };
      return {
        ...copy,
        details,
        technical,
        location: capital(where),
        coordinates: place,
        focusKey: `weather-${weatherId(item)}`,
      };
    }
    case "FLOOD_STARTED": {
      const place = edgeMidpoint(topology, d.edge_id);
      const road = edgeName(topology, d.edge_id);
      const district = place ? districtOf(topology, place) : undefined;
      return {
        title: "Flooding",
        summary: `Flooding is affecting ${road ?? "a road"}${district ? ` in ${district}` : ""}.`,
        details: [
          ...(road ? [{ label: "Road", value: road }] : []),
          ...(typeof d.flood === "number" ? [{ label: "Flood level", value: pct(d.flood) }] : []),
        ],
        technical,
        location: district ? capital(district) : road,
        coordinates: place,
        focusKey: "flood",
      };
    }
    case "INCIDENT_ACTIVATED":
    case "INCIDENT_RESOLVED": {
      const type = typeof d.type === "string" ? d.type : "incident";
      const kind = INCIDENT_TITLES[type] ?? "Incident";
      const place = edgeMidpoint(topology, d.edge_id);
      const road = edgeName(topology, d.edge_id) ?? "the network";
      const district = place ? districtOf(topology, place) : undefined;
      if (item.template_id === "INCIDENT_RESOLVED")
        return {
          title: `${kind} cleared`,
          summary: `The ${kind.toLowerCase()} on ${road} has cleared. Normal traffic flow is restored.`,
          details: [{ label: "Road", value: road }],
          technical,
          location: district ? capital(district) : road,
          coordinates: place,
          focusKey: typeof d.incident_id === "number" ? `incident-${d.incident_id}` : undefined,
        };
      const [head, ...rest] = incidentDescription(item.message).split(":");
      const tail = rest.join(":").trim();
      const summary = sentence(`${capital(head.trim() || kind)} on ${road}`) + (tail ? ` ${sentence(capital(tail))}` : "");
      const details: Described["details"] = [
        { label: "Severity", value: SEVERITY_LABEL[severityOf(item.severity)] },
        { label: "Road", value: road },
      ];
      if (typeof d.closed === "boolean") details.push({ label: "Road closed", value: d.closed ? "Yes" : "No" });
      if (typeof d.speed_multiplier === "number" && d.speed_multiplier < 1)
        details.push({ label: "Speed limit", value: `${pct(d.speed_multiplier)} of normal` });
      if (typeof d.capacity_multiplier === "number" && d.capacity_multiplier < 1)
        details.push({ label: "Capacity", value: `${pct(d.capacity_multiplier)} of normal` });
      if (typeof d.end_virtual_s === "number")
        details.push({ label: "Expected to clear", value: formatSimulationTime(d.end_virtual_s, false), time: d.end_virtual_s });
      return {
        title: kind,
        summary,
        details,
        technical,
        location: district ? capital(district) : road,
        coordinates: place,
        focusKey: typeof d.incident_id === "number" ? `incident-${d.incident_id}` : undefined,
      };
    }
    case "DEMAND_CHANGED": {
      const feature = topology?.features.find((f) => f.id === d.feature_id);
      const text = stripPrefix(item.message);
      const [label, name] = text.split(" · ");
      const multiplier = typeof d.multiplier === "number" ? d.multiplier : 1;
      const where = name?.trim() || feature?.name || "a modelled place";
      const back = /returns to normal/i.test(label);
      const peak = /peak/i.test(label);
      return {
        title: back ? "Demand normal" : peak ? "Demand at peak" : "Demand rising",
        summary: back
          ? `Traffic demand around ${where} has returned to normal.`
          : `${capital(label.replace(/\s*peak$/i, "").trim())} is ${peak ? "at its peak" : "raising traffic demand"} around ${where}.`,
        details: [
          { label: "Place", value: where },
          { label: "Demand", value: `${multiplier.toFixed(2)}× normal` },
        ],
        technical,
        location: where,
        coordinates: feature ? { x_m: feature.position.x_m, y_m: feature.position.y_m } : undefined,
      };
    }
    case "TRAFFIC_SURGE_ACTIVE": {
      const place = nodePlace(topology, d.node_id);
      const district = place ? districtOf(topology, place) : undefined;
      return {
        title: "Demand surge",
        summary: `A demand surge is active in ${district ?? "the network"}.`,
        details: [
          ...(typeof d.factor === "number" ? [{ label: "Demand", value: `+${Math.round((d.factor - 1) * 100)}%` }] : []),
          ...(typeof d.radius_m === "number" ? [{ label: "Radius", value: km(d.radius_m) }] : []),
        ],
        technical,
        location: district ? capital(district) : undefined,
        coordinates: place,
      };
    }
    default:
      return {
        title: capital(categoryOf(item.category)),
        summary: sentence(stripPrefix(item.message)),
        details: [],
        technical,
      };
  }
}

/** Collapse a burst of news into structured, grouped notifications, newest first. */
export function buildNotifications(items: News[], topology: Topology | null): UiNotification[] {
  return groupNotifications(items).map((group) => {
    const latest = group.latest;
    const described = describeNews(latest, topology);
    const count = group.items.length;
    const oldest = group.items[group.items.length - 1];
    let summary = described.summary;
    if (count > 1 && latest.template_id === "FLOOD_STARTED")
      summary = `Flooding is affecting ${count} roads.`;
    else if (count > 1) summary = `${summary} ${count - 1} similar event${count === 2 ? "" : "s"} grouped.`;
    return {
      id: group.key,
      newsIds: group.items.map((n) => n.news_id),
      type: latest.template_id,
      category: categoryOf(latest.category),
      severity: group.items.reduce<NotificationSeverity>(
        (worst, n) => (rank(severityOf(n.severity)) > rank(worst) ? severityOf(n.severity) : worst),
        "info",
      ),
      timestamp: latest.virtual_day_s,
      startedAt: oldest.virtual_day_s,
      ...described,
      summary,
      count,
    };
  });
}

const rank = (s: NotificationSeverity) => (s === "alert" ? 2 : s === "warning" ? 1 : 0);

// ---------------------------------------------------------------------------
// Do Not Disturb
// ---------------------------------------------------------------------------

export interface DisplayPolicy {
  enabled: boolean;
  dnd: boolean;
  mutedCategories: readonly string[];
  mutedSeverities: readonly string[];
}

/** Whether a notification key describes the auto-focus target key. */
export function focusMatches(focusKey: string | undefined, targetKey: string | null | undefined): boolean {
  if (!focusKey || !targetKey) return false;
  return targetKey === focusKey || targetKey.startsWith(`${focusKey}-`);
}

/**
 * Whether a notification should be shown.
 *
 * Suppression affects presentation only: suppressed events are still stored,
 * listed in the telemetry deck and included in the report. The one override is
 * the event auto-focus is currently showing, which stays visible so the
 * operator knows why the camera moved.
 */
export function shouldDisplayNotification(
  n: Pick<UiNotification, "category" | "severity" | "focusKey">,
  policy: DisplayPolicy,
  focus: { enabled: boolean; targetKey: string | null | undefined },
): boolean {
  if (focus.enabled && focusMatches(n.focusKey, focus.targetKey)) return true;
  if (!policy.enabled) return false;
  if (!policy.dnd) return true;
  return !policy.mutedCategories.includes(n.category) && !policy.mutedSeverities.includes(n.severity);
}

/** Order for the capsule: the focused event first, then severity, then recency. */
export function orderForDisplay(list: UiNotification[], focusedKey: string | null | undefined): UiNotification[] {
  return [...list].sort((a, b) => {
    const fa = focusMatches(a.focusKey, focusedKey) ? 1 : 0;
    const fb = focusMatches(b.focusKey, focusedKey) ? 1 : 0;
    return fb - fa || rank(b.severity) - rank(a.severity) || b.timestamp - a.timestamp;
  });
}

/** Apply the 12/24 hour preference to text the core composed. */
export function presentText(text: string, hour12: boolean): string {
  return localizeTimes(text, hour12);
}
