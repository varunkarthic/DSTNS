// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useScrollFade } from "./scrollFade";
import { FluidPanel } from "./FluidPanel";
import { PlaceGlyph } from "./Legends";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Icon, ActionIcon, MotionIcon } from "./Icons";
import { Tooltip } from "./Tooltip";
import type { AutoFocusStrategy } from "./uiConfig";
import type { MapFeature } from "./types";
import { placeKind, placeTitle, popularPlaces, searchPlaces } from "./mapModel";

/**
 * The left sidebar: zoom, fit, place search, Auto Focus, Do Not Disturb,
 * reduced motion and Settings.
 *
 * Search is an icon that expands into a field beside the dock, so the map
 * keeps its full width until a place is actually being looked up. Auto Focus
 * toggles on a single click; a double click opens its order menu beside it.
 */

export interface MapDockProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;

  autoFocus: boolean;
  autoFocusAvailable: boolean;
  strategy: AutoFocusStrategy;
  onToggleAutoFocus: () => void;
  onStrategy: (strategy: AutoFocusStrategy) => void;

  dnd: boolean;
  onToggleDnd: () => void;

  reduceMotion: boolean;
  motionLocked: boolean;
  onToggleMotion: () => void;

  settingsOpen: boolean;
  onToggleSettings: () => void;

  features: MapFeature[];
  city?: string;
  onPickPlace: (feature: MapFeature) => void;

  disabled?: boolean;
  /** Controls contributed by applications. */
  extra?: ReactNode;
}

/** The match within a name, marked. */
function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

