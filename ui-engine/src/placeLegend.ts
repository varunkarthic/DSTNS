import { DEMAND_TYPE_LABEL, PLACE_KINDS, UNCLASSIFIED, hasMarker, placeKind } from "./mapModel";
import type { DemandState, MapFeature } from "./types";

/**
 * The place legend.
 *
 * Built from the same taxonomy the map draws with and limited to the kinds
 * that actually carry a marker in the loaded district, so every glyph in the
 * legend can be found on the map and nothing on the map is missing from it.
 *
 * Demand is whatever the core reports: a per-place multiplier on base demand
 * (1.00× at rest) for places the core models, identified by `demand_type`.
 * Kinds with no modelled places say so rather than showing a figure.
 */

export interface PlaceLegendEntry {
  id: string;
  icon: string;
  label: string;
  group: "place" | "other";
  /** Places of this kind drawn with a marker. */
  count: number;
  /** Of those, how many the core models demand for. */
  modelled: number;
  /** Modelled places currently above their resting demand. */
  raised: number;
  /** Highest current multiplier among modelled places, 1 at rest. */
  peak: number | null;
  /** The core's demand types present in this kind, as display names. */
  demandTypes: string[];
}

export interface PlaceCensus {
  entries: Omit<PlaceLegendEntry, "raised" | "peak">[];
  /** feature id -> legend entry id, for modelled places only. */
  modelledKind: Map<string, string>;
}

const ORDER = new Map([...PLACE_KINDS.map((k, i) => [k.id, i] as const), [UNCLASSIFIED.id, PLACE_KINDS.length]]);

/**
 * The topology-dependent half of the legend: which kinds appear, how many of
 * each and which are demand-modelled. Computed once per topology.
 */
export function placeCensus(features: readonly MapFeature[]): PlaceCensus {
  const byKind = new Map<string, Omit<PlaceLegendEntry, "raised" | "peak"> & { types: Set<string> }>();
  const modelledKind = new Map<string, string>();
  for (const f of features) {
    if (!hasMarker(f)) continue;
    const kind = placeKind(f);
    let entry = byKind.get(kind.id);
    if (!entry) {
      entry = { id: kind.id, icon: kind.icon, label: kind.label, group: kind.group, count: 0, modelled: 0, demandTypes: [], types: new Set() };
      byKind.set(kind.id, entry);
    }
    entry.count += 1;
    if (f.demand_type) {
      entry.modelled += 1;
      entry.types.add(DEMAND_TYPE_LABEL[f.demand_type] ?? f.demand_type);
      modelledKind.set(f.id, kind.id);
    }
  }
  const entries = [...byKind.values()]
    .sort((a, b) => (ORDER.get(a.id) ?? 99) - (ORDER.get(b.id) ?? 99))
    .map(({ types, ...rest }) => ({ ...rest, demandTypes: [...types].sort() }));
  return { entries, modelledKind };
}

/**
 * The full legend for the current instant. `showOther` mirrors the
 * Unclassified places layer: when that layer is off its dots are not drawn,
 * so they are not listed.
 */
export function placeLegend(census: PlaceCensus, demand: readonly DemandState[] | undefined, showOther: boolean): PlaceLegendEntry[] {
  const raised = new Map<string, number>();
  const peak = new Map<string, number>();
  for (const d of demand ?? []) {
    const kind = census.modelledKind.get(d.feature_id);
    if (!kind) continue;
    if (d.active) raised.set(kind, (raised.get(kind) ?? 0) + 1);
    peak.set(kind, Math.max(peak.get(kind) ?? 1, d.multiplier));
  }
  return census.entries
    .filter((e) => showOther || e.group !== "other")
    .map((e) => ({ ...e, raised: raised.get(e.id) ?? 0, peak: e.modelled ? peak.get(e.id) ?? 1 : null }));
}

/** One short line describing a kind's demand, fixed in shape so it never reflows the legend. */
export function demandSummary(entry: Pick<PlaceLegendEntry, "modelled" | "raised" | "peak">): string {
  if (!entry.modelled || entry.peak === null) return "Not modelled";
  if (!entry.raised) return "At rest";
  return `Peak ${entry.peak.toFixed(2)}×`;
}

/** A longer, accessible description of the same, for tooltips and screen readers. */
export function demandDetail(entry: PlaceLegendEntry): string {
  if (!entry.modelled) return `${entry.count} on the map. The simulation does not model demand for this kind of place.`;
  const share = entry.modelled === entry.count ? `All ${entry.count}` : `${entry.modelled} of ${entry.count}`;
  const types = entry.demandTypes.join(", ");
  const now = entry.raised
    ? `${entry.raised} currently raised, highest ${entry.peak!.toFixed(2)}× base demand.`
    : "All at base demand (1.00×).";
  return `${share} have modelled ${types.toLowerCase()} demand. ${now}`;
}
