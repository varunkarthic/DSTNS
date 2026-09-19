import type { Backpressure, Snapshot } from "./types";

/**
 * Observer-side telemetry.
 *
 * The core publishes the state of the simulation at an instant; it does not
 * keep a history of what the observer received, how fast, or what the operator
 * did. This recorder keeps that history for the session so the report can
 * chart it. Every sample is a measurement taken when a snapshot arrived:
 * nothing is interpolated or estimated.
 *
 * Memory is bounded. When the buffer fills, the older half is thinned to every
 * second sample, so a long session keeps its whole shape at decreasing
 * resolution while the recent past stays at full resolution.
 */

export type RuntimeStatus = "online" | "degraded" | "offline";

export interface TelemetrySample {
  wall_ms: number;
  virtual_s: number;
  lifecycle: string;
  tick_rate: number;
  vehicles: number;
  halting: number;
  /** Vehicle-weighted mean speed on roads carrying traffic, km/h. */
  mean_speed_kmh: number;
  congestion: number;
  active_edges: number;
  flooded_edges: number;
  closed_edges: number;
  weather_cells: number;
  /** Highest rain cell intensity, 0 to 1. */
  rain_peak: number;
  /** Combined footprint of active rain cells, km² (overlaps counted once per cell). */
  rain_area_km2: number;
  incidents: number;
  bytes_per_s: number | null;
  snapshots_per_s: number | null;
  asb_score: number | null;
  asb_state: string | null;
  /** Round trip for the status and snapshot requests, ms. */
  latency_ms: number | null;
  status: RuntimeStatus;
}

export interface ControlRecord {
  wall_ms: number;
  virtual_s: number;
  action: string;
  detail: string;
}

export interface Transition {
  wall_ms: number;
  virtual_s: number;
  kind: "lifecycle" | "asb" | "status";
  from: string;
  to: string;
}

export interface TelemetryLog {
  runId: string;
  startedWall: number;
  samples: TelemetrySample[];
  controls: ControlRecord[];
  transitions: Transition[];
}

/** Summarize a snapshot into the scalar fields a sample stores. */
export function measureSnapshot(snapshot: Snapshot) {
  let vehicles = 0, halting = 0, speedWeighted = 0, active = 0, flooded = 0, closed = 0;
  for (const e of snapshot.edges) {
    vehicles += e.vehicle_count;
    halting += e.halting_count;
    if (e.vehicle_count > 0) {
      active += 1;
      speedWeighted += e.mean_speed_mps * e.vehicle_count;
    }
    if (e.flood > 0.01) flooded += 1;
    if (e.closed || e.incident_closed) closed += 1;
  }
  let rainPeak = 0, rainArea = 0;
  for (const w of snapshot.active_weather) {
    rainPeak = Math.max(rainPeak, w.intensity);
    rainArea += (Math.PI * w.radius_m * w.radius_m) / 1e6;
  }
  return {
    vehicles,
    halting,
    mean_speed_kmh: vehicles ? (speedWeighted / vehicles) * 3.6 : 0,
    congestion: snapshot.congestion?.current ?? 0,
    active_edges: active,
    flooded_edges: flooded,
    closed_edges: closed,
    weather_cells: snapshot.active_weather.length,
    rain_peak: rainPeak,
    rain_area_km2: rainArea,
    incidents: snapshot.active_incidents.length,
  };
}

export class TelemetryRecorder {
  private log: TelemetryLog;
  private last = new Map<Transition["kind"], string>();

  constructor(private readonly limit = 2400, now: () => number = Date.now) {
    this.now = now;
    this.log = { runId: "", startedWall: now(), samples: [], controls: [], transitions: [] };
  }
  private now: () => number;

  /** Start a fresh log for a new run. Calling with the current run is a no-op. */
  reset(runId: string) {
    if (runId === this.log.runId) return;
    this.log = { runId, startedWall: this.now(), samples: [], controls: [], transitions: [] };
    this.last.clear();
  }

  get runId() {
    return this.log.runId;
  }

