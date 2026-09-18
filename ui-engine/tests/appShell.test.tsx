import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

// The canvas is exercised by the browser suites; here it only needs to mount.
vi.mock("../src/NetworkMap", () => ({
  default: ({ layers }: { layers: Record<string, boolean> }) => (
    <div
      data-testid="map"
      data-layers={Object.entries(layers)
        .filter(([, on]) => on)
        .map(([k]) => k)
        .sort()
        .join(",")}
    />
  ),
}));

const clock = {
  playback_state: "RUNNING",
  playback_duration_seconds: 3600,
  simulation_percentage: 0.25,
  simulated_current_time: "06:00:00",
  virtual_day_seconds: 21600,
  tick_rate: 1,
  target_virtual_rate: 1,
};

const topology = {
  graph_hash: "sha256:abc123",
  nodes: [
    {
      id: 0,
      position: { x_m: 0, y_m: 0, lat: 52.5, lon: 13.4 },
      degree: 2,
      signal: false,
      osm_node_id: 1,
    },
  ],
  edges: [
    {
      id: 0,
      from: 0,
      to: 0,
      reverse_twin: -1,
      synthetic_reverse: false,
      name: "Test Road",
      road_class: "residential",
      length_m: 100,
      lanes: 1,
      free_speed_mps: 13.9,
      geometry: [],
    },
  ],
  features: [],
  source: "OpenStreetMap",
  map_selection_version: "urban-crfg-v2",
  bounds: { min_lat: 52.4, max_lat: 52.6, min_lon: 13.3, max_lon: 13.5 },
  projection: {
    name: "local equirectangular",
    origin_lat: 52.5,
    origin_lon: 13.4,
    units: "metres",
  },
  location: {
    city: "Berlin",
    country: "Germany",
    anchor_lat: 52.505,
    anchor_lon: 13.4235,
    tile_radius_m: 2000,
    downloaded: true,
  },
};

const snapshot = {
  topology_revision: 1,
  nodes: [],
  edges: [
    {
      id: 0,
      congestion: 0.2,
      rainfall: 0,
      flood: 0,
      effective_speed_mps: 11,
      mean_speed_mps: 11,
      vehicle_count: 7,
      halting_count: 1,
      closed: false,
      incident_closed: false,
      incident_speed_multiplier: 1,
      signal_multiplier: 1,
      demand_vph: 300,
      effective_capacity_vph: 900,
      demand_causes: [],
    },
  ],
  signals: [],
  demand: [],
  congestion: { current: 14, average: 20, delta: -6, source: "model" },
  active_weather: [],
  active_incidents: [],
};

/** Record every mutating call so tests can assert what reached the core. */
let calls: { path: string; method: string; body: string }[] = [];

function mockApi(overrides: { lifecycle?: string; runId?: string } = {}) {
  const runId = overrides.runId ?? "run_1";
  const lifecycle = overrides.lifecycle ?? "RUNNING";
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (method !== "GET")
        calls.push({ path, method, body: String(init?.body ?? "") });
      const envelope = (data: unknown) => ({
        api_version: "1.0",
        run_id: runId,
        global_seed: "0x5089050192221083c848bf3e12e22a4f",
        state_revision: 1,
        config_revision: 1,
        clock,
        data,
      });
      let data: unknown = {};
      if (path.includes("/playback/status"))
        data = {
          lifecycle,
          day: 0,
          saved_seed_id: "",
          map_selection_version: "urban-crfg-v2",
          modules: { traffic: true, signals: true, dws: true },
        };
      else if (path.includes("/view/topology")) data = topology;
      else if (path.includes("/view/snapshot")) data = snapshot;
      else if (path.includes("/news")) data = { items: [] };
      else if (path.includes("/view/congestion"))
        data = { ...snapshot.congestion, history: [] };
      return new Response(JSON.stringify(envelope(data)), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("observer shell", () => {
  it("shows the seed-selected city and its coordinates", async () => {
    mockApi();
    render(<App />);
    expect(await screen.findByText("Berlin, Germany")).toBeInTheDocument();
    // The HUD falls back to the tile anchor until the pointer moves over the map.
    expect(
      await screen.findByText(/52\.5050° N, 13\.4235° E/),
    ).toBeInTheDocument();
    expect(await screen.findByText(/TILE 4 km/)).toBeInTheDocument();
  });

  it("renders live telemetry from the snapshot", async () => {
    mockApi();
    render(<App />);
    expect(await screen.findByText("LIVE TELEMETRY")).toBeDefined();
    await waitFor(() =>
      expect(screen.getByText("14%")).toBeInTheDocument(),
    );
  });

  it("drives playback through the core API", async () => {
    mockApi();
    render(<App />);
    fireEvent.click(await screen.findByLabelText("Pause simulation"));
    await waitFor(() =>
      expect(calls.some((c) => c.path.includes("/playback/pause"))).toBe(true),
    );

    fireEvent.click(screen.getByLabelText("Step forward one virtual minute"));
    await waitFor(() => {
      const seek = calls.find((c) => c.path.includes("/playback/seek"));
      expect(seek).toBeDefined();
      // 06:00:00 plus one minute.
      expect(JSON.parse(seek!.body).target_time).toBe(21660);
    });

    fireEvent.click(
      screen.getByLabelText("Reset simulation to the start of the day"),
    );
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.path.includes("/playback/seek") &&
            JSON.parse(c.body).target_time === 0,
        ),
      ).toBe(true),
    );
  });

  it("keeps display layers entirely in the frontend", async () => {
    mockApi();
    render(<App />);
    const map = await screen.findByTestId("map");
    expect(map.getAttribute("data-layers")).toContain("weather");

    fireEvent.click(screen.getByRole("button", { name: /Display Layers/ }));
    const weather = await screen.findByLabelText("Weather (DWS)");
    fireEvent.click(weather);

    // The canvas stops drawing the layer...
    await waitFor(() =>
      expect(screen.getByTestId("map").getAttribute("data-layers")).not.toContain(
        "weather",
      ),
    );
    // ...and nothing about it was ever sent to the simulation core.
    expect(calls).toEqual([]);
  });

  it("does not offer playback control while the core is idle", async () => {
    mockApi({ lifecycle: "IDLE" });
    render(<App />);
    expect(
      await screen.findByText("./launcher start --seed 382923"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Pause simulation")).toBeDisabled();
  });

  it("surfaces a map download failure as an alert", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "MAP_FETCH_FAILED",
            message:
              "OSM download failed for Berlin (Germany) at 52.505, 13.423: Overpass returned HTTP 429",
          },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    });
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/OSM download failed for Berlin/);
    expect(alert.className).toContain("map-error");
  });
});
