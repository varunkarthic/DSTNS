// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { LOGO, logoPng } from "./logoAsset";
import reportFontUrl from "./assets/report-inter.ttf?url";
import { DEMAND_TYPE_LABEL, placeKind, roadState, roadTitle } from "./mapModel";
import { DAY_TICKS, PRINT, ReportDocument, lineHeight, wallTicks } from "./pdfLayout";
import type { Column, Series } from "./pdfLayout";
import {
  bytesTransferred,
  congestionPeriods,
  formatBytes,
  incidentRecords,
  latestByVirtual,
  networkStats,
  pearson,
  rainEvents,
  stats,
  throughputUnit,
  timeline,
} from "./reportModel";
import { describeNews, districtOf, INCIDENT_TITLES, roadNearNode } from "./notificationModel";
import { intervals } from "./telemetryRecorder";
import type { TelemetryLog } from "./telemetryRecorder";
import { DAY_SECONDS, formatDuration, formatSimulationTime, formatWallDuration } from "./timeFormat";
import type { Backpressure, Congestion, Envelope, Layers, News, Snapshot, Status, Topology } from "./types";

/**
 * The simulation report.
 *
 * Generated in the browser from data the observer holds or fetches from the
 * core: the full news record, the congestion history, the live snapshot, the
 * topology and the observer's own telemetry log. Every figure is observed or
 * derived from those records; where a measure was not recorded the report says
 * so instead of estimating it.
 */

export interface ReportInput {
  status: Envelope<Status>;
  snapshot: Envelope<Snapshot>;
  topology: Topology;
  congestion: Congestion;
  news: News[];
  asb: Backpressure | null;
  telemetry: TelemetryLog;
  hour12: boolean;
  uiVersion: string;
  layers: Layers;
}

export interface ReportResources {
  /** Base64 TrueType font. Without it the PDF standard font is used. */
  font?: string;
  logoLight?: string;
  logoDark?: string;
  map?: { dataUrl: string; aspect: number } | null;
  coreVersion?: string;
  now?: Date;
  platform?: string[];
}

const LAYER_NAMES: Record<keyof Layers, string> = {
  roads: "Roads",
  traffic: "Traffic",
  vehicles: "Flow markers",
  signals: "Signals",
  buildings: "Buildings",
  place_names: "Place names",
  other_places: "Unclassified places",
  labels: "Street names",
  weather: "Weather",
  flooding: "Flooding",
  incidents: "Incidents",
  events: "Demand",
};

const MODULE_NAMES: Record<string, string> = {
  traffic: "Traffic",
  signals: "Signals",
  buildings: "Place demand",
  dws: "Weather",
  flooding: "Flooding",
  news: "Event news",
  incidents: "Incidents",
};

