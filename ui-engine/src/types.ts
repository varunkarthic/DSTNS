// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

export type Lifecycle =
  | "IDLE"
  | "PREPARING"
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "SEEKING"
  | "STOPPED"
  | "COMPLETED"
  | "ERROR"
  | "TERMINATING";
export interface Clock {
  playback_state: Lifecycle;
  playback_duration_seconds: number;
  simulation_percentage: number;
  simulated_current_time: string;
  virtual_day_seconds: number;
  tick_rate: number;
  target_virtual_rate: number;
}
export interface Envelope<T> {
  api_version: string;
  run_id: string;
  /** The run's name: the raw decimal seed that started it. */
  seed: string;
  /** The same value in the core's internal hexadecimal form. */
  global_seed: string;
  state_revision: number;
  config_revision: number;
  clock: Clock;
  data: T;
}
/** When and where a run is: the seed's own values unless configured. */
export interface Calendar {
  location: { city: string; country: string; latitude: number; longitude: number; source: string };
  month: number;
  month_name: string;
  month_source: string;
  day: number;
  day_type: "weekday" | "weekend";
  day_source: string;
  seed_derived?: { city: string; country: string; month: number; month_name: string; day_type: string };
}
export interface Status {
  preparation_error?: string;
  playback_revision?: number;
  lifecycle: Lifecycle;
  day: number;
  saved_seed_id: string;
  map_selection_version: string;
  modules: Record<string, boolean>;
  calendar?: Calendar | null;
}
/** What a seed alone determines, from /seeds/describe and /seeds/generate. */
export interface SeedMetadata {
  seed: string;
  seed_hex?: string;
  location: { city: string; country: string; index?: number; latitude: number; longitude: number };
  month: number;
  month_name: string;
  day: number;
  day_type: "weekday" | "weekend";
  candidates_examined?: number;
  search_ms?: number;
}
export interface SeedLocation {
  index: number;
  city: string;
  country: string;
  slug: string;
  latitude: number;
  longitude: number;
}
export interface Point {
  x_m: number;
  y_m: number;
  lat: number;
  lon: number;
}
export interface TopologyNode {
  id: number;
  position: Point;
  degree: number;
  signal: boolean;
  osm_node_id: number;
}
export interface TopologyEdge {
  id: number;
  from: number;
  to: number;
  reverse_twin: number;
  synthetic_reverse: boolean;
  name: string;
  road_class: string;
  length_m: number;
  lanes: number;
  free_speed_mps: number;
  geometry: Point[];
}
export interface MapFeature {
  id: string;
  name: string;
  category: string;
  polygon: boolean;
  position: Point;
  geometry: Point[];
  tags: Record<string, string>;
  /** The core's demand model for this place, or null when it has none. */
  demand_type?: "school" | "office" | "mall" | "store" | null;
}
// Where on earth this graph was cut from. Positions elsewhere in the topology
// are true metres from the projection origin; the UI compresses only for display.
export interface MapLocation {
  city: string;
  country: string;
  anchor_lat: number;
  anchor_lon: number;
  city_extent_m: number;
  downloaded: boolean;
}
export interface Topology {
  graph_hash: string;
  location?: MapLocation;
  projection?: {
    name: string;
    origin_lat: number;
    origin_lon: number;
    units: string;
  };
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  features: MapFeature[];
  source: string;
  map_selection_version: string;
  bounds: {
    min_lat: number;
    max_lat: number;
    min_lon: number;
    max_lon: number;
  };
}
export interface EdgeState {
  id: number;
  congestion: number;
  rainfall: number;
  flood: number;
  effective_speed_mps: number;
  mean_speed_mps: number;
  vehicle_count: number;
  halting_count: number;
  closed: boolean;
  incident_closed: boolean;
  incident_speed_multiplier: number;
  signal_multiplier: number;
  demand_vph: number;
  effective_capacity_vph: number;
  demand_causes: string[];
}
export interface SignalState {
  signal_id: number;
  junction_id: number;
  phase: number;
  phase_name: string;
  group_a: string;
  group_b: string;
  phase_started_at: number | null;
  time_in_phase: number | null;
  next_transition_at: number | null;
  cycle_length: number;
  enabled: boolean;
}
export interface DemandState {
  feature_id: string;
  multiplier: number;
  active: boolean;
  radius_m: number;
}
export interface WeatherState {
  id: number;
  x_m: number;
  y_m: number;
  radius_m: number;
  intensity: number;
  /** Rain rate at the cell's centre, mm/h, as the hydrology uses it. */
  rain_mm_h?: number;
  epicenter_node?: number;
  lat?: number;
  lon?: number;
  /** Fraction of the cell's lifetime elapsed: growth below 0.25, decay above 0.7. */
  phase?: number;
  flood_gain?: number;
}
export interface IncidentState {
  id?: number;
  incident_id?: number;
  edge_id: number;
  type?: string;
  description?: string;
  closed: boolean;
  flood: number;
  node_id?: number;
  road_class?: string;
  congestion?: number;
  vehicle_count?: number;
  speed_multiplier?: number;
  capacity_multiplier?: number;
  start_virtual_s?: number;
  end_virtual_s?: number;
  remaining_s?: number;
}
export interface Congestion {
  current: number;
  average: number;
  delta: number;
  source: string;
  history?: { virtual_s: number; current: number; average: number }[];
}
export interface Snapshot {
  topology_revision: number;
  nodes: {
    id: number;
    rainfall: number;
    flood: number;
    building_effect: number;
  }[];
  edges: EdgeState[];
  signals: SignalState[];
  demand: DemandState[];
  congestion: Congestion;
  active_weather: WeatherState[];
  active_incidents: IncidentState[];
}
export interface News {
  news_id: number;
  event_id: number;
  virtual_day_s: number;
  simulated_current_time: string;
  category: string;
  severity: string;
  template_id: string;
  message: string;
  data: Record<string, unknown>;
}
export interface ScheduledEvent {
  id: number;
  virtual_s: number;
  entity: number;
  category: string;
  description: string;
  status: string;
  phase: number;
  value: number;
}
export interface EventPage {
  items: ScheduledEvent[];
  total: number;
  pending_count: number;
  executed_count: number;
  history_retention: number;
}
// Display layers are frontend-only: toggling one changes what is drawn, never
// what the simulation computes. No layer state is ever sent to the core.
export interface Layers {
  traffic: boolean;
  weather: boolean;
  flooding: boolean;
  events: boolean;
  buildings: boolean;
  signals: boolean;
  roads: boolean;
  vehicles: boolean;
  incidents: boolean;
  /** Street-name labels on roads. */
  labels: boolean;
  /** Names of places. Buildings stay visible when this is off; only their
   *  names are withheld, so the map keeps its shape without the clutter. */
  place_names: boolean;
  /** Places with no DSTNS type (benches, stops, rail lines), drawn as dots. */
  other_places: boolean;
  /** The (synthetic) drainage network under the streets. */
  drains: boolean;
}
export const defaultLayers: Layers = {
  traffic: true,
  weather: true,
  flooding: true,
  events: true,
  buildings: true,
  signals: true,
  roads: true,
  vehicles: true,
  incidents: true,
  // Off by default: road names crowd the network at district scale.
  labels: false,
  // Off by default: names are dense enough to obscure the network they sit on.
  place_names: false,
  // Off by default: thousands of unclassified points bury the typed places.
  other_places: false,
  // Off by default: a synthetic network under every street is busy to look at.
  drains: false,
};
/**
 * Which kinds of place are drawn, by taxonomy id.
 *
 * Kept apart from Layers because it is a taxonomy rather than a fixed set of
 * switches: the kinds come from the map, and a district with no university
 * should not need a layer for one. A kind missing from the record is shown,
 * so a new kind appears on the map the day it is added rather than waiting
 * for everyone's saved settings to catch up.
 */
