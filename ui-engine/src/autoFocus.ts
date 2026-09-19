import { roadTitle } from "./mapModel";
import { INCIDENT_TITLES } from "./notificationModel";
import type { Snapshot, Topology } from "./types";

/**
 * Auto-focus geometry.
 *
 * Every event the camera can follow is described by its real footprint, not
 * by a point and a fixed zoom: a collision is a point on a road, a rain cell is
 * a disc that grows and drifts, a flood is a cluster of road segments. The
 * camera fits the footprint's bounds with room for the interface around it.
 *
 * All coordinates are metres in the core's projection, y pointing north.
 */

export type FocusGeometry =
  | { kind: "point"; x: number; y: number }
  | { kind: "radius"; x: number; y: number; r: number }
  | { kind: "line"; points: { x: number; y: number }[] }
  | { kind: "polygon"; points: { x: number; y: number }[] }
  | { kind: "bbox"; minX: number; maxX: number; minY: number; maxY: number };

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface FocusTarget {
  /** Stable identity: "incident-4", "weather-7", "flood-2". */
  key: string;
  kind: "incident" | "weather" | "flood";
  label: string;
  geometry: FocusGeometry;
  /** Lower is more important. */
  rank: number;
}

/** Smallest footprint the camera will frame, so a point is not magnified absurdly. */
export const MIN_SPAN_M = 320;

export function boundsOf(g: FocusGeometry): Bounds {
  switch (g.kind) {
    case "point":
      return { minX: g.x, maxX: g.x, minY: g.y, maxY: g.y };
    case "radius":
      return { minX: g.x - g.r, maxX: g.x + g.r, minY: g.y - g.r, maxY: g.y + g.r };
    case "bbox":
      return { minX: g.minX, maxX: g.maxX, minY: g.minY, maxY: g.maxY };
    case "line":
    case "polygon": {
      const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (const p of g.points) {
        b.minX = Math.min(b.minX, p.x);
        b.maxX = Math.max(b.maxX, p.x);
        b.minY = Math.min(b.minY, p.y);
        b.maxY = Math.max(b.maxY, p.y);
      }
      return b;
    }
  }
}

export function centreOf(b: Bounds) {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/** Grow bounds so each side spans at least `min` metres, keeping the centre. */
export function withMinimumSpan(b: Bounds, min = MIN_SPAN_M): Bounds {
  const c = centreOf(b);
  const w = Math.max(min, b.maxX - b.minX);
  const h = Math.max(min, b.maxY - b.minY);
  return { minX: c.x - w / 2, maxX: c.x + w / 2, minY: c.y - h / 2, maxY: c.y + h / 2 };
}

export interface Viewport {
  width: number;
  height: number;
  /** Pixels covered by interface chrome on each side. */
  insets: { top: number; right: number; bottom: number; left: number };
}

/**
 * Camera for a footprint: pixels per metre, and the metre coordinate that
 * lands at the centre of the unobscured part of the viewport.
 *
 * The footprint is fitted inside the viewport minus its insets, then padded by
 * `padding` (a fraction of the fitted size) so it never touches the chrome.
 */
export function viewportFor(
  bounds: Bounds,
  viewport: Viewport,
  options: { padding?: number; minScale?: number; maxScale?: number; minSpan?: number } = {},
) {
  const padding = options.padding ?? 0.18;
  const b = withMinimumSpan(bounds, options.minSpan ?? MIN_SPAN_M);
  const { insets } = viewport;
  const usableW = Math.max(80, viewport.width - insets.left - insets.right);
  const usableH = Math.max(80, viewport.height - insets.top - insets.bottom);
  const spanX = (b.maxX - b.minX) * (1 + padding * 2);
  const spanY = (b.maxY - b.minY) * (1 + padding * 2);
  const raw = Math.min(usableW / spanX, usableH / spanY);
  const scale = Math.min(options.maxScale ?? 4, Math.max(options.minScale ?? 0.025, raw));
  const c = centreOf(b);
  return {
    scale,
    centre: c,
    /** Screen position the centre should occupy. */
    screen: { x: insets.left + usableW / 2, y: insets.top + usableH / 2 },
  };
}

/**
 * A fingerprint of the framing a target needs. The camera moves again only
 * when this changes, so a growing rain cell re-frames in steps as it expands
 * instead of nudging the view on every snapshot.
 */
export function framingSignature(target: FocusTarget, step = 0.12): string {
  const b = withMinimumSpan(boundsOf(target.geometry));
  const size = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  // Size in logarithmic buckets: a 12% change in extent is a new bucket.
  const bucket = Math.round(Math.log(size) / Math.log(1 + step));
  const c = centreOf(b);
  // Centre quantized to a quarter of the extent.
  const q = size / 4;
  return `${target.key}|${bucket}|${Math.round(c.x / q)}|${Math.round(c.y / q)}`;
}

// ---------------------------------------------------------------------------
// Targets from live state
// ---------------------------------------------------------------------------

/** Group flooded road segments into spatial clusters on a coarse grid. */
export function floodClusters(
  segments: { x: number; y: number }[][],
  cell = 600,
): { points: { x: number; y: number }[] }[] {
  const cells = new Map<string, { x: number; y: number }[]>();
  for (const seg of segments) {
    if (!seg.length) continue;
    const mid = seg[Math.floor(seg.length / 2)];
    const key = `${Math.floor(mid.x / cell)},${Math.floor(mid.y / cell)}`;
    const list = cells.get(key) ?? [];
    list.push(...seg);
    cells.set(key, list);
  }
  // Union neighbouring cells so a flood straddling a grid line stays whole.
  const keys = [...cells.keys()];
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  for (const k of keys) {
    const [cx, cy] = k.split(",").map(Number);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const n = `${cx + dx},${cy + dy}`;
        if (parent.has(n)) parent.set(find(n), find(k));
      }
  }
  const groups = new Map<string, { x: number; y: number }[]>();
  for (const k of keys) {
    const root = find(k);
    groups.set(root, [...(groups.get(root) ?? []), ...cells.get(k)!]);
  }
  // Stable order: largest cluster first, then by position.
  return [...groups.values()]
    .map((points) => ({ points }))
    .sort((a, b) => b.points.length - a.points.length || a.points[0].x - b.points[0].x);
}

