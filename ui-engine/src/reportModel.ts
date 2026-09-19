import type { Congestion, News, Topology } from "./types";
import type { TelemetrySample } from "./telemetryRecorder";
import { stripPrefix } from "./notificationModel";

/**
 * Report data derivation.
 *
 * Pure functions from recorded data to the tables and series the report
 * prints. Nothing here fabricates a value: every figure is either read from a
 * record or computed from records, and absent data stays absent.
 */

export interface RainEvent {
  id: number;
  start: number | null;
  peak: number | null;
  end: number | null;
  radius_m: number | null;
  intensity: number | null;
  epicenter: number | null;
}

/** Join rain start, peak and end news by the cell they describe. */
export function rainEvents(news: News[]): RainEvent[] {
  const byId = new Map<number, RainEvent>();
  const get = (id: number) => {
    let e = byId.get(id);
    if (!e) {
      e = { id, start: null, peak: null, end: null, radius_m: null, intensity: null, epicenter: null };
      byId.set(id, e);
    }
    return e;
  };
  for (const n of news) {
    const d = (n.data ?? {}) as Record<string, unknown>;
    if (n.template_id === "DWS_RAIN_STARTED") {
      const e = get(n.event_id);
      e.start = n.virtual_day_s;
      if (typeof d.radius_m === "number") e.radius_m = d.radius_m;
      if (typeof d.intensity === "number") e.intensity = d.intensity;
      if (typeof d.epicenter === "number") e.epicenter = d.epicenter;
    } else if (n.template_id === "DWS_RAIN_PEAK") {
      const e = get(n.event_id - 50000);
      e.peak = n.virtual_day_s;
      if (typeof d.intensity === "number" && e.intensity === null) e.intensity = d.intensity;
      if (typeof d.epicenter === "number" && e.epicenter === null) e.epicenter = d.epicenter;
    } else if (n.template_id === "DWS_RAIN_ENDED") {
      get(n.event_id - 100000).end = n.virtual_day_s;
    }
  }
  return [...byId.values()].sort((a, b) => (a.start ?? a.peak ?? a.end ?? 0) - (b.start ?? b.peak ?? b.end ?? 0));
}

export interface IncidentRecord {
  id: number;
  type: string;
  severity: string;
  start: number | null;
  end: number | null;
  /** Scheduled clearance, from the activation record. */
  plannedEnd: number | null;
  edge: number | null;
  node: number | null;
  closed: boolean | null;
  speed: number | null;
  capacity: number | null;
  description: string;
}

/** Join incident activation and resolution news by incident id. */
export function incidentRecords(news: News[]): IncidentRecord[] {
  const byId = new Map<number, IncidentRecord>();
  for (const n of news) {
    if (n.template_id !== "INCIDENT_ACTIVATED" && n.template_id !== "INCIDENT_RESOLVED") continue;
    const d = (n.data ?? {}) as Record<string, unknown>;
    const id = typeof d.incident_id === "number" ? d.incident_id : n.event_id;
    const rec: IncidentRecord = byId.get(id) ?? {
      id,
      type: typeof d.type === "string" ? d.type : "incident",
      severity: "",
      start: null,
      end: null,
      plannedEnd: null,
      edge: typeof d.edge_id === "number" ? d.edge_id : null,
      node: typeof d.node_id === "number" ? d.node_id : null,
      closed: null,
      speed: null,
      capacity: null,
      description: "",
    };
    if (n.template_id === "INCIDENT_ACTIVATED") {
      rec.start = n.virtual_day_s;
      rec.severity = n.severity;
      if (typeof d.closed === "boolean") rec.closed = d.closed;
      if (typeof d.speed_multiplier === "number") rec.speed = d.speed_multiplier;
      if (typeof d.capacity_multiplier === "number") rec.capacity = d.capacity_multiplier;
      if (typeof d.end_virtual_s === "number") rec.plannedEnd = d.end_virtual_s;
      rec.description = stripPrefix(n.message).replace(/\s+on Edge #\d+.*$/, "");
    } else rec.end = n.virtual_day_s;
    byId.set(id, rec);
  }
  return [...byId.values()].sort((a, b) => (a.start ?? a.end ?? 0) - (b.start ?? b.end ?? 0));
}

export interface TimelineRow {
  time: number;
  category: string;
  severity: string;
  text: string;
  count: number;
  /** The record the row came from, for callers that can describe it better. */
  source?: News;
}

const TIMELINE_TEMPLATES = new Set([
  "DWS_RAIN_STARTED",
  "DWS_RAIN_PEAK",
  "DWS_RAIN_ENDED",
  "FLOOD_STARTED",
  "INCIDENT_ACTIVATED",
  "INCIDENT_RESOLVED",
  "TRAFFIC_SURGE_ACTIVE",
  "SIGNAL_MANUAL_OVERRIDE",
  "DAY_CHANGED",
  "MODULE_ENABLED",
  "MODULE_DISABLED",
]);

/**
 * Significant events in order. Flood onsets arrive in bursts, one per road, so
 * consecutive onsets within `burstSeconds` become one row with a count. Demand
 * ramps are included only at their peaks.
 */
export function timeline(news: News[], burstSeconds = 60): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const sorted = [...news].sort((a, b) => a.virtual_day_s - b.virtual_day_s || a.news_id - b.news_id);
  for (const n of sorted) {
    const demandPeak = n.template_id === "DEMAND_CHANGED" && /\bpeak\b/i.test(n.message);
    const significant = TIMELINE_TEMPLATES.has(n.template_id) || demandPeak || n.severity === "alert";
    if (!significant) continue;
    const last = rows[rows.length - 1];
    if (n.template_id === "FLOOD_STARTED" && last?.category === "flooding" && last.text.startsWith("Flooding") && n.virtual_day_s - last.time <= burstSeconds) {
      last.count += 1;
      last.text = `Flooding detected on ${last.count} roads`;
      continue;
    }
    rows.push({
      time: n.virtual_day_s,
      category: n.category,
      severity: n.severity,
      text: n.template_id === "FLOOD_STARTED" ? "Flooding detected on 1 road" : stripPrefix(n.message),
      count: 1,
      source: n.template_id === "FLOOD_STARTED" ? undefined : n,
    });
  }
  return rows;
}

