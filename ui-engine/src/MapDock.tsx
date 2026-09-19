import { useEffect, useRef, useState } from "react";
import type React from "react";
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

/**
 * Dock glyphs.
 *
 * Drawn rather than typed. Text characters come from different families at
 * different optical sizes and weights - the search glyph in particular sat
 * noticeably smaller than its neighbours - so they never line up however they
 * are nudged. These share one 24-unit box, one stroke width and one cap style.
 */
function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    minus: <path d="M5 12h14" />,
    fit: <path d="M3 8V4h4M21 8V4h-4M3 16v4h4M21 16v4h-4" />,
    search: (
      <>
        <circle cx="11" cy="11" r="6" />
        <path d="M20 20l-4.3-4.3" />
      </>
    ),
    // Auto-focus: a reticle closing on a target.
    focus: (
      <>
        <circle cx="12" cy="12" r="3.2" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        <circle cx="12" cy="12" r="8.5" strokeDasharray="3 3" />
      </>
    ),
    // Do not disturb: a bell, and the same bell struck through.
    bell: (
      <>
        <path d="M18 8a6 6 0 10-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
        <path d="M10.5 20a2 2 0 003 0" />
      </>
    ),
    bellOff: (
      <>
        <path d="M18 8a6 6 0 00-9.3-5" />
        <path d="M5.2 6.2A6 6 0 006 8c0 6-2 7-2 7h12" />
        <path d="M10.5 20a2 2 0 003 0" />
        <path d="M3 3l18 18" />
      </>
    ),
    // Reduce motion: motion lines, and the same lines stilled.
    motion: (
      <>
        <path d="M3 8h13M3 12h9M3 16h13" />
        <circle cx="19" cy="12" r="2.2" />
      </>
    ),
    motionOff: (
      <>
        <path d="M3 8h7M3 12h5M3 16h7" />
        <circle cx="16" cy="12" r="2.2" />
        <path d="M3 3l18 18" />
      </>
    ),
  };
  return (
    <svg
      className="dock-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
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
    <div className="map-dock" ref={dockRef} data-tutorial="zoom">
      <Tooltip info={{ title: "Zoom in", category: "Map control" }}>
        <button aria-label="Zoom in" onClick={props.onZoomIn} disabled={props.disabled}>
          <Icon name="plus" />
        </button>
      </Tooltip>
      <Tooltip info={{ title: "Zoom out", category: "Map control" }}>
        <button aria-label="Zoom out" onClick={props.onZoomOut} disabled={props.disabled}>
          <Icon name="minus" />
        </button>
      </Tooltip>
      <Tooltip info={{ title: "Fit network", category: "Map control" }}>
        <button
          aria-label="Fit network to viewport"
          onClick={props.onFit}
          disabled={props.disabled}
        >
          <Icon name="fit" />
        </button>
      </Tooltip>

      <div className="divider" aria-hidden="true" />

      {/* Item 17: search as an icon, expanding into a field beside the dock. */}
      <Tooltip info={{ title: "Search places", category: "Map control" }}>
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
          <Icon name="search" />
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
          data-tutorial="focus"
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
          <Icon name="focus" />
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
          <Icon name={props.dnd ? "bellOff" : "bell"} />
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
          data-tutorial="motion"
          aria-label="Reduce motion"
          aria-pressed={props.reduceMotion}
          className={props.reduceMotion ? "active" : ""}
          onClick={props.onToggleMotion}
          disabled={props.disabled || props.motionLocked}
        >
          <Icon name={props.reduceMotion ? "motionOff" : "motion"} />
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
