import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../src/App';

vi.mock('../src/NetworkMap', () => ({
  NetworkMap: ({ topology, focusTarget }: { topology: { graph_hash: string } | null; focusTarget: unknown }) => (
    <div data-testid="map" data-graph={topology?.graph_hash} data-focused={Boolean(focusTarget)} />
  ),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('clears a focused location when a seed reroll loads a new district', async () => {
  let graph = 'first-district';
  const node = { id: 0, position: { lon: 13.39, lat: 52.52 }, signal: false, bus_stop: false, building: null };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = String(input);
    let data: unknown = {};
    if (path.endsWith('/prepare')) graph = 'new-district';
    if (path.endsWith('/status')) return new Response(JSON.stringify({
      run_id: graph, clock: {}, data: { lifecycle: 'READY', day: 0, modules: {} },
    }));
    if (path.endsWith('/topology')) data = { graph_hash: graph, nodes: [node], edges: [] };
    if (path.endsWith('/snapshot')) data = { nodes: [], edges: [], active_weather: [] };
    if (path.includes('/news?')) data = { items: [] };
    if (path.endsWith('/weather')) data = { items: [{
      event_id: 1, epicenter_node: 0, start_ppm: 500000, end_ppm: 600000,
      intensity: 0.5, radius_m: 300, active: false,
    }] };
    return new Response(JSON.stringify({ data }));
  });
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('map')).toHaveAttribute('data-graph', 'first-district'));
  fireEvent.click(screen.getByRole('button', { name: 'Focus', exact: true }));
  expect(screen.getByTestId('map')).toHaveAttribute('data-focused', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Re-roll', exact: true }));
  await waitFor(() => expect(screen.getByTestId('map')).toHaveAttribute('data-graph', 'new-district'), { timeout: 3000 });
  expect(screen.getByTestId('map')).toHaveAttribute('data-focused', 'false');
});
