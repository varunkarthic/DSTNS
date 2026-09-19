import reportFontUrl from "./assets/report-inter.ttf?url";
import { placeKind, roadState, roadTitle } from "./mapModel";
import type {
  Backpressure,
  Congestion,
  Envelope,
  News,
  Snapshot,
  Status,
  Topology,
} from "./types";

/**
 * Printable observation report.
 *
 * Generated locally from state the observer already holds - nothing is fetched
 * from a service and nothing is invented. Every figure on the page is either
 * read from a snapshot or derived from one, and the provenance of the map and
 * the model is stated rather than implied.
 *
 * The layout follows one grid and one type scale across all four pages, so the
 * document reads as a single artefact rather than four screens pasted together.
 */

/** Page geometry, in millimetres. One source for every position on the page. */
const PAGE = { w: 210, h: 297, margin: 14, gutter: 6 } as const;
const COL = PAGE.w - PAGE.margin * 2;

const INK = {
  bg: "#071420",
  panel: "#101d29",
  panelEdge: "#233442",
  text: "#d7e4f5",
  dim: "#93a6b4",
  faint: "#5f7280",
  accent: "#37d7ff",
  mint: "#93ffde",
  amber: "#ffb938",
  red: "#ff5b65",
  blue: "#4ba9ff",
} as const;

