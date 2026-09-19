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

const backpressure = {
  state: "NORMAL",
  score: 0.02,
  synced: true,
  rate_locked: false,
  motion_locked: false,
  gui_suspended: false,
  rate_capped: false,
  rate_cap: -1,
  applied_tick_rate: 1,
  requested_tick_rate: 1,
  stressed_for_s: 0,
  state_for_s: 12,
  throughput: { snapshots_per_s: 1.1, bytes_per_s: 65536 },
  actions: [],
  thresholds: {},
};

/** Record every mutating call so tests can assert what reached the core. */
let calls: { path: string; method: string; body: string }[] = [];

/** ui-config that asks before enabling auto-focus, rather than forcing it on. */
const ASKS_FIRST = { auto_focus: { mode: "enable" } };

/** Wait until the run has loaded and its controls are live. */
async function ready() {
  await waitFor(() => expect(screen.getByLabelText("Pause simulation")).toBeEnabled(), {
    timeout: 4000,
  });
}

function mockApi(
  overrides: {
    lifecycle?: string;
    runId?: string;
    backpressure?: typeof backpressure;
    uiConfig?: Record<string, unknown>;
  } = {},
) {
  const runId = overrides.runId ?? "run_1";
  const lifecycle = overrides.lifecycle ?? "RUNNING";
  const asbBody = overrides.backpressure ?? backpressure;
  const uiConfig = overrides.uiConfig ?? {};
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (method !== "GET" && !path.includes("/system/backpressure"))
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
      // Endpoints that are not enveloped.
      if (path.includes("/system/ui-config"))
        return new Response(JSON.stringify({ api_version: "1.0", data: uiConfig }), {
          headers: { "Content-Type": "application/json" },
        });
      if (path.includes("/system/map-status"))
        return new Response(JSON.stringify({ api_version: "1.0", data: { active: false } }), {
          headers: { "Content-Type": "application/json" },
        });
      if (path.includes("/system/backpressure"))
        return new Response(JSON.stringify(asbBody), {
          headers: { "Content-Type": "application/json" },
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
  // The shell remembers per run whether auto-focus was offered, so each test
  // starts from a clean slate rather than inheriting the previous one's answer.
  localStorage.clear();
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
    await ready();
    fireEvent.click(await screen.findByLabelText("Pause simulation"));
    await waitFor(() =>
      expect(calls.some((c) => c.path.includes("/playback/pause"))).toBe(true),
    );

    fireEvent.click(screen.getByLabelText("Step forward 1m"));
    await waitFor(() => {
      const seek = calls.find((c) => c.path.includes("/playback/seek"));
      expect(seek).toBeDefined();
      // 06:00:00 plus one minute.
      expect(JSON.parse(seek!.body).target_time).toBe(21660);
    });

    // Reset is destructive enough to confirm first, so the click alone must
    // not reach the core.
    calls.length = 0;
    fireEvent.click(screen.getByLabelText("Reset simulation to the start of the day"));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Reset the simulation?");
    expect(calls).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Reset to 00:00:00" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.path.includes("/playback/seek") && JSON.parse(c.body).target_time === 0,
        ),
      ).toBe(true),
    );
  });

  it("abandons a reset when the confirmation is cancelled", async () => {
    mockApi();
    render(<App />);
    await ready();
    calls.length = 0;
    fireEvent.click(screen.getByLabelText("Reset simulation to the start of the day"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls).toEqual([]);
  });

  it("keeps display layers entirely in the frontend", async () => {
    mockApi();
    render(<App />);
    await ready();
    const map = await screen.findByTestId("map");
    expect(map.getAttribute("data-layers")).toContain("weather");

    fireEvent.click(screen.getByRole("button", { name: /Display Layers/ }));
    const weather = await screen.findByLabelText("Weather cells");
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
    expect(await screen.findByText("Awaiting a run")).toBeInTheDocument();
    expect(screen.getByText(/Start a simulation from the CLI/)).toBeInTheDocument();
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

describe("v2 surfaces", () => {
  it("offers auto-focus once per run and remembers the answer", async () => {
    mockApi({ uiConfig: ASKS_FIRST });
    render(<App />);
    // The offer appears because ui-config's default mode is "enable".
    expect(await screen.findByText("This simulation supports Auto-Focus")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() =>
      expect(screen.queryByText("This simulation supports Auto-Focus")).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Auto-focus on live events")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // It is an offer, not a nag: it does not return for the same run.
    await new Promise((r) => setTimeout(r, 120));
    expect(screen.queryByText("This simulation supports Auto-Focus")).not.toBeInTheDocument();
  });

  it("shows the About card with the licence and a source offer", async () => {
    mockApi();
    render(<App />);
    await ready();
    fireEvent.click(screen.getByLabelText("About DSTNS, licence and source"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Varun Karthic");
    expect(dialog).toHaveTextContent(/Affero General Public License/);
    expect(dialog).toHaveTextContent(/OpenStreetMap/);
    // AGPL section 13: the source offer must be reachable from the interface.
    expect(screen.getByRole("link", { name: /Source/ })).toHaveAttribute(
      "href",
      "/api/v1/system/source",
    );
  });

  it("closes a dialog on Escape", async () => {
    mockApi();
    render(<App />);
    await ready();
    fireEvent.click(screen.getByLabelText("About DSTNS, licence and source"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("silences notifications under do-not-disturb without touching the core", async () => {
    mockApi();
    render(<App />);
    await ready();
    calls.length = 0;
    fireEvent.click(screen.getByLabelText("Do not disturb"));
    await waitFor(() =>
      expect(screen.getByLabelText("Do not disturb")).toHaveAttribute("aria-pressed", "true"),
    );
    // Silencing is a presentation choice; it must never reach the simulation.
    expect(calls).toEqual([]);
  });

  it("ships with place names off while still drawing the buildings", async () => {
    mockApi();
    render(<App />);
    await ready();
    const drawn = () => screen.getByTestId("map").getAttribute("data-layers") ?? "";
    // The shipped default: the network keeps its shape without the clutter.
    expect(drawn()).not.toContain("place_names");
    expect(drawn()).toContain("buildings");

    // And the two are independent, so names can be turned on on their own.
    fireEvent.click(screen.getByRole("button", { name: /Display Layers/ }));
    fireEvent.click(await screen.findByLabelText("Place names"));
    await waitFor(() => {
      expect(drawn()).toContain("place_names");
      expect(drawn()).toContain("buildings");
    });
  });

  it("opens the auto-focus strategy menu on a double click", async () => {
    mockApi();
    render(<App />);
    await ready();
    fireEvent.doubleClick(screen.getByLabelText("Auto-focus on live events"));
    const menu = await screen.findByRole("menu", { name: "Auto-focus strategy" });
    expect(menu).toBeInTheDocument();
    // Round-Robin is the documented default.
    expect(screen.getByRole("menuitemradio", { name: /Round-Robin/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Latest/ }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("expands search from the dock rather than occupying the map", async () => {
    mockApi();
    render(<App />);
    await ready();
    // No search field until it is asked for.
    expect(screen.queryByLabelText("Search places")).toBeInstanceOf(HTMLButtonElement);
    fireEvent.click(screen.getByLabelText("Search places"));
    const field = await screen.findByPlaceholderText("Search places…");
    expect(field).toBeInTheDocument();
  });

  it("suspends the interface when ASB reports Async, leaving the run alive", async () => {
    mockApi({
      backpressure: {
        ...backpressure,
        state: "ASYNC",
        score: 1,
        synced: false,
        rate_locked: true,
        motion_locked: true,
        gui_suspended: true,
      },
    });
    render(<App />);
    const alert = await screen.findByRole("alertdialog", {}, { timeout: 4000 });
    expect(alert).toHaveTextContent(/suspended by the ASB/i);
    expect(alert).toHaveTextContent(/still running and still streaming/i);
    // Exactly the controls the design promises remain.
    const within = alert as HTMLElement;
    const overlayButton = (name: RegExp) =>
      Array.from(within.querySelectorAll("button")).find((b) => name.test(b.textContent ?? ""));
    expect(overlayButton(/^Terminate session$/)).toBeEnabled();
    expect(overlayButton(/^Reset$/)).toBeEnabled();
    expect(overlayButton(/^(Pause|Resume) simulation$/)).toBeEnabled();
    // And the ordinary chrome is stood down.
    expect(screen.getByRole("button", { name: /Display Layers/ })).toBeDisabled();
  });

  it("locks rate and motion while ASB is Restricted", async () => {
    mockApi({
      backpressure: {
        ...backpressure,
        state: "RESTRICTED",
        score: 0.9,
        synced: false,
        rate_locked: true,
        motion_locked: true,
        applied_tick_rate: 1,
        requested_tick_rate: 20,
      },
    });
    render(<App />);
    // Wait for ASB itself to be reported, not merely for controls to be
    // unavailable: they are also unavailable before any data has arrived.
    await screen.findByText("ASB · Restricted", {}, { timeout: 4000 });
    expect(screen.getByLabelText("Simulation rate multiplier")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const motion = screen.getByLabelText("Reduce motion");
    expect(motion).toBeDisabled();
    expect(motion).toHaveAttribute("aria-pressed", "true");
  });
});