export type PlaceVisibility = Record<string, boolean>;

/**
 * Kinds hidden until asked for. These are the ones the demand model says
 * nothing about, so their markers add clutter without adding information.
 */
export const defaultPlaceVisibility: PlaceVisibility = {
  worship: false,
  residential: false,
};

export interface Inspection {
  title: string;
  category: string;
  status?: string;
  description?: string;
  metrics?: [string, string][];
}

// ---------------------------------------------------------------------------
// Adaptive Simulation Backpressure
// ---------------------------------------------------------------------------
export type AsbState = "NORMAL" | "RESTRICTED" | "ASYNC";
export interface AsbAction {
  at_s: number;
  action: string;
  reason: string;
  score: number;
  rate_before: number;
  rate_after: number;
}
export interface Backpressure {
  state: AsbState;
  score: number;
  synced: boolean;
  rate_locked: boolean;
  motion_locked: boolean;
  gui_suspended: boolean;
  rate_capped: boolean;
  rate_cap: number;
  applied_tick_rate: number;
  requested_tick_rate: number;
  stressed_for_s: number;
  state_for_s: number;
  throughput: { snapshots_per_s: number; bytes_per_s: number };
  actions: AsbAction[];
  thresholds: Record<string, number>;
}

// ---------------------------------------------------------------------------
// World regeneration
// ---------------------------------------------------------------------------
export type WorldJobState = "idle" | "generating" | "ready" | "failed";
export type WorldStage =
  | "idle"
  | "compiling"
  | "requesting"
  | "downloading"
  | "validating"
  | "building"
  | "installing"
  | "ready"
  | "failed";
export interface WorldStatus {
  state: WorldJobState;
  stage: WorldStage;
  /** The new world's raw decimal seed. */
  seed: string;
  seed_hex?: string;
  previous_run_id: string;
  run_id: string;
  generation: number;
  elapsed_s: number;
  enabled?: boolean;
  map: {
    city: string;
    country: string;
    phase: string;
    bytes: number;
    total: number;
    elapsed_s: number;
  } | null;
  error: { code: string; message: string } | null;
}

