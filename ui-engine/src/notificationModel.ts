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
  /** "realistic" when the summary is a Realistic News item written by the on-device model. */
  source?: "realistic" | "standard";
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

/** Standard wordings for an incident starting, beside the core's own description. */
const INCIDENT_WORDINGS: Record<string, (road: string, inArea: string) => string[]> = {
  accident: (road, inArea) => [
    `A collision on ${road} is holding up traffic${inArea}.`,
    `Crash on ${road}${inArea}: a lane is blocked and emergency services are there.`,
  ],
  road_closure: (road, inArea) => [
    `${capital(road)} is closed${inArea}; traffic is being turned away.`,
    `Emergency closure on ${road}${inArea}. Find another route.`,
  ],
  congestion: (road, inArea) => [
    `Traffic has backed up on ${road}${inArea}.`,
    `Heavy, slow traffic on ${road}${inArea}; expect delays.`,
  ],
  vehicle_breakdown: (road, inArea) => [
    `A broken-down vehicle is blocking a lane on ${road}${inArea}.`,
    `Breakdown on ${road}${inArea}: expect delays while it is cleared.`,
  ],
  hazard_spill: (road, inArea) => [
    `A spill on ${road}${inArea} has made the surface hazardous; traffic is crawling.`,
    `Hazardous spill on ${road}${inArea}. Crews are cleaning up and speeds are well down.`,
  ],
  incident: (road, inArea) => [`An incident is affecting traffic on ${road}${inArea}.`],
};

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
  source?: "realistic" | "standard";
}

/** The product name for news written by the on-device model. */
export const REALISTIC_NEWS = "Realistic News";

/**
 * One of several predefined wordings, chosen by the event's identity.
 *
 * Standard news varies its phrasing so a day's feed does not repeat itself,
 * but an item must keep its wording across re-renders, the history and the
 * report, so the choice is a hash of the event, not a random draw.
 */
export function pickWording(options: string[], item: Pick<News, "event_id" | "template_id">): string {
  let hash = 2166136261;
  for (const ch of `${item.template_id}:${item.event_id}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return options[(hash >>> 0) % options.length];
}

/**
 * Describe a single news item in operator language.
 *
 * With Realistic News on, an item the on-device model has written arrives
 * with a narrative, which becomes the summary; the title, the measured
 * details and the focus target are still derived here from the item's data,
 * and the core's own text stays available under the technical fields.
 * Otherwise the summary is one of the predefined Standard wordings.
 */
export function describeNews(item: News, topology: Topology | null): Described {
  const described = describeTemplate(item, topology);
  const narrative = item.narrative?.trim();
  if (!narrative) return { ...described, source: "standard" };
  return {
    ...described,
    summary: narrative,
    source: "realistic",
    technical: [...described.technical, { label: "Core message", value: stripPrefix(item.message) }],
  };
}

function describeTemplate(item: News, topology: Topology | null): Described {
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
          ? {
              title: heavy ? "Heavy rain" : "Rain started",
              summary: pickWording(
                [
                  `${heavy ? "Heavy rainfall" : "Rainfall"} has developed over ${where}${near}.`,
                  `${heavy ? "A heavy downpour" : "Showers"} moving in over ${where}${near}; expect wet roads.`,
                  `Rain is now falling across ${where}${near}. Allow extra time for journeys.`,
                ],
                item,
              ),
            }
          : item.template_id === "DWS_RAIN_PEAK"
            ? {
                title: "Rain at peak",
                summary: pickWording(
                  [
                    `Rainfall has reached peak intensity over ${where}${near}. Road friction is reduced.`,
                    `The rain over ${where} is at its heaviest${near}, with spray and standing water on some roads.`,
                    `Rain over ${where} has peaked${near}. Roads are slick and visibility is down.`,
                  ],
                  item,
                ),
              }
            : {
                title: "Rain cleared",
                summary: pickWording(
                  [
                    `Rain has cleared over ${where}. Roads are returning to normal conditions.`,
                    `The rain over ${where} has passed and roads are starting to dry.`,
                    `Skies are clearing over ${where}; driving conditions are back to normal.`,
                  ],
                  item,
                ),
              };
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
        summary: pickWording(
          [
            `Flooding is affecting ${road ?? "a road"}${district ? ` in ${district}` : ""}.`,
            `Standing water has built up on ${road ?? "a road"}${district ? ` in ${district}` : ""}; take care.`,
            `${capital(road ?? "a road")} is waterlogged${district ? ` in ${district}` : ""}, slowing traffic.`,
          ],
          item,
        ),
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
          summary: pickWording(
            [
              `The ${kind.toLowerCase()} on ${road} has cleared. Normal traffic flow is restored.`,
              `${capital(road)} is moving freely again after the ${kind.toLowerCase()}.`,
              `All clear on ${road}: the ${kind.toLowerCase()} has been dealt with.`,
            ],
            item,
          ),
          details: [{ label: "Road", value: road }],
          technical,
          location: district ? capital(district) : road,
          coordinates: place,
          focusKey: typeof d.incident_id === "number" ? `incident-${d.incident_id}` : undefined,
        };
      const [head, ...rest] = incidentDescription(item.message).split(":");
      const tail = rest.join(":").trim();
      const inArea = district ? ` in ${district}` : "";
      const summary = pickWording(
        [
          sentence(`${capital(head.trim() || kind)} on ${road}`) + (tail ? ` ${sentence(capital(tail))}` : ""),
          ...(INCIDENT_WORDINGS[type] ?? INCIDENT_WORDINGS.incident)(road, inArea),
        ],
        item,
      );
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
      const reason = label.replace(/\s*peak$/i, "").trim();
      const lowered = reason.toLowerCase();
      const why = lowered.includes("school")
        ? [`The school run is building traffic around ${where}.`, `Pupils coming and going at ${where} are adding to traffic nearby.`]
        : lowered.includes("office")
          ? [`Commuters heading to ${where} are adding to the traffic.`, `The office rush is filling the roads around ${where}.`]
          : lowered.includes("retail")
            ? [`Shoppers are out in force around ${where}.`, `It is a busy time at ${where}, and the roads nearby show it.`]
            : lowered.includes("hospital")
              ? [`Visitors and shift changes are bringing extra traffic to ${where}.`, `The roads around ${where} are busier than usual.`]
              : [`More people than usual are heading to ${where}.`, `Traffic is picking up around ${where}.`];
      return {
        title: back ? "Demand normal" : peak ? "Demand at peak" : "Demand rising",
        summary: back
          ? pickWording(
              [`Traffic demand around ${where} has returned to normal.`, `Things have quietened down around ${where}.`],
              item,
            )
          : pickWording([`${capital(reason)} is ${peak ? "at its peak" : "raising traffic demand"} around ${where}.`, ...why], item),
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
        summary: pickWording(
          [
            `A demand surge is active in ${district ?? "the network"}.`,
            `Traffic has suddenly picked up across ${district ?? "the network"}.`,
            `A rush of extra vehicles is hitting ${district ?? "the network"}.`,
          ],
          item,
        ),
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
