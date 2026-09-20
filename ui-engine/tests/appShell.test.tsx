import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { worldErrorMessage } from "../src/App";

// The canvas is exercised by the browser suites; here it only needs to mount,
// and to expose what it was asked to draw and where the camera was sent.
vi.mock("../src/NetworkMap", () => ({
  default: ({ layers, focus }: { layers: Record<string, boolean>; focus?: { bounds?: unknown; token: number } | null }) => (
    <div
      data-testid="map"
      data-layers={Object.entries(layers)
        .filter(([, on]) => on)
        .map(([k]) => k)
        .sort()
        .join(",")}
      data-focus={focus?.bounds ? JSON.stringify(focus.bounds) : ""}
    />
  ),
}));

const baseClock = {
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
    { id: 0, position: { x_m: 0, y_m: 0, lat: 52.5, lon: 13.4 }, degree: 2, signal: false, osm_node_id: 1 },
    { id: 1, position: { x_m: 2000, y_m: 2000, lat: 52.52, lon: 13.43 }, degree: 2, signal: false, osm_node_id: 2 },
  ],
  edges: [
    {
      id: 0, from: 0, to: 1, reverse_twin: -1, synthetic_reverse: false, name: "Test Road", road_class: "residential",
      length_m: 100, lanes: 1, free_speed_mps: 13.9,
      geometry: [
        { x_m: 0, y_m: 0, lat: 52.5, lon: 13.4 },
        { x_m: 2000, y_m: 2000, lat: 52.52, lon: 13.43 },
      ],
    },
  ],
  features: [],
  source: "OpenStreetMap",
  map_selection_version: "urban-crfg-v3",
  bounds: { min_lat: 52.4, max_lat: 52.6, min_lon: 13.3, max_lon: 13.5 },
  projection: { name: "local equirectangular", origin_lat: 52.5, origin_lon: 13.4, units: "metres" },
  location: { city: "Berlin", country: "Germany", anchor_lat: 52.505, anchor_lon: 13.4235, city_extent_m: 5000, downloaded: true },
};

const baseSnapshot = {
  topology_revision: 1,
  nodes: [],
  edges: [
    {
      id: 0, congestion: 0.2, rainfall: 0, flood: 0, effective_speed_mps: 11, mean_speed_mps: 11, vehicle_count: 7,
      halting_count: 1, closed: false, incident_closed: false, incident_speed_multiplier: 1, signal_multiplier: 1,
      demand_vph: 300, effective_capacity_vph: 900, demand_causes: [],
    },
  ],
  signals: [],
  demand: [],
  congestion: { current: 14, average: 20, delta: -6, source: "model" },
  active_weather: [] as { id: number; x_m: number; y_m: number; radius_m: number; intensity: number; phase?: number }[],
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

/** Every mutating call, so tests can assert exactly what reached the core. */
let calls: { path: string; method: string; body: string }[] = [];

type Mock = {
  lifecycle: string;
  runId: string;
  seed: string;
  seedHex: string;
  clock: typeof baseClock;
  snapshot: typeof baseSnapshot;
  backpressure: typeof backpressure;
  uiConfig: Record<string, unknown>;
  news: Record<string, unknown>[];
  world: Record<string, unknown>;
  worldQueue: Record<string, unknown>[];
  topology?: unknown;
  preparation: string;
  topologyDelay: boolean;
};
let state: Mock;

const ASKS_FIRST = { auto_focus: { mode: "enable" } };

/** Wait until the run has loaded and its controls are live. */
async function ready() {
  await waitFor(() => expect(screen.getByLabelText("Pause simulation")).toBeEnabled(), { timeout: 4000 });
}

function mockApi(overrides: Partial<Mock> = {}) {
  state = {
    lifecycle: "RUNNING",
    runId: "run_1",
    seed: "17310766248549826767",
    seedHex: "0xf02b5a3a1c2d4e8f",
    clock: { ...baseClock },
    snapshot: structuredClone(baseSnapshot),
    backpressure,
    uiConfig: {},
    news: [],
    world: { state: "idle", stage: "idle", seed: "", previous_run_id: "", run_id: "", generation: 0, elapsed_s: 0, map: null, error: null, enabled: true },
    worldQueue: [],
    preparation: "",
    topologyDelay: false,
    ...overrides,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET" && !path.includes("/system/backpressure")) calls.push({ path, method, body: String(init?.body ?? "") });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const envelope = (data: unknown) => ({
      api_version: "1.0",
      run_id: state.runId,
      seed: state.seed,
      global_seed: state.seedHex,
      state_revision: 1,
      config_revision: 1,
      clock: { ...state.clock, playback_state: state.lifecycle },
      data,
    });
    if (path.includes("/system/ui-config")) return json({ api_version: "1.0", data: state.uiConfig });
    if (path.includes("/system/map-status"))
      return json({ api_version: "1.0", data: { active: false, preparation: state.preparation } });
    if (path.includes("/system/backpressure")) return json(state.backpressure);
    if (path.includes("/world/regenerate")) {
      state.world = { ...state.world, state: "generating", stage: "compiling", seed: "4210818", previous_run_id: state.runId };
      return json({ api_version: "1.0", data: state.world }, 202);
    }
    if (path.includes("/world/status")) {
      // Progress only advances once a generation has been requested.
      if (state.world.state === "generating" && state.worldQueue.length) state.world = { ...state.world, ...state.worldQueue.shift() };
      return json({ api_version: "1.0", data: state.world });
    }
    if (path.includes("/playback/step")) return json({ simulated_seconds: state.clock.virtual_day_seconds + 60, stepped_seconds: 60, lifecycle: "PAUSED" });
    let data: unknown = {};
    if (path.includes("/playback/status"))
      data = { lifecycle: state.lifecycle, day: 0, saved_seed_id: "", map_selection_version: "urban-crfg-v3", modules: { traffic: true, signals: true, dws: true }, playback_revision: 1 };
    else if (path.includes("/view/topology")) {
      if (state.topologyDelay) return json({ error: { code: "NOT_READY", message: "no topology yet" } }, 409);
      data = state.topology ?? topology;
    }
    else if (path.includes("/view/snapshot")) data = state.snapshot;
    else if (path.includes("/news")) {
      const since = Number(new URL(path, "http://x").searchParams.get("since_news_id") ?? 0);
      data = { items: state.news.filter((n) => (n.news_id as number) > since) };
    } else if (path.includes("/view/congestion")) data = { ...state.snapshot.congestion, history: [] };
    else if (path.includes("/view/event-queue")) {
      const category = new URL(path, "http://x").searchParams.get("category") ?? "all";
      const items = [{ id: 1, virtual_s: 25200, entity: 3, category: "signals", description: "Signal 3 → NS green", status: "pending", phase: 1, value: 0 }];
      const shown = items.filter((i) => category === "all" || i.category === category);
      data = { items: shown, total: shown.length, pending_count: shown.length, executed_count: 0, history_retention: 500 };
    }
    return json(envelope(data));
  });
}