const pct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const title = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export async function buildReport(input: ReportInput, resources: ReportResources = {}) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
  let font = "helvetica";
  if (resources.font) {
    pdf.addFileToVFS("Inter.ttf", resources.font);
    pdf.addFont("Inter.ttf", "Inter", "normal");
    font = "Inter";
  }
  const doc = new ReportDocument(pdf, font);
  const { status, snapshot, topology, congestion, news, asb, telemetry, hour12 } = input;
  const now = resources.now ?? new Date();
  const t = (s: number) => formatSimulationTime(s, hour12);
  const tShort = (s: number) => formatSimulationTime(s, hour12, { seconds: false });
  const virtual = snapshot.clock.virtual_day_seconds;
  const lifecycle = status.data.lifecycle;
  const location = topology.location?.city ? topology.location : undefined;
  const place = location ? `${location.city}, ${location.country}` : "Explicit map file";
  const seed = status.seed || status.global_seed;
  const shortSeed = seed.length > 14 ? `${seed.slice(0, 12)}…` : seed;

  // ---- Derived records -----------------------------------------------------
  const net = networkStats(topology);
  const rains = rainEvents(news);
  const incidents = incidentRecords(news);
  const floods = news.filter((n) => n.template_id === "FLOOD_STARTED");
  const floodRoads = new Set(floods.map((n) => (n.data as Record<string, unknown>)?.edge_id)).size;
  const events = timeline(news);
  const history = congestion.history ?? [];
  const samples = telemetry.samples;
  const simSamples = latestByVirtual(samples);
  const wallStart = telemetry.startedWall;
  const wallEnd = samples.length ? samples[samples.length - 1].wall_ms : wallStart;
  const observedMs = samples.length ? wallEnd - wallStart : 0;
  const peakCongestion = history.length ? history.reduce((a, b) => (b.current > a.current ? b : a)) : null;
  const vehicleStats = stats(simSamples.map((s) => s.vehicles));
  const peakVehicles = simSamples.length ? simSamples.reduce((a, b) => (b.vehicles > a.vehicles ? b : a)) : null;
  const speedStats = stats(simSamples.filter((s) => s.vehicles > 0).map((s) => s.mean_speed_kmh));
  const scenarioHash = (news.find((n) => n.template_id === "SCENARIO_INITIALIZED")?.data as Record<string, unknown> | undefined)?.scenario_hash;
  const forecast = (news.find((n) => n.template_id === "WEATHER_FORECAST")?.data as Record<string, unknown> | undefined)?.event_count;
  const stateById = new Map(snapshot.data.edges.map((e) => [e.id, e]));
  const realEdges = topology.edges.filter((e) => !e.synthetic_reverse);
  const nodePlace = (id: number | null) => (id !== null && topology.nodes[id] ? { x_m: topology.nodes[id].position.x_m, y_m: topology.nodes[id].position.y_m } : undefined);
  const areaOf = (id: number | null) => {
    const p = nodePlace(id);
    const d = p ? districtOf(topology, p) : undefined;
    const road = id !== null ? roadNearNode(topology, id) : undefined;
    return [d ? d.replace(/^the /, "").replace(/^./, (c) => c.toUpperCase()) : "", road ? `near ${road}` : ""].filter(Boolean).join(", ") || "Not recorded";
  };
  const chartOrNote = (points: number, draw: () => void, what: string) => {
    if (points >= 2) draw();
    else doc.note("Observed", `Not enough samples of ${what} were recorded during this observation to chart it.`);
  };
  const virtualDomain: [number, number] = [0, DAY_SECONDS];
  const vTick = (v: number) => tShort(Math.round(v));
  const wallTick = (v: number) => {
    const s = Math.max(0, Math.round(v));
    return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const wallX = (ms: number) => (ms - wallStart) / 1000;

  // =========================================================================
  // Cover
  // =========================================================================
  doc.newPage();
  doc.rect(0, 0, doc.W, 122, PRINT.dark, 0);
  if (resources.logoLight) pdf.addImage(resources.logoLight, "PNG", doc.M, 24, 12 * LOGO.aspect, 12);
  else doc.line("DSTNS", doc.M, 24, 22, PRINT.darkInk);
  doc.line("SIMULATION REPORT", doc.M, 50, 8, "#6fd7f2");
  doc.line(place, doc.M, 57, 24, "#ffffff");
  doc.line("Deterministic Spatiotemporal Transport Network Simulator", doc.M, 69, 9.5, "#9fb4c3");
  const cover: [string, string][] = [
    ["Seed", seed],
    ["Run", status.run_id],
    ["Simulation time", `${t(virtual)} (${pct(virtual / DAY_SECONDS, 1)} of the day)`],
    ["State", title(lifecycle.toLowerCase())],
    ["Generated", now.toLocaleString()],
  ];
  cover.forEach(([k, v], i) => {
    doc.line(k.toUpperCase(), doc.M, 82 + i * 7, 6.5, "#7f96a6");
    doc.line(v, doc.M + 34, 81.4 + i * 7, 8.5, "#e6f0f7");
  });
  doc.y = 134;
  doc.line("About this report", doc.M, doc.y, 12, PRINT.ink);
  doc.y += lineHeight(12) + 2;
  doc.paragraph(
    "This report records one DSTNS simulation run as observed from the operator interface. It covers the scenario configuration, the road network, traffic, weather, flooding, incidents, a timeline of significant events, and the performance of the connection between the simulation and the interface.",
  );
  doc.paragraph("Statements are labelled by where they come from:", { after: 1.5 });
  doc.note("Observed", "Read directly from simulation records or measured by the interface while observing.");
  doc.note("Derived", "Computed in this report from observed records, such as totals, durations and correlations.");
  doc.note("Interpretation", "A reading of the data offered for context. Interpretations are never presented as measurements.");
  doc.y += 2;
  doc.paragraph(
    `Simulation timestamps use the ${hour12 ? "12" : "24"} hour clock selected in the interface. Wall-clock durations refer to real time spent observing.`,
    { size: 8.5, color: PRINT.dim },
  );

  // Contents page, filled once page numbers are known.
  doc.newPage();
  const contentsPage = doc.page;

  // =========================================================================
  // 1 Executive summary
  // =========================================================================
  doc.sectionHeading("Executive Summary", "The run at a glance. Figures cover the whole run where the core keeps a complete record, and the observed session where only the interface measured them.", true);
  doc.tiles([
    { label: "Simulation time", value: t(virtual), note: `${pct(virtual / DAY_SECONDS, 1)} of the virtual day` },
    { label: "Observed for", value: observedMs ? formatWallDuration(observedMs) : "Not recorded", note: "Wall-clock time" },
    { label: "Incidents", value: String(incidents.filter((i) => i.start !== null).length), note: `${incidents.filter((i) => i.closed).length} closed a road`, color: PRINT.red },
    { label: "Rain events", value: String(rains.filter((r) => r.start !== null).length), note: forecast !== undefined ? `${forecast} forecast` : undefined, color: PRINT.blue },
    { label: "Flood onsets", value: String(floods.length), note: `${floodRoads} distinct roads`, color: PRINT.blue },
    { label: "Peak congestion", value: peakCongestion ? `${peakCongestion.current.toFixed(1)}%` : "Not recorded", note: peakCongestion ? `at ${tShort(peakCongestion.virtual_s)}` : undefined, color: PRINT.amber },
    { label: "Peak vehicles", value: peakVehicles ? peakVehicles.vehicles.toLocaleString() : "Not recorded", note: peakVehicles ? `at ${tShort(peakVehicles.virtual_s)}` : "Observed samples" },
    { label: "State", value: title(lifecycle.toLowerCase()), note: lifecycle === "COMPLETED" ? "Virtual day finished" : "At report time" },
  ]);
  doc.heading("Key observations");
  doc.bullets([
    `The seed selected ${location ? `${location.city}, ${location.country}, at ${location.anchor_lat.toFixed(4)}, ${location.anchor_lon.toFixed(4)}` : "an operator-pinned map file"}. The network has ${net.nodes.toLocaleString()} junctions and ${net.directions.toLocaleString()} road directions totalling ${net.km.toFixed(1)} km.`,
    `The run reached ${t(virtual)} and is ${lifecycle === "COMPLETED" ? "complete" : `in the ${lifecycle.toLowerCase()} state`}.`,
    `${incidents.length} incident${incidents.length === 1 ? " was" : "s were"} recorded, ${rains.length} rain event${rains.length === 1 ? "" : "s"} and ${floods.length} flood onset${floods.length === 1 ? "" : "s"} across ${floodRoads} road${floodRoads === 1 ? "" : "s"}.`,
    peakCongestion
      ? `The congestion index peaked at ${peakCongestion.current.toFixed(1)}% at ${t(peakCongestion.virtual_s)} and is ${snapshot.data.congestion.current.toFixed(1)}% now.`
      : `The congestion index is ${snapshot.data.congestion.current.toFixed(1)}% now; no history was available.`,
    asb
      ? `Adaptive Simulation Backpressure is ${asb.state.toLowerCase()}, with ${asb.actions.length} recent intervention${asb.actions.length === 1 ? "" : "s"} recorded by the core.`
      : "Backpressure reporting was not active for this session.",
  ]);

  // =========================================================================
  // 2 Configuration
  // =========================================================================
  const base = DAY_SECONDS / snapshot.clock.playback_duration_seconds;
  doc.sectionHeading("Simulation Configuration", "The parameters the run was started with, as reported by the core.");
  doc.heading("Scenario");
  doc.keyValues([
    ["Seed", seed],
    ["Saved configuration", status.data.saved_seed_id || "Not saved"],
    ["Day type", status.data.day === 1 ? "Weekend" : "Weekday"],
    ["Virtual day", "24 hours, 00:00:00 to 24:00:00"],
    ["Playback duration", `${snapshot.clock.playback_duration_seconds} s of wall time per virtual day at 1×`],
    ["Base rate", `${base.toFixed(1)} virtual seconds per wall second`],
    ["Speed at report time", `${snapshot.clock.tick_rate}×${asb && asb.requested_tick_rate !== snapshot.clock.tick_rate ? ` applied, ${asb.requested_tick_rate}× requested` : ""}`],
    ["Map selection", topology.map_selection_version],
    ["Deterministic parameters", "Independent sub-seeds for the map, weather, traffic, incidents, events and scenario are derived from the master seed, so the same seed reproduces the same run."],
  ]);
  doc.heading("Map");
  doc.keyValues([
    ["Source", topology.source],
    ["Location", location ? `${location.city}, ${location.country}` : "Explicit map file"],
    ...(location
      ? ([
          ["Seed-derived anchor", `${location.anchor_lat.toFixed(5)}, ${location.anchor_lon.toFixed(5)}`],
          ["City extract", `${(location.city_extent_m / 1000).toFixed(1)} km square`],
          ["Obtained", location.downloaded ? "Downloaded for this run" : "Reused from the local cache"],
        ] as [string, string][])
      : []),
    ["Bounds", `${topology.bounds.min_lat.toFixed(5)}, ${topology.bounds.min_lon.toFixed(5)} to ${topology.bounds.max_lat.toFixed(5)}, ${topology.bounds.max_lon.toFixed(5)}`],
    ["Projection", topology.projection ? `${topology.projection.name}, origin ${topology.projection.origin_lat.toFixed(5)}, ${topology.projection.origin_lon.toFixed(5)}, ${topology.projection.units}` : "Not reported"],
  ]);
  doc.heading("Systems and layers");
  const modules = Object.entries(status.data.modules ?? {});
  doc.keyValues([
    ["Enabled systems", modules.filter(([, on]) => on).map(([k]) => MODULE_NAMES[k] ?? title(k)).join(", ") || "None reported"],
    ["Disabled systems", modules.filter(([, on]) => !on).map(([k]) => MODULE_NAMES[k] ?? title(k)).join(", ") || "None"],
    ["Layers shown at export", (Object.keys(LAYER_NAMES) as (keyof Layers)[]).filter((k) => input.layers[k]).map((k) => LAYER_NAMES[k]).join(", ")],
    ["Weather forecast", forecast !== undefined ? `${forecast} rain events scheduled for the day` : "Not recorded"],
    ["Traffic model", "Aggregate edge model with deterministic queue dynamics"],
  ]);

  // =========================================================================
  // 3 Environment
  // =========================================================================
  doc.sectionHeading("Environment and Runtime", "Software versions and the environment the report was produced in. Filesystem paths are deliberately omitted.");
  doc.keyValues([
    ["DSTNS core", resources.coreVersion ?? "Not reported"],
    ["Interface", input.uiVersion],
    ["API version", status.api_version],
    ["Build identifier", "Not embedded in this build"],
    ["Traffic model", "DSTNS aggregate traffic model"],
    ...((resources.platform ?? []).map((p) => {
      const [k, ...v] = p.split(": ");
      return [k, v.join(": ")] as [string, string];
    })),
    ["Observation started", samples.length ? new Date(wallStart).toLocaleString() : "Not recorded"],
    ["Last sample", samples.length ? new Date(wallEnd).toLocaleString() : "Not recorded"],
    ["Report generated", now.toLocaleString()],
    ["State revision", String(snapshot.state_revision)],
    ["Configuration revision", String(snapshot.config_revision)],
  ]);

  // =========================================================================
  // 4 Road network
  // =========================================================================
  doc.sectionHeading("Road Network Analysis", "The static network the model runs on, and its state at report time.");
  doc.tiles([
    { label: "Junctions", value: net.nodes.toLocaleString(), note: `${net.intersections.toLocaleString()} intersections` },
    { label: "Road directions", value: net.directions.toLocaleString(), note: `${net.syntheticReverse.toLocaleString()} synthetic reverse` },
    { label: "Network length", value: `${net.km.toFixed(1)} km` },
    { label: "Signals", value: net.signals.toLocaleString(), note: `${snapshot.data.signals.length} controllers live` },
  ]);
  doc.heading("Connectivity");
  doc.keyValues([
    ["Mean junction degree", net.meanDegree.toFixed(2)],
    ["Intersections", `${net.intersections.toLocaleString()} junctions join three or more roads`],
    ["Dead ends", `${net.deadEnds.toLocaleString()} junctions with a single connection`],
    ["Segment length", net.lengths ? `median ${km(net.lengths.median)}, mean ${km(net.lengths.mean)}, longest ${km(net.lengths.max)}` : "Not available"],
  ]);
  doc.barChart(
    "Junctions by number of connections",
    net.degrees.slice(0, 10).map(([degree, count]) => ({ label: `${degree} connection${degree === 1 ? "" : "s"}`, value: count })),
    "",
    "How connected is the network? Higher degrees indicate a denser grid of intersections.",
  );
  doc.heading("Road classes");
  doc.table(
    [
      { title: "Class", width: 0.28 },
      { title: "Directions", width: 0.14, align: "right" },
      { title: "Length", width: 0.16, align: "right" },
      { title: "Share", width: 0.12, align: "right" },
      { title: "Mean lanes", width: 0.14, align: "right" },
      { title: "Free speed", width: 0.16, align: "right" },
    ],
    net.classes.map((c) => [title(c.name), c.count.toLocaleString(), `${c.km.toFixed(2)} km`, pct(c.km / Math.max(1e-9, net.km), 1), c.lanes.toFixed(1), `${c.speed.toFixed(0)} km/h`]),
  );
  const byState = { clear: 0, moderate: 0, severe: 0, blocked: 0, flooded: 0 };
  for (const e of realEdges) byState[roadState(stateById.get(e.id)) as keyof typeof byState] += 1;
  doc.heading("Road state at report time");
  doc.barChart(
    "Road directions by state",
    [
      { label: "Clear", value: byState.clear, color: PRINT.mint },
      { label: "Moderate", value: byState.moderate, color: PRINT.amber },
      { label: "Severe", value: byState.severe, color: PRINT.red },
      { label: "Closed", value: byState.blocked, color: PRINT.red },
      { label: "Flooded", value: byState.flooded, color: PRINT.blue },
    ],
    "",
    "How much of the network is impaired right now, and by what?",
  );
  const byPlace = new Map<string, number>();
  for (const f of topology.features) byPlace.set(placeKind(f).label, (byPlace.get(placeKind(f).label) ?? 0) + 1);
  if (byPlace.size)
    doc.barChart(
      "Places by kind",
      [...byPlace.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, value]) => ({ label, value })),
      "",
      "What kinds of places make up this district?",
    );
  const byDemand = new Map<string, number>();
  for (const f of topology.features)
    if (f.demand_type) {
      const label = DEMAND_TYPE_LABEL[f.demand_type] ?? f.demand_type;
      byDemand.set(label, (byDemand.get(label) ?? 0) + 1);
    }
  if (byDemand.size)
    doc.barChart(
      "Demand-modelled places by demand type",
      [...byDemand.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
      "",
      "Which places does the core schedule demand for?",
    );

  // =========================================================================
  // 5 Traffic
  // =========================================================================
  doc.sectionHeading("Traffic Analysis", "Traffic measures across the virtual day. The congestion history is kept by the core for the whole run; vehicle and speed series are the interface's samples.");
  chartOrNote(
    history.length,
    () =>
      doc.lineChart({
        title: "Congestion index across the virtual day",
        question: "When was the network most congested, and how quickly did it recover?",
        xLabel: "Simulation time",
        yLabel: "Congestion index (%)",
        xDomain: virtualDomain,
        xTicks: DAY_TICKS,
        yDomain: [0, Math.max(10, ...history.map((h) => h.current))],
        xTick: vTick,
        series: [{ name: "Congestion index", points: history.map((h) => ({ x: h.virtual_s, y: h.current })) }],
      }),
    "the congestion index",
  );
  if (history.length) {
    const s = stats(history.map((h) => h.current))!;
    doc.note("Derived", `Across ${s.count} per-minute samples the index averaged ${s.mean.toFixed(1)}%, with a median of ${s.median.toFixed(1)}% and a 95th percentile of ${s.p95.toFixed(1)}%.`);
    const periods = congestionPeriods(history, 35);
    doc.heading("Congestion periods");
    doc.table(
      [
        { title: "From", width: 0.2, mono: true },
        { title: "To", width: 0.2, mono: true },
        { title: "Duration", width: 0.2, align: "right" },
        { title: "Peak", width: 0.18, align: "right" },
        { title: "Peak at", width: 0.22, mono: true, align: "right" },
      ],
      periods.map((p) => [t(p.from), t(p.to), formatDuration(p.to - p.from + 60), `${p.peak.toFixed(1)}%`, t(p.peakAt)]),
      { caption: "Continuous spans with the index at or above 35%, the moderate threshold used by the map legend.", empty: "The index did not reach 35% during the recorded history." },
    );
  }
  chartOrNote(
    simSamples.length,
    () =>
      doc.lineChart({
        title: "Vehicles on the network",
        question: "How did demand build and fall through the day?",
        xLabel: "Simulation time",
        yLabel: "Vehicles",
        xDomain: virtualDomain,
        xTicks: DAY_TICKS,
        xTick: vTick,
        yTick: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)),
        series: [
          { name: "Vehicles", points: simSamples.map((s) => ({ x: s.virtual_s, y: s.vehicles })) },
          { name: "Halting", points: simSamples.map((s) => ({ x: s.virtual_s, y: s.halting })) },
        ],
      }),
    "vehicle counts",
  );
  chartOrNote(
    simSamples.filter((s) => s.vehicles > 0).length,
    () =>
      doc.lineChart({
        title: "Mean vehicle speed",
        question: "How much did congestion, rain and incidents slow traffic?",
        xLabel: "Simulation time",
        yLabel: "Speed (km/h)",
        xDomain: virtualDomain,
        xTicks: DAY_TICKS,
        xTick: vTick,
        series: [{ name: "Vehicle-weighted mean speed", points: simSamples.filter((s) => s.vehicles > 0).map((s) => ({ x: s.virtual_s, y: s.mean_speed_kmh })) }],
      }),
    "vehicle speed",
  );
  if (vehicleStats && speedStats)
    doc.note(
      "Observed",
      `Over ${vehicleStats.count} samples the network carried between ${vehicleStats.min.toLocaleString()} and ${vehicleStats.max.toLocaleString()} vehicles (mean ${Math.round(vehicleStats.mean).toLocaleString()}). Mean speed ranged from ${speedStats.min.toFixed(1)} to ${speedStats.max.toFixed(1)} km/h.`,
    );
  const worst = realEdges
    .map((edge) => ({ edge, s: stateById.get(edge.id) }))
    .filter((r) => r.s && !r.s.closed && !r.s.incident_closed && r.s.vehicle_count > 0)
    .sort((a, b) => b.s!.congestion - a.s!.congestion || b.s!.vehicle_count - a.s!.vehicle_count)
    .slice(0, 15);
  doc.heading("Most congested roads at report time");
  doc.table(
    [
      { title: "Road", width: 0.34 },
      { title: "Class", width: 0.16 },
      { title: "Congestion", width: 0.13, align: "right" },
      { title: "Speed", width: 0.13, align: "right" },
      { title: "Vehicles", width: 0.11, align: "right" },
      { title: "Demand", width: 0.13, align: "right" },
    ],
    worst.map(({ edge, s }) => [roadTitle(edge), title(edge.road_class), pct(s!.congestion), `${(s!.mean_speed_mps * 3.6).toFixed(0)} km/h`, String(s!.vehicle_count), `${s!.demand_vph.toFixed(0)}/h`]),
    { caption: "Roads carrying traffic, ranked by congestion. Closed roads are listed under Road Network Analysis.", empty: "No road is carrying congested traffic at report time." },
  );

  // =========================================================================
  // 6 Weather
  // =========================================================================
  doc.sectionHeading("Weather Analysis", "Rain cells from the deterministic weather model. Start, peak and end times come from the core's event record for the whole run.");
  doc.table(
    [
      { title: "Cell", width: 0.07, align: "right" },
      { title: "Start", width: 0.13, mono: true },
      { title: "Peak", width: 0.13, mono: true },
      { title: "End", width: 0.13, mono: true },
      { title: "Duration", width: 0.12, align: "right" },
      { title: "Location", width: 0.24 },
      { title: "Radius", width: 0.09, align: "right" },
      { title: "Intensity", width: 0.09, align: "right" },
    ],
    rains.map((r) => [
      String(r.id),
      r.start !== null ? t(r.start) : "Before record",
      r.peak !== null ? t(r.peak) : "",
      r.end !== null ? t(r.end) : r.start !== null && virtual < DAY_SECONDS ? "Active" : "",
      r.start !== null && r.end !== null ? formatDuration(r.end - r.start) : "",
      areaOf(r.epicenter),
      r.radius_m !== null ? km(r.radius_m) : "",
      r.intensity !== null ? pct(r.intensity) : "",
    ]),
    { caption: "Rain events in order of onset.", empty: "No rain was recorded during this run." },
  );
  if (rains.some((r) => r.start !== null && r.end !== null)) {
    const durations = rains.filter((r) => r.start !== null && r.end !== null).map((r) => r.end! - r.start!);
    const d = stats(durations)!;
    doc.note("Derived", `Completed rain events lasted ${formatDuration(d.min)} to ${formatDuration(d.max)}, a mean of ${formatDuration(d.mean)}. Rain cells grow over the first quarter of their life, hold, then contract and drift with the wind.`);
  }
  chartOrNote(
    simSamples.length,
    () =>
      doc.lineChart({
        title: "Rain activity",
        question: "When was rain active, and how intense was the strongest cell?",
        xLabel: "Simulation time",
        yLabel: "Peak intensity (%)",
        xDomain: virtualDomain,
        xTicks: DAY_TICKS,
        yDomain: [0, 100],
        xTick: vTick,
        series: [{ name: "Strongest cell intensity", points: simSamples.map((s) => ({ x: s.virtual_s, y: s.rain_peak * 100 })) }],
      }),
    "rain activity",
  );
  chartOrNote(
    simSamples.filter((s) => s.rain_area_km2 > 0).length,
    () =>
      doc.lineChart({
        title: "Rain footprint",
        question: "How large an area was under rain as cells grew and faded?",
        xLabel: "Simulation time",
        yLabel: "Area (km²)",
        xDomain: virtualDomain,
        xTicks: DAY_TICKS,
        xTick: vTick,
        series: [{ name: "Combined footprint", points: simSamples.map((s) => ({ x: s.virtual_s, y: s.rain_area_km2 })) }],
      }),
    "the rain footprint",
  );

  // =========================================================================
  // 7 Flooding
  // =========================================================================
  doc.sectionHeading("Flooding Analysis", "Flooding accumulates from rainfall at each junction according to its susceptibility, and drains over time, so it can persist after rain has cleared.");
  doc.tiles(
    [
      { label: "Flood onsets", value: floods.length.toLocaleString(), color: PRINT.blue },
      { label: "Distinct roads", value: floodRoads.toLocaleString() },
      { label: "Flooded now", value: String(snapshot.data.edges.filter((e) => e.flood > 0.01).length), note: "Road directions" },
      { label: "First onset", value: floods.length ? tShort(Math.min(...floods.map((f) => f.virtual_day_s))) : "None" },
    ],
    4,
  );
  const hourly = new Array(24).fill(0);
  for (const f of floods) hourly[Math.min(23, Math.floor(f.virtual_day_s / 3600))] += 1;
  if (floods.length)
    doc.barChart(
      "Flood onsets by hour",
      hourly.map((v, h) => ({ label: tShort(h * 3600), value: v, color: PRINT.blue })).filter((r) => r.value > 0),
      "",
      "When did roads become flood affected?",
    );
  chartOrNote(
    simSamples.length,
    () =>
      doc.lineChart({
        title: "Flooded and closed roads",
        question: "How far did flooding spread and how long did it persist?",
        xLabel: "Simulation time",
        yLabel: "Road directions",
        xDomain: virtualDomain,
        xTicks: DAY_TICKS,
        xTick: vTick,
        series: [
          { name: "Flooded", points: simSamples.map((s) => ({ x: s.virtual_s, y: s.flooded_edges })), color: PRINT.blue },
          { name: "Closed", points: simSamples.map((s) => ({ x: s.virtual_s, y: s.closed_edges })), color: PRINT.red },
        ],
      }),
    "flooded roads",
  );
  const r = pearson(simSamples.map((s) => s.rain_area_km2), simSamples.map((s) => s.flooded_edges));
  if (r !== null) {
    doc.note("Derived", `The correlation between rain footprint and flooded roads across the observed samples is r = ${r.toFixed(2)}.`);
    doc.note(
      "Interpretation",
      r > 0.5
        ? "Flooding tracked rainfall closely in this run, as expected from the accumulation model."
        : "Flooding did not closely track rainfall in the observed samples. Flooding lags rain and drains slowly, and the observation may not cover whole storms, so a weak correlation does not indicate independence.",
    );
  }

  // =========================================================================
  // 8 Incidents
  // =========================================================================
  doc.sectionHeading("Incident Analysis", "Incidents are scheduled deterministically from the seed and restrict speed and capacity or close roads while active.");
  const severityCount = (s: string) => incidents.filter((i) => i.severity === s).length;
  doc.barChart(
    "Incidents by severity",
    [
      { label: "High", value: severityCount("alert"), color: PRINT.red },
      { label: "Moderate", value: severityCount("warning"), color: PRINT.amber },
      { label: "Low", value: severityCount("info"), color: PRINT.accent },
    ],
    "",
    "How serious were the incidents in this run?",
  );
  const byType = new Map<string, number>();
  for (const i of incidents) byType.set(INCIDENT_TITLES[i.type] ?? title(i.type), (byType.get(INCIDENT_TITLES[i.type] ?? title(i.type)) ?? 0) + 1);
  doc.barChart("Incidents by type", [...byType.entries()].map(([label, value]) => ({ label, value })), "", "What kinds of disruption occurred?");
  doc.heading("Incident register");
  doc.table(
    [
      { title: "ID", width: 0.06, align: "right" },
      { title: "Type", width: 0.15 },
      { title: "Severity", width: 0.1 },
      { title: "Start", width: 0.12, mono: true },
      { title: "Cleared", width: 0.12, mono: true },
      { title: "Duration", width: 0.1, align: "right" },
      { title: "Road", width: 0.19 },
      { title: "Effect", width: 0.16 },
    ],
    incidents.map((i) => {
      const edge = i.edge !== null ? topology.edges[i.edge] : undefined;
      const effect = [i.closed ? "Closed" : "", i.speed !== null && i.speed < 1 ? `speed ${pct(i.speed)}` : "", i.capacity !== null && i.capacity < 1 ? `capacity ${pct(i.capacity)}` : ""].filter(Boolean).join(", ");
      const end = i.end ?? null;
      return [
        String(i.id),
        INCIDENT_TITLES[i.type] ?? title(i.type),
        i.severity === "alert" ? "High" : i.severity === "warning" ? "Moderate" : i.severity === "info" ? "Low" : "",
        i.start !== null ? t(i.start) : "Before record",
        end !== null ? t(end) : i.plannedEnd !== null ? `Due ${tShort(i.plannedEnd)}` : "",
        i.start !== null && end !== null ? formatDuration(end - i.start) : "",
        edge ? roadTitle(edge) : "",
        effect,
      ];
    }),
    { empty: "No incidents were recorded during this run." },
  );
  if (incidents.some((i) => i.description)) {
    doc.heading("Incident descriptions");
    doc.table(
      [
        { title: "ID", width: 0.08, align: "right" },
        { title: "Description", width: 0.66 },
        { title: "Location", width: 0.26 },
      ],
      incidents.filter((i) => i.description).map((i) => [String(i.id), i.description, areaOf(i.node)]),
    );
  }

  // =========================================================================
  // 9 Timeline
  // =========================================================================
  doc.sectionHeading("Simulation Event Timeline", `Significant events in simulation-time order: ${events.length} entries. Consecutive flood onsets within one minute are combined; demand changes are listed at their peaks.`);
  doc.table(
    [
      { title: "Time", width: 0.14, mono: true },
      { title: "Category", width: 0.13 },
      { title: "Severity", width: 0.11 },
      { title: "Event", width: 0.62 },
    ],
    events.map((e) => [
      t(e.time),
      title(e.category),
      e.severity === "alert" ? "High" : e.severity === "warning" ? "Moderate" : "Low",
      e.source ? describeNews(e.source, topology).summary : e.text,
    ]),
    { empty: "No significant events were recorded." },
  );

  // =========================================================================
  // 10 Performance
  // =========================================================================
  doc.sectionHeading("Performance and Telemetry", "How the simulation and the interface kept pace with each other during observation. These measures are the interface's own; times are wall-clock minutes and seconds since observation began.");
  const rated = samples.filter((s) => s.bytes_per_s !== null);
  const { unit, divisor } = throughputUnit(Math.max(0, ...rated.map((s) => s.bytes_per_s!)));
  const asbBands = intervals(telemetry.transitions, "asb", (v) => v !== "NORMAL", wallEnd).map((iv) => ({
    from: wallX(iv.from_ms),
    to: wallX(iv.to_ms),
    color: iv.value === "ASYNC" ? "#f6d9dc" : "#fbecd2",
  }));
  const wallDomain: [number, number] = [0, Math.max(1, wallX(wallEnd))];
  const transferred = bytesTransferred(samples);
  doc.tiles([
    { label: "Data delivered", value: transferred !== null ? formatBytes(transferred) : "Not recorded", note: "Snapshots, integrated" },
    { label: "Mean throughput", value: rated.length ? `${(stats(rated.map((s) => s.bytes_per_s!))!.mean / divisor).toFixed(2)} ${unit}` : "Not recorded" },
    { label: "Round trip", value: (() => { const l = stats(samples.filter((s) => s.latency_ms !== null).map((s) => s.latency_ms!)); return l ? `${l.median.toFixed(0)} ms` : "Not recorded"; })(), note: "Median, status and snapshot" },
    { label: "Samples", value: samples.length.toLocaleString(), note: "Snapshots observed" },
  ]);
  chartOrNote(
    rated.length,
    () =>
      doc.lineChart({
        title: `Connection throughput (${unit})`,
        question: "How much simulation data reached the interface each second, and was it steady?",
        xLabel: "Observation time (min:s)",
        yLabel: `Throughput (${unit})`,
        xDomain: wallDomain,
        xTicks: wallTicks(wallDomain[1]),
        xTick: wallTick,
        yTick: (v) => v.toFixed(v < 10 ? 1 : 0),
        bands: asbBands,
        series: [{ name: "Snapshot throughput", points: rated.map((s) => ({ x: wallX(s.wall_ms), y: s.bytes_per_s! / divisor })) }],
      }),
    "throughput",
  );
  chartOrNote(
    rated.length,
    () =>
      doc.lineChart({
        title: "Snapshot delivery rate",
        question: "How often did fresh simulation state arrive?",
        xLabel: "Observation time (min:s)",
        yLabel: "Snapshots per second",
        xDomain: wallDomain,
        xTicks: wallTicks(wallDomain[1]),
        xTick: wallTick,
        bands: asbBands,
        series: [{ name: "Snapshots per second", points: rated.map((s) => ({ x: wallX(s.wall_ms), y: s.snapshots_per_s ?? 0 })) }],
      }),
    "snapshot rate",
  );
  const latency = samples.filter((s) => s.latency_ms !== null);
  chartOrNote(
    latency.length,
    () =>
      doc.lineChart({
        title: "Request round trip",
        question: "How quickly did the core answer the interface's polls?",
        xLabel: "Observation time (min:s)",
        yLabel: "Round trip (ms)",
        xDomain: wallDomain,
        xTicks: wallTicks(wallDomain[1]),
        xTick: wallTick,
        series: [{ name: "Status and snapshot round trip", points: latency.map((s) => ({ x: wallX(s.wall_ms), y: s.latency_ms! })) }],
      }),
    "round-trip latency",
  );
  const pressured = samples.filter((s) => s.asb_score !== null);
  chartOrNote(
    pressured.length,
    () =>
      doc.lineChart({
        title: "Adaptive Simulation Backpressure",
        question: "Did the interface fall behind, and did backpressure intervene? Shaded spans are Restricted or Async.",
        xLabel: "Observation time (min:s)",
        yLabel: "Pressure (%) and speed (×)",
        xDomain: wallDomain,
        xTicks: wallTicks(wallDomain[1]),
        xTick: wallTick,
        bands: asbBands,
        series: [
          { name: "Backpressure score (%)", points: pressured.map((s) => ({ x: wallX(s.wall_ms), y: s.asb_score! * 100 })) },
          { name: "Applied speed (× 10)", points: samples.map((s) => ({ x: wallX(s.wall_ms), y: s.tick_rate * 10 })), step: true },
        ],
      }),
    "backpressure",
  );
  const asbIntervals = intervals(telemetry.transitions, "asb", (v) => v !== "NORMAL", wallEnd);
  doc.heading("Backpressure interventions");
  doc.table(
    [
      { title: "State", width: 0.16 },
      { title: "From", width: 0.16, mono: true },
      { title: "To", width: 0.16, mono: true },
      { title: "Duration", width: 0.16, align: "right" },
      { title: "Simulation time", width: 0.36, mono: true },
    ],
    asbIntervals.map((iv) => [title(iv.value.toLowerCase()), wallTick(wallX(iv.from_ms)), wallTick(wallX(iv.to_ms)), formatWallDuration(iv.to_ms - iv.from_ms), `${t(iv.virtual_from)} to ${iv.virtual_to !== null ? t(iv.virtual_to) : "report time"}`]),
    { empty: "Backpressure stayed Normal throughout the observation." },
  );
  if (asb?.actions.length) {
    doc.table(
      [
        { title: "Action", width: 0.22 },
        { title: "Reason", width: 0.46 },
        { title: "Score", width: 0.1, align: "right" },
        { title: "Speed", width: 0.22, align: "right" },
      ],
      asb.actions.map((a) => [title(a.action), a.reason, pct(a.score), a.rate_before >= 0 && a.rate_after >= 0 ? `${a.rate_before}× to ${a.rate_after}×` : ""]),
      { caption: "Recent actions reported by the core's backpressure governor." },
    );
  }
  const statusIntervals = intervals(telemetry.transitions, "status", (v) => v !== "online", wallEnd);
  doc.heading("Degraded and offline periods");
  doc.table(
    [
      { title: "Status", width: 0.2 },
      { title: "From", width: 0.2, mono: true },
      { title: "To", width: 0.2, mono: true },
      { title: "Duration", width: 0.4, align: "right" },
    ],
    statusIntervals.map((iv) => [title(iv.value), wallTick(wallX(iv.from_ms)), wallTick(wallX(iv.to_ms)), formatWallDuration(iv.to_ms - iv.from_ms)]),
    { empty: "The connection stayed Online throughout the observation." },
  );
  doc.heading("Operator controls and playback");
  const lifecycleRows = telemetry.transitions.filter((x) => x.kind === "lifecycle" && x.from);
  doc.table(
    [
      { title: "Observed at", width: 0.16, mono: true },
      { title: "Simulation time", width: 0.2, mono: true },
      { title: "Event", width: 0.64 },
    ],
    [
      ...telemetry.controls.map((c) => ({ wall: c.wall_ms, row: [wallTick(wallX(c.wall_ms)), t(c.virtual_s), `${title(c.action)}${c.detail ? `: ${c.detail}` : ""}`] })),
      ...lifecycleRows.map((x) => ({ wall: x.wall_ms, row: [wallTick(wallX(x.wall_ms)), t(x.virtual_s), `Playback ${x.from.toLowerCase()} to ${x.to.toLowerCase()}`] })),
    ]
      .sort((a, b) => a.wall - b.wall)
      .map((x) => x.row),
    { caption: "Speed changes, pauses, steps and other controls issued from this interface, with the playback transitions that followed.", empty: "No controls were used during the observation." },
  );

  // =========================================================================
  // 11 Determinism and integrity
  // =========================================================================
  doc.sectionHeading("Determinism and Integrity", "Identifiers that tie this report to a reproducible run.");
  doc.keyValues([
    ["Seed", seed],
    ["Run identifier", status.run_id],
    ["Graph hash", topology.graph_hash],
    ["Scenario hash", typeof scenarioHash === "string" ? scenarioHash : "Not recorded"],
    ["Map selection version", topology.map_selection_version],
    ["Playback revision", String(status.data.playback_revision ?? "Not reported")],
    ["Reproduction", "Starting the same seed with the same configuration reproduces this network, schedule, weather and incidents exactly. Playback speed changes pacing only, never physics."],
    ["Verification", "This report carries no cryptographic signature. The hashes above identify the run; they do not authenticate this document."],
  ]);
  const lifecycleAll = telemetry.transitions.filter((x) => x.kind === "lifecycle");
  if (lifecycleAll.length) {
    doc.heading("Engine lifecycle during observation");
    doc.table(
      [
        { title: "Observed at", width: 0.2, mono: true },
        { title: "Simulation time", width: 0.24, mono: true },
        { title: "State", width: 0.56 },
      ],
      lifecycleAll.map((x) => [wallTick(wallX(x.wall_ms)), t(x.virtual_s), title(x.to.toLowerCase())]),
    );
  }

  // =========================================================================
  // 12 Map
  // =========================================================================
  if (resources.map) {
    doc.sectionHeading("Map at Export", "The map as it was drawn at the moment of export, including the current viewport and layers.");
    doc.image(resources.map.dataUrl, resources.map.aspect, 150, "Road colour shows state: clear, moderate, severe and flooded. Map data © OpenStreetMap contributors, ODbL 1.0.");
  }

  // =========================================================================
  // Appendix
  // =========================================================================
  doc.sectionHeading("Methodology and Definitions", "How the figures in this report are defined.");
  const defs: [string, string][] = [
    ["Congestion index", "For each traversable road: 60% speed loss plus 25% halted share plus 15% occupancy, clamped to 0 to 1. Speed loss is one minus mean speed over free-flow speed. Closed roads score 1. The network index weights each road by length times lanes and is expressed in percent."],
    ["Vehicles", "The sum of modelled vehicle counts on all road directions. The traffic model is aggregate; vehicles are not individually tracked."],
    ["Mean speed", "Speed on roads carrying traffic, weighted by the number of vehicles on each."],
    ["Rain intensity", "A normalized 0 to 1 field from the deterministic weather model. Rates in millimetres per hour shown in the interface are indicative."],
    ["Rain footprint", "The sum of the areas of active rain cells. Overlapping cells are counted once each."],
    ["Flooding", "A synthetic 0 to 1 level per junction that accumulates from rain and drains over time. It is a model value, not a measured water depth. A road counts as flooded above 1%."],
    ["Throughput", "Snapshot bytes delivered to observers per second, as measured by the core. Data delivered integrates that rate over observation time."],
    ["Backpressure", "A 0 to 1 score from the interface's lag, frame time and data staleness. Sustained pressure lowers the applied speed; persistent pressure restricts or suspends the interface while the simulation continues."],
    ["Runtime status", "Online when data is current; Degraded while data is stale or backpressure is intervening; Offline when the core cannot be reached."],
  ];
  doc.keyValues(defs, 40);
  doc.paragraph("© 2026 Varun Karthic. DSTNS is released under the GNU Affero General Public License v3 or later. Map data © OpenStreetMap contributors, ODbL 1.0.", { size: 8, color: PRINT.dim });

  // =========================================================================
  // Contents, headers and footers
  // =========================================================================
  const pages = pdf.getNumberOfPages();
  pdf.setPage(contentsPage);
  doc.page = contentsPage;
  doc.y = doc.top;
  doc.line("CONTENTS", doc.M, doc.y, 7.5, PRINT.accent);
  doc.y += 5;
  doc.line("Contents", doc.M, doc.y, 18, PRINT.ink);
  doc.y += 14;
  for (const entry of doc.outline) {
    doc.line(entry.number, doc.M, doc.y, 10.5, PRINT.accent);
    doc.line(entry.title, doc.M + 10, doc.y, 10.5, PRINT.ink);
    doc.line(String(entry.page), doc.W - doc.M, doc.y, 10.5, PRINT.dim, "right");
    const tw = doc.textWidth(entry.title, 10.5);
    const pw = doc.textWidth(String(entry.page), 10.5);
    pdf.setDrawColor("#c5cfd6");
    pdf.setLineDashPattern([0.4, 1.2], 0);
    pdf.line(doc.M + 12 + tw, doc.y + 3.2, doc.W - doc.M - pw - 2, doc.y + 3.2);
    pdf.setLineDashPattern([], 0);
    doc.y += 9;
  }
  for (let p = 2; p <= pages; p++) {
    pdf.setPage(p);
    doc.page = p;
    if (resources.logoDark) pdf.addImage(resources.logoDark, "PNG", doc.M, 10, 4.2 * LOGO.aspect, 4.2);
    else doc.line("DSTNS", doc.M, 9.6, 9, PRINT.ink, "left", "chrome");
    doc.line(`Simulation Report · ${place}`, doc.W - doc.M, 10.2, 7.5, PRINT.dim, "right", "chrome");
    doc.rule(17);
    doc.rule(doc.H - 14);
    doc.line(`DSTNS · Seed ${shortSeed} · Run ${status.run_id}`, doc.M, doc.H - 11.5, 7, PRINT.faint, "left", "chrome");
    doc.line(`Page ${p} of ${pages}`, doc.W - doc.M, doc.H - 11.5, 7.5, PRINT.dim, "right", "chrome");
  }

  pdf.setProperties({
    title: `DSTNS Simulation Report, ${place}`,
    subject: `Seed ${seed}`,
    author: "DSTNS",
    creator: `DSTNS interface ${input.uiVersion}`,
    keywords: "DSTNS, traffic simulation, OpenStreetMap, AGPL-3.0",
  });
  return { pdf, doc, pages };
}

