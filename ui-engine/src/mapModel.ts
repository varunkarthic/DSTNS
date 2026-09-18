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
