// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { LOGO, logoPng } from "../components/logoAsset";
import { coverMap } from "./reportCover";
import { printMap } from "./reportMap";
import reportFontUrl from "../assets/report-inter.ttf?url";
import { DEMAND_TYPE_LABEL, placeKind, roadState, roadTitle } from "../core/mapModel";
import { DAY_TICKS, PRINT, PT, ReportDocument, lineHeight, wallTicks } from "./pdfLayout";
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
import { describeNews, districtOf, INCIDENT_TITLES, roadNearNode } from "../core/notificationModel";
import { intervals } from "../simulation/telemetryRecorder";
import type { TelemetryLog } from "../simulation/telemetryRecorder";
import { DAY_SECONDS, formatDuration, formatSimulationTime, formatWallDuration } from "../core/timeFormat";
import type { Backpressure, Congestion, Envelope, Layers, News, Snapshot, Status, Topology } from "../core/types";

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
  /** The city, to the edges of the page, as a JPEG. */
  cover?: string | null;
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

const MODULE_NAMES: Record<string, string> = Object.assign(Object.create(null), {
  traffic: "Traffic",
  signals: "Signals",
  buildings: "Place demand",
  dws: "Weather",
  flooding: "Flooding",
  news: "Event news",
  incidents: "Incidents",
});

