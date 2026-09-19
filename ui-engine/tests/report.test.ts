import { describe, expect, it } from "vitest";
import fontDataUrl from "../src/assets/report-inter.ttf?inline";
import { buildReport } from "../src/report";
import type { ReportInput } from "../src/report";
import { overlappingText } from "../src/pdfLayout";
import { TelemetryRecorder, sampleFrom } from "../src/telemetryRecorder";
import { defaultLayers } from "../src/types";
import type { Backpressure, News, Snapshot, Topology } from "../src/types";

const font = String(fontDataUrl).replace(/^data:[^,]*,/, "");

/** A 12 x 12 grid district with named roads and a few places. */
function topology(): Topology {
  const nodes: { id: number; position: { x_m: number; y_m: number; lat: number; lon: number }; degree: number; signal: boolean; osm_node_id: number }[] = [];
  for (let y = 0; y < 12; y++)
    for (let x = 0; x < 12; x++)
      nodes.push({ id: y * 12 + x, position: { x_m: x * 250, y_m: y * 250, lat: 52.5 + y * 0.002, lon: 13.4 + x * 0.003 }, degree: x % 11 && y % 11 ? 4 : 2, signal: (x + y) % 5 === 0, osm_node_id: y * 12 + x });
  const edges: Record<string, unknown>[] = [];
  const classes = ["primary", "secondary", "residential", "service", "tertiary"];
  for (let y = 0; y < 12; y++)
    for (let x = 0; x < 11; x++) {
      const a = nodes[y * 12 + x], b = nodes[y * 12 + x + 1];
      edges.push({ id: edges.length, from: a.id, to: b.id, reverse_twin: -1, synthetic_reverse: false, name: x % 3 ? `Very Long Avenue Name Number ${y}` : "", road_class: classes[(x + y) % 5], length_m: 250, lanes: 1 + (y % 3), free_speed_mps: 8 + (x % 4) * 3, geometry: [a.position, b.position] });
    }
  const features = Array.from({ length: 30 }, (_, i) => ({ id: `way/${i}`, name: `Place ${i}`, category: ["school", "office", "retail", "hospital", "park"][i % 5], polygon: false, position: nodes[i * 4].position, geometry: [], tags: { amenity: ["school", "office", "marketplace", "hospital", "park"][i % 5] } }));
  return {
    graph_hash: "sha256:0123456789abcdef0123456789abcdef", nodes, edges, features, source: "OpenStreetMap", map_selection_version: "urban-crfg-v2",
    bounds: { min_lat: 52.5, max_lat: 52.522, min_lon: 13.4, max_lon: 13.433 },
    projection: { name: "local equirectangular", origin_lat: 52.5, origin_lon: 13.4, units: "metres" },
    location: { city: "Berlin", country: "Germany", anchor_lat: 52.505, anchor_lon: 13.4235, city_extent_m: 5000, downloaded: true },
  } as unknown as Topology;
}

function snapshot(topo: Topology, virtual: number): Snapshot {
  return {
    topology_revision: 1,
    nodes: [],
    edges: topo.edges.map((e, i) => ({ id: e.id, congestion: (i % 10) / 10, rainfall: 0, flood: i % 17 === 0 ? 0.3 : 0, effective_speed_mps: 10, mean_speed_mps: 4 + (i % 7), vehicle_count: i % 9, halting_count: i % 3, closed: i % 23 === 0, incident_closed: false, incident_speed_multiplier: 1, signal_multiplier: 1, demand_vph: 100 + i, effective_capacity_vph: 900, demand_causes: [] })),
    signals: [],
    demand: [],
    congestion: { current: 31.5, average: 25, delta: 1, source: "model", history: Array.from({ length: Math.floor(virtual / 60) }, (_, i) => ({ virtual_s: i * 60, current: 30 + 25 * Math.sin(i / 90), average: 0 })) },
    active_weather: [{ id: 2, x_m: 1000, y_m: 1000, radius_m: 600, intensity: 0.7 }],
    active_incidents: [],
  } as unknown as Snapshot;
}