/** Collect browser-side resources, build the report and save it. */
export async function exportReport(input: ReportInput) {
  const fontResponse = await fetch(reportFontUrl);
  if (!fontResponse.ok) throw new Error("The report font could not be loaded. Reload and retry.");
  const bytes = new Uint8Array(await fontResponse.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const [logoLight, logoDark] = await Promise.all([logoPng().catch(() => undefined), logoPng(PRINT.dark).catch(() => undefined)]);

  let coreVersion: string | undefined;
  try {
    const res = await fetch("/api/v1/system/source");
    if (res.ok) coreVersion = (await res.json())?.data?.version;
  } catch {
    /* Reported as not available. */
  }

  let map: ReportResources["map"] = null;
  const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>(".map-canvas"));
  if (canvases.length && canvases[0].width > 0) {
    const merged = document.createElement("canvas");
    merged.width = canvases[0].width;
    merged.height = canvases[0].height;
    const ctx = merged.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#030f1b";
      ctx.fillRect(0, 0, merged.width, merged.height);
      for (const c of canvases) ctx.drawImage(c, 0, 0);
      map = { dataUrl: merged.toDataURL("image/png"), aspect: merged.width / merged.height };
    }
  }

  const platform = [
    `Platform: ${navigator.platform || "Not reported"}`,
    `Language: ${navigator.language}`,
    `Viewport: ${window.innerWidth} × ${window.innerHeight} at ${window.devicePixelRatio}× pixel ratio`,
    `Logical processors: ${navigator.hardwareConcurrency || "Not reported"}`,
  ];
  const { pdf } = await buildReport(input, { font: btoa(binary), logoLight, logoDark, map, coreVersion, platform });
  pdf.save(`DSTNS-report-${input.status.run_id}-${input.snapshot.clock.virtual_day_seconds}.pdf`);
}

export type { Column, Series };