let newsId = 1;
function news(partial: Record<string, unknown>) {
  const id = newsId++;
  return { news_id: id, event_id: id, virtual_day_s: 21600, simulated_current_time: "06:00:00", category: "system", severity: "info", template_id: "X", message: "", data: {}, ...partial };
}

beforeEach(() => {
  calls = [];
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("observer shell", () => {
  it("shows the seed-selected city and its coordinates", async () => {
    mockApi();
    render(<App />);
    expect(await screen.findByText("Berlin, Germany")).toBeInTheDocument();
    expect(await screen.findByText(/52\.5050° N, 13\.4235° E/)).toBeInTheDocument();
  });

  it("renders live telemetry from the snapshot", async () => {
    mockApi();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Live Telemetry" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("14%").length).toBeGreaterThan(0));
  });

  it("does not offer playback control while the core is idle", async () => {
    mockApi({ lifecycle: "IDLE" });
    render(<App />);
    expect(await screen.findByText("Waiting for a simulation")).toBeInTheDocument();
    expect(screen.getByText(/Start a run from the DSTNS CLI/)).toBeInTheDocument();
    // Waiting for a run is not presented as loading progress.
    expect(screen.queryByRole("list", { name: "Progress" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Pause simulation")).toBeDisabled();
  });

  it("surfaces a map download failure as an alert", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ ok: false, error: { code: "MAP_FETCH_FAILED", message: "OSM download failed for Berlin (Germany) at 52.505, 13.423: Overpass returned HTTP 429" } }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/OSM download failed for Berlin/);
    expect(alert.className).toContain("capsule");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });
});

describe("command rail", () => {
  it("drives play, pause, back, step and forward through the core", async () => {
    mockApi();
    render(<App />);
    await ready();
    fireEvent.click(screen.getByLabelText("Pause simulation"));
    await waitFor(() => expect(calls.some((c) => c.path.includes("/playback/pause"))).toBe(true));

    // Back and Forward skip 15 minutes by default, through real seeks.
    fireEvent.click(screen.getByLabelText("Back 15 min"));
    await waitFor(() => expect(calls.some((c) => c.path.includes("/playback/seek") && JSON.parse(c.body).target_time === 21600 - 900)).toBe(true));
    fireEvent.click(screen.getByLabelText("Forward 15 min"));
    await waitFor(() => expect(calls.some((c) => c.path.includes("/playback/seek") && JSON.parse(c.body).target_time === 21600 + 900)).toBe(true));

    // Step uses the core's step operation, which holds the run afterwards.
    fireEvent.click(screen.getByLabelText("Step 1 min"));
    await waitFor(() => {
      const step = calls.find((c) => c.path.includes("/playback/step"));
      expect(step && JSON.parse(step.body)).toEqual({ seconds: 60 });
    });
  });

  it("confirms before resetting and does nothing when cancelled", async () => {
    mockApi();
    render(<App />);
    await ready();
    calls.length = 0;
    fireEvent.click(screen.getByLabelText("Reset simulation to the start of the day"));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Reset the simulation?");
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls).toEqual([]);

    fireEvent.click(screen.getByLabelText("Reset simulation to the start of the day"));
    fireEvent.click(await screen.findByRole("button", { name: "Reset to 00:00:00" }));
    await waitFor(() => expect(calls.some((c) => c.path.includes("/playback/seek") && JSON.parse(c.body).target_time === 0)).toBe(true));
  });

  it("offers exactly the seven supported speeds and sets the real engine rate", async () => {
    mockApi();
    render(<App />);
    await ready();
    const group = screen.getByRole("radiogroup", { name: "Simulation speed" });
    const options = within(group).getAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual(["0.25×", "0.5×", "1×", "2×", "3×", "5×", "10×"]);
    expect(within(group).getByRole("radio", { name: "1 times speed" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(group).getByRole("radio", { name: "3 times speed" }));
    await waitFor(() => {
      const tick = calls.find((c) => c.path.includes("/control/tick-rate"));
      expect(tick && JSON.parse(tick.body)).toEqual({ tick_rate: 3 });
    });
    // Arrow keys move between the offered steps.
    calls.length = 0;
    fireEvent.keyDown(within(group).getByRole("radio", { name: "1 times speed" }), { key: "ArrowLeft" });
    await waitFor(() => expect(calls.some((c) => c.path.includes("/control/tick-rate") && JSON.parse(c.body).tick_rate === 0.5)).toBe(true));
  });

  it("shows progress and switches 12/24 hour time everywhere from one control", async () => {
    mockApi({ news: [news({ category: "weather", template_id: "WEATHER_FORECAST", message: "[14:30:00] Forecast issued at 14:30:00", virtual_day_s: 52200 })] });
    render(<App />);
    await ready();
    const time = screen.getByRole("button", { name: /Simulation time 06:00:00, 25 percent complete/ });
    expect(time).toHaveTextContent("25% complete");
    // The News tab lists the event in 24 hour time.
    fireEvent.click(screen.getByRole("tab", { name: /News/ }));
    expect(await screen.findByText("Forecast issued at 14:30:00")).toBeInTheDocument();

    fireEvent.click(time);
    await waitFor(() => expect(screen.getByRole("button", { name: /Simulation time 6:00:00 AM/ })).toBeInTheDocument());
    // Text composed by the core and timestamps elsewhere follow the same preference.
    expect(await screen.findByText("Forecast issued at 2:30:00 PM")).toBeInTheDocument();
    expect(screen.getAllByText("2:30:00 PM").length).toBeGreaterThan(0);
    // And the preference persists as a viewer choice.
    expect(JSON.parse(localStorage.getItem("dstns.ui-config.v1") ?? "{}")).toMatchObject({ clock: { hour12: true } });
  });

  it("marks the paused state on the time control", async () => {
    mockApi({ lifecycle: "PAUSED" });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Resume simulation")).toBeEnabled(), { timeout: 4000 });
    const time = screen.getByRole("button", { name: /Simulation time/ });
    expect(time.className).toContain("paused");
    expect(time).toHaveAccessibleName(/paused/);
  });

  it("shows the raw numeric seed and copies it whole on click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mockApi();
    render(<App />);
    await ready();
    // The run is named by the number that starts it, not by its hash.
    const seed = screen.getByRole("button", { name: /Copy seed 17310766248549826767/ });
    expect(seed).toHaveTextContent("17310766…6767");
    expect(seed).not.toHaveTextContent("0xf02b");
    fireEvent.click(seed);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("17310766248549826767"));
    expect(await within(seed).findByText("Copied")).toBeInTheDocument();
    // Copying is local; nothing reaches the core.
    expect(calls).toEqual([]);
  });

  it("shows runtime status as Online, and Degraded while ASB intervenes", async () => {
    mockApi();
    render(<App />);
    await ready();
    expect(screen.getByRole("status", { name: "Runtime status Online" })).toBeInTheDocument();
    expect(screen.queryByText(/1 Hz/)).not.toBeInTheDocument();
    cleanup();
    mockApi({ backpressure: { ...backpressure, rate_capped: true, applied_tick_rate: 1, requested_tick_rate: 3 } });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("status", { name: "Runtime status Degraded" })).toBeInTheDocument(), { timeout: 4000 });
  });

  it("confirms before terminating", async () => {
    mockApi();
    render(<App />);
    await ready();
    calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Terminate" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Terminate this session?");
    expect(calls).toEqual([]);
  });
});

