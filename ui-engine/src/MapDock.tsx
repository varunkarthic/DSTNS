import { useEffect, useRef, useState } from "react";
import { Tooltip } from "./Tooltip";
import type { AutoFocusStrategy } from "./uiConfig";
import type { MapFeature } from "./types";
import { placeTitle } from "./mapModel";

/**
 * The floating map dock: zoom, fit, search, auto-focus, do-not-disturb and
 * reduced motion, in that order.
 *
 * Search lives here as an icon rather than as a permanent bar across the top of
 * the map, so the map keeps its full width until the operator actually wants to
 * look something up.
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
  // Distinguish a double click from two singles without delaying the toggle.
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

  const results = query.trim()
    ? props.features
        .filter((f) => {
          const needle = query.trim().toLowerCase();
          return (
            f.name?.toLowerCase().includes(needle) ||
            placeTitle(f).toLowerCase().includes(needle)
          );
        })
        .slice(0, 8)
    : [];

  return (
    <div className="map-dock" ref={dockRef}>
      <Tooltip info={{ title: "Zoom in", category: "Map control" }}>
        <button aria-label="Zoom in" onClick={props.onZoomIn} disabled={props.disabled}>
          <span aria-hidden="true">+</span>
        </button>
      </Tooltip>
      <Tooltip info={{ title: "Zoom out", category: "Map control" }}>
        <button aria-label="Zoom out" onClick={props.onZoomOut} disabled={props.disabled}>
          <span aria-hidden="true">−</span>
        </button>
      </Tooltip>
      <Tooltip info={{ title: "Fit network", category: "Map control" }}>
        <button
          aria-label="Fit network to viewport"
          onClick={props.onFit}
          disabled={props.disabled}
        >
          <span aria-hidden="true">⛶</span>
        </button>
      </Tooltip>

      <div className="divider" aria-hidden="true" />

      {/* Item 17: search as an icon, expanding into a field beside the dock. */}
      <Tooltip info={{ title: "Search places", category: "Map control" }}>
        <button
          aria-label="Search places"
          aria-expanded={searchOpen}
          className={searchOpen ? "active" : ""}
          onClick={() => {
            setSearchOpen((v) => !v);
            setMenuOpen(false);
          }}
          disabled={props.disabled}
        >
          <span aria-hidden="true">⌕</span>
        </button>
      </Tooltip>

      {/* Item 18: single click toggles, double click opens the strategy menu. */}
      <Tooltip
        info={{
          title: props.autoFocusAvailable ? "Auto-focus on events" : "Auto-focus unavailable",
          category: "Map control",
          description: props.autoFocusAvailable
            ? "Glides the camera to live incidents, flooding and weather cells. Traffic signals are ignored, and any manual pan or zoom takes over immediately. Double-click for Round-Robin or Latest."
            : "Auto-focus is disabled for this deployment in ui-config.json.",
        }}
      >
        <button
          aria-label="Auto-focus on live events"
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
          <span aria-hidden="true">◎</span>
        </button>
      </Tooltip>

      {/* Item 13: do not disturb. */}
      <Tooltip
        info={{
          title: props.dnd ? "Notifications silenced" : "Do not disturb",
          category: "Notifications",
          description:
            "Stops notifications appearing on screen. Events are still recorded and stay readable in the telemetry deck.",
        }}
      >
        <button
          aria-label="Do not disturb"
          aria-pressed={props.dnd}
          className={props.dnd ? "active muted-active" : ""}
          onClick={props.onToggleDnd}
          disabled={props.disabled}
        >
          <span aria-hidden="true">{props.dnd ? "⃠" : "◔"}</span>
        </button>
      </Tooltip>

      {/* Item 3: reduced motion sits directly below auto-focus. */}
      <Tooltip
        info={{
          title: props.motionLocked ? "Reduced motion (locked by ASB)" : "Reduce motion",
          category: "Accessibility",
          description: props.motionLocked
            ? "Backpressure has forced reduced motion on while the interface catches up. It unlocks when synchronization holds."
            : "Reduces moving vehicles, pulsing effects and other non-essential motion. Traffic and simulation state remain visible.",
        }}
      >
        <button
          aria-label="Reduce motion"
          aria-pressed={props.reduceMotion}
          className={props.reduceMotion ? "active" : ""}
          onClick={props.onToggleMotion}
          disabled={props.disabled || props.motionLocked}
        >
          <span aria-hidden="true">◌</span>
        </button>
      </Tooltip>

      {menuOpen && (
        <div className="dock-menu glass" role="menu" aria-label="Auto-focus strategy">
          <span className="eyebrow">Auto-focus</span>
          <div className="dock-choice">
            {(
              [
                ["round-robin", "Round-Robin", "Cycle through every live event in turn."],
                ["latest", "Latest", "Always follow the most recent event."],
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
        </div>
      )}

      {searchOpen && (
        <div className="dock-search glass">
          <input
            ref={searchRef}
            type="search"
            aria-label="Search places"
            placeholder="Search places…"
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
                    {placeTitle(f)}
                    <small>{f.name ? f.id : f.category}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query.trim() && results.length === 0 && (
            <p className="dock-empty">No place matches “{query.trim()}”.</p>
          )}
        </div>
      )}
    </div>
  );
}