const pct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const title = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export async function buildReport(input: ReportInput, resources: ReportResources = {}, onProgress?: (label: string, share: number) => void) {
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
  // The engine that made this world, as it describes itself. A server from before engines described themselves ran
  // core-legacy, the only engine there was.
  const engine = status.data.engine_identity ?? null;
  const engineText = engine ? `${engine.id} ${engine.version} (${engine.channel}, ${engine.type === "delegating" ? "delegating engine" : "standalone engine"})` : `${status.data.engine || "core-legacy"} (not described by this server)`;

  // ---- Derived records -----------------------------------------------------
  const net = networkStats(topology);
  const rains = rainEvents(news);
  const incidents = incidentRecords(news);
  const floods = news.filter((n) => n.template_id === "FLOOD_STARTED");
  const floodRoads = new Set(floods.map((n) => (n.data as Record<string, unknown>)?.edge_id)).size;
  const events = timeline(news, 900, topology);
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
  // A dark page with this run's own city behind the words, softening and dissolving down the page. The name stands
  // low on the page over what the run came to and what identifies it. Everything stays inside the margins, and a
  // long name or seed is set smaller rather than cut off.
  onProgress?.("Drawing the cover", 0.04);
  doc.newPage();
  doc.rect(0, 0, doc.W, doc.H, PRINT.dark, 0);
  if (resources.cover) pdf.addImage(resources.cover, "JPEG", 0, 0, doc.W, doc.H);
  const edge = doc.M;
  const room = doc.width;
  if (resources.logoLight) pdf.addImage(resources.logoLight, "PNG", edge, 15, 6.2 * LOGO.aspect, 6.2);
  else doc.line("DSTNS", edge, 15, 14, PRINT.darkInk);
  doc.line("SIMULATION REPORT", doc.W - edge, 16.2, 7.2, "#c6d8e3", "right");
  const city = location?.city ?? "Explicit map file";
  const sized = (text: string, wanted: number, width: number) => Math.min(wanted, (wanted * width) / Math.max(1, doc.textWidth(text, wanted)));
  const nameSize = sized(city, 60, room);
  // Hung from the line beneath it, so that a smaller name sits as close to its country as a large one.
  const nameTop = 216.5 - nameSize * PT * 1.2;
  doc.line(location ? "A SIMULATED DAY IN" : "A SIMULATED DAY", edge, nameTop - 4.4, 8, "#5ee3bf");
  // Set a little tight, as large type wants to be.
  pdf.setCharSpace(-nameSize * PT * 0.016);
  doc.line(city, edge - nameSize * PT * 0.03, nameTop, nameSize, "#ffffff");
  pdf.setCharSpace(0);
  doc.line(location?.country ?? "Deterministic Spatiotemporal Transport Network Simulator", edge, 216.5, 13, "#b7cbd7");

  const vehiclesNow = snapshot.data.edges.reduce((sum, e) => sum + e.vehicle_count, 0);
  const headlines: [string, string][] = [
    [`${Math.round(net.km).toLocaleString()} km`, "OF ROAD"],
    [vehiclesNow.toLocaleString(), "VEHICLES AT THIS MOMENT"],
    [`${(peakCongestion?.current ?? snapshot.data.congestion.current).toFixed(0)}%`, "PEAK CONGESTION"],
    [incidents.length.toLocaleString(), incidents.length === 1 ? "INCIDENT" : "INCIDENTS"],
  ];
  headlines.forEach(([value, label], n) => {
    const x = edge + (n * room) / 4;
    doc.line(value, x, 230, sized(value, 21, room / 4 - 4), "#ffffff");
    doc.line(label, x, 240.5, 5.8, "#93acba");
  });
  pdf.setDrawColor("#28434f");
  pdf.setLineWidth(0.2);
  pdf.line(edge, 247, doc.W - edge, 247);
  const facts: [string, string][] = [
    ["SEED", seed],
    ["GENERATED", now.toLocaleString(undefined, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })],
    ["SIMULATED TO", `${tShort(virtual)}, ${pct(virtual / DAY_SECONDS, 0)} of the day`],
    ["RUN", status.run_id],
  ];
  facts.forEach(([key, value], n) => {
    const x = edge + (n % 2) * (room / 2);
    const y = 251 + Math.floor(n / 2) * 11;
    doc.line(key, x, y, 5.8, "#93acba");
    doc.line(value, x, y + 3.3, sized(value, 9.5, room / 2 - 5), "#e8f1f6");
  });
  doc.line("© 2026 Varun Karthic. AGPL-3.0-or-later.", edge, 281, 6.6, "#93acba");
  doc.line("Map data © OpenStreetMap contributors, ODbL.", doc.W - edge, 281, 6.6, "#93acba", "right");

  // About and contents, on one page. The contents are filled once page numbers are known.
  doc.newPage();
  const contentsPage = doc.page;
  doc.line("ABOUT", doc.M, doc.y, 7.5, PRINT.accent);
  doc.y += 5;
  doc.line("About this report", doc.M, doc.y, 18, PRINT.ink);
  doc.y += 11;
  doc.paragraph(
    "This report records one DSTNS simulation run as observed from the operator interface. It covers the scenario configuration, the road network, traffic, signals, weather, flooding, incidents, a timeline of significant events, and the performance of the connection between the simulation and the interface.",
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
  const contentsTop = doc.y + 7;

  // =========================================================================
  // I At a glance
  // =========================================================================
  onProgress?.("Summarising the run", 0.1);
  doc.part("At a glance", "What this simulated day came to, in one sentence, in figures and in a few findings, before the detail of each part that follows.", "summary");
  doc.sectionHeading("Executive Summary", "Figures cover the whole run where the core keeps a complete record, and the observed session where only the interface measured them.");
  const closures = incidents.filter((i) => i.closed).length;
  const started = incidents.filter((i) => i.start !== null);
  const rainsStarted = rains.filter((r) => r.start !== null).length;
  const clauses = [
    peakCongestion ? `congestion peaked at ${peakCongestion.current.toFixed(0)}% at ${tShort(peakCongestion.virtual_s)}` : "",
    started.length ? `${started.length} incident${started.length === 1 ? "" : "s"} ${closures ? `closed ${closures} road${closures === 1 ? "" : "s"}` : "slowed traffic without closing a road"}` : "no incidents occurred",
    rainsStarted ? `${rainsStarted} rain cell${rainsStarted === 1 ? "" : "s"} passed over${floods.length ? `, flooding ${floodRoads.toLocaleString()} road${floodRoads === 1 ? "" : "s"}` : ""}` : "the weather stayed dry",
  ].filter(Boolean);
  const spoken = clauses.length > 1 ? `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}` : clauses[0];
  doc.headline(`${lifecycle === "COMPLETED" ? "A full simulated day" : "A simulated day"} in ${location ? location.city : "this network"}, across ${Math.round(net.km).toLocaleString()} km of road: ${spoken}.`);
  doc.tiles([
    { label: "Road network", value: `${Math.round(net.km).toLocaleString()} km`, note: `${net.nodes.toLocaleString()} junctions` },
    { label: "Peak vehicles", value: peakVehicles ? peakVehicles.vehicles.toLocaleString() : "Not recorded", note: peakVehicles ? `at ${tShort(peakVehicles.virtual_s)}` : "Observed samples" },
    { label: "Peak congestion", value: peakCongestion ? `${peakCongestion.current.toFixed(1)}%` : "Not recorded", note: peakCongestion ? `at ${tShort(peakCongestion.virtual_s)}` : undefined, color: PRINT.amber },
    { label: "Mean speed", value: speedStats ? `${speedStats.mean.toFixed(0)} km/h` : "Not recorded", note: speedStats ? `${speedStats.min.toFixed(0)} to ${speedStats.max.toFixed(0)} km/h` : undefined },
    { label: "Incidents", value: String(started.length), note: `${closures} closed a road`, color: PRINT.red },
    { label: "Rain events", value: String(rainsStarted), note: forecast !== undefined ? `${forecast} forecast` : undefined, color: PRINT.blue },
    { label: "Flood onsets", value: floods.length.toLocaleString(), note: `${floodRoads.toLocaleString()} distinct roads`, color: PRINT.blue },
    { label: "Observed for", value: observedMs ? formatWallDuration(observedMs) : "Not recorded", note: "Wall-clock time" },
  ]);
  chartOrNote(
    history.length,
    () =>
      doc.lineChart({
        title: "The day's congestion",
        question: "When the network was busiest, from the core's record of the whole run.",
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
  // Findings: each says what was found and what it rests on, and is labelled by where it comes from.
  const findings: { title: string; body: string; kind: "Observed" | "Derived" | "Interpretation" }[] = [];
  const busy = history.length ? congestionPeriods(history, 35) : [];
  const congested = stats(history.map((h) => h.current));
  if (busy.length) {
    const longest = busy.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
    findings.push({ kind: "Derived", title: `Busiest from ${tShort(longest.from)} to ${tShort(longest.to)}`, body: `The congestion index stayed at or above 35% for ${formatDuration(longest.to - longest.from + 60)}, peaking at ${longest.peak.toFixed(1)}% at ${tShort(longest.peakAt)}. It was this busy ${busy.length === 1 ? "once" : `${busy.length} times`} in the day.` });
  } else if (congested) {
    findings.push({ kind: "Derived", title: "The network never reached moderate congestion", body: `Across ${congested.count} per-minute samples the index averaged ${congested.mean.toFixed(1)}% and its 95th percentile was ${congested.p95.toFixed(1)}%, below the 35% the map calls moderate.` });
  }
  if (peakVehicles && vehicleStats)
    findings.push({ kind: "Observed", title: `${peakVehicles.vehicles.toLocaleString()} vehicles at the peak`, body: `Demand built to its peak at ${tShort(peakVehicles.virtual_s)}, against a mean of ${Math.round(vehicleStats.mean).toLocaleString()} and a low of ${vehicleStats.min.toLocaleString()} over the observed samples.` });
  if (speedStats)
    findings.push({ kind: "Observed", title: `Traffic moved at ${speedStats.mean.toFixed(0)} km/h on average`, body: `Vehicle-weighted mean speed ranged from ${speedStats.min.toFixed(1)} to ${speedStats.max.toFixed(1)} km/h. Where it fell, congestion, rain or an incident was holding traffic back.` });
  if (started.length) {
    const lasted = started.filter((i) => i.end !== null).map((i) => (i.end as number) - (i.start as number));
    findings.push({ kind: "Observed", title: `${started.length} incident${started.length === 1 ? "" : "s"}, ${closures ? `${closures} closing a road` : "none closing a road"}`, body: lasted.length ? `Those that cleared lasted ${formatDuration(Math.round(lasted.reduce((a, b) => a + b, 0) / lasted.length))} on average. Each is listed with where and how long under Incident Analysis.` : "None had cleared by the end of the record. Each is listed under Incident Analysis." });
  }
  if (rainsStarted || floods.length) {
    const r = pearson(simSamples.map((x) => x.rain_area_km2), simSamples.map((x) => x.flooded_edges));
    findings.push({ kind: r !== null ? "Derived" : "Observed", title: floods.length ? `Rain flooded ${floodRoads.toLocaleString()} road${floodRoads === 1 ? "" : "s"}` : `${rainsStarted} rain cell${rainsStarted === 1 ? "" : "s"}, no flooding`, body: r !== null ? `Flooded roads followed the area under rain with a correlation of ${r.toFixed(2)}: flooding builds from rainfall and drains after it, so it can outlast the rain.` : "Rain cells passed without enough samples to relate them to flooding." });
  }
  if (asb)
    findings.push({ kind: "Observed", title: asb.actions.length ? `The display was eased ${asb.actions.length} time${asb.actions.length === 1 ? "" : "s"}` : "The display kept pace throughout", body: asb.actions.length ? "Adaptive Simulation Backpressure lowered the playback rate when the interface fell behind, and raised it again once it caught up. The simulation itself is never slowed." : `Adaptive Simulation Backpressure stayed ${asb.state.toLowerCase()} with no intervention recorded.` });
  if (findings.length) {
    doc.heading("Findings");
    doc.insights(findings.slice(0, 6));
  }
  if (resources.map) {
    doc.heading("The network");
    doc.image(resources.map.dataUrl, resources.map.aspect, 112, "The whole network when the report was made: road state, closures, rain and places. Part VI has it at full size.");
  }

  doc.part("The city", "Where the day was simulated: the scenario the seed chose, the road network the model runs on, and the signals that control its junctions.", "network");
  // =========================================================================
  // 2 Configuration
  // =========================================================================
  const base = DAY_SECONDS / snapshot.clock.playback_duration_seconds;
  onProgress?.("Reading the configuration", 0.16);
  doc.sectionHeading("Simulation Configuration", "The parameters the run was started with, as reported by the core.", false, "configuration");
  doc.heading("Scenario");
  doc.keyValues([
    ["Seed", seed],
    ["Saved configuration", status.data.saved_seed_id || "Not saved"],
    ["Engine", engineText],
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
  // 4 Road network
  // =========================================================================
  onProgress?.("Measuring the road network", 0.28);
  doc.sectionHeading("Road Network Analysis", "The static network the model runs on, and its state at report time.", false, "network");
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
  // The six longest classes as shares of the network, the rest together, then every class in detail.
  const longest = [...net.classes].sort((a, b) => b.km - a.km);
  doc.donut(
    "Length of road by class",
    [...longest.slice(0, 6).map((c) => ({ label: title(c.name), value: c.km })), ...(longest.length > 6 ? [{ label: "Other classes", value: longest.slice(6).reduce((sum, c) => sum + c.km, 0), color: PRINT.faint }] : [])],
    " km",
    "Which kinds of road make up the network the traffic runs on.",
  );
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
  doc.heading("Road state when exported");
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
  // Signals
  // =========================================================================
  const signals = snapshot.data.signals;
  onProgress?.("Listing the signals", 0.52);
  doc.sectionHeading("Signal Control", "Signalled junctions run their own fixed schedules, derived from the seed. These are the controllers as they stood at report time.", false, "signals");
  const cycles = signals.map((c) => c.cycle_length).filter((c) => c > 0);
  doc.tiles([
    { label: "Controllers", value: signals.length.toLocaleString(), note: `${signals.filter((c) => c.enabled).length} enabled` },
    { label: "Shortest cycle", value: cycles.length ? `${Math.min(...cycles.slice(0, 5000)).toFixed(0)} s` : "Not recorded" },
    { label: "Longest cycle", value: cycles.length ? `${Math.max(...cycles.slice(0, 5000)).toFixed(0)} s` : "Not recorded" },
    { label: "Mean cycle", value: cycles.length ? `${(cycles.reduce((sum, c) => sum + c, 0) / cycles.length).toFixed(0)} s` : "Not recorded" },
  ]);
  doc.table(
    [
      { title: "Junction", width: 0.36 },
      { title: "Phase", width: 0.2 },
      { title: "In phase", width: 0.12, align: "right" },
      { title: "Next change", width: 0.18, mono: true },
      { title: "Cycle", width: 0.14, align: "right" },
    ],
    signals.slice(0, 24).map((c) => [
      roadNearNode(topology, c.junction_id) ?? `Junction ${c.junction_id}`,
      c.phase_name ? title(c.phase_name.toLowerCase().replace(/_/g, " ")) : `Phase ${c.phase}`,
      c.time_in_phase !== null ? `${c.time_in_phase.toFixed(0)} s` : "",
      c.next_transition_at !== null ? t(c.next_transition_at) : "",
      `${c.cycle_length.toFixed(0)} s`,
    ]),
    { caption: signals.length > 24 ? `The first 24 of ${signals.length} controllers.` : undefined, empty: "This network has no signal controllers." },
  );

  doc.part("Traffic", "How demand built and fell through the day, where the network was most congested, and which roads and places drew the most traffic.", "traffic");
  // =========================================================================
  // 5 Traffic
  // =========================================================================
  onProgress?.("Charting the traffic", 0.42);
  doc.sectionHeading("Traffic Analysis", "Traffic measures across the virtual day. The congestion history is kept by the core for the whole run; vehicle and speed series are the interface's samples.", false, "traffic");
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
  doc.heading("Most congested roads when exported");
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

  // What each class of road is carrying, which says more than the network's total does.
  const carrying = new Map<string, { roads: number; km: number; vehicles: number; speed: number; moving: number; congestion: number }>();
  for (const edge of realEdges) {
    const state = stateById.get(edge.id);
    const row = carrying.get(edge.road_class) ?? { roads: 0, km: 0, vehicles: 0, speed: 0, moving: 0, congestion: 0 };
    row.roads += 1;
    row.km += edge.length_m / 1000;
    if (state) {
      row.vehicles += state.vehicle_count;
      row.congestion += state.congestion;
      if (state.vehicle_count > 0) {
        row.speed += state.mean_speed_mps * 3.6 * state.vehicle_count;
        row.moving += state.vehicle_count;
      }
    }
    carrying.set(edge.road_class, row);
  }
  doc.heading("Traffic by road class at report time");
  doc.table(
    [
      { title: "Class", width: 0.28 },
      { title: "Roads", width: 0.12, align: "right" },
      { title: "Length", width: 0.14, align: "right" },
      { title: "Vehicles", width: 0.14, align: "right" },
      { title: "Mean speed", width: 0.16, align: "right" },
      { title: "Congestion", width: 0.16, align: "right" },
    ],
    [...carrying.entries()]
      .sort((a, b) => b[1].vehicles - a[1].vehicles)
      .map(([name, row]) => [title(name), row.roads.toLocaleString(), `${row.km.toFixed(1)} km`, row.vehicles.toLocaleString(), row.moving ? `${(row.speed / row.moving).toFixed(1)} km/h` : "No traffic", pct(row.congestion / Math.max(1, row.roads), 1)]),
    { caption: "Mean speed is weighted by vehicles, and congestion is the mean across the class's roads.", empty: "No road state was available." },
  );
  const featureById = new Map(topology.features.map((f) => [f.id, f]));
  const drawing = snapshot.data.demand
    .filter((d) => d.active)
    .sort((a, b) => b.multiplier - a.multiplier)
    .slice(0, 12);
  doc.heading("Places drawing extra traffic at report time");
  doc.table(
    [
      { title: "Place", width: 0.46 },
      { title: "Kind", width: 0.22 },
      { title: "Demand", width: 0.16, align: "right" },
      { title: "Radius", width: 0.16, align: "right" },
    ],
    drawing.map((d) => {
      const feature = featureById.get(d.feature_id);
      return [feature?.name || "Unnamed place", feature ? placeKind(feature).label : "Not recorded", `${d.multiplier.toFixed(2)}×`, `${Math.round(d.radius_m)} m`];
    }),
    { caption: `${snapshot.data.demand.filter((d) => d.active).length} of ${snapshot.data.demand.length} demand-modelled places are active, the highest listed here.`, empty: "No place was drawing extra traffic at this moment." },
  );

  doc.part("Disruptions", "What interrupted the day: rain from the weather model, the flooding it caused, scheduled incidents, and every significant event in order.", "incidents");
  // =========================================================================
  // 6 Weather
  // =========================================================================
  onProgress?.("Reading the weather", 0.58);
  doc.sectionHeading("Weather Analysis", "Rain cells from the deterministic weather model. Start, peak and end times come from the core's event record for the whole run.", false, "weather");
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
  onProgress?.("Reading the flooding", 0.63);
  doc.sectionHeading("Flooding Analysis", "Flooding accumulates from rainfall at each junction according to its susceptibility, and drains over time, so it can persist after rain has cleared.", false, "flooding");
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
  onProgress?.("Registering the incidents", 0.68);
  doc.sectionHeading("Incident Analysis", "Incidents are scheduled deterministically from the seed and restrict speed and capacity or close roads while active.", false, "incidents");
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
  onProgress?.("Laying out the timeline", 0.74);
  // Demand peaks are many and alike, so they are counted by hour; everything else is listed as it happened.
  const peaks = events.filter((e) => e.category === "demand");
  const notable = events.filter((e) => e.category !== "demand");
  doc.sectionHeading("Simulation Event Timeline", `Weather, flooding, incidents and the system, in simulation-time order: ${notable.length} entr${notable.length === 1 ? "y" : "ies"}. Flood onsets within fifteen minutes of each other are combined. The ${peaks.length.toLocaleString()} peaks in demand at places are counted by hour.`, false, "timeline");
  if (peaks.length) {
    const byHour = new Map<number, number>();
    for (const e of peaks) byHour.set(Math.floor(e.time / 3600), (byHour.get(Math.floor(e.time / 3600)) ?? 0) + 1);
    const hours = [...byHour.keys()].sort((a, b) => a - b);
    doc.barChart(
      "Peaks in demand at places, by hour",
      hours.map((h) => ({ label: tShort(h * 3600), value: byHour.get(h) ?? 0, color: PRINT.amber })),
      "",
      "When schools, offices and shops drew their extra traffic.",
    );
  }
  doc.table(
    [
      { title: "Time", width: 0.14, mono: true },
      { title: "Category", width: 0.13 },
      { title: "Severity", width: 0.11 },
      { title: "Event", width: 0.62 },
    ],
    notable.map((e) => [
      t(e.time),
      title(e.category),
      e.severity === "alert" ? "High" : e.severity === "warning" ? "Moderate" : "Low",
      e.source ? describeNews(e.source, topology).summary : e.text,
    ]),
    { empty: "No significant events were recorded." },
  );

  doc.part("How it ran", "How the simulation and the interface kept pace with each other, what they held in memory, and the software it ran on.", "performance");
  // =========================================================================
  // 10 Performance
  // =========================================================================
  onProgress?.("Plotting the performance", 0.82);
  doc.sectionHeading("Performance and Telemetry", "How the simulation and the interface kept pace with each other during observation. These measures are the interface's own; times are wall-clock minutes and seconds since observation began.", false, "performance");
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
  const STATUS_WHY: Record<string, string> = {
    restricted: "Held at a lower speed with motion reduced, on purpose, while a long jump settled",
    degraded: "Fresh state arrived late, or backpressure was acting",
    offline: "The core did not answer",
  };
  doc.heading("Restricted, degraded and offline periods");
  doc.paragraph("A jump through the day of half an hour or more is Restricted: it is worked out while the core keeps answering, lands at 0.25× and doubles back to the requested speed every two seconds, with map motion reduced until it is there.", { size: 8.5, color: PRINT.dim });
  doc.table(
    [
      { title: "Status", width: 0.14 },
      { title: "From", width: 0.11, mono: true },
      { title: "To", width: 0.11, mono: true },
      { title: "Duration", width: 0.13, align: "right" },
      { title: "Why", width: 0.51 },
    ],
    statusIntervals.map((iv) => [title(iv.value), wallTick(wallX(iv.from_ms)), wallTick(wallX(iv.to_ms)), formatWallDuration(iv.to_ms - iv.from_ms), STATUS_WHY[iv.value] ?? ""]),
    { empty: "The connection stayed Online throughout the observation." },
  );
  const jumps = telemetry.controls.filter((c) => (c.action === "back" || c.action === "forward") && c.detail);
  if (jumps.length) {
    doc.heading("Jumps through the day");
    doc.table(
      [
        { title: "Observed at", width: 0.18, mono: true },
        { title: "From", width: 0.2, mono: true },
        { title: "Jump", width: 0.32 },
        { title: "Restricted after", width: 0.3 },
      ],
      jumps.map((c) => {
        const after = statusIntervals.find((iv) => iv.value === "restricted" && iv.from_ms >= c.wall_ms - 500 && iv.from_ms - c.wall_ms < 5000);
        return [wallTick(wallX(c.wall_ms)), t(c.virtual_s), `${title(c.action)} ${c.detail}`, after ? `Yes, for ${formatWallDuration(after.to_ms - after.from_ms)}` : "No"];
      }),
      { caption: "Each Back, Forward and Time Control jump, and whether the run was Restricted after it." },
    );
  }
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
  // System resources
  // =========================================================================
  onProgress?.("Measuring the resources", 0.86);
  const res = telemetry.resources ?? [];
  doc.sectionHeading("System Resources", "What the simulation server and this interface held in memory over the observation, and the processor time the server used, read every five seconds. The server's figures are its whole process; the interface's are this page's JavaScript heap where the browser reports it.", false, "resources");
  const mb = (bytes: number) => bytes / (1024 * 1024);
  const fmtMb = (bytes: number | null | undefined) => (bytes == null ? "Not recorded" : `${mb(bytes) >= 100 ? mb(bytes).toFixed(0) : mb(bytes).toFixed(1)} MB`);
  const lastRes = res[res.length - 1];
  const firstRes = res[0];
  const heaps = res.filter((r) => r.heap_bytes !== null);
  const cpuShare = firstRes && lastRes && lastRes.wall_ms > firstRes.wall_ms ? (lastRes.cpu_s - firstRes.cpu_s) / ((lastRes.wall_ms - firstRes.wall_ms) / 1000) : null;
  const growth = firstRes && lastRes && lastRes !== firstRes ? lastRes.rss_bytes - firstRes.rss_bytes : null;
  doc.tiles([
    { label: "Server memory", value: fmtMb(lastRes?.rss_bytes), note: "At report time" },
    { label: "Server peak", value: fmtMb(lastRes?.peak_rss_bytes), note: "Most held since it started" },
    { label: "Change over observation", value: growth === null ? "Not recorded" : `${growth >= 0 ? "+" : "−"}${fmtMb(Math.abs(growth))}`, note: res.length ? `${res.length} readings` : undefined, color: growth !== null && growth > 256 * 1024 * 1024 ? PRINT.amber : undefined },
    { label: "Server processor", value: cpuShare === null ? "Not recorded" : `${(cpuShare * 100).toFixed(0)}%`, note: "Of one core, on average" },
    { label: "Interface heap", value: fmtMb(heaps[heaps.length - 1]?.heap_bytes), note: heaps.length ? `of ${fmtMb(heaps[heaps.length - 1]?.heap_limit_bytes)} allowed` : "Not reported by this browser" },
    { label: "Interface heap peak", value: heaps.length ? fmtMb(Math.max(...heaps.map((r) => r.heap_bytes!))) : "Not recorded" },
    { label: "Processor time", value: lastRes ? `${lastRes.cpu_s.toFixed(0)} s` : "Not recorded", note: "Used by the server" },
    { label: "Logical processors", value: String(navigator.hardwareConcurrency || "Not reported"), note: "On this machine" },
  ]);
  chartOrNote(
    res.length,
    () =>
      doc.lineChart({
        title: "Memory over the observation",
        question: "Did either side hold more and more memory as the run went on, or did it settle?",
        xLabel: "Observation time (min:s)",
        yLabel: "Memory (MB)",
        xDomain: wallDomain,
        xTicks: wallTicks(wallDomain[1]),
        xTick: wallTick,
        yTick: (v) => v.toFixed(0),
        bands: asbBands,
        series: [
          { name: "Server resident memory (MB)", points: res.map((r) => ({ x: wallX(r.wall_ms), y: mb(r.rss_bytes) })) },
          ...(heaps.length ? [{ name: "Interface heap (MB)", points: heaps.map((r) => ({ x: wallX(r.wall_ms), y: mb(r.heap_bytes!) })) }] : []),
        ],
      }),
    "memory",
  );
  const cpuPoints = res.slice(1).map((r, i) => ({ x: wallX(r.wall_ms), y: Math.max(0, ((r.cpu_s - res[i].cpu_s) / Math.max(0.001, (r.wall_ms - res[i].wall_ms) / 1000)) * 100) }));
  chartOrNote(
    cpuPoints.length,
    () =>
      doc.lineChart({
        title: "Server processor use",
        question: "How hard did the server work, and when? A long jump shows as a burst.",
        xLabel: "Observation time (min:s)",
        yLabel: "Of one core (%)",
        xDomain: wallDomain,
        xTicks: wallTicks(wallDomain[1]),
        xTick: wallTick,
        yTick: (v) => v.toFixed(0),
        bands: asbBands,
        series: [{ name: "Processor use (% of one core)", points: cpuPoints }],
      }),
    "processor use",
  );
  doc.heading("System parameters");
  doc.keyValues([
    ["Playback", `${formatWallDuration(snapshot.clock.playback_duration_seconds * 1000)} of wall time per virtual day at 1×`],
    ["Requested speed", asb ? `${asb.requested_tick_rate}×` : `${snapshot.clock.tick_rate}×`],
    ["Applied speed", asb ? `${asb.applied_tick_rate}×${asb.rate_capped ? ", capped" : ""}` : `${snapshot.clock.tick_rate}×`],
    ["Backpressure", asb ? `${title(asb.state.toLowerCase())}${asb.restriction ? ` (${asb.restriction === "jump" ? "after a long jump" : "the interface fell behind"})` : ""}, score ${pct(asb.score)}` : "Not reported"],
    ["Backpressure thresholds", asb?.thresholds ? `in sync below ${pct(asb.thresholds.synced)}, stressed above ${pct(asb.thresholds.stressed)}, critical above ${pct(asb.thresholds.critical)}` : "Not reported"],
    ["Long jumps", "Restricted from 30 minutes of simulated time; land at 0.25× and double every 2 s"],
    ["Readings kept", `${samples.length.toLocaleString()} snapshot samples, ${res.length.toLocaleString()} resource readings, ${telemetry.controls.length.toLocaleString()} controls`],
    ["Sampling", "One sample per snapshot delivered; resources every 5 s. Older halves are thinned to every other reading when a buffer fills."],
  ]);

  // =========================================================================
  // 3 Environment
  // =========================================================================
  onProgress?.("Noting the environment", 0.2);
  doc.sectionHeading("Environment and Runtime", "Software versions and the environment the report was produced in. Filesystem paths are deliberately omitted.", false, "environment");
  doc.keyValues([
    ["DSTNS server", resources.coreVersion ?? "Not reported"],
    ["Engine", engineText],
    ...(engine && engine.channel !== "stable" ? [["Engine release channel", `${engine.channel}: not a stable engine; its results may change in later versions`] as [string, string]] : []),
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

  doc.part("Reference", "What ties this report to a reproducible run, the whole network at export, and how every figure is defined.", "methodology");
  // =========================================================================
  // 11 Determinism and integrity
  // =========================================================================
  onProgress?.("Sealing the identifiers", 0.88);
  doc.sectionHeading("Determinism and Integrity", "Identifiers that tie this report to a reproducible run.", false, "integrity");
  doc.keyValues([
    ["Seed", seed],
    ["Run identifier", status.run_id],
    ["Graph hash", topology.graph_hash],
    ["Scenario hash", typeof scenarioHash === "string" ? scenarioHash : "Not recorded"],
    ["Map selection version", topology.map_selection_version],
    ["Engine", engineText],
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
    onProgress?.("Printing the map", 0.92);
  doc.sectionHeading("Map at Export", "The whole network at the moment of export, drawn afresh in print colours for reading on paper.", false, "map");
    doc.image(resources.map.dataUrl, resources.map.aspect, 150, "Road colour shows state: clear, moderate, severe and flooded. Map data © OpenStreetMap contributors, ODbL 1.0.");
  }

  // =========================================================================
  // Appendix
  // =========================================================================
  onProgress?.("Adding the definitions", 0.96);
  doc.sectionHeading("Methodology and Definitions", "How the figures in this report are defined.", false, "methodology");
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

  doc.flush();
  // =========================================================================
  // Contents, headers and footers
  // =========================================================================
  const pages = pdf.getNumberOfPages();
  pdf.setPage(contentsPage);
  doc.page = contentsPage;
  doc.y = contentsTop;
  doc.line("CONTENTS", doc.M, doc.y, 7.5, PRINT.accent);
  doc.y += 5;
  doc.line("Contents", doc.M, doc.y, 18, PRINT.ink);
  doc.y += 12;
  // Two columns, each part a heading over its sections, the first three parts on the left.
  const groups: { part: (typeof doc.outline)[number]; sections: (typeof doc.outline)[number][] }[] = [];
  for (const entry of doc.outline) {
    if (entry.part) groups.push({ part: entry, sections: [] });
    else groups[groups.length - 1]?.sections.push(entry);
  }
  const columnW = (doc.width - 10) / 2;
  const columnTop = doc.y;
  const leader = (x: number, y: number, from: number, to: number) => {
    pdf.setDrawColor("#c5cfd6");
    pdf.setLineDashPattern([0.4, 1.2], 0);
    pdf.line(from, y, to, y);
    pdf.setLineDashPattern([], 0);
  };
  groups.forEach((group, g) => {
    const x = doc.M + (g < Math.ceil(groups.length / 2) ? 0 : columnW + 10);
    if (g === Math.ceil(groups.length / 2)) doc.y = columnTop;
    const right = x + columnW;
    doc.line(`PART ${group.part.number}`, x, doc.y, 6.5, PRINT.accent);
    doc.y += 3.4;
    doc.line(group.part.title, x, doc.y, 11.5, PRINT.ink);
    doc.line(String(group.part.page), right, doc.y + 0.6, 10, PRINT.dim, "right");
    doc.y += 7;
    for (const entry of group.sections) {
      doc.line(entry.number, x, doc.y, 9.2, PRINT.accent);
      const name = doc.fit(entry.title, columnW - 18, 9.2);
      doc.line(name, x + 7, doc.y, 9.2, PRINT.ink);
      doc.line(String(entry.page), right, doc.y, 9.2, PRINT.dim, "right");
      leader(x, doc.y + 2.9, x + 9 + doc.textWidth(name, 9.2), right - doc.textWidth(String(entry.page), 9.2) - 2);
      doc.y += 5.8;
    }
    doc.y += 4.5;
  });
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

  // Bookmarks, so that a reader can move about it, and everything a catalogue needs to know.
  let partMark: unknown = null;
  for (const entry of doc.outline)
    if (entry.part) partMark = pdf.outline.add(null, `Part ${entry.number}  ${entry.title}`, { pageNumber: entry.page });
    else pdf.outline.add(partMark as never, `${entry.number}  ${entry.title}`, { pageNumber: entry.page });
  const ident = `Seed ${seed}, run ${status.run_id}`;
  pdf.setProperties({
    title: `DSTNS Simulation Report: ${place}`,
    subject: `Simulation of ${place} to ${t(virtual)} (${pct(virtual / DAY_SECONDS, 1)} of the day). ${ident}.`,
    author: "Varun Karthic",
    creator: `DSTNS Interface ${input.uiVersion}, server ${resources.coreVersion ?? "not reported"}, engine ${engineText}, API ${status.api_version}`,
    keywords: ["DSTNS", "traffic simulation", "transport network", "deterministic", "OpenStreetMap", place, `seed ${seed}`, status.run_id, "AGPL-3.0-or-later"].join(", "),
  });
  pdf.setCreationDate(now);
  pdf.setLanguage("en-GB");
  pdf.setDisplayMode("fullwidth", "continuous", "UseOutlines");
  pdf.viewerPreferences({ DisplayDocTitle: true });
  const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  pdf.addMetadata(
    [
      `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">DSTNS Simulation Report: ${xml(place)}</rdf:li></rdf:Alt></dc:title>`,
      `<dc:creator><rdf:Seq><rdf:li>Varun Karthic</rdf:li></rdf:Seq></dc:creator>`,
      `<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">Copyright (C) 2026 Varun Karthic. AGPL-3.0-or-later. Map data (C) OpenStreetMap contributors, ODbL.</rdf:li></rdf:Alt></dc:rights>`,
      `<dc:source>${xml(topology.source)}</dc:source>`,
      `<dc:coverage>${xml(place)}</dc:coverage>`,
      `<dstns:seed>${xml(seed)}</dstns:seed>`,
      `<dstns:run>${xml(status.run_id)}</dstns:run>`,
      `<dstns:state>${xml(lifecycle)}</dstns:state>`,
      `<dstns:virtualSeconds>${Math.round(virtual)}</dstns:virtualSeconds>`,
      `<dstns:server>${xml(resources.coreVersion ?? "not reported")}</dstns:server>`,
      `<dstns:engine>${xml(engine?.id ?? status.data.engine ?? "core-legacy")}</dstns:engine>`,
      `<dstns:engineVersion>${xml(engine?.version ?? "not reported")}</dstns:engineVersion>`,
      `<dstns:engineChannel>${xml(engine?.channel ?? "not reported")}</dstns:engineChannel>`,
      `<dstns:engineType>${xml(engine?.type ?? "not reported")}</dstns:engineType>`,
      `<dstns:interface>${xml(input.uiVersion)}</dstns:interface>`,
      `<dstns:api>${xml(status.api_version)}</dstns:api>`,
      `<dstns:mapSelection>${xml(topology.map_selection_version)}</dstns:mapSelection>`,
      `<dstns:junctions>${net.nodes}</dstns:junctions>`,
      `<dstns:roadKilometres>${net.km.toFixed(2)}</dstns:roadKilometres>`,
    ].join(""),
    "http://purl.org/dc/elements/1.1/",
  );
  onProgress?.("Finishing", 1);
  return { pdf, doc, pages };
}

/**
 * Collect what only the page can reach, then build the report on a worker, so that the interface
 * goes on moving while it is put together. Hands back the finished file for the page to save.
 */
export async function exportReport(input: ReportInput, onProgress: (label: string, share: number) => void = () => {}): Promise<{ blob: Blob; name: string }> {
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
  const platform = [
    `Platform: ${navigator.platform || "Not reported"}`,
    `Language: ${navigator.language}`,
    `Viewport: ${window.innerWidth} × ${window.innerHeight} at ${window.devicePixelRatio}× pixel ratio`,
    `Logical processors: ${navigator.hardwareConcurrency || "Not reported"}`,
  ];
  const resources: ReportResources = { font: btoa(binary), logoLight, logoDark, coreVersion, platform };
  const name = `DSTNS-report-${input.status.run_id}-${input.snapshot.clock.virtual_day_seconds}.pdf`;
  const offThread = () =>
    new Promise<Blob>((resolve, reject) => {
      const worker = new Worker(new URL("./reportWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }) => {
        if (data.type === "progress") onProgress(data.label, data.share);
        else {
          worker.terminate();
          if (data.type === "done") resolve(new Blob([data.bytes], { type: "application/pdf" }));
          else reject(new Error(data.message));
        }
      };
      worker.onerror = (event) => {
        worker.terminate();
        reject(new Error(event.message));
      };
      worker.postMessage({ input, resources });
    });
  // Whatever happens, it says so: a report that silently never arrives looks like a frozen button.
  const watchdog = <T,>(work: Promise<T>) =>
    Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The report took too long to put together.")), 90000))]);
  try {
    return { blob: await watchdog(offThread()), name };
  } catch {
    // Without a worker it can still be done here, at the cost of a pause.
    const [map, cover] = await Promise.all([printMap(input.topology, input.snapshot.data, input.layers).catch(() => null), coverMap(input.topology, input.snapshot.data, input.snapshot.clock.virtual_day_seconds).catch(() => null)]);
    const { pdf } = await buildReport(input, { ...resources, map, cover }, onProgress);
    return { blob: pdf.output("blob"), name };
  }
}

export type { Column, Series };