  sample(s: Omit<TelemetrySample, "wall_ms"> & { wall_ms?: number }) {
    const wall = s.wall_ms ?? this.now();
    const prev = this.log.samples[this.log.samples.length - 1];
    // One sample per snapshot: repeated deliveries of the same state add nothing.
    if (prev && prev.virtual_s === s.virtual_s && prev.lifecycle === s.lifecycle && wall - prev.wall_ms < 1000) return;
    this.log.samples.push({ ...s, wall_ms: wall });
    this.transition("lifecycle", s.lifecycle, s.virtual_s, wall);
    if (s.asb_state) this.transition("asb", s.asb_state, s.virtual_s, wall);
    this.transition("status", s.status, s.virtual_s, wall);
    if (this.log.samples.length > this.limit) this.thin();
  }

  private thin() {
    const half = Math.floor(this.log.samples.length / 2);
    const older = this.log.samples.slice(0, half).filter((_, i) => i % 2 === 0);
    this.log.samples = [...older, ...this.log.samples.slice(half)];
  }

  control(action: string, detail: string, virtual_s: number) {
    this.log.controls.push({ wall_ms: this.now(), virtual_s, action, detail });
    if (this.log.controls.length > 2000) this.log.controls.splice(0, this.log.controls.length - 2000);
  }

  private transition(kind: Transition["kind"], to: string, virtual_s: number, wall: number) {
    const from = this.last.get(kind);
    if (from === to) return;
    this.last.set(kind, to);
    this.log.transitions.push({ wall_ms: wall, virtual_s, kind, from: from ?? "", to });
  }

  export(): TelemetryLog {
    return {
      ...this.log,
      samples: [...this.log.samples],
      controls: [...this.log.controls],
      transitions: [...this.log.transitions],
    };
  }
}

/** Build a sample from the observer's current state. */
export function sampleFrom(options: {
  snapshot: Snapshot;
  virtual_s: number;
  lifecycle: string;
  tick_rate: number;
  asb: Backpressure | null;
  latency_ms: number | null;
  status: RuntimeStatus;
}): Omit<TelemetrySample, "wall_ms"> {
  const { asb } = options;
  return {
    virtual_s: options.virtual_s,
    lifecycle: options.lifecycle,
    tick_rate: options.tick_rate,
    ...measureSnapshot(options.snapshot),
    bytes_per_s: asb ? asb.throughput.bytes_per_s : null,
    snapshots_per_s: asb ? asb.throughput.snapshots_per_s : null,
    asb_score: asb ? asb.score : null,
    asb_state: asb ? asb.state : null,
    latency_ms: options.latency_ms,
    status: options.status,
  };
}

/**
 * Wall-clock intervals during which a transition kind held a value matching
 * `predicate`. An interval still open at the end is closed at `endWall`.
 */
export function intervals(
  transitions: Transition[],
  kind: Transition["kind"],
  predicate: (value: string) => boolean,
  endWall: number,
): { from_ms: number; to_ms: number; value: string; virtual_from: number; virtual_to: number | null }[] {
  const out: { from_ms: number; to_ms: number; value: string; virtual_from: number; virtual_to: number | null }[] = [];
  let open: { from_ms: number; value: string; virtual_from: number } | null = null;
  for (const t of transitions) {
    if (t.kind !== kind) continue;
    if (open) {
      out.push({ ...open, to_ms: t.wall_ms, virtual_to: t.virtual_s });
      open = null;
    }
    if (predicate(t.to)) open = { from_ms: t.wall_ms, value: t.to, virtual_from: t.virtual_s };
  }
  if (open) out.push({ ...open, to_ms: endWall, virtual_to: null });
  return out;
}

/** Runtime status as shown to the operator. */
export function runtimeStatus(options: {
  connected: boolean;
  stale: boolean;
  error: boolean;
  asb: Backpressure | null;
}): RuntimeStatus {
  if (options.error || !options.connected) return "offline";
  if (options.stale) return "degraded";
  const a = options.asb;
  if (a && (a.state !== "NORMAL" || a.rate_capped || !a.synced)) return "degraded";
  return "online";
}
