import { useMemo, useRef, useState } from "react";
import { Floating, useDismiss } from "./Popover";
import { Tooltip } from "./Tooltip";
import { demandColor } from "./mapModel";
import { demandDetail, demandSummary, placeCensus, placeLegend } from "./placeLegend";
import type { PlaceLegendEntry } from "./placeLegend";
import type { DemandState, MapFeature } from "./types";

/** Road states in the order they worsen, matching the map's colours. */
export const ROAD_STATES = [
  { id: "clear", label: "Clear", color: "var(--state-clear)", hint: "Below 35% congestion." },
  { id: "moderate", label: "Moderate", color: "var(--state-moderate)", hint: "35% to 70% congestion." },
  { id: "severe", label: "Severe", color: "var(--state-severe)", hint: "70% congestion or more, or closed." },
  { id: "flooded", label: "Flooded", color: "var(--state-flooded)", hint: "Standing water on the road." },
] as const;

function RoadRows() {
  return (
    <>
      {ROAD_STATES.map((s) => (
        <span key={s.id} className="legend-item" title={s.hint}>
          <i className="legend-swatch" style={{ background: s.color }} aria-hidden="true" />
          {s.label}
        </span>
      ))}
    </>
  );
}

/**
 * Road state legend. Inline where the lower HUD has room; a compact button
 * with the same swatches and a popover where it does not. Which of the two is
 * visible is decided by the HUD's container width in CSS.
 */
export function RoadLegend() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [trigger, panel]);
  return (
    <div className="legend-road" data-tutorial="legend">
      <div className="hud-pill legend-inline" role="list" aria-label="Road state legend" data-tip-avoid>
        <span className="legend-heading" aria-hidden="true">
          Roads
        </span>
        {ROAD_STATES.map((s) => (
          <span key={s.id} className="legend-item" role="listitem">
            <i className="legend-swatch" style={{ background: s.color }} aria-hidden="true" />
            {s.label}
          </span>
        ))}
      </div>
      <button
        ref={trigger}
        type="button"
        className={`hud-pill hud-button legend-compact${open ? " active" : ""}`}
        aria-expanded={open}
        aria-label="Road state legend"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="legend-swatches" aria-hidden="true">
          {ROAD_STATES.map((s) => (
            <i key={s.id} style={{ background: s.color }} />
          ))}
        </span>
        Roads
      </button>
      <Floating anchor={trigger} open={open} className="legend-popover" panelRef={panel} label="Road state legend">
        <span className="floating-title">Road state</span>
        <div className="legend-list">
          <RoadRows />
        </div>
      </Floating>
    </div>
  );
}

/** A marker glyph drawn as the map draws it. */
export function PlaceGlyph({ icon, tint }: { icon: string; tint?: string }) {
  return (
    <span className="place-glyph" style={tint ? { ["--tint" as string]: tint } : undefined} aria-hidden="true">
      {icon}
    </span>
  );
}

/** Peak demand as a bar from 1.00× (empty) to 2.00× (full). */
function DemandBar({ entry }: { entry: PlaceLegendEntry }) {
  if (entry.peak === null) return <span className="demand-bar none" aria-hidden="true" />;
  const t = Math.max(0, Math.min(1, entry.peak - 1));
  return (
    <span className="demand-bar" aria-hidden="true">
      <i style={{ transform: `scaleX(${t})`, background: demandColor(entry.peak) }} />
    </span>
  );
}

/**
 * Place legend: every marker glyph on the map, what it stands for, how many
 * there are and, where the core models it, current demand.
 */
export function PlaceLegend({
  features,
  demand,
  visible,
  showOther,
  onShowOther,
}: {
  features: readonly MapFeature[];
  demand: readonly DemandState[] | undefined;
  /** The Buildings layer is on, so markers are drawn at all. */
  visible: boolean;
  showOther: boolean;
  onShowOther: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [trigger, panel]);
  const census = useMemo(() => placeCensus(features), [features]);
  // Demand is only read while the legend is open, so ticks cost nothing when closed.
  const entries = useMemo(() => placeLegend(census, open ? demand : undefined, showOther), [census, demand, open, showOther]);
  const preview = census.entries.filter((e) => e.group === "place").slice(0, 4);
  const hiddenOther = census.entries.filter((e) => e.group === "other").reduce((n, e) => n + e.count, 0);

  return (
    <div className="legend-place">
      <Tooltip label="Place legend" detail={visible ? "What each marker stands for, with live demand." : "Buildings are hidden in Layers."}>
        <button
          ref={trigger}
          type="button"
          className={`hud-pill hud-button${open ? " active" : ""}${visible ? "" : " muted"}`}
          aria-expanded={open}
          aria-label="Place legend"
          data-tutorial="places"
          disabled={!census.entries.length}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="glyph-preview" aria-hidden="true">
            {preview.map((e) => (
              <PlaceGlyph key={e.id} icon={e.icon} />
            ))}
          </span>
          Places
        </button>
      </Tooltip>
      <Floating anchor={trigger} open={open} className="legend-popover places" panelRef={panel} label="Place legend">
        <div className="floating-head">
          <span className="floating-title">Places</span>
          <span className="floating-sub">Demand is the multiplier on base demand the core applies.</span>
        </div>
        {!visible && <p className="floating-note">Buildings are hidden in Layers. Markers return when the layer is on.</p>}
        <ul className="place-rows">
          {entries.map((e) => (
            <li key={e.id} className={e.group === "other" ? "other" : undefined}>
              <PlaceGlyph icon={e.icon} />
              <span className="place-name">{e.label}</span>
              <span className="place-count mono">{e.count.toLocaleString()}</span>
              <span className="place-demand" aria-label={demandDetail(e)} title={demandDetail(e)}>
                <DemandBar entry={e} />
                <span className="mono">{demandSummary(e)}</span>
              </span>
            </li>
          ))}
        </ul>
        {hiddenOther > 0 && (
          <div className="floating-foot">
            <span>
              Unclassified places <span className="mono">{hiddenOther.toLocaleString()}</span>
              <small>Benches, stops, rail lines and other untyped points.</small>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={showOther}
              aria-label="Show unclassified places"
              className={`switch${showOther ? " on" : ""}`}
              onClick={() => onShowOther(!showOther)}
            >
              <i aria-hidden="true" />
            </button>
          </div>
        )}
      </Floating>
    </div>
  );
}
