import reportFontUrl from "./assets/report-inter.ttf?url";
import type {
  Congestion,
  Envelope,
  News,
  Snapshot,
  Status,
  Topology,
} from "./types";
export async function exportReport(
  status: Envelope<Status>,
  snapshot: Envelope<Snapshot>,
  topology: Topology,
  congestion: Congestion,
  news: News[],
) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4" }),
    w = 210,
    h = 297;
  // Embed a local font so names and metric symbols survive PDF export offline.
  const fontResponse = await fetch(reportFontUrl);
  if (!fontResponse.ok)
    throw new Error("Report font unavailable. Reload and retry.");
  const fontBytes = new Uint8Array(await fontResponse.arrayBuffer());
  let fontBinary = "";
  for (const byte of fontBytes) fontBinary += String.fromCharCode(byte);
  pdf.addFileToVFS("Inter.ttf", btoa(fontBinary));
  pdf.addFont("Inter.ttf", "Inter", "normal");
  pdf.setFont("Inter", "normal");
  const safe = (s: string) => s;
  const text = (
    s: string,
    x: number,
    y: number,
    size = 10,
    color = "#d7e4f5",
  ) => {
    pdf.setFontSize(size);
    pdf.setTextColor(color);
    pdf.text(safe(s), x, y);
  };
  let page = 0;
  const sheet = (title: string) => {
    if (page) pdf.addPage();
    page++;
    pdf.setFillColor("#071420");
    pdf.rect(0, 0, w, h, "F");
    pdf.setFillColor("#14212d");
    pdf.roundedRect(12, 12, 186, 22, 3, 3, "F");
    text("DSTNS", 18, 23, 18, "#b2ebff");
    text("SIMULATION OBSERVATORY", 18, 29, 8);
    text(title, 14, 48, 19);
    text("DSTNS / " + status.run_id, 14, 286, 8, "#bbc9ce");
    text(String(page), 192, 286, 8);
  };
  const row = (label: string, value: string, y: number) => {
    text(label, 18, y, 9, "#bbc9ce");
    text(value, 75, y, 10);
  };
  sheet("Simulation report");
  row("Seed", status.global_seed, 61);
  row("Saved configuration", status.data.saved_seed_id || "Not saved", 70);
  row(
    "Day / status",
    `${status.data.day === 1 ? "Weekend" : "Weekday"} / ${status.data.lifecycle}`,
    79,
  );
  row("Virtual time", snapshot.clock.simulated_current_time, 88);
  row(
    "Playback duration",
    `${snapshot.clock.playback_duration_seconds} seconds at ${snapshot.clock.tick_rate}x`,
    97,
  );
  row("Map selection", topology.map_selection_version, 106);
  row(
    "Region",
    `${topology.bounds.min_lat.toFixed(4)}, ${topology.bounds.min_lon.toFixed(4)} to ${topology.bounds.max_lat.toFixed(4)}, ${topology.bounds.max_lon.toFixed(4)}`,
    115,
  );
  text("Congestion", 14, 132, 16);
  pdf.setFillColor("#14212d");
  pdf.roundedRect(14, 139, 182, 32, 3, 3, "F");
  text("CURRENT", 20, 148, 8);
  text("AVERAGE", 83, 148, 8);
  text("DELTA", 147, 148, 8);
  text(
    `${snapshot.data.congestion.current.toFixed(1)}%`,
    20,
    162,
    23,
    "#37d7ff",
  );
  text(
    `${snapshot.data.congestion.average.toFixed(1)}%`,
    83,
    162,
    23,
    "#93ffde",
  );
  text(
    `${snapshot.data.congestion.delta >= 0 ? "+" : ""}${snapshot.data.congestion.delta.toFixed(1)} pp`,
    147,
    162,
    18,
  );
  const history = congestion.history ?? [];
  const x = 22,
    y = 185,
    cw = 170,
    ch = 52;
  pdf.setDrawColor("#3c494d");
  pdf.rect(x, y, cw, ch);
  for (const [key, color] of [
    ["current", "#37d7ff"],
    ["average", "#93ffde"],
  ] as const) {
    pdf.setDrawColor(color);
    pdf.setLineWidth(0.5);
    for (let i = 1; i < history.length; i++) {
      const a = history[i - 1],
        b = history[i];
      pdf.line(
        x + (a.virtual_s / 86400) * cw,
        y + ch - (a[key] / 100) * ch,
        x + (b.virtual_s / 86400) * cw,
        y + ch - (b[key] / 100) * ch,
      );
    }
  }
  text("100%", 14, 183, 7);
  text("0%", 14, 241, 7);
  text("00:00", 22, 244, 8);
  text("24:00", 180, 244, 8);
  text("Current (cyan) / Average (mint)", 22, 253, 9);
  text(
    "Length x lanes weighted. Average: 15-minute virtual-time EMA.",
    14,
    264,
    9,
  );
  text(
    "Source: DSTNS aggregate traffic model. Snapshot revision " +
      snapshot.state_revision,
    14,
    272,
    8,
  );
  sheet("Geographic network");
  const canvases = Array.from(
    document.querySelectorAll<HTMLCanvasElement>(".map-canvas"),
  );
  if (canvases.length) {
    const merged = document.createElement("canvas");
    merged.width = canvases[0].width;
    merged.height = canvases[0].height;
    const ctx = merged.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#030f1b";
      ctx.fillRect(0, 0, merged.width, merged.height);
      for (const canvas of canvases) ctx.drawImage(canvas, 0, 0);
      const height = Math.min(155, (182 * merged.height) / merged.width);
      pdf.addImage(merged.toDataURL("image/png"), "PNG", 14, 59, 182, height);
    }
  }
  row(
    "Road directions",
    String(topology.edges.filter((e) => !e.synthetic_reverse).length),
    226,
  );
  row("Network nodes", String(topology.nodes.length), 235);
  row("Buildings / POIs", String(topology.features.length), 244);
  row("Signal controllers", String(snapshot.data.signals.length), 253);
  text(
    "Green: clear | Amber: moderate | Red: severe / blocked | Blue: flood",
    14,
    266,
    9,
  );
  text(
    "Map: OpenStreetMap contributors. Metric projection preserves proportions.",
    14,
    273,
    8,
  );
  sheet("Events and network effects");
  row(
    "Active weather regions",
    String(snapshot.data.active_weather.length),
    62,
  );
  row(
    "Flood-affected roads",
    String(snapshot.data.edges.filter((e) => e.flood > 0.01).length),
    71,
  );
  row(
    "Active incident effects",
    String(snapshot.data.active_incidents.length),
    80,
  );
  row(
    "Demand increases",
    String(snapshot.data.demand.filter((d) => d.active).length),
    89,
  );
  row(
    "Modelled vehicles",
    String(snapshot.data.edges.reduce((sum, e) => sum + e.vehicle_count, 0)),
    98,
  );
  text("Recent important events", 14, 116, 15);
  let yy = 128;
  for (const n of news.slice(0, 9)) {
    const lines = pdf.splitTextToSize(
      safe(n.message.replace(/^\[.*?\]\s*/, "")),
      151,
    );
    if (yy + lines.length * 4 > 269) break;
    text(n.simulated_current_time, 14, yy, 8, "#37d7ff");
    pdf.setTextColor("#d7e4f5");
    pdf.setFontSize(9);
    pdf.text(lines, 42, yy);
    yy += lines.length * 4 + 7;
  }
  if (!news.length)
    text("No events recorded at this observation time.", 14, 130, 10);
  try {
    const logo = await fetch("/media/logo.png");
    if (logo.ok && logo.headers.get("content-type")?.includes("image")) {
      const blob = await logo.blob();
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
      for (let i = 1; i <= page; i++) {
        pdf.setPage(i);
        pdf.addImage(data, "PNG", 170, 17, 20, 12);
      }
    }
  } catch {
    /* Optional branding never blocks export. */
  }
  pdf.setProperties({
    title: "DSTNS Simulation Report",
    subject: `Seed ${status.global_seed}`,
    creator: "DSTNS",
  });
  pdf.save(`DSTNS-${status.run_id}-${snapshot.clock.virtual_day_seconds}.pdf`);
}