/**
 * Every event worth following, most important first: flooding and closures,
 * then other incidents, then weather cells. Signals and demand are excluded;
 * they change constantly and would keep the camera moving for nothing.
 */
export function focusTargets(snapshot: Snapshot | null, topology: Topology | null): FocusTarget[] {
  if (!snapshot || !topology) return [];
  const out: FocusTarget[] = [];
  for (const incident of snapshot.active_incidents) {
    const edge = topology.edges[incident.edge_id];
    if (!edge?.geometry.length) continue;
    const id = incident.incident_id ?? incident.id ?? incident.edge_id;
    const kind = INCIDENT_TITLES[incident.type ?? ""] ?? "Incident";
    out.push({
      key: `incident-${id}`,
      kind: "incident",
      label: `${kind} on ${roadTitle(edge)}`,
      // The road segment carrying the incident, so a long closure is framed whole.
      geometry: { kind: "line", points: edge.geometry.map((p) => ({ x: p.x_m, y: p.y_m })) },
      rank: incident.closed ? 1 : 2,
    });
  }
  const flooded: { x: number; y: number }[][] = [];
  for (const e of snapshot.edges) {
    if (e.flood <= 0.01) continue;
    const edge = topology.edges[e.id];
    if (!edge || edge.synthetic_reverse || !edge.geometry.length) continue;
    flooded.push(edge.geometry.map((p) => ({ x: p.x_m, y: p.y_m })));
  }
  floodClusters(flooded).forEach((cluster, i) =>
    out.push({
      key: `flood-${i}`,
      kind: "flood",
      label: "Flooding",
      geometry: { kind: "polygon", points: cluster.points },
      rank: 0,
    }),
  );
  for (const cell of snapshot.active_weather)
    out.push({
      key: `weather-${cell.id}`,
      kind: "weather",
      label: cell.intensity > 0.6 ? "Heavy rain" : "Rain",
      // The current footprint: radius grows through the storm's life.
      geometry: { kind: "radius", x: cell.x_m, y: cell.y_m, r: cell.radius_m },
      rank: 3,
    });
  return out.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key, undefined, { numeric: true }));
}

/** Full network bounds, for when nothing needs attention. */
export function networkBounds(topology: Topology | null): Bounds | null {
  if (!topology?.nodes.length) return null;
  return boundsOf({ kind: "polygon", points: topology.nodes.map((n) => ({ x: n.position.x_m, y: n.position.y_m })) });
}

/**
 * Choose the target to show.
 *
 * Round-Robin visits each target in turn; `index` is the rotation counter.
 * Latest follows the most recently appeared target, using when each key was
 * first seen.
 */
export function chooseTarget(
  targets: FocusTarget[],
  strategy: "round-robin" | "latest",
  index: number,
  firstSeen: ReadonlyMap<string, number>,
): FocusTarget | undefined {
  if (!targets.length) return undefined;
  if (strategy === "latest")
    return [...targets].sort(
      (a, b) => (firstSeen.get(b.key) ?? 0) - (firstSeen.get(a.key) ?? 0) || a.rank - b.rank,
    )[0];
  return targets[((index % targets.length) + targets.length) % targets.length];
}