function PlaceSearch({ open, features, city, onClose, onPick }: { open: boolean; features: MapFeature[]; city?: string; onClose: () => void; onPick: (feature: MapFeature) => void }) {
  const scroll = useScrollFade<HTMLUListElement>();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const needle = query.trim();
  const popular = useMemo(() => popularPlaces(features), [features]);
  const results = useMemo(() => (needle ? searchPlaces(features, needle) : popular), [features, needle, popular]);
  useEffect(() => setActive(0), [needle]);
  useEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
    else setQuery("");
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  const onKeys = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((i) => Math.min(results.length - 1, i + 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (e.key === "Enter" && results[active]) onPick(results[active]);
    else return;
    e.preventDefault();
  };
  return (
    <div className="place-finder">
      <label className="place-search-field">
        <Icon name="search" size={16} />
        <input ref={input} type="search" aria-label="Search places" placeholder={city ? `Search ${city}` : "Search places"} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeys} />
        {query && (
          <button type="button" className="icon-btn small" aria-label="Clear search" onClick={() => { setQuery(""); input.current?.focus({ preventScroll: true }); }}>
            <Icon name="close" size={14} />
          </button>
        )}
      </label>
      <p className="place-search-heading">{needle ? (results.length ? `${results.length === 24 ? "24+" : results.length} ${results.length === 1 ? "place" : "places"}` : "") : popular.length ? `Popular${city ? ` in ${city}` : " in this district"}` : ""}</p>
      {results.length > 0 && (
        <ul {...scroll} className={`place-search-results ${scroll.className}`} aria-label={needle ? "Matching places" : "Popular places"}>
          {results.map((feature, index) => (
            <li key={feature.id}>
              <button type="button" className={index === active ? "active" : ""} onPointerEnter={() => setActive(index)} onClick={() => onPick(feature)}>
                <PlaceGlyph kind={placeKind(feature).id} />
                <span className="place-search-text">
                  <strong><Highlight text={placeTitle(feature)} query={needle} /></strong>
                  <small>{placeKind(feature).label}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {needle && results.length === 0 && (
        <p className="place-search-empty">
          <Icon name="pin" size={18} />
          No place here matches “{needle}”.
        </p>
      )}
      {!needle && features.length === 0 && <p className="place-search-empty">No named places in this district.</p>}
    </div>
  );
}

export function MapDock(props: MapDockProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  // Tell a double click from two singles without delaying the toggle much.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // One secondary panel at a time.
  useEffect(() => {
    if (props.settingsOpen) setSearchOpen(false);
  }, [props.settingsOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!dockRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => () => clearTimeout(clickTimer.current), []);

  return (
    <>
    <nav className="map-dock" ref={dockRef} aria-label="Map tools" data-tutorial="zoom">
      <Tooltip label="Zoom in" side={["right"]}>
        <button aria-label="Zoom in" onClick={props.onZoomIn} disabled={props.disabled}>
          <Icon name="plus" size={18} />
        </button>
      </Tooltip>
      <Tooltip label="Zoom out" side={["right"]}>
        <button aria-label="Zoom out" onClick={props.onZoomOut} disabled={props.disabled}>
          <Icon name="minus" size={18} />
        </button>
      </Tooltip>
      <Tooltip label="Fit network" side={["right"]}>
        <button aria-label="Fit network to viewport" onClick={props.onFit} disabled={props.disabled}>
          <Icon name="fit" size={18} />
        </button>
      </Tooltip>

      <div className="divider" aria-hidden="true" />

      <Tooltip label="Search places" side={["right"]}>
        <button
          data-tutorial="search"
          data-search-trigger
          aria-label="Search places"
          aria-expanded={searchOpen}
          className={searchOpen ? "active" : ""}
          onClick={() => {
            setSearchOpen((v) => !v);
            setMenuOpen(false);
            if (props.settingsOpen) props.onToggleSettings();
          }}
          disabled={props.disabled}
        >
          <Icon name="search" size={18} />
        </button>
      </Tooltip>

      <Tooltip
        label={props.autoFocusAvailable ? (props.autoFocus ? "Auto Focus on" : "Auto Focus off") : "Auto Focus unavailable"}
        detail={props.autoFocusAvailable ? "Double-click for Round-Robin or Latest." : "Disabled for this deployment."}
        side={["right"]}
      >
        <button
          data-tutorial="focus"
          aria-label="Auto Focus on live events"
          aria-pressed={props.autoFocus}
          className={props.autoFocus ? "active" : ""}
          disabled={props.disabled || !props.autoFocusAvailable}
          onClick={() => {
            clearTimeout(clickTimer.current);
            clickTimer.current = setTimeout(() => props.onToggleAutoFocus(), 220);
          }}
          onDoubleClick={() => {
            clearTimeout(clickTimer.current);
            setMenuOpen((v) => !v);
            setSearchOpen(false);
          }}
        >
          <ActionIcon name="focus" size={18} signal={props.autoFocus} reduceMotion={props.reduceMotion} />
        </button>
      </Tooltip>

      <Tooltip
        label={props.dnd ? "Do Not Disturb on" : "Do Not Disturb"}
        detail="Mutes the categories chosen in Settings. Events are still recorded."
        side={["right"]}
      >
        <button
          data-tutorial="dnd"
          aria-label="Do Not Disturb"
          aria-pressed={props.dnd}
          className={props.dnd ? "active muted-active" : ""}
          onClick={props.onToggleDnd}
          disabled={props.disabled}
        >
          <ActionIcon name={props.dnd ? "bellOff" : "bell"} size={18} signal={props.dnd} reduceMotion={props.reduceMotion} />
        </button>
      </Tooltip>

      <Tooltip
        label={props.motionLocked ? "Reduced motion held" : "Reduce motion"}
        detail={props.motionLocked ? "Held on by Adaptive Simulation Backpressure until the interface is in sync." : undefined}
        side={["right"]}
      >
        <button
          data-tutorial="motion"
          aria-label="Reduce motion"
          aria-pressed={props.reduceMotion}
          className={props.reduceMotion ? "active" : ""}
          onClick={props.onToggleMotion}
          disabled={props.disabled || props.motionLocked}
        >
          <MotionIcon reduced={props.reduceMotion} />
        </button>
      </Tooltip>

      {props.extra}

      <div className="divider" aria-hidden="true" />

      <Tooltip label="Settings" side={["right"]}>
        <button
          data-tutorial="settings"
          data-settings-trigger
          aria-label="Settings"
          aria-expanded={props.settingsOpen}
          className={`settings-trigger${props.settingsOpen ? " active" : ""}`}
          onClick={props.onToggleSettings}
        >
          <Icon name="settings" size={20} />
        </button>
      </Tooltip>

      {menuOpen && (
        <div className="dock-menu" role="menu" aria-label="Auto Focus order">
          <span className="dock-menu-title">Auto Focus</span>
          {(
            [
              ["round-robin", "Round-Robin", "Visit every live event in turn."],
              ["latest", "Latest", "Stay on the most recent event."],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              role="menuitemradio"
              aria-checked={props.strategy === value}
              className={props.strategy === value ? "selected" : ""}
              onClick={() => {
                props.onStrategy(value);
                setMenuOpen(false);
              }}
            >
              <strong>{label}</strong>
              <small>{hint}</small>
            </button>
          ))}
        </div>
      )}

    </nav>
    <FluidPanel open={searchOpen} anchor="[data-search-trigger]" label="Search places" className="search-panel" width={372} reduceMotion={props.reduceMotion}>
      <PlaceSearch
        open={searchOpen}
        features={props.features}
        city={props.city}
        onClose={() => setSearchOpen(false)}
        onPick={(feature) => {
          props.onPickPlace(feature);
          setSearchOpen(false);
        }}
      />
    </FluidPanel>
    </>
  );
}