describe("world regeneration", () => {
  it("asks first, then runs the real pipeline with staged progress until the new world loads", async () => {
    mockApi({
      worldQueue: [
        { stage: "downloading", elapsed_s: 2, map: { city: "Oslo", country: "Norway", phase: "download", bytes: 2 * 1048576, total: 8 * 1048576, elapsed_s: 1 } },
        { stage: "building", elapsed_s: 4 },
        { stage: "installing", elapsed_s: 5 },
        { state: "ready", stage: "ready", run_id: "run_2", elapsed_s: 6 },
      ],
    });
    render(<App />);
    await ready();
    calls.length = 0;
    fireEvent.click(screen.getByLabelText("Generate new world"));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Generate New World?");
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    const overlay = await screen.findByRole("alertdialog");
    await waitFor(() => expect(calls.some((c) => c.path.includes("/world/regenerate") && JSON.parse(c.body).expected_run_id === "run_1")).toBe(true));
    expect(await within(overlay).findByText("4210818")).toBeInTheDocument();
    // Real download progress is shown when the core knows the size.
    expect(await within(overlay).findByText(/Downloading Oslo, Norway: 2\.0 of 8\.0 MiB/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(within(overlay).getByRole("progressbar", { name: "Download progress" })).toHaveAttribute("aria-valuenow", "25");
    expect(await within(overlay).findByText("Constructing the graph, signals and schedules", {}, { timeout: 3000 })).toBeInTheDocument();

    // The core swaps worlds: the interface picks the new run up and the overlay leaves.
    state.runId = "run_2";
    state.seed = "4210818";
    state.seedHex = "0x40422";
    state.lifecycle = "PAUSED";
    expect(await screen.findByText("New world ready", {}, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByRole("button", { name: /Copy seed 4210818/ })).toBeInTheDocument();
  }, 20000);

  it("reports a failed generation and keeps the current world", async () => {
    mockApi({ worldQueue: [{ state: "failed", stage: "failed", error: { code: "MAP_FETCH_FAILED", message: "OSM download failed for Oslo: Overpass returned HTTP 429" } }] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<App />);
    await ready();
    fireEvent.click(screen.getByLabelText("Generate new world"));
    fireEvent.click(await screen.findByRole("button", { name: "Generate" }));
    const overlay = await screen.findByRole("alertdialog");
    expect(await within(overlay).findByText("World generation failed", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(overlay).toHaveTextContent(/could not be downloaded from OpenStreetMap\. Overpass returned HTTP 429/);
    expect(overlay).toHaveTextContent("The previous world is unchanged");
    expect(overlay).not.toHaveTextContent(/at .*\.cpp|stack/i);
    expect(errors).toHaveBeenCalled();
    // Retry issues a fresh request; Return closes without touching the run.
    calls.length = 0;
    fireEvent.click(within(overlay).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls.some((c) => c.path.includes("/world/regenerate"))).toBe(true));
    state.worldQueue = [{ state: "failed", stage: "failed", error: { code: "WORLD_GENERATION_FAILED", message: "x" } }];
    fireEvent.click(await screen.findByRole("button", { name: "Return to current world" }, { timeout: 3000 }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Copy seed 17310766/ })).toBeInTheDocument();
  }, 15000);

  it("phrases generation errors for operators", () => {
    expect(worldErrorMessage("WORLD_REGENERATION_DISABLED", "")).toBe("World generation is disabled for this deployment.");
    expect(worldErrorMessage("WORLD_GENERATION_FAILED", "std::runtime_error at engine.cpp:120")).not.toMatch(/cpp/);
  });

  it("keeps the whole cause of a failed map download, and what to do about it", () => {
    const fromCore =
      "OSM download failed for San Jose (Costa Rica) at 9.934443, -84.081511: fetch_osm: no route to Overpass from this host: " +
      "overpass-api.de (Connection refused); overpass.kumi.systems (Connection refused). Check the network connection, VPN or proxy, " +
      "or set DSTNS_OVERPASS_ENDPOINTS to a reachable Overpass instance. An already cached city can be used with --osm-file.";
    const shown = worldErrorMessage("MAP_FETCH_FAILED", fromCore);
    // The cause survives in full: both mirrors, and the ways out.
    expect(shown).toMatch(/could not be downloaded from OpenStreetMap/);
    expect(shown).toMatch(/overpass-api.de \(Connection refused\)/);
    expect(shown).toMatch(/overpass.kumi.systems/);
    expect(shown).toMatch(/DSTNS_OVERPASS_ENDPOINTS/);
    expect(shown).toMatch(/--osm-file/);
    // Without the core's own prefixes, which say nothing to an operator.
    expect(shown).not.toMatch(/fetch_osm:/);
    expect(shown).not.toMatch(/^OSM download failed/);
  });
});

describe("notifications", () => {
  const rain = () =>
    news({ category: "weather", severity: "warning", template_id: "DWS_RAIN_STARTED", event_id: 4, message: "[06:00:00] Rain storm initiated at Node 1 (Radius: 800m, Intensity: 80%)", data: { epicenter: 1, radius_m: 800, intensity: 0.8 } });
  const crash = () =>
    news({ category: "incident", severity: "alert", template_id: "INCIDENT_ACTIVATED", message: "[06:00:00] Multi-vehicle collision: lane blocked on Edge #0 near Node #0. (HIGH SEVERITY)", data: { incident_id: 9, type: "accident", edge_id: 0, closed: true } });

  /** News only becomes a notification after the first poll, as it does live. */
  async function arrive(...items: Record<string, unknown>[]) {
    await ready();
    await act(async () => {
      state.news.push(...items);
      await new Promise((r) => setTimeout(r, 1300));
    });
  }

  it("shows one compact capsule with a count badge and expands in place", async () => {
    mockApi({ uiConfig: { auto_focus: { mode: "disable" } } });
    render(<App />);
    await arrive(rain(), crash());
    const capsule = await screen.findByRole("article", { name: "Notifications" });
    const head = within(capsule).getByRole("button", { expanded: false });
    // The most severe event leads; the other is counted, not stacked.
    expect(head).toHaveTextContent("Collision");
    expect(head).toHaveTextContent("+1");
    expect(head).not.toHaveTextContent(/Edge #0|Node #0/);
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(capsule).toHaveTextContent("Multi-vehicle collision on Test Road. Lane blocked.");
    expect(capsule).toHaveTextContent("Severity");
    // Raw fields stay behind the technical disclosure.
    fireEvent.click(within(capsule).getByRole("button", { name: /Technical details/ }));
    expect(capsule).toHaveTextContent("INCIDENT_ACTIVATED");
    // The other event is one click away.
    fireEvent.click(within(capsule).getByRole("button", { name: /Heavy rain/ }));
    expect(capsule).toHaveTextContent(/Heavy rainfall has developed over/);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(within(capsule).getByRole("button", { expanded: false })).toBeInTheDocument());
  }, 15000);

  it("silences muted categories under Do Not Disturb without touching the core", async () => {
    mockApi({ uiConfig: { auto_focus: { mode: "disable" }, notifications: { dnd: true, dnd_categories: ["weather"] } } });
    render(<App />);
    await arrive(rain(), crash());
    const capsule = await screen.findByRole("article", { name: "Notifications" });
    expect(capsule).toHaveTextContent("Collision");
    expect(capsule).not.toHaveTextContent("+1");
    expect(calls).toEqual([]);
  }, 15000);

  it("keeps silenced events in the Notifications history instead of announcing them", async () => {
    mockApi({ uiConfig: { auto_focus: { mode: "disable" }, notifications: { dnd: true } } });
    render(<App />);
    await arrive(rain(), crash());
    const tab = await screen.findByRole("tab", { name: "Notifications, 2 silenced" }, { timeout: 4000 });
    expect(screen.queryByRole("article", { name: "Notifications" })).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ silenced/)).not.toBeInTheDocument();
    fireEvent.click(tab);
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("radio", { name: "Silenced, 2" })).toBeInTheDocument();
    // Both events are kept, each marked as held back rather than shown.
    for (const title of [/Heavy rain/, /Collision/]) {
      const row = within(panel).getByRole("button", { name: title });
      expect(within(row).getByText("Silenced")).toBeInTheDocument();
    }
    // Each record expands to its details and technical fields.
    const [first] = within(panel).getAllByRole("button", { name: /Collision|Heavy rain/ });
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(within(panel).getByRole("button", { name: "Technical details" }));
    expect(within(panel).getByText("Template")).toBeInTheDocument();
  }, 15000);

  it("records shown notifications once, in the global time format", async () => {
    mockApi({ uiConfig: { auto_focus: { mode: "disable" }, clock: { hour12: true } } });
    render(<App />);
    await arrive(rain());
    await screen.findByRole("article", { name: "Notifications" }, { timeout: 4000 });
    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    const panel = screen.getByRole("tabpanel");
    await waitFor(() => expect(within(panel).getAllByRole("button", { name: /Heavy rain/ })).toHaveLength(1));
    const row = within(panel).getByRole("button", { name: /Heavy rain/ });
    expect(within(row).getByText("Shown")).toBeInTheDocument();
    expect(within(row).getByText("6:00:00 AM")).toBeInTheDocument();
    // Further polls re-render the same event without duplicating it.
    await new Promise((r) => setTimeout(r, 1300));
    expect(within(panel).getAllByRole("button", { name: /Heavy rain/ })).toHaveLength(1);
  }, 15000);

  it("lets the auto-focused event through DND, and only that event", async () => {
    const snapshot = structuredClone(baseSnapshot);
    snapshot.active_weather = [{ id: 4, x_m: 500, y_m: 500, radius_m: 800, intensity: 0.8, phase: 0.1 }];
    mockApi({ snapshot, uiConfig: { notifications: { dnd: true } } });
    render(<App />);
    await arrive(rain(), crash());
    const capsule = await screen.findByRole("article", { name: "Notifications" });
    // Weather is muted, but it is what the camera is following.
    expect(capsule).toHaveTextContent("Heavy rain");
    expect(capsule).not.toHaveTextContent("+1");
    fireEvent.click(within(capsule).getByRole("button", { expanded: false }));
    expect(capsule).toHaveTextContent("Following");
  }, 15000);
});

describe("auto focus", () => {
  it("frames a rain cell by its footprint and follows it as it grows", async () => {
    const snapshot = structuredClone(baseSnapshot);
    snapshot.active_weather = [{ id: 4, x_m: 500, y_m: 500, radius_m: 300, intensity: 0.5, phase: 0.05 }];
    mockApi({ snapshot });
    render(<App />);
    await ready();
    const focus = () => JSON.parse(screen.getByTestId("map").getAttribute("data-focus") || "null");
    await waitFor(() => expect(focus()).toEqual({ minX: 200, maxX: 800, minY: 200, maxY: 800 }));
    // The cell grows: the framing widens to keep the whole cloud in view.
    await act(async () => {
      state.snapshot = { ...state.snapshot, active_weather: [{ id: 4, x_m: 520, y_m: 500, radius_m: 900, intensity: 0.8, phase: 0.2 }] };
      await new Promise((r) => setTimeout(r, 1300));
    });
    await waitFor(() => expect(focus()).toEqual({ minX: -380, maxX: 1420, minY: -400, maxY: 1400 }));
  }, 15000);

  it("returns to the whole network when nothing needs attention", async () => {
    mockApi();
    render(<App />);
    await ready();
    await waitFor(() => expect(JSON.parse(screen.getByTestId("map").getAttribute("data-focus") || "null")).toEqual({ minX: 0, maxX: 2000, minY: 0, maxY: 2000 }));
  });

  it("offers Auto Focus once per run and remembers the answer", async () => {
    mockApi({ uiConfig: ASKS_FIRST });
    render(<App />);
    expect(await screen.findByText("This simulation supports Auto Focus")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(screen.queryByText("This simulation supports Auto Focus")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Auto Focus on live events")).toHaveAttribute("aria-pressed", "true");
    await new Promise((r) => setTimeout(r, 120));
    expect(screen.queryByText("This simulation supports Auto Focus")).not.toBeInTheDocument();
  });

  it("opens the order menu on a double click", async () => {
    mockApi();
    render(<App />);
    await ready();
    fireEvent.doubleClick(screen.getByLabelText("Auto Focus on live events"));
    await screen.findByRole("menu", { name: "Auto Focus order" });
    expect(screen.getByRole("menuitemradio", { name: /Round-Robin/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Latest/ }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
});

describe("settings", () => {
  it("slides a drawer in from the sidebar with Auto Focus and DND categories", async () => {
    mockApi();
    render(<App />);
    await ready();
    const drawer = document.querySelector<HTMLElement>(".settings-drawer")!;
    expect(drawer).toHaveAttribute("aria-hidden", "true");
    expect(drawer.className).not.toContain("open");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(drawer.className).toContain("open");
    expect(drawer).toHaveAttribute("aria-hidden", "false");

    const autoFocus = within(drawer).getByRole("switch", { name: "Auto Focus Events" });
    expect(autoFocus).toHaveAttribute("aria-checked", "true");
    fireEvent.click(autoFocus);
    expect(autoFocus).toHaveAttribute("aria-checked", "false");
    expect(screen.getByLabelText("Auto Focus on live events")).toHaveAttribute("aria-pressed", "false");

    const dnd = within(drawer).getByRole("switch", { name: "Do Not Disturb" });
    fireEvent.click(dnd);
    expect(screen.getByRole("button", { name: "Do Not Disturb" })).toHaveAttribute("aria-pressed", "true");
    const weather = within(drawer).getByRole("checkbox", { name: /Weather updates/ });
    expect(weather).toBeChecked();
    fireEvent.click(weather);
    expect(weather).not.toBeChecked();
    expect(JSON.parse(localStorage.getItem("dstns.ui-config.v1") ?? "{}").notifications.dnd_categories).not.toContain("weather");

    // Presentation only: none of this reaches the core.
    expect(calls).toEqual([]);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(drawer.className).not.toContain("open"));
  });

  it("changes the skip and step intervals used by the rail", async () => {
    mockApi();
    render(<App />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const drawer = screen.getByRole("dialog", { name: "Settings" });
    fireEvent.click(within(within(drawer).getByRole("radiogroup", { name: "Skip interval" })).getByRole("radio", { name: "1h" }));
    fireEvent.click(within(within(drawer).getByRole("radiogroup", { name: "Step interval" })).getByRole("radio", { name: "10s" }));
    expect(screen.getByLabelText("Back 1 h 00 min")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Step 10 s"));
    await waitFor(() => expect(calls.some((c) => c.path.includes("/playback/step") && JSON.parse(c.body).seconds === 10)).toBe(true));
  });
});

describe("layers and legend", () => {
  it("keeps layers entirely in the frontend", async () => {
    mockApi();
    render(<App />);
    await ready();
    expect(screen.getByTestId("map").getAttribute("data-layers")).toContain("weather");
    fireEvent.click(screen.getByRole("button", { name: /Layers/ }));
    fireEvent.click(await screen.findByRole("switch", { name: "Weather" }));
    await waitFor(() => expect(screen.getByTestId("map").getAttribute("data-layers")).not.toContain("weather"));
    expect(calls).toEqual([]);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Layers" })).not.toBeInTheDocument());
  });

  it("ships with road and place names hidden while drawing roads and buildings", async () => {
    mockApi();
    render(<App />);
    await ready();
    const drawn = () => screen.getByTestId("map").getAttribute("data-layers") ?? "";
    expect(drawn()).not.toContain("labels");
    expect(drawn()).not.toContain("place_names");
    expect(drawn()).toContain("roads");
    expect(drawn()).toContain("buildings");
    fireEvent.click(screen.getByRole("button", { name: /Layers/ }));
    fireEvent.click(await screen.findByRole("switch", { name: "Place names" }));
    await waitFor(() => expect(drawn()).toContain("place_names"));
  });

  it("shows the road-state legend beside the layers control", async () => {
    mockApi();
    render(<App />);
    await ready();
    const legend = screen.getByRole("list", { name: "Road state legend" });
    expect(legend).toHaveTextContent(/Clear.*Moderate.*Severe.*Flooded/);
    // The compact form opens the same legend in a popover.
    fireEvent.click(screen.getByRole("button", { name: "Road state legend" }));
    expect(await screen.findByRole("dialog", { name: "Road state legend" })).toHaveTextContent(/Clear.*Flooded/);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Road state legend" })).not.toBeInTheDocument());
  });
});

describe("start-up", () => {
  const sizeTo = (width: number, height: number) => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
    fireEvent(window, new Event("resize"));
  };
  afterEach(() => sizeTo(1440, 900));

  it("narrates the stages the core reports, then shows the map", async () => {
    mockApi({ lifecycle: "PREPARING" });
    state.preparation = "selecting";
    state.topologyDelay = true;
    render(<App />);
    const surface = await screen.findByRole("status", { name: /Selecting world|Starting interface/ }, { timeout: 4000 });
    await waitFor(() => expect(within(surface).getByRole("heading")).toHaveTextContent("Selecting world"), { timeout: 4000 });
    const steps = within(surface).getByRole("list", { name: "Progress" });
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Starting interface",
      "Selecting world",
      "Downloading map",
      "Generating world",
      "Initializing simulation",
    ]);
    expect(within(steps).getByText("Selecting world").closest("li")).toHaveClass("active");
    expect(within(steps).getByText("Starting interface").closest("li")).toHaveClass("done");

    state.preparation = "building";
    await waitFor(() => expect(within(surface).getByRole("heading")).toHaveTextContent("Generating world"), { timeout: 4000 });
    expect(within(steps).getByText("Selecting world").closest("li")).toHaveClass("done");

    // The map arrives: the start-up screen leaves rather than disappearing.
    state.preparation = "";
    state.lifecycle = "RUNNING";
    state.topologyDelay = false;
    await ready();
    await waitFor(() => expect(document.querySelector(".loading-surface")).toBeNull(), { timeout: 4000 });
  }, 20000);

  it("does not claim progress before a run exists", async () => {
    mockApi({ lifecycle: "IDLE" });
    render(<App />);
    expect(await screen.findByText("Waiting for a simulation")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Progress" })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("refuses to squeeze the interface onto a small display", async () => {
    mockApi();
    render(<App />);
    await ready();
    sizeTo(900, 700);
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("This interface is not optimized for this screen size.");
    expect(notice).toHaveTextContent("1024");
    expect(notice).toHaveTextContent("900");
    expect(screen.queryByLabelText("Pause simulation")).not.toBeInTheDocument();
    // It leaves on its own once there is room again.
    sizeTo(1440, 900);
    await waitFor(() => expect(screen.getByLabelText("Pause simulation")).toBeInTheDocument());
  }, 15000);
});

describe("telemetry collapse", () => {
  const deck = () => screen.getByRole("complementary", { name: "Live telemetry" });

  it("collapses to a compact strip and opens detail views in a side panel", async () => {
    const snapshot = structuredClone(baseSnapshot);
    snapshot.edges = Array.from({ length: 1 }, () => ({ ...baseSnapshot.edges[0], vehicle_count: 1240 }));
    snapshot.active_weather = [{ id: 3, x_m: 0, y_m: 0, radius_m: 900, intensity: 0.8, phase: 0.4 }];
    mockApi({ snapshot });
    render(<App />);
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: /Queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse live telemetry" }));
    expect(deck()).toHaveClass("compact");
    expect(localStorage.getItem("dstns.telemetry-mode.v1")).toBe("compact");

    const strip = screen.getByRole("navigation", { name: "Telemetry summary" });
    // Compact figures, with names that do not depend on the tooltip.
    expect(within(strip).getByRole("button", { name: /^Vehicles: 1,240/ })).toHaveTextContent("1.2K");
    expect(within(strip).getByRole("button", { name: "Weather: Heavy rain, 1 active cell, 6.4 mm/h" })).toBeInTheDocument();

    // Stack opens a side panel; Incidents and Queue switch it without closing it.
    fireEvent.click(within(strip).getByRole("button", { name: "Stack" }));
    const panel = await screen.findByRole("dialog", { name: "Stack" });
    expect(panel).toHaveTextContent("Road network");
    fireEvent.click(within(strip).getByRole("button", { name: "Incidents" }));
    expect(await screen.findByRole("dialog", { name: "Incidents" })).toBe(panel);
    fireEvent.click(within(strip).getByRole("button", { name: "Queue" }));
    expect(await screen.findByRole("dialog", { name: "Queue" })).toBe(panel);
    expect(deck()).toHaveClass("compact");

    // Escape closes the panel and returns focus to the strip.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Queue" })).not.toBeInTheDocument());
    expect(within(strip).getByRole("button", { name: "Queue" })).toHaveFocus();

    // Expanding restores the full panel on the tab it was left on.
    fireEvent.click(within(strip).getByRole("button", { name: "Expand live telemetry" }));
    expect(deck()).not.toHaveClass("compact");
    expect(screen.getByRole("tab", { name: /Queue/ })).toHaveAttribute("aria-selected", "true");
  });

  it("remembers the collapsed layout across reloads", async () => {
    localStorage.setItem("dstns.telemetry-mode.v1", "compact");
    mockApi();
    render(<App />);
    await ready();
    expect(deck()).toHaveClass("compact");
  });

  it("uses a custom dropdown for the queue category", async () => {
    mockApi();
    render(<App />);
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: /Queue/ }));
    const trigger = screen.getByRole("button", { name: "Event category: All categories" });
    expect(document.querySelector(".telemetry-deck select")).toBeNull();
    fireEvent.click(trigger);
    const list = await screen.findByRole("listbox", { name: "Event category" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Event category: Signals" })).toBeInTheDocument());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("place legend", () => {
  const at = { x_m: 100, y_m: 100, lat: 52.5, lon: 13.4 };
  const feature = (id: string, category: string, tags: Record<string, string>, demand_type: string | null = null) => ({
    id, name: "", category, polygon: false, position: at, geometry: [at], tags, demand_type,
  });
  const withPlaces = () => ({
    ...topology,
    features: [
      feature("s1", "school", { amenity: "school" }, "school"),
      feature("s2", "school", { amenity: "school" }, "school"),
      feature("h1", "hospital", { amenity: "hospital" }, "store"),
      feature("p1", "pharmacy", { amenity: "pharmacy" }),
      feature("b1", "bench", { amenity: "bench" }),
      feature("b2", "bench", { amenity: "bench" }),
    ],
  });

  it("lists the markers on the map with the core's demand, and hides unclassified places by default", async () => {
    const snapshot = structuredClone(baseSnapshot) as Omit<typeof baseSnapshot, "demand"> & {
      demand: { feature_id: string; multiplier: number; active: boolean; radius_m: number }[];
    };
    snapshot.demand = [
      { feature_id: "s1", multiplier: 1.62, active: true, radius_m: 400 },
      { feature_id: "s2", multiplier: 1, active: false, radius_m: 400 },
      { feature_id: "h1", multiplier: 1.15, active: true, radius_m: 400 },
    ];
    mockApi({ topology: withPlaces(), snapshot: snapshot as typeof baseSnapshot });
    render(<App />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Place legend" }));
    const legend = await screen.findByRole("dialog", { name: "Place legend" });
    const rows = within(legend).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^HHospital1Peak 1\.15×$/),
      expect.stringMatching(/^SSchool2Peak 1\.62×$/),
      expect.stringMatching(/^\+Pharmacy1Not modelled$/),
    ]);
    // Unclassified dots are off by default and can be turned on here or in Layers.
    const toggle = within(legend).getByRole("switch", { name: "Show unclassified places" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(within(legend).getAllByRole("listitem")).toHaveLength(4));
    expect(within(legend).getAllByRole("listitem")[3]).toHaveTextContent(/Unclassified2Not modelled/);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    expect(screen.getByRole("switch", { name: "Unclassified places" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("dialogs and suspension", () => {
  it("shows the About card with the licence and a source offer", async () => {
    mockApi();
    render(<App />);
    await ready();
    fireEvent.click(screen.getByLabelText("About DSTNS, licence and source"));
    const dialog = await screen.findByRole("dialog", { name: /Deterministic Spatiotemporal Transport Network Simulator/ });
    expect(dialog).toHaveTextContent("Varun Karthic");
    expect(dialog).toHaveTextContent(/Affero General Public License/);
    expect(dialog).toHaveTextContent(/Version \d+\.\d+\.\d+/);
    expect(screen.getByRole("link", { name: /Source code/ })).toHaveAttribute("href", "/api/v1/system/source");
    // The licence is a custom disclosure, closed until asked for.
    const licence = within(dialog).getByRole("button", { name: /Licence and attribution/ });
    expect(licence).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(licence);
    expect(licence).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByRole("button", { name: "Copy seed" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Deterministic Spatiotemporal/ })).not.toBeInTheDocument());
  });

  it("announces completion and offers the report", async () => {
    mockApi({ lifecycle: "COMPLETED", clock: { ...baseClock, virtual_day_seconds: 86400, simulation_percentage: 1 }, news: [news({ template_id: "INCIDENT_ACTIVATED", severity: "alert", category: "incident" }), news({ template_id: "DWS_RAIN_STARTED", severity: "warning", category: "weather" })] });
    render(<App />);
    const dialog = await screen.findByRole("dialog", { name: "Simulation Complete" }, { timeout: 5000 });
    expect(dialog).toHaveTextContent("24:00:00");
    await waitFor(() => expect(dialog).toHaveTextContent(/Incidents\s*1/));
    expect(dialog).toHaveTextContent(/Rain events\s*1/);
    expect(dialog).toHaveTextContent("17310766248549826767");
    expect(within(dialog).getByRole("button", { name: /Download Report/ })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Simulation Complete" })).not.toBeInTheDocument());
  });

  it("suspends the interface when ASB reports Async, leaving the run alive", async () => {
    mockApi({ backpressure: { ...backpressure, state: "ASYNC", score: 1, synced: false, rate_locked: true, motion_locked: true, gui_suspended: true } });
    render(<App />);
    const alert = await screen.findByRole("alertdialog", {}, { timeout: 4000 });
    expect(alert).toHaveTextContent(/suspended by the ASB/i);
    expect(alert).toHaveTextContent(/still running and still streaming/i);
    const button = (name: RegExp) => Array.from(alert.querySelectorAll("button")).find((b) => name.test(b.textContent ?? ""));
    expect(button(/^Terminate session$/)).toBeEnabled();
    expect(button(/^Reset$/)).toBeEnabled();
    expect(button(/^(Pause|Resume) simulation$/)).toBeEnabled();
    expect(screen.getByRole("button", { name: /Layers/ })).toBeDisabled();
  });

  it("locks speed and motion while ASB is Restricted", async () => {
    mockApi({ backpressure: { ...backpressure, state: "RESTRICTED", score: 0.9, synced: false, rate_locked: true, motion_locked: true, applied_tick_rate: 1, requested_tick_rate: 3 } });
    render(<App />);
    await screen.findByText("ASB · Restricted", {}, { timeout: 4000 });
    expect(screen.getByRole("radiogroup", { name: "Simulation speed" })).toHaveAttribute("aria-disabled", "true");
    const motion = screen.getByRole("button", { name: "Reduce motion" });
    expect(motion).toBeDisabled();
    expect(motion).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status", { name: "Runtime status Degraded" })).toBeInTheDocument();
  });

  it("expands search from the dock rather than occupying the map", async () => {
    mockApi();
    render(<App />);
    await ready();
    expect(screen.queryByLabelText("Search places")).toBeInstanceOf(HTMLButtonElement);
    fireEvent.click(screen.getByLabelText("Search places"));
    expect(await screen.findByPlaceholderText("Search places")).toBeInTheDocument();
  });
});

describe("professional copy", () => {
  it("uses no em dashes or development-history wording in the rendered interface", async () => {
    mockApi();
    render(<App />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Layers/ }));
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/\b(no longer|previously|new version|moving average|as requested)\b/i);
  });
});