export async function exportReport(
  status: Envelope<Status>,
  snapshot: Envelope<Snapshot>,
  topology: Topology,
  congestion: Congestion,
  news: News[],
  asb?: Backpressure | null,
) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4" });

  // Embed a local font so names and symbols survive export with no network.
  const fontResponse = await fetch(reportFontUrl);
  if (!fontResponse.ok) throw new Error("Report font unavailable. Reload and retry.");
  const fontBytes = new Uint8Array(await fontResponse.arrayBuffer());
  let fontBinary = "";
  for (const byte of fontBytes) fontBinary += String.fromCharCode(byte);
  pdf.addFileToVFS("Inter.ttf", btoa(fontBinary));
  pdf.addFont("Inter.ttf", "Inter", "normal");
  pdf.setFont("Inter", "normal");

  // ---- Primitives -------------------------------------------------------
  const text = (s: string, x: number, y: number, size = 9.5, color: string = INK.text) => {
    pdf.setFontSize(size);
    pdf.setTextColor(color);
    pdf.text(s, x, y);
  };
  const right = (s: string, x: number, y: number, size = 9.5, color: string = INK.text) => {
    pdf.setFontSize(size);
    pdf.setTextColor(color);
    pdf.text(s, x, y, { align: "right" });
  };
  const rule = (y: number, from = PAGE.margin, to = PAGE.w - PAGE.margin) => {
    pdf.setDrawColor(INK.panelEdge);
    pdf.setLineWidth(0.2);
    pdf.line(from, y, to, y);
  };
  const panel = (x: number, y: number, w: number, h: number) => {
    pdf.setFillColor(INK.panel);
    pdf.roundedRect(x, y, w, h, 2, 2, "F");
  };

  /** The DSTNS mark, drawn as vectors so the report needs no image asset. */
  const mark = (cx: number, cy: number, r: number) => {
    pdf.setDrawColor(INK.accent);
    pdf.setLineWidth(r * 0.09);
    pdf.circle(cx, cy, r, "S");
    pdf.setLineWidth(r * 0.16);
    const inner = r * 0.34;
    const outer = r * 0.82;
    pdf.line(cx, cy - outer, cx, cy - inner);
    pdf.line(cx, cy + inner, cx, cy + outer);
    pdf.line(cx - outer, cy, cx - inner, cy);
    pdf.line(cx + inner, cy, cx + outer, cy);
    pdf.setFillColor(INK.bg);
    pdf.setDrawColor(INK.accent);
    pdf.setLineWidth(r * 0.12);
    pdf.roundedRect(cx - inner, cy - inner, inner * 2, inner * 2, r * 0.1, r * 0.1, "FD");
    pdf.setFillColor(INK.accent);
    pdf.circle(cx, cy, r * 0.13, "F");
  };

  let page = 0;
  const sheet = (title: string, kicker: string) => {
    if (page) pdf.addPage();
    page++;
    pdf.setFillColor(INK.bg);
    pdf.rect(0, 0, PAGE.w, PAGE.h, "F");

    mark(PAGE.margin + 6, 20, 6);
    text("DSTNS", PAGE.margin + 16, 18, 13, INK.text);
    text("Deterministic Spatiotemporal Transport Network Simulator", PAGE.margin + 16, 23.5, 6.5, INK.faint);
    right(status.run_id, PAGE.w - PAGE.margin, 18, 7, INK.dim);
    right(snapshot.clock.simulated_current_time + " virtual", PAGE.w - PAGE.margin, 23, 7, INK.faint);
    rule(28);

    text(kicker.toUpperCase(), PAGE.margin, 40, 6.5, INK.accent);
    text(title, PAGE.margin, 49, 17, INK.text);

    // Footer, identical on every page.
    rule(PAGE.h - 14);
    text("Observation report · generated locally", PAGE.margin, PAGE.h - 9, 6.5, INK.faint);
    right(`${page}`, PAGE.w - PAGE.margin, PAGE.h - 9, 7, INK.dim);
  };

  /** Label/value row on the document's single left-aligned grid. */
  const row = (label: string, value: string, y: number) => {
    text(label, PAGE.margin + 4, y, 8, INK.dim);
    text(value, PAGE.margin + 62, y, 9, INK.text);
  };

  /** A titled statistic tile. */
  const tile = (x: number, y: number, w: number, label: string, value: string, note = "", color: string = INK.text) => {
    panel(x, y, w, 24);
    text(label.toUpperCase(), x + 5, y + 7.5, 6.2, INK.faint);
    text(value, x + 5, y + 17, 15, color);
    if (note) right(note, x + w - 5, y + 17, 7, INK.dim);
  };

  const sectionTitle = (s: string, y: number) => {
    text(s, PAGE.margin, y, 12, INK.text);
    rule(y + 2.5);
  };

  // ---- Derived figures ---------------------------------------------------
  const realEdges = topology.edges.filter((e) => !e.synthetic_reverse);
  const stateById = new Map(snapshot.data.edges.map((e) => [e.id, e]));
  const vehicles = snapshot.data.edges.reduce((s, e) => s + e.vehicle_count, 0);
  const halting = snapshot.data.edges.reduce((s, e) => s + e.halting_count, 0);

  const byState = { clear: 0, moderate: 0, severe: 0, blocked: 0, flooded: 0 };
  for (const e of realEdges) {
    const key = roadState(stateById.get(e.id)) as keyof typeof byState;
    if (key in byState) byState[key] += 1;
  }

  const byClass = new Map<string, { count: number; km: number }>();
  for (const e of realEdges) {
    const entry = byClass.get(e.road_class) ?? { count: 0, km: 0 };
    entry.count += 1;
    entry.km += e.length_m / 1000;
    byClass.set(e.road_class, entry);
  }
  const networkKm = realEdges.reduce((s, e) => s + e.length_m, 0) / 1000;

  const byPlace = new Map<string, number>();
  for (const f of topology.features) {
    const label = placeKind(f).label;
    byPlace.set(label, (byPlace.get(label) ?? 0) + 1);
  }

  // "Most congested" means roads actually carrying traffic. A closed or flooded
  // road scores 1.0 with nothing on it, which is a closure, not congestion, and
  // is reported separately in the road-state tiles above.
  const worst = [...realEdges]
    .map((e) => ({ edge: e, state: stateById.get(e.id) }))
    .filter((r) => r.state && r.state.vehicle_count > 0 && r.state.congestion > 0)
    .sort(
      (a, b) =>
        (b.state!.congestion ?? 0) - (a.state!.congestion ?? 0) ||
        (b.state!.vehicle_count ?? 0) - (a.state!.vehicle_count ?? 0),
    )
    .slice(0, 10);
  const closedCount = realEdges.filter((e) => {
    const st = stateById.get(e.id);
    return st && (st.closed || st.incident_closed);
  }).length;

  // =======================================================================
  // 1 — Run
  // =======================================================================
  sheet("Run and provenance", "Section one");

  panel(PAGE.margin, 56, COL, 62);
  row("Seed", status.global_seed, 65);
  row("Saved configuration", status.data.saved_seed_id || "Not saved", 73);
  row("Day type / lifecycle", `${status.data.day === 1 ? "Weekend" : "Weekday"} · ${status.data.lifecycle}`, 81);
  row("Virtual time", snapshot.clock.simulated_current_time, 89);
  row("Playback", `${snapshot.clock.playback_duration_seconds}s per day at ${snapshot.clock.tick_rate}×`, 97);
  row("Graph hash", topology.graph_hash.replace(/^sha256:/, "").slice(0, 32), 105);
  row("Map selection", topology.map_selection_version, 113);

  sectionTitle("Where this is", 132);
  panel(PAGE.margin, 137, COL, 40);
  if (topology.location?.city) {
    row("City", `${topology.location.city}, ${topology.location.country}`, 146);
    row(
      "Seed-derived anchor",
      `${Math.abs(topology.location.anchor_lat).toFixed(4)}° ${topology.location.anchor_lat >= 0 ? "N" : "S"}, ` +
        `${Math.abs(topology.location.anchor_lon).toFixed(4)}° ${topology.location.anchor_lon >= 0 ? "E" : "W"}`,
      154,
    );
    row("City extract", `${(topology.location.city_extent_m / 1000).toFixed(1)} km square`, 162);
    row("Obtained", topology.location.downloaded ? "Downloaded this run" : "Reused from cache", 170);
  } else {
    row("Source", "Explicit map file (no seed-derived location)", 146);
    row(
      "Bounds",
      `${topology.bounds.min_lat.toFixed(4)}, ${topology.bounds.min_lon.toFixed(4)} → ` +
        `${topology.bounds.max_lat.toFixed(4)}, ${topology.bounds.max_lon.toFixed(4)}`,
      154,
    );
  }

  sectionTitle("Network", 192);
  const tw = (COL - PAGE.gutter * 2) / 3;
  tile(PAGE.margin, 197, tw, "Junctions", topology.nodes.length.toLocaleString());
  tile(PAGE.margin + tw + PAGE.gutter, 197, tw, "Road directions", realEdges.length.toLocaleString());
  tile(PAGE.margin + (tw + PAGE.gutter) * 2, 197, tw, "Network length", `${networkKm.toFixed(1)} km`);
  tile(PAGE.margin, 197 + 30, tw, "Places", topology.features.length.toLocaleString());
  tile(PAGE.margin + tw + PAGE.gutter, 197 + 30, tw, "Signals", snapshot.data.signals.length.toLocaleString());
  tile(
    PAGE.margin + (tw + PAGE.gutter) * 2,
    197 + 30,
    tw,
    "Vehicles",
    vehicles.toLocaleString(),
    `${halting.toLocaleString()} halting`,
    INK.accent,
  );

  text(
    "Positions and lengths are true metres from the projection origin; the map's on-screen scale is a display concern only.",
    PAGE.margin,
    PAGE.h - 22,
    7,
    INK.faint,
  );

  // =======================================================================
  // 2 — Congestion
  // =======================================================================
  sheet("Congestion", "Section two");

  const tw2 = (COL - PAGE.gutter * 2) / 3;
  tile(PAGE.margin, 58, tw2, "Current", `${snapshot.data.congestion.current.toFixed(1)}%`, "", INK.accent);
  tile(PAGE.margin + tw2 + PAGE.gutter, 58, tw2, "Moving average", `${snapshot.data.congestion.average.toFixed(1)}%`, "", INK.mint);
  tile(
    PAGE.margin + (tw2 + PAGE.gutter) * 2,
    58,
    tw2,
    "Delta",
    `${snapshot.data.congestion.delta >= 0 ? "+" : ""}${snapshot.data.congestion.delta.toFixed(1)} pp`,
  );

  sectionTitle("Across the virtual day", 96);
  const history = congestion.history ?? [];
  const cx = PAGE.margin + 10;
  const cy = 104;
  const cw = COL - 14;
  const ch = 48;
  panel(PAGE.margin, cy - 4, COL, ch + 14);
  pdf.setDrawColor(INK.panelEdge);
  pdf.setLineWidth(0.15);
  for (const frac of [0, 0.5, 1]) pdf.line(cx, cy + ch * frac, cx + cw, cy + ch * frac);
  for (const [key, color] of [
    ["average", INK.mint],
    ["current", INK.accent],
  ] as const) {
    pdf.setDrawColor(color);
    pdf.setLineWidth(0.45);
    for (let i = 1; i < history.length; i++) {
      const a = history[i - 1];
      const b = history[i];
      pdf.line(
        cx + (a.virtual_s / 86400) * cw,
        cy + ch - (a[key] / 100) * ch,
        cx + (b.virtual_s / 86400) * cw,
        cy + ch - (b[key] / 100) * ch,
      );
    }
  }
  text("100%", PAGE.margin + 1, cy + 2, 6, INK.faint);
  text("0%", PAGE.margin + 1, cy + ch, 6, INK.faint);
  text("00:00", cx, cy + ch + 6, 6.5, INK.faint);
  right("24:00", cx + cw, cy + ch + 6, 6.5, INK.faint);
  text("Current (cyan) · 15-minute moving average (mint)", cx, cy + ch + 11, 7, INK.dim);

  sectionTitle("Road state", 176);
  let bx = PAGE.margin;
  const stateEntries: [string, number, string][] = [
    ["Clear", byState.clear, INK.mint],
    ["Moderate", byState.moderate, INK.amber],
    ["Severe", byState.severe + byState.blocked, INK.red],
    ["Flooded", byState.flooded, INK.blue],
  ];
  const sw = (COL - PAGE.gutter * 3) / 4;
  for (const [label, count, color] of stateEntries) {
    const share = realEdges.length ? (count / realEdges.length) * 100 : 0;
    tile(bx, 181, sw, label, `${share.toFixed(1)}%`, `${count}`, color);
    bx += sw + PAGE.gutter;
  }

  sectionTitle("Most congested roads", 216);
  let wy = 224;
  if (!worst.length)
    text(
      "No road is carrying congested traffic at this observation time.",
      PAGE.margin + 4,
      wy,
      9,
      INK.dim,
    );
  for (const { edge, state } of worst.slice(0, 8)) {
    text(roadTitle(edge), PAGE.margin + 4, wy, 8.5, INK.text);
    right(`${((state?.congestion ?? 0) * 100).toFixed(0)}%`, PAGE.margin + 120, wy, 8.5, INK.amber);
    right(`${((state?.mean_speed_mps ?? 0) * 3.6).toFixed(0)} km/h`, PAGE.margin + 150, wy, 8, INK.dim);
    right(`${state?.vehicle_count ?? 0} veh`, PAGE.w - PAGE.margin - 4, wy, 8, INK.dim);
    wy += 6.5;
  }

  text(
    `${closedCount} road direction${closedCount === 1 ? " is" : "s are"} closed by an incident or flooding and excluded from the ranking above.`,
    PAGE.margin,
    PAGE.h - 27,
    7,
    INK.faint,
  );
  text(
    "Speed loss (60%), queue ratio (25%) and occupancy (15%), weighted by length × lanes. Synthetic reverse directions excluded.",
    PAGE.margin,
    PAGE.h - 22,
    7,
    INK.faint,
  );

  // =======================================================================
  // 3 — Geography
  // =======================================================================
  sheet("Geographic network", "Section three");

  const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>(".map-canvas"));
  let mapBottom = 60;
  if (canvases.length) {
    const merged = document.createElement("canvas");
    merged.width = canvases[0].width;
    merged.height = canvases[0].height;
    const ctx = merged.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#030f1b";
      ctx.fillRect(0, 0, merged.width, merged.height);
      for (const canvas of canvases) ctx.drawImage(canvas, 0, 0);
      const height = Math.min(120, (COL * merged.height) / merged.width);
      pdf.addImage(merged.toDataURL("image/png"), "PNG", PAGE.margin, 58, COL, height);
      pdf.setDrawColor(INK.panelEdge);
      pdf.rect(PAGE.margin, 58, COL, height, "S");
      mapBottom = 58 + height;
    }
  }
  text(
    "Clear · Moderate · Severe or blocked · Flooded — as rendered at the moment of export, including the current viewport and layers.",
    PAGE.margin,
    mapBottom + 6,
    7,
    INK.faint,
  );

  sectionTitle("Road classes", mapBottom + 18);
  let ry = mapBottom + 26;
  const classes = [...byClass.entries()].sort((a, b) => b[1].km - a[1].km).slice(0, 7);
  for (const [name, entry] of classes) {
    text(name, PAGE.margin + 4, ry, 8.5, INK.text);
    right(`${entry.count}`, PAGE.margin + 110, ry, 8.5, INK.dim);
    right(`${entry.km.toFixed(1)} km`, PAGE.margin + 145, ry, 8.5, INK.text);
    // Proportional bar, so the mix is legible without reading the figures.
    const share = networkKm ? entry.km / networkKm : 0;
    pdf.setFillColor(INK.accent);
    pdf.rect(PAGE.margin + 150, ry - 2.6, Math.max(0.6, share * 30), 2.6, "F");
    ry += 6.5;
  }

  sectionTitle("Places", ry + 6);
  ry += 14;
  const places = [...byPlace.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [label, count] of places) {
    if (ry > PAGE.h - 26) break;
    text(label, PAGE.margin + 4, ry, 8.5, INK.text);
    right(count.toLocaleString(), PAGE.margin + 110, ry, 8.5, INK.dim);
    ry += 6.5;
  }

  text(
    "Map data © OpenStreetMap contributors, ODbL 1.0. Place kinds are normalised from raw OSM tags.",
    PAGE.margin,
    PAGE.h - 22,
    7,
    INK.faint,
  );

  // =======================================================================
  // 4 — Events, environment and runtime
  // =======================================================================
  sheet("Events and runtime", "Section four");

  const tw4 = (COL - PAGE.gutter * 3) / 4;
  tile(PAGE.margin, 58, tw4, "Weather cells", String(snapshot.data.active_weather.length));
  tile(PAGE.margin + tw4 + PAGE.gutter, 58, tw4, "Flooded roads", String(snapshot.data.edges.filter((e) => e.flood > 0.01).length), "", INK.blue);
  tile(PAGE.margin + (tw4 + PAGE.gutter) * 2, 58, tw4, "Incidents", String(snapshot.data.active_incidents.length), "", INK.red);
  tile(PAGE.margin + (tw4 + PAGE.gutter) * 3, 58, tw4, "Demand peaks", String(snapshot.data.demand.filter((d) => d.active).length), "", INK.amber);

  sectionTitle("Adaptive Simulation Backpressure", 92);
  // Four rows at 8mm pitch starting 9mm in, plus breathing room at the foot.
  panel(PAGE.margin, 97, COL, 40);
  if (asb) {
    row("State", asb.state, 106);
    row("Backpressure", `${(asb.score * 100).toFixed(0)}% (${asb.synced ? "in sync" : "out of sync"})`, 114);
    row(
      "Rate",
      asb.rate_capped
        ? `${asb.applied_tick_rate}× applied of ${asb.requested_tick_rate}× requested`
        : `${asb.applied_tick_rate}× (ungoverned)`,
      122,
    );
    row(
      "Throughput",
      `${asb.throughput.snapshots_per_s.toFixed(1)} snapshots/s · ${(asb.throughput.bytes_per_s / 1024 / 1024).toFixed(2)} MiB/s`,
      130,
    );
  } else {
    row("State", "Not reported", 106);
    text("Backpressure reporting was disabled or unavailable for this run.", PAGE.margin + 4, 116, 8, INK.dim);
  }

  sectionTitle("Recent events", 142);
  let ey = 151;
  for (const n of news.slice(0, 12)) {
    const lines = pdf.splitTextToSize(n.message.replace(/^\[.*?\]\s*/, ""), COL - 40);
    if (ey + lines.length * 4 > PAGE.h - 30) break;
    text(n.simulated_current_time, PAGE.margin + 4, ey, 7.5, INK.accent);
    pdf.setTextColor(INK.text);
    pdf.setFontSize(8.5);
    pdf.text(lines, PAGE.margin + 30, ey);
    ey += lines.length * 4 + 3.5;
  }
  if (!news.length) text("No events recorded at this observation time.", PAGE.margin + 4, ey, 9, INK.dim);

  // Provenance and licence, stated rather than implied.
  rule(PAGE.h - 30);
  text(
    "DSTNS aggregate traffic model. Vehicle markers are representative flow samples derived from modelled edge counts and speeds,",
    PAGE.margin,
    PAGE.h - 25,
    6.8,
    INK.faint,
  );
  text(
    "not individually tracked vehicles. © 2026 Varun Karthic · AGPL-3.0-or-later · Map data © OpenStreetMap contributors (ODbL).",
    PAGE.margin,
    PAGE.h - 21,
    6.8,
    INK.faint,
  );

  pdf.setProperties({
    title: "DSTNS Observation Report",
    subject: `Seed ${status.global_seed}`,
    author: "DSTNS",
    creator: "DSTNS " + (topology.map_selection_version ?? ""),
    keywords: "DSTNS, traffic simulation, OpenStreetMap, AGPL-3.0",
  });
  pdf.save(`DSTNS-${status.run_id}-${snapshot.clock.virtual_day_seconds}.pdf`);
}
