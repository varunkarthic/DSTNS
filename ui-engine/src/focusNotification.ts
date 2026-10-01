// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { boundsOf } from "./autoFocus";
import type { FocusTarget } from "./autoFocus";
import { districtOf, INCIDENT_TITLES } from "./notificationModel";
import type { UiNotification } from "./notificationModel";
import { roadTitle } from "./mapModel";
import type { Snapshot, Topology } from "./types";

/**
 * The notification for whatever auto-focus is showing.
 *
 * When the camera moves to an event the operator should see why, even if the
 * news item that announced it has already expired. This builds the record from
 * live state, so it describes the event as it is now.
 */
export function focusNotification(
  target: FocusTarget,
  snapshot: Snapshot,
  topology: Topology | null,
  virtualTime: number,
): UiNotification {
  const b = boundsOf(target.geometry);
  const centre = { x_m: (b.minX + b.maxX) / 2, y_m: (b.minY + b.maxY) / 2 };
  const district = districtOf(topology, centre);
  const where = district ?? "the network";
  const base = {
    id: `focus:${target.key}`,
    newsIds: [],
    timestamp: virtualTime,
    startedAt: virtualTime,
    focusKey: target.key,
    coordinates: centre,
    location: district ? district.charAt(0).toUpperCase() + district.slice(1) : undefined,
    count: 1,
  };

  if (target.kind === "weather") {
    const id = Number(target.key.split("-")[1]);
    const cell = snapshot.active_weather.find((w) => w.id === id);
    const phase = cell?.phase;
    const growing = typeof phase === "number" && phase < 0.25;
    const easing = typeof phase === "number" && phase > 0.7;
    const radius = cell?.radius_m ?? 0;
    return {
      ...base,
      type: "FOCUS_WEATHER",
      category: "weather",
      severity: (cell?.intensity ?? 0) > 0.6 ? "warning" : "info",
      title: target.label,
      summary: growing
        ? `Rainfall is expanding across ${where}.`
        : easing
          ? `Rainfall over ${where} is easing.`
          : `Rainfall continues over ${where}.`,
      details: [
        { label: "Intensity", value: `${Math.round((cell?.intensity ?? 0) * 100)}%` },
        { label: "Affected radius", value: radius >= 1000 ? `${(radius / 1000).toFixed(1)} km` : `${Math.round(radius)} m` },
        ...(typeof phase === "number"
          ? [{ label: "Stage", value: growing ? "Growing" : easing ? "Dissipating" : "Sustained" }]
          : []),
      ],
      technical: [
        { label: "Cell ID", value: String(id) },
        ...(cell ? [{ label: "Centre (m)", value: `${cell.x_m.toFixed(0)}, ${cell.y_m.toFixed(0)}` }] : []),
        ...(typeof phase === "number" ? [{ label: "Phase", value: phase.toFixed(3) }] : []),
      ],
    };
  }

  if (target.kind === "incident") {
    const id = Number(target.key.split("-")[1]);
    const incident = snapshot.active_incidents.find((i) => (i.incident_id ?? i.id ?? i.edge_id) === id);
    const edge = incident ? topology?.edges[incident.edge_id] : undefined;
    const kind = INCIDENT_TITLES[incident?.type ?? ""] ?? "Incident";
    const road = edge ? roadTitle(edge) : "the network";
    return {
      ...base,
      type: "FOCUS_INCIDENT",
      category: "incident",
      severity: incident?.closed ? "alert" : "warning",
      title: kind,
      summary: `${kind} on ${road}${incident?.closed ? ". The road is closed" : ""}.`,
      details: [
        { label: "Road", value: road },
        { label: "Road closed", value: incident?.closed ? "Yes" : "No" },
        ...(typeof incident?.end_virtual_s === "number"
          ? [{ label: "Expected to clear", value: "", time: incident.end_virtual_s }]
          : []),
      ],
      technical: [
        { label: "Incident ID", value: String(id) },
        ...(incident ? [{ label: "Edge", value: String(incident.edge_id) }] : []),
        ...(incident?.description ? [{ label: "Description", value: incident.description }] : []),
      ],
    };
  }

  return {
    ...base,
    type: "FOCUS_FLOOD",
    category: "flooding",
    severity: "warning",
    title: "Flooding",
    summary: `Flooding is affecting roads in ${where}.`,
    details: [
      { label: "Extent", value: `${((b.maxX - b.minX) / 1000).toFixed(1)} × ${((b.maxY - b.minY) / 1000).toFixed(1)} km` },
    ],
    technical: [{ label: "Cluster", value: target.key }],
  };
}
