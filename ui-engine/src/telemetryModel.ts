import type { Snapshot, Topology, WeatherState } from "./types";

/**
 * Figures shared by the full telemetry panel and its collapsed strip, so the
 * two can never disagree.
 */

export type WeatherLevel = "clear" | "light" | "moderate" | "heavy";

export interface WeatherSummary {
  level: WeatherLevel;
  /** "Clear", "Light rain", "Moderate rain", "Heavy rain". */
  label: string;
  /** Active rain cells. */
  cells: number;
  /** Highest normalised intensity (0 to 1) across the active cells. */
  peak: number;
  /** Indicative rate at the peak, as the deck has always shown it. */
  rate: string;
  /** 0 to 3 filled bars for the compact indicator. */
  bars: number;
}

/**
 * Current weather from the core's rain cells.
 *
 * Each cell carries a normalised intensity. Cells can overlap, and the core
 * does not sum them, so the headline is the strongest cell together with how
 * many are active; that is the rule the full deck already applies.
 */
export function weatherSummary(weather: readonly WeatherState[] | undefined): WeatherSummary {
  const cells = weather?.length ?? 0;
  if (!cells) return { level: "clear", label: "Clear", cells: 0, peak: 0, rate: "No active cells", bars: 0 };
  const peak = weather!.reduce((m, w) => Math.max(m, w.intensity), 0);
  const level: WeatherLevel = peak > 0.6 ? "heavy" : peak > 0.3 ? "moderate" : "light";
  const label = level === "heavy" ? "Heavy rain" : level === "moderate" ? "Moderate rain" : "Light rain";
  // Intensity is a normalised 0 to 1 field; shown as an indicative rate.
  return { level, label, cells, peak, rate: `${(peak * 8).toFixed(1)} mm/h`, bars: level === "heavy" ? 3 : level === "moderate" ? 2 : 1 };
}

export interface NetworkFigures {
  edges: number;
  vehicles: number;
  halting: number;
  flowingEdges: number;
  incidents: number;
  closed: number;
  congestion: number;
}

export function networkFigures(snapshot: Snapshot | null, topology: Topology | null): NetworkFigures {
  let vehicles = 0;
  let halting = 0;
  let flowingEdges = 0;
  for (const e of snapshot?.edges ?? []) {
    vehicles += e.vehicle_count;
    halting += e.halting_count;
    if (e.vehicle_count > 0) flowingEdges += 1;
  }
  const incidents = snapshot?.active_incidents ?? [];
  return {
    edges: topology?.edges.length ?? 0,
    vehicles,
    halting,
    flowingEdges,
    incidents: incidents.length,
    closed: incidents.filter((i) => i.closed).length,
    congestion: snapshot?.congestion.current ?? 0,
  };
}
