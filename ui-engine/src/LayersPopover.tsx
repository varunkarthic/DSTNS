// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useScrollFade } from "./scrollFade";
import { useEffect, useMemo, useRef } from "react";
import { hasMarker, placeKind } from "./mapModel";
import type { KeyboardEvent } from "react";
import { Icon } from "./Icons";
import type { IconName } from "./Icons";
import type { Layers, Snapshot, Topology } from "./types";
import { FIELD_OVERLAYS } from "./fields";
import type { FieldOverlay } from "./fields";

/**
 * The Layers panel. Toggling a layer changes what the map draws and nothing
 * else: no layer state is sent to the simulation core.
 */
type Props = {
  layers: Layers;
  /** The operator's configured defaults, which Reset returns to. */
  defaults: Layers;
  onChange: (layers: Layers) => void;
  onClose: () => void;
  topology: Topology | null;
  snapshot: Snapshot | null;
  /** The one continuous field shown, if any; fields never stack. */
  overlay?: FieldOverlay;
  onOverlay?: (overlay: FieldOverlay) => void;
  /** Fields this world provides; the rest are listed but unavailable. */
  availableFields?: string[];
};

const FIELD_ICONS: Record<FieldOverlay, IconName> = {
  none: "off",
  elevation: "mountain",
  wind: "wind",
  solar: "sun",
  temperature: "thermometer",
  flood: "flood",
};

type Item = { key: keyof Layers; label: string; icon: IconName; count?: string };

export function LayersPopover({ layers, defaults, onChange, onClose, topology, snapshot, overlay = "none", onOverlay, availableFields = [] }: Props) {
  const scroll = useScrollFade<HTMLDivElement>();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target instanceof Element && target.closest("[data-layers-trigger]")) return;
      if (target && !panel.current?.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    panel.current?.querySelector<HTMLElement>("[role='switch']")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const vehicles = snapshot?.edges.reduce((sum, e) => sum + e.vehicle_count, 0) ?? 0;
  // Places with no DSTNS type, which the map draws as plain dots.
  const otherPlaces = useMemo(
    () => topology?.features.filter((f) => hasMarker(f) && placeKind(f).group === "other").length ?? 0,
    [topology],
  );
  const noData = !topology;

  const groups: { title: string; items: Item[] }[] = [
    {
      title: "Network",
      items: [
        { key: "roads", label: "Roads", icon: "road" },
        { key: "traffic", label: "Traffic", icon: "traffic" },
        { key: "vehicles", label: "Flow markers", icon: "pulse", count: vehicles ? vehicles.toLocaleString() : undefined },
        { key: "signals", label: "Signals", icon: "signal", count: snapshot ? String(snapshot.signals.length) : undefined },
      ],
    },
    {
      title: "Places",
      items: [
        { key: "buildings", label: "Buildings and places", icon: "building", count: topology ? topology.features.length.toLocaleString() : undefined },
        { key: "other_places", label: "Unclassified places", icon: "pin", count: otherPlaces ? otherPlaces.toLocaleString() : undefined },
        { key: "place_names", label: "Place names", icon: "label" },
        { key: "labels", label: "Street names", icon: "label" },
      ],
    },
    {
      title: "Environment and events",
      items: [
        { key: "weather", label: "Weather", icon: "rain", count: snapshot ? String(snapshot.active_weather.length) : undefined },
        { key: "flooding", label: "Flooding", icon: "flood" },
        { key: "drains", label: "Drains (synthetic)", icon: "network" },
        { key: "incidents", label: "Incidents", icon: "incident", count: snapshot ? String(snapshot.active_incidents.length) : undefined },
        { key: "events", label: "Demand", icon: "demand" },
      ],
    },
  ];

  const navigate = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const switches = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("[role='switch']") ?? []);
    const i = switches.indexOf(document.activeElement as HTMLButtonElement);
    const next = switches[(i + (e.key === "ArrowDown" ? 1 : -1) + switches.length) % switches.length];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <div ref={panel} className="layers-panel" role="dialog" aria-label="Layers" onKeyDown={navigate} data-tip-avoid>
      <header>
        <span className="layers-title">Layers</span>
        <div className="layers-actions">
          <button type="button" className="text-button" onClick={() => onChange(Object.fromEntries(Object.keys(layers).map((k) => [k, true])) as unknown as Layers)}>
            All on
          </button>
          <button type="button" className="text-button muted" onClick={() => onChange({ ...defaults })}>
            Reset
          </button>
        </div>
      </header>
      {noData && <p className="layers-empty">Layers apply once a map is loaded.</p>}
      <div {...scroll} className={`layers-scroll ${scroll.className}`} tabIndex={0} aria-label="Display layers">
      {onOverlay && (
        <div className="layer-group" role="radiogroup" aria-label="Field overlay">
          <span className="layer-group-title">Field overlay · one at a time</span>
          {[{ id: "none" as FieldOverlay, label: "None", field: "", description: "No continuous field" }, ...FIELD_OVERLAYS].map((f) => {
            const available = f.id === "none" || availableFields.includes(f.field);
            const checked = overlay === f.id;
            return (
              <div className={`layer-row radio${checked ? " on" : ""}${available ? "" : " unavailable"}`} key={f.id}>
                <Icon name={FIELD_ICONS[f.id]} size={16} />
                <span className="layer-name">
                  {f.label}
                  {!available && <small>Not simulated in this world</small>}
                </span>
                <button
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={f.label}
                  disabled={!available}
                  className={`switch${checked ? " on" : ""}`}
                  onClick={() => onOverlay(f.id)}
                >
                  <i aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {groups.map((group) => (
        <div className="layer-group" key={group.title} role="group" aria-label={group.title}>
          <span className="layer-group-title">{group.title}</span>
          {group.items.map((item) => (
            <div className={`layer-row${layers[item.key] ? " on" : ""}`} key={item.key}>
              <Icon name={item.icon} size={16} />
              <span className="layer-name">{item.label}</span>
              {item.count !== undefined && <span className="layer-count mono">{item.count}</span>}
              <button
                type="button"
                role="switch"
                aria-checked={layers[item.key]}
                aria-label={item.label}
                className={`switch${layers[item.key] ? " on" : ""}`}
                onClick={() => onChange({ ...layers, [item.key]: !layers[item.key] })}
              >
                <i aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ))}
      </div>
      <p className="layers-note">Layers change what is drawn, never what the simulation computes. One field overlay shows at a time.</p>
    </div>
  );
}