/** Periods during which the congestion index was at or above `threshold`. */
export function congestionPeriods(history: NonNullable<Congestion["history"]>, threshold: number) {
  const out: { from: number; to: number; peak: number; peakAt: number }[] = [];
  let open: { from: number; to: number; peak: number; peakAt: number } | null = null;
  const sorted = [...history].sort((a, b) => a.virtual_s - b.virtual_s);
  for (const h of sorted) {
    if (h.current >= threshold) {
      if (!open) open = { from: h.virtual_s, to: h.virtual_s, peak: h.current, peakAt: h.virtual_s };
      open.to = h.virtual_s;
      if (h.current > open.peak) {
        open.peak = h.current;
        open.peakAt = h.virtual_s;
      }
    } else if (open) {
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
}

/** Pearson correlation, or null when either series is constant or too short. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  if (vx < 1e-12 || vy < 1e-12) return null;
  return cov / Math.sqrt(vx * vy);
}

/**
 * Samples keyed by virtual time, keeping the most recently observed sample in
 * each bucket. When the operator steps back and replays part of the day, the
 * replay supersedes the first pass instead of interleaving with it.
 */
export function latestByVirtual(samples: TelemetrySample[], bucket = 60): TelemetrySample[] {
  const map = new Map<number, TelemetrySample>();
  for (const s of samples) map.set(Math.floor(s.virtual_s / bucket), s);
  return [...map.values()].sort((a, b) => a.virtual_s - b.virtual_s);
}

/** Bytes delivered, integrating the reported rate over wall time. */
export function bytesTransferred(samples: TelemetrySample[]): number | null {
  const rated = samples.filter((s) => s.bytes_per_s !== null);
  if (rated.length < 2) return null;
  let total = 0;
  for (let i = 1; i < rated.length; i++) {
    const dt = (rated[i].wall_ms - rated[i - 1].wall_ms) / 1000;
    if (dt <= 0 || dt > 30) continue; // A gap means no delivery was measured.
    total += ((rated[i].bytes_per_s! + rated[i - 1].bytes_per_s!) / 2) * dt;
  }
  return total;
}

export function stats(values: number[]) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: v.reduce((a, b) => a + b, 0) / v.length,
    median: pct(0.5),
    p95: pct(0.95),
    count: v.length,
  };
}

export function networkStats(topology: Topology) {
  const real = topology.edges.filter((e) => !e.synthetic_reverse);
  const km = real.reduce((s, e) => s + e.length_m, 0) / 1000;
  const degrees = new Map<number, number>();
  for (const n of topology.nodes) degrees.set(n.degree, (degrees.get(n.degree) ?? 0) + 1);
  const classes = new Map<string, { count: number; km: number; lanes: number; speed: number }>();
  for (const e of real) {
    const c = classes.get(e.road_class) ?? { count: 0, km: 0, lanes: 0, speed: 0 };
    c.count += 1;
    c.km += e.length_m / 1000;
    c.lanes += e.lanes;
    c.speed += e.free_speed_mps * 3.6;
    classes.set(e.road_class, c);
  }
  const lengths = stats(real.map((e) => e.length_m));
  const meanDegree = topology.nodes.length ? topology.nodes.reduce((s, n) => s + n.degree, 0) / topology.nodes.length : 0;
  return {
    nodes: topology.nodes.length,
    directions: real.length,
    syntheticReverse: topology.edges.length - real.length,
    km,
    intersections: topology.nodes.filter((n) => n.degree >= 3).length,
    deadEnds: topology.nodes.filter((n) => n.degree <= 1).length,
    signals: topology.nodes.filter((n) => n.signal).length,
    meanDegree,
    lengths,
    degrees: [...degrees.entries()].sort((a, b) => a[0] - b[0]),
    classes: [...classes.entries()]
      .map(([name, c]) => ({ name, count: c.count, km: c.km, lanes: c.lanes / c.count, speed: c.speed / c.count }))
      .sort((a, b) => b.km - a.km),
  };
}

/** Byte counts in binary units. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Not recorded";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${Math.round(bytes)} B`;
}

/** Pick a throughput unit that keeps chart values readable. */
export function throughputUnit(maxBytesPerSecond: number): { unit: string; divisor: number } {
  if (maxBytesPerSecond >= 1024 ** 2) return { unit: "MiB/s", divisor: 1024 ** 2 };
  return { unit: "KiB/s", divisor: 1024 };
}
