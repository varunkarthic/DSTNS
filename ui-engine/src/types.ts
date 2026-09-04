export type Lifecycle='IDLE'|'PREPARING'|'READY'|'RUNNING'|'PAUSED'|'SEEKING'|'STOPPED'|'COMPLETED'|'ERROR'|'TERMINATING';

export interface Clock {
  playback_state: Lifecycle;
  playback_duration_seconds: number;
  simulation_percentage: number;
  simulated_current_time: string;
  virtual_day_seconds: number;
  base_rate: number;
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
  run_id: string;
  day: number;
  paused: boolean;
  simulated_seconds: number;
  virtual_seconds_remaining: number;
  modules: Record<string, boolean>;
}

export interface TopologyNode {
  id: number;
  osm_node_id: number;
  position: { lat: number; lon: number; x_m: number; y_m: number };
  degree: number;
  bus_stop: boolean;
  signal: boolean;
  building: string | null;
  building_impact?: number;
  building_radius_m?: number;
}

export interface TopologyEdge {
  id: number;
  from: number;
  to: number;
  reverse_twin: number;
  road_class: string;
  length_m: number;
  free_speed_mps: number;
  geometry: { lat: number; lon: number; x_m: number; y_m: number }[];
}

export interface TopologyBounds {
  min_lat: number;
  max_lat: number;
  min_lon: number;
  max_lon: number;
  center_lat?: number;
  center_lon?: number;
}

export interface Topology {
  root_node: number;
  topology_revision: number;
  graph_hash: string;
  bounds?: TopologyBounds;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export interface EdgeState {
  id: number;
  congestion: number;
  rainfall: number;
  flood: number;
  effective_speed_mps: number;
  vehicle_count: number;
  halting_count?: number;
  closed: boolean;
}

export interface NodeState {
  id: number;
  rainfall: number;
  flood: number;
  building_effect: number;
}

export interface ActiveWeather {
  id: number;
  epicenter_node: number;
  lat: number;
  lon: number;
  x_m: number;
  y_m: number;
  radius_m: number;
  intensity: number;
  flood_gain: number;
}

export interface ActiveIncident {
  edge_id: number;
  from_node: number;
  to_node: number;
  road_class: string;
  congestion: number;
  flood: number;
  closed: boolean;
  effective_speed_mps: number;
  vehicle_count: number;
}

export interface EventItem {
  news_id: number;
  event_id: number;
  simulated_current_time: string;
  category: string;
  severity: string;
  template_id: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface Snapshot {
  topology_revision: number;
  nodes: NodeState[];
  edges: EdgeState[];
  active_weather_events: number;
  active_weather?: ActiveWeather[];
  active_incidents?: ActiveIncident[];
  event_stack?: EventItem[];
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