let nid = 1;
const item = (p: Partial<News>): News => ({ news_id: nid++, event_id: 0, virtual_day_s: 0, simulated_current_time: "", category: "system", severity: "info", template_id: "", message: "", data: {}, ...p });

/** A busy day: hundreds of events of every kind. */
function busyNews(): News[] {
  const out: News[] = [
    item({ template_id: "SCENARIO_INITIALIZED", message: "[00:00:00] Scenario initialized", data: { scenario_hash: "sha256:feedface" } }),
    item({ template_id: "WEATHER_FORECAST", category: "weather", data: { event_count: 12 } }),
  ];
  for (let r = 0; r < 12; r++) {
    const start = 3000 + r * 6500;
    out.push(item({ template_id: "DWS_RAIN_STARTED", category: "weather", severity: "warning", event_id: r + 1, virtual_day_s: start, message: `[x] Rain storm initiated at Node ${r * 7}`, data: { epicenter: r * 7, radius_m: 300 + r * 40, intensity: 0.4 + (r % 5) / 10 } }));
    out.push(item({ template_id: "DWS_RAIN_PEAK", category: "weather", severity: "alert", event_id: 50000 + r + 1, virtual_day_s: start + 1500, message: "[x] Peak precipitation", data: { epicenter: r * 7 } }));
    if (r < 11) out.push(item({ template_id: "DWS_RAIN_ENDED", category: "weather", event_id: 100000 + r + 1, virtual_day_s: start + 3000, message: "[x] Rain storm cleared" }));
    for (let f = 0; f < 25; f++) out.push(item({ template_id: "FLOOD_STARTED", category: "flooding", severity: "warning", virtual_day_s: start + 600 + f * (f % 4 === 0 ? 90 : 3), message: `Flooding detected on Edge ${f * 5}`, data: { edge_id: (f * 5) % 132, flood: 0.2 } }));
  }
  const types = ["road_closure", "accident", "congestion", "vehicle_breakdown", "hazard_spill"];
  for (let i = 0; i < 40; i++) {
    const start = 1000 + i * 2000;
    out.push(item({ template_id: "INCIDENT_ACTIVATED", category: "incident", severity: ["alert", "warning", "info"][i % 3], virtual_day_s: start, message: `[x] Multi-vehicle collision: lane blocked, emergency services on scene on Edge #${i} near Node #${i}. (HIGH SEVERITY)`, data: { incident_id: i, type: types[i % 5], edge_id: i, node_id: i, closed: i % 2 === 0, speed_multiplier: 0.4, capacity_multiplier: 0.5, end_virtual_s: start + 2400 } }));
    if (i < 36) out.push(item({ template_id: "INCIDENT_RESOLVED", category: "incident", virtual_day_s: start + 2400, message: "[x] Incident cleared", data: { incident_id: i, type: types[i % 5], edge_id: i } }));
  }
  for (let d = 0; d < 60; d++) out.push(item({ template_id: "DEMAND_CHANGED", category: "demand", virtual_day_s: 20000 + d * 500, message: d % 4 === 0 ? `Retail peak · Place ${d}` : `Retail · Place ${d}`, data: { feature_id: `way/${d % 30}`, multiplier: 1.4 } }));
  return out;
}

