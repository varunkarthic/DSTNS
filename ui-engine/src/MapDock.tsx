import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";
import { Tooltip } from "./Tooltip";
import type { AutoFocusStrategy } from "./uiConfig";
import type { MapFeature } from "./types";
import { placeTitle } from "./mapModel";

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
  onPickPlace: (feature: MapFeature) => void;

  disabled?: boolean;
}

export function MapDock(props: MapDockProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  // Tell a double click from two singles without delaying the toggle much.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen && !menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!dockRef.current?.contains(e.target as Node)) {
        setSearchOpen(false);
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSearchOpen(false);
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [searchOpen, menuOpen]);

  useEffect(() => () => clearTimeout(clickTimer.current), []);

  const needle = query.trim().toLowerCase();
  const results = needle
    ? props.features
        .filter((f) => f.name?.toLowerCase().includes(needle) || placeTitle(f).toLowerCase().includes(needle))
        .slice(0, 8)
    : [];

  return (
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
          aria-label="Search places"
          aria-expanded={searchOpen}
          className={searchOpen ? "active" : ""}
          onClick={() => {
            setSearchOpen((v) => !v);
            setMenuOpen(false);
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
          <Icon name="focus" size={18} />
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
          <Icon name={props.dnd ? "bellOff" : "bell"} size={18} />
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
          <Icon name={props.reduceMotion ? "motionOff" : "motion"} size={18} />
        </button>
      </Tooltip>

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

      {searchOpen && (
        <div className="dock-search">
          <input
            ref={searchRef}
            type="search"
            aria-label="Search places"
            placeholder="Search places"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {results.length > 0 && (
            <ul>
              {results.map((f) => (
                <li key={f.id}>
                  <button
                    onClick={() => {
                      props.onPickPlace(f);
                      setSearchOpen(false);
                      setQuery("");
                    }}
                  >
                    <Icon name="pin" size={14} />
                    <span>{placeTitle(f)}</span>
                    <small>{f.name ? f.category : f.id}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {needle && results.length === 0 && <p className="dock-empty">No place matches “{query.trim()}”.</p>}
          {!needle && props.features.length === 0 && <p className="dock-empty">No named places in this district.</p>}
        </div>
      )}
    </nav>
  );
}
