import { useMemo, useRef, useState } from "react";
import { Floating, useDismiss } from "./Popover";
import { Icon } from "./Icons";
import { Tooltip } from "./Tooltip";
import { demandColor } from "./mapModel";
import { glyphFor } from "./placeGlyphs";
import { useScrollFade } from "./scrollFade";
import { demandDetail, demandSummary, placeCensus, placeLegend } from "./placeLegend";
import type { PlaceLegendEntry } from "./placeLegend";
import type { DemandState, MapFeature, PlaceVisibility } from "./types";

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

/**
 * A marker glyph drawn as the map draws it.
 *
 * Both take their strokes from placeGlyphs, so a legend entry cannot end up
 * showing a shape the map does not draw. `kind` selects the glyph; `icon` is
 * the old single-letter fallback, kept for anything outside the taxonomy.
 */
export function PlaceGlyph({ kind, icon, tint }: { kind?: string; icon?: string; tint?: string }) {
  const strokes = kind ? glyphFor(kind) : null;
  return (
    <span className="place-glyph" style={tint ? { ["--tint" as string]: tint } : undefined} aria-hidden="true">
      {strokes ? (
        <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          {strokes.map((d: string) => (
            <path key={d} d={d} />
          ))}
        </svg>
      ) : (
        icon
      )}
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
  places,
  onTogglePlace,
  onResetPlaces,
}: {
  features: readonly MapFeature[];
  demand: readonly DemandState[] | undefined;
  /** The Buildings layer is on, so markers are drawn at all. */
  visible: boolean;
  showOther: boolean;
  onShowOther: (on: boolean) => void;
  /** Which kinds are drawn; a kind absent from this is drawn. */
  places: PlaceVisibility;
  onTogglePlace: (kind: string, on: boolean) => void;
  onResetPlaces: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [trigger, panel]);
  const rowScroll = useScrollFade<HTMLUListElement>();
  const census = useMemo(() => placeCensus(features), [features]);
  // Demand is only read while the legend is open, so ticks cost nothing when closed.
  const entries = useMemo(() => placeLegend(census, open ? demand : undefined, showOther), [census, demand, open, showOther]);
  const hiddenOther = census.entries.filter((e) => e.group === "other").reduce((n, e) => n + e.count, 0);

  return (
    <div className="legend-place">
      {/* The tooltip explains the control; once the legend is open it would
          only repeat what is already on screen. */}
      <Tooltip label="Place legend" detail={visible ? "What each marker stands for, with live demand." : "Buildings are hidden in Layers."} disabled={open}>
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
          <Icon name="pin" size={16} />
          <span>Places</span>
          <span className="legend-button-hint">Legend</span>
          <Icon name="chevronUp" size={12} />
        </button>
      </Tooltip>
      <Floating anchor={trigger} open={open} className="legend-popover places" panelRef={panel} label="Place legend">
        <div className="floating-head">
          <span className="floating-title">Places</span>
          <span className="floating-sub">Demand is the multiplier on base demand the core applies.</span>
        </div>
        {!visible && <p className="floating-note">Buildings are hidden in Layers. Markers return when the layer is on.</p>}
        <ul {...rowScroll} className={`place-rows ${rowScroll.className}`}>
          {entries.map((e) => {
            // A kind not named in the record is shown: new kinds appear the
            // day they are added rather than waiting for saved settings.
            const shown = places[e.id] !== false;
            return (
              <li key={e.id} className={`${e.group === "other" ? "other" : ""}${shown ? "" : " hidden-kind"}`.trim() || undefined}>
                <button
                  type="button"
                  className="place-toggle"
                  role="switch"
                  aria-checked={shown}
                  aria-label={`${e.label}, ${e.count.toLocaleString()} on the map`}
                  onClick={() => onTogglePlace(e.id, !shown)}
                >
                  <PlaceGlyph kind={e.id} icon={e.icon} />
                  <span className="place-name">{e.label}</span>
                  <span className="place-count mono">{e.count.toLocaleString()}</span>
                </button>
                <span className="place-demand" aria-label={demandDetail(e)} title={demandDetail(e)}>
                  <DemandBar entry={e} />
                  <span className="mono">{demandSummary(e)}</span>
                </span>
              </li>
            );
          })}
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
        <div className="floating-actions">
          <button type="button" className="btn ghost small" onClick={onResetPlaces}>
            <Icon name="reset" size={14} />
            Use Defaults
          </button>
        </div>
      </Floating>
    </div>
  );
}