function telemetry(runs: number) {
  let wall = 1_700_000_000_000;
  const r = new TelemetryRecorder(2400, () => wall);
  r.reset("run_test");
  const topo = topology();
  const asb = (score: number, state: Backpressure["state"]) => ({ state, score, synced: score < 0.3, rate_capped: false, throughput: { bytes_per_s: 400_000 + score * 900_000, snapshots_per_s: 1 }, actions: [] }) as unknown as Backpressure;
  for (let i = 0; i < runs; i++) {
    wall += 1000;
    const state = i > 200 && i < 240 ? "RESTRICTED" : i >= 240 && i < 250 ? "ASYNC" : "NORMAL";
    r.sample({ ...sampleFrom({ snapshot: snapshot(topo, 60), virtual_s: i * 120, lifecycle: i === 100 ? "PAUSED" : "RUNNING", tick_rate: state === "NORMAL" ? 2 : 1, asb: asb(state === "NORMAL" ? 0.1 : 0.8, state), latency_ms: 20 + (i % 13), status: state === "NORMAL" ? "online" : "degraded" }), wall_ms: wall });
    if (i % 50 === 0) r.control("speed", "2x", i * 120);
  }
  return r.export();
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  const topo = topology();
  const virtual = 60000;
  return {
    status: { api_version: "1.0", run_id: "run_test", global_seed: "0x5089050192221083c848bf3e12e22a4f", state_revision: 9, config_revision: 3, clock: { playback_state: "RUNNING", playback_duration_seconds: 3600, simulation_percentage: virtual / 86400, simulated_current_time: "16:40:00", virtual_day_seconds: virtual, tick_rate: 2, target_virtual_rate: 48 }, data: { lifecycle: "RUNNING", day: 0, saved_seed_id: "", map_selection_version: "urban-crfg-v2", modules: { traffic: true, signals: true, dws: true, flooding: true, news: true, buildings: false }, playback_revision: 12 } },
    snapshot: { api_version: "1.0", run_id: "run_test", global_seed: "0x5089050192221083c848bf3e12e22a4f", state_revision: 9, config_revision: 3, clock: { playback_state: "RUNNING", playback_duration_seconds: 3600, simulation_percentage: virtual / 86400, simulated_current_time: "16:40:00", virtual_day_seconds: virtual, tick_rate: 2, target_virtual_rate: 48 }, data: snapshot(topo, virtual) },
    topology: topo,
    congestion: snapshot(topo, virtual).congestion,
    news: busyNews(),
    asb: { state: "NORMAL", score: 0.1, synced: true, rate_locked: false, motion_locked: false, gui_suspended: false, rate_capped: false, rate_cap: -1, applied_tick_rate: 2, requested_tick_rate: 2, stressed_for_s: 0, state_for_s: 5, throughput: { snapshots_per_s: 1, bytes_per_s: 500000 }, actions: [{ at_s: 3, action: "throttle", reason: "virtual lag", score: 0.7, rate_before: 3, rate_after: 2 }], thresholds: {} },
    telemetry: telemetry(400),
    hour12: false,
    uiVersion: "2.1.0",
    layers: { ...defaultLayers },
    ...overrides,
  };
}

function verifyLayout(doc: Awaited<ReturnType<typeof buildReport>>["doc"]) {
  const overlaps = overlappingText(doc.boxes);
  expect(overlaps.map(([a, b]) => `p${a.page}: "${a.text}" / "${b.text}"`)).toEqual([]);
  for (const b of doc.boxes) {
    if (b.kind === "chrome") continue;
    // Everything stays inside the page margins.
    expect(b.x, `${b.text ?? b.kind} left edge on page ${b.page}`).toBeGreaterThanOrEqual(-0.01);
    expect(b.x + b.w, `${b.text ?? b.kind} right edge on page ${b.page}`).toBeLessThanOrEqual(doc.W + 0.01);
    if (b.page > 1 && b.kind === "text") {
      expect(b.x, `"${b.text}" inside left margin`).toBeGreaterThanOrEqual(doc.M - 0.5);
      expect(b.x + b.w, `"${b.text}" inside right margin`).toBeLessThanOrEqual(doc.W - doc.M + 0.5);
      expect(b.y, `"${b.text}" below the header`).toBeGreaterThanOrEqual(doc.top - 0.5);
      expect(b.y + b.h, `"${b.text}" above the footer`).toBeLessThanOrEqual(doc.bottom + 0.5);
    }
  }
}