/** Which hardware runs the physics step (GET /api/v1/system/compute). Descriptive only. */
export type ComputeInfo = {
  requested_backend: "auto" | "cpu" | "vulkan";
  active_backend: "cpu" | "vulkan";
  selection_reason?: string;
  fallback_reason?: string | null;
  health?: { cpu?: string; vulkan?: string };
  device?: { name?: string; driver?: string; type?: string; moltenvk?: boolean; software?: boolean } | null;
  step?: { backend?: string; total_ms?: number; cpu_ms?: number; gpu_ms?: number };
};

/** Where the terrain came from: enough to cite or reproduce it. */
export interface TerrainInfo {
  source: string;
  provider: string;
  dataset: string;
  licence: string;
  attribution: string;
  note: string;
  observed: boolean;
  degraded: boolean;
  data_class: string;
  zoom: number;
  native_resolution_m: number;
  grid: { width: number; height: number; cell_m: number; origin_x_m: number; origin_y_m: number };
  elevation_min_m: number;
  elevation_max_m: number;
  hash: string;
}
export interface Stats { min: number; mean: number; max: number }
/** The deterministic cosmic model: the Sun and the surface it heats. */
export interface DcmState {
  updated_s: number;
  interval_s: number;
  representative_day_of_year: number;
  latitude: number;
  longitude: number;
  solar_time_h: number;
  elevation_deg: number;
  azimuth_deg: number;
  daylight: boolean;
  direct_normal_w_m2: number;
  diffuse_horizontal_w_m2: number;
  clear_sky_global_horizontal_w_m2: number;
  cloud_mean: number;
  air_temperature_c: number;
  irradiance_w_m2: Stats | null;
  surface_temperature_c: Stats | null;
  sun_path: { t: number; elevation_deg: number; azimuth_deg: number }[];
  surface: { class: string; albedo: number; emissivity: number };
}
/** Surface water: the shallow-water model's state and its exact ledger. */
export interface HydrologyState {
  updated_s: number;
  interval_s: number;
  scheme: string;
  solver: string;
  substeps: number;
  dt_s: number;
  cfl_capped: boolean;
  stored_m3: number;
  max_depth_m: number;
  wet_cells: number;
  flooded_cells: number;
  flooded_area_m2: number;
  peak_rain_mm_h: number;
  peak_depth_m: number;
  peak_flooded_area_m2: number;
  ledger_m3: { initial: number; rain: number; boundary_outflow: number; open_water: number; evaporated: number; infiltrated: number; drained: number };
  conservation_error_m3: number;
  conservation_error_relative: number;
  max_froude: number;
  supercritical_cells: number;
  refinement_candidates: { x_m: number; y_m: number; depth_m: number }[];
}
/** The synthetic drainage network's summary. */
export interface DrainageSummary {
  source: string;
  data_class: string;
  inlets: number;
  junctions: number;
  pipes: number;
  outfalls: number;
  pipe_length_m: number;
  design_rain_mm_h: number;
  stored_m3: number;
  inflow_m3: number;
  backflow_m3: number;
  outfall_m3: number;
  conservation_error_m3: number;
  surcharged_nodes: number;
  full_pipes: number;
  peak_utilisation: number;
  peak_surcharged_nodes: number;
}
export interface DrainagePipe {
  from: number;
  to: number;
  diameter_m: number;
  slope: number;
  length_m: number;
  capacity_m3_s: number;
  flow_m3_s: number;
  utilisation: number;
}
/** The atmosphere's summary: the steady wind solution and what drives it. */
export interface AtmosphereSummary {
  solved: boolean;
  solved_s: number;
  updated_s: number;
  solves: number;
  solves_skipped: number;
  solve_interval_s: number;
  scheme: string;
  solver: string;
  lattice: { nx: number; ny: number; nz: number; dx_m: number; cells: number };
  iterations: number;
  converged: boolean;
  max_mach: number;
  background: { speed_mps: number; from_deg: number };
  climate: { belt: string; mean_speed_mps: number; prevailing_from_deg: number };
  near_surface_mps: { mean: number; max: number };
  reference_height_m: number;
  canopy: {
    buildings: number;
    height_tagged: number;
    levels_tagged: number;
    estimated: number;
    built_fraction: number;
    mean_height_m: number;
    max_height_m: number;
    source: string;
  };
}
/** The near-surface wind on the atmosphere's lattice: u east, v north, m/s. */
export interface WindView {
  enabled: boolean;
  solved: boolean;
  updated_s: number;
  width: number;
  height: number;
  origin_x_m: number;
  origin_y_m: number;
  cell_m: number;
  height_m: number;
  background: { speed_mps: number; from_deg: number };
  max_mps: number;
  /** Row-major, south row first. */
  u: number[];
  v: number[];
}
export interface DrainageView {
  summary: DrainageSummary;
  pipes: DrainagePipe[];
  outfalls: number[];
  surcharged: number[];
  enabled: boolean;
}
export interface EnvironmentInfo {
  schema_version: number;
  calendar?: Calendar;
  terrain: TerrainInfo | null;
  roads?: { max_abs_grade: number };
  modules?: Record<string, boolean>;
  state?: { time_s: number; dcm?: DcmState; hydrology?: HydrologyState; drainage?: DrainageSummary; atmosphere?: AtmosphereSummary } | null;
  fields: { name: string; units: string; kind: string }[];
}
