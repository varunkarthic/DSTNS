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
  global_seed: string;
  state_revision: number;
  config_revision: number;
  clock: Clock;
  data: T;
}
export interface Status {
  lifecycle: Lifecycle;
  day: number;
  saved_seed_id: string;
  map_selection_version: string;
  modules: Record<string, boolean>;
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
}
// Where on earth this graph was cut from. Positions elsewhere in the topology
// are true metres from the projection origin; the UI compresses only for display.
export interface MapLocation {
  city: string;
  country: string;
  anchor_lat: number;
  anchor_lon: number;
  tile_radius_m: number;
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
}
export interface IncidentState {
  id?: number;
  incident_id?: number;
  edge_id: number;
  type?: string;
  description?: string;
  closed: boolean;
  flood: number;
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
  nodes: boolean;
  vehicles: boolean;
  transit: boolean;
  incidents: boolean;
  labels: boolean;
}
export const defaultLayers: Layers = {
  traffic: true,
  weather: true,
  flooding: true,
  events: true,
  buildings: true,
  signals: true,
  roads: true,
  nodes: true,
  vehicles: true,
  transit: true,
  incidents: true,
  labels: false,
};
export interface Inspection {
  title: string;
  category: string;
  status?: string;
  description?: string;
  metrics?: [string, string][];
}