describe("report generation", () => {
  it("produces a detailed, paginated report for a busy day without overlaps", async () => {
    const { pdf, doc, pages } = await buildReport(input(), { font, now: new Date(2026, 8, 19, 12, 0, 0), coreVersion: "2.0.0", platform: ["Platform: Test", "Language: en-GB"] });
    expect(pages).toBeGreaterThanOrEqual(10);
    expect(pages).toBeLessThanOrEqual(40);
    verifyLayout(doc);
    const titles = doc.outline.map((o) => o.title);
    expect(titles).toEqual([
      "Executive Summary",
      "Simulation Configuration",
      "Environment and Runtime",
      "Road Network Analysis",
      "Traffic Analysis",
      "Weather Analysis",
      "Flooding Analysis",
      "Incident Analysis",
      "Simulation Event Timeline",
      "Performance and Telemetry",
      "Determinism and Integrity",
      "Methodology and Definitions",
    ]);
    // Section pages are in order.
    for (let i = 1; i < doc.outline.length; i++) expect(doc.outline[i].page).toBeGreaterThanOrEqual(doc.outline[i - 1].page);
    const bytes = pdf.output("arraybuffer");
    expect(new TextDecoder().decode(new Uint8Array(bytes).slice(0, 5))).toBe("%PDF-");
  }, 60000);

  it("repeats table headers on continuation pages", async () => {
    const { doc } = await buildReport(input(), { font });
    const timeline = doc.outline.find((o) => o.title === "Simulation Event Timeline")!;
    const performance = doc.outline.find((o) => o.title === "Performance and Telemetry")!;
    const headerPages = new Set(doc.boxes.filter((b) => b.text === "Event" && b.page >= timeline.page && b.page <= performance.page).map((b) => b.page));
    // The timeline spans pages, and each page carries its own header row.
    expect(headerPages.size).toBeGreaterThan(1);
  }, 60000);

  it("includes the throughput chart and every section's key content", async () => {
    const { doc } = await buildReport(input(), { font });
    const text = doc.boxes.map((b) => b.text ?? "").join("\n");
    expect(text).toMatch(/Connection throughput \((KiB|MiB)\/s\)/);
    expect(text).toContain("Congestion index across the virtual day");
    expect(text).toContain("Incident register");
    expect(text).toContain("Backpressure interventions");
    expect(text).toContain("0x5089050192221083c848bf3e12e22a4f");
    expect(text).toContain("sha256:feedface");
    expect(text).toMatch(/Flooding detected on \d+ roads/);
    expect(text).toContain("OBSERVED");
    expect(text).toContain("DERIVED");
    expect(text).toContain("INTERPRETATION");
  }, 60000);

  it("uses no em dashes and no development-history language", async () => {
    const { doc } = await buildReport(input(), { font });
    const text = doc.boxes.map((b) => b.text ?? "").join("\n");
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/\b(no longer|previously|new version|moving average)\b/i);
  }, 60000);

  it("follows the 12 hour preference", async () => {
    const { doc } = await buildReport(input({ hour12: true }), { font });
    const text = doc.boxes.map((b) => b.text ?? "").join("\n");
    expect(text).toMatch(/\d{1,2}:\d{2}:\d{2} PM/);
    expect(text).toContain("12 hour clock");
  }, 60000);

  it("reports missing data as missing rather than inventing it", async () => {
    const empty = input({
      news: [],
      telemetry: new TelemetryRecorder().export(),
      asb: null,
      congestion: { current: 0, average: 0, delta: 0, source: "model", history: [] },
    });
    const { doc, pages } = await buildReport(empty, { font });
    verifyLayout(doc);
    const text = doc.boxes.map((b) => b.text ?? "").join("\n");
    expect(text).toContain("No rain was recorded during this run.");
    expect(text).toContain("No incidents were recorded during this run.");
    expect(text).toMatch(/Not enough samples of throughput were recorded/);
    expect(text).toContain("Backpressure stayed Normal throughout the observation.");
    expect(pages).toBeGreaterThanOrEqual(6);
  }, 60000);

  it("builds without the embedded font", async () => {
    const { doc } = await buildReport(input({ news: busyNews().slice(0, 20) }));
    verifyLayout(doc);
  }, 60000);
});
