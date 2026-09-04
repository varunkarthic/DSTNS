import type {Envelope,News,Snapshot,Status,Topology,TransitRouteResult} from './types';

const base = (import.meta.env.VITE_DSTNS_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
  });
  const parsed = await response.json();
  if (!response.ok) throw new Error(parsed?.error?.message ?? `Request failed (${response.status})`);
  return parsed as T;
}

export const api = {
  health: () => request<{ ok: boolean; lifecycle: string }>('/health'),
  status: () => request<Envelope<Status>>('/api/v1/playback/status'),
  topology: () => request<Envelope<Topology>>('/api/v1/view/topology'),
  snapshot: () => request<Envelope<Snapshot>>('/api/v1/view/snapshot'),
  news: (since = 0) => request<Envelope<{ items: News[] }>>(`/api/v1/news?since_news_id=${since}&limit=200`),
  prepare: (payload: unknown) => request('/api/v1/playback/prepare', { method: 'POST', body: JSON.stringify(payload) }),
  start: (payload: unknown) => request('/api/v1/playback/start', { method: 'POST', body: JSON.stringify(payload) }),
  pause: () => request('/api/v1/playback/pause', { method: 'POST', body: '{}' }),
  play: () => request('/api/v1/playback/play', { method: 'POST', body: '{}' }),
  stop: () => request('/api/v1/playback/stop', { method: 'POST', body: '{}' }),
  reset: () => request('/api/v1/playback/reset', { method: 'POST', body: '{}' }),
  seek: (target_time: string) => request('/api/v1/playback/seek', { method: 'POST', body: JSON.stringify({ target_time }) }),
  tick: (tick_rate: number) => request('/api/v1/control/tick-rate', { method: 'PUT', body: JSON.stringify({ tick_rate }) }),
  module: (module: string, enabled: boolean) => request(`/api/v1/control/modules/${module}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  weather: (epicenter_node: number, radius_m?: number, intensity = 0.85) => {
    const rad = radius_m ?? Math.floor(100 + Math.random() * 500);
    return request('/api/v1/control/events/weather', {
      method: 'POST',
      body: JSON.stringify({ epicenter_node, intensity, radius_m: rad, duration_virtual_minutes: 60, flood_gain: 0.75 })
    });
  },
  toggleSignal: (node_id: number) => request(`/api/v1/control/signals/${node_id}/toggle`, { method: 'POST', body: '{}' }),
  triggerSurge: (node_id: number, factor = 1.8, radius_m = 350, duration_s = 1800, label = '') =>
    request('/api/v1/control/events/surge', { method: 'POST', body: JSON.stringify({ node_id, factor, radius_m, duration_s, label }) }),
  global: () => request<Envelope<unknown>>('/api/v1/view/global'),
  catalogWeather: () => request<Envelope<{ items: Array<{ event_id: number; epicenter_node: number; start_ppm: number; end_ppm: number; intensity: number; radius_m: number; active: boolean }> }>>('/api/v1/view/weather'),
  overrideEdge: (edge_id: number, opts: { speed_multiplier?: number; capacity_multiplier?: number; closed?: boolean }) =>
    request(`/api/v1/control/edges/${edge_id}`, { method: 'PUT', body: JSON.stringify(opts) }),
  setDay: (day: number) => request('/api/v1/control/day', { method: 'POST', body: JSON.stringify({ day }) }),
  undo: () => request('/api/v1/control/undo', { method: 'POST', body: '{"count":1}' }),
  redo: () => request('/api/v1/control/redo', { method: 'POST', body: '{"count":1}' }),
  validateTransitRoute: (nodes: number[], bus_id = 'BUS-101', label = '') =>
    request<Envelope<TransitRouteResult> | TransitRouteResult>('/api/v1/control/transit/route', {
      method: 'POST',
      body: JSON.stringify({ nodes, bus_id, label })
    }),
  terminate: () => request<{ ok: boolean; message: string }>('/terminate', { method: 'POST', body: '{}' })
};
