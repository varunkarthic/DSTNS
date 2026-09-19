import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NetworkMap from "./NetworkMap";
import type { MapControls, MapView } from "./NetworkMap";
import { TelemetryDeck } from "./TelemetryDeck";
import { PlaybackDock } from "./PlaybackDock";
import { LayersPopover } from "./LayersPopover";
import { Tooltip } from "./Tooltip";
import { useSimulation } from "./useSimulation";
import { api } from "./api";
import { formatCoordinate, scaleBarFor } from "./mapProjection";
import { defaultLayers } from "./types";
import type { Congestion, Layers } from "./types";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
// style.css is the legacy sheet (map canvas, tooltips, PDF report chrome);
// theme.css carries the alpha design and must win where the two overlap.
import "./style.css";
import "./theme.css";

const motionInfo = {
  title: "Reduce Motion",
  category: "Accessibility",
  description:
    "Reduces moving vehicles, pulsing effects and other non-essential motion for users with visual motion sensitivity. Traffic and simulation state remain visible.",
};

function readMotion() {
  try {
    const stored = localStorage.getItem("dstns.reduce-motion.v1");
    if (stored !== null) return stored === "true";
  } catch {
    /* Storage may be disabled. */
  }
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export default function App() {
  const sim = useSimulation();
  const [motion, setMotion] = useState(readMotion);
  const [layers, setLayers] = useState<Layers>({ ...defaultLayers });
  const [layersOpen, setLayersOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [logo, setLogo] = useState(true);
  const [history, setHistory] = useState<Congestion | null>(null);
  const [fullSeed, setFullSeed] = useState(false);
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(
    null,
  );
  const [view, setView] = useState<MapView>({ scale: 1, metresPerPixel: 1 });
  const [autoFocus, setAutoFocus] = useState(() => {
    try {
      return localStorage.getItem("dstns.auto-focus.v1") === "true";
    } catch {
      return false;
    }
  });
  const [focusIndex, setFocusIndex] = useState(0);
  const focusToken = useRef(0);
  const mapControls = useRef<MapControls | null>(null);

  const status = sim.status?.data;
  const lifecycle = status?.lifecycle ?? "IDLE";
  const clock = sim.snapshot?.clock ?? sim.status?.clock;
  const valid = !!sim.snapshot && !sim.error && !sim.stale;
  const congestion = sim.snapshot?.data.congestion;
  // Only treat the location as real when the seed actually chose a city: a run
  // started from an explicit --osm-file reports an empty, zeroed block.
  const rawLocation = sim.topology?.location;
  const location = rawLocation?.city ? rawLocation : undefined;
  const origin = sim.topology?.projection;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      try {
        if (localStorage.getItem("dstns.reduce-motion.v1") !== null) return;
      } catch {
        /* Storage may be disabled. */
      }
      setMotion(media.matches);
    };
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (!sim.status?.run_id) {
      setHistory(null);
      return;
    }
    let cancel = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await api.congestion();
        if (!cancel && value.run_id === sim.status?.run_id)
          setHistory(value.data);
      } catch {
        /* Congestion history is supplementary; the deck degrades gracefully. */
      } finally {
        if (!cancel) timer = setTimeout(refresh, 5000);
      }
    };
    void refresh();
    return () => {
      cancel = true;
      clearTimeout(timer);
    };
  }, [sim.status?.run_id]);

  const toggleMotion = () =>
    setMotion((v) => {
      try {
        localStorage.setItem("dstns.reduce-motion.v1", String(!v));
      } catch {
        /* Storage may be disabled. */
      }
      return !v;
    });

  const action = useCallback(async (fn: () => Promise<unknown>) => {
    setPending(true);
    setActionError("");
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setPending(false);
    }
  }, []);

  const report = () =>
    action(async () => {
      if (!sim.status || !sim.snapshot || !sim.topology) return;
      const { exportReport } = await import("./report");
      await exportReport(
        sim.status,
        sim.snapshot,
        sim.topology,
        history ?? sim.snapshot.data.congestion,
        sim.news,
      );
    });

  const terminate = () =>
    action(async () => {
      if (
        !window.confirm(
          "Terminate the DSTNS simulation server? The run and its API will stop.",
        )
      )
        return;
      await api.terminate();
    });

  // Places worth watching: real disruption only. Signals cycle constantly and
  // would just make the camera twitch, so they are deliberately excluded.
  const focusTargets = useMemo(() => {
    const snap = sim.snapshot?.data;
    const topo = sim.topology;
    if (!snap || !topo) return [];
    const geometry = new Map(topo.edges.map((e) => [e.id, e.geometry]));
    const out: { key: string; label: string; x_m: number; y_m: number; rank: number }[] = [];
    for (const incident of snap.active_incidents) {
      const line = geometry.get(incident.edge_id);
      if (!line?.length) continue;
      const mid = line[Math.floor(line.length / 2)];
      const flooded = incident.flood > 0.01;
      out.push({
        key: `incident-${incident.incident_id ?? incident.id ?? incident.edge_id}`,
        label: flooded ? "Flooding" : incident.closed ? "Road closed" : "Incident",
        x_m: mid.x_m,
        y_m: mid.y_m,
        rank: flooded ? 0 : incident.closed ? 1 : 2,
      });
    }
    for (const cell of snap.active_weather) {
      out.push({
        key: `weather-${cell.id}`,
        label: "Weather cell",
        x_m: cell.x_m,
        y_m: cell.y_m,
        rank: 3,
      });
    }
    // Stable order so the camera cycles predictably rather than jumping about.
    return out.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
  }, [sim.snapshot, sim.topology]);

  const focusKeys = focusTargets.map((t) => t.key).join("|");
  useEffect(() => {
    // Restart the cycle whenever the set of live events changes.
    setFocusIndex(0);
  }, [focusKeys]);
  useEffect(() => {
    if (!autoFocus || focusTargets.length < 2) return;
    const timer = setInterval(
      () => setFocusIndex((i) => (i + 1) % focusTargets.length),
      9000,
    );
    return () => clearInterval(timer);
  }, [autoFocus, focusTargets.length]);

  const active = autoFocus ? focusTargets[focusIndex % Math.max(1, focusTargets.length)] : undefined;
  const activeKey = active?.key;
  const focus = useMemo(() => {
    if (!active) return null;
    focusToken.current += 1;
    return { x_m: active.x_m, y_m: active.y_m, scale: 1.6, token: focusToken.current };
    // A new token is only minted when the camera should actually move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const toggleAutoFocus = () =>
    setAutoFocus((v) => {
      try {
        localStorage.setItem("dstns.auto-focus.v1", String(!v));
      } catch {
        /* Storage may be disabled. */
      }
      return !v;
    });

  const seed = sim.status?.global_seed ?? "";
  const shortSeed =
    seed.length > 14 ? `${seed.slice(0, 8)}…${seed.slice(-4)}` : seed;
  const scaleBar = scaleBarFor(view.metresPerPixel);
  // A map fetch failure names the city and cause; surface it as its own state.
  const mapError = /MAP_FETCH_FAILED|OSM download|map tile/i.test(
    sim.error || actionError,
  );

  return (
    <div className={`app-shell ${motion ? "reduce-motion" : ""}`}>
      <header className="app-header">
        <div className="brand">
          {logo && (
            <img src="/media/logo.png" alt="" onError={() => setLogo(false)} />
          )}
          <div>
            <h1>DSTNS</h1>
            <p>Deterministic Spatiotemporal Transport Network Simulator</p>
          </div>
        </div>
        <div className="header-actions">
          {location?.city && (
            <Tooltip
              info={{
                title: "Seed-selected district",
                category: "Map source",
                description: `The 128-bit seed resolved to this city and to ${formatCoordinate(location.anchor_lat, location.anchor_lon)}. The tile was downloaded from OpenStreetMap on demand.`,
              }}
            >
              <span className="chip">
                {location.city}, {location.country}
              </span>
            </Tooltip>
          )}
          <button className="btn" onClick={report} disabled={!valid || pending}>
            ↓ <span>Export Report</span>
          </button>
          <Tooltip info={motionInfo}>
            <button
              className="btn icon"
              aria-label="Toggle reduced motion"
              aria-pressed={motion}
              onClick={toggleMotion}
            >
              ◌
            </button>
          </Tooltip>
          {/* AGPL section 13: anyone interacting with this program over a
              network must be offered its corresponding source. */}
          <Tooltip
            info={{
              title: "DSTNS " + (import.meta.env.VITE_DSTNS_VERSION ?? "2.0.0"),
              category: "About",
              description:
                "Copyright (C) 2026 Varun Karthic. Licensed under the GNU Affero General Public License v3 or later. You may obtain the complete corresponding source of this running version, and map data is © OpenStreetMap contributors under ODbL.",
            }}
          >
            <a
              className="btn icon"
              href="/api/v1/system/source"
              aria-label="Licence and source"
            >
              ⓘ
            </a>
          </Tooltip>
        </div>
      </header>

      <main className="workspace">
        <div className="map-layer">
          <NetworkMap
            topology={sim.topology}
            snapshot={sim.snapshot?.data ?? null}
            layers={layers}
            reduceMotion={motion}
            running={valid && lifecycle === "RUNNING"}
            virtualTime={clock?.virtual_day_seconds ?? 0}
            tickRate={clock?.tick_rate ?? 1}
            focus={focus}
            controls={mapControls}
            onView={setView}
            onCursor={setCursor}
          />
        </div>

        <div className="map-dock">
          <Tooltip info={{ title: "Zoom in", category: "Map control" }}>
            <button aria-label="Zoom in" onClick={() => mapControls.current?.zoomIn()}>
              +
            </button>
          </Tooltip>
          <Tooltip info={{ title: "Zoom out", category: "Map control" }}>
            <button
              aria-label="Zoom out"
              onClick={() => mapControls.current?.zoomOut()}
            >
              −
            </button>
          </Tooltip>
          <div className="divider" aria-hidden="true" />
          <Tooltip
            info={{
              title: "Auto-focus on events",
              category: "Map control",
              description:
                "Glides the camera to live incidents, flooding and weather cells, cycling between them. Traffic signals are ignored. Any manual pan or zoom takes over immediately.",
            }}
          >
            <button
              aria-label="Auto-focus on live events"
              aria-pressed={autoFocus}
              className={autoFocus ? "active" : ""}
              onClick={toggleAutoFocus}
            >
              ◎
            </button>
          </Tooltip>
          <Tooltip info={{ title: "Fit network", category: "Map control" }}>
            <button
              aria-label="Fit network to viewport"
              onClick={() => mapControls.current?.fit()}
            >
              ⛶
            </button>
          </Tooltip>
        </div>

        {layersOpen && (
          <LayersPopover
            layers={layers}
            onChange={setLayers}
            onClose={() => setLayersOpen(false)}
            topology={sim.topology}
            snapshot={sim.snapshot?.data ?? null}
          />
        )}

        <TelemetryDeck
          status={status}
          snapshot={sim.snapshot?.data ?? null}
          topology={sim.topology}
          congestion={congestion}
          history={history}
          news={sim.news}
          connected={valid}
          virtualTime={clock?.virtual_day_seconds ?? 0}
          runId={sim.status?.run_id ?? ""}
        />

        <div className="bottom-stack">
        <div className="map-hud">
          <div className="hud-chip">
            <span aria-hidden="true" style={{ color: "var(--primary)" }}>
              ⌖
            </span>
            <span>
              {cursor
                ? formatCoordinate(cursor.lat, cursor.lon)
                : location
                  ? formatCoordinate(location.anchor_lat, location.anchor_lon)
                  : origin
                    ? formatCoordinate(origin.origin_lat, origin.origin_lon)
                    : "—"}
            </span>
            {location && location.tile_radius_m > 0 && (
              <>
                <span className="dot">•</span>
                <span className="muted">
                  TILE {(location.tile_radius_m * 2) / 1000} km
                </span>
              </>
            )}
          </div>
          <div className="scale-bar" aria-label="Map scale">
            <span>0</span>
            <i style={{ width: Math.round(scaleBar.pixels) }} />
            <span>{scaleBar.label}</span>
          </div>
          <div className="legend" aria-label="Road state legend">
            {[
              ["var(--state-clear)", "Clear"],
              ["var(--state-moderate)", "Moderate"],
              ["var(--state-severe)", "Severe"],
              ["var(--state-flooded)", "Flooded"],
            ].map(([color, label]) => (
              <span key={label}>
                <i style={{ background: color }} />
                {label}
              </span>
            ))}
          </div>
        </div>

        <div className="control-strip">
          <Tooltip
            info={{
              title: "Terminate simulation",
              category: "Runtime control",
              description:
                "Stops the run and shuts the simulation server down. Start a new run from the CLI.",
            }}
          >
            <button
              className="btn pill danger"
              onClick={terminate}
              disabled={pending || lifecycle === "IDLE"}
            >
              ⏻ <span>Terminate Sim</span>
            </button>
          </Tooltip>

          <div className={`status ${valid ? "" : "down"}`}>
            <span className="live-dot sm" aria-hidden="true">
              <span />
              <span />
            </span>
            <span className="label">
              {sim.error
                ? "Disconnected"
                : sim.stale
                  ? "Stale"
                  : lifecycle === "IDLE"
                    ? "Awaiting run"
                    : "Connected"}
            </span>
            <span className="addr">{window.location.host}</span>
          </div>

          <button
            className="seed-toggle"
            aria-label="Toggle the full 128-bit seed"
            onClick={() => setFullSeed((v) => !v)}
          >
            <span className="muted">Seed:</span>
            <span className="value">
              {seed ? (fullSeed ? seed : shortSeed) : "—"}
            </span>
            <span aria-hidden="true">⇕</span>
          </button>

          <button
            className="btn pill"
            data-layers-trigger
            aria-expanded={layersOpen}
            onClick={() => setLayersOpen((v) => !v)}
          >
            ▤ <span>Display Layers</span>
          </button>
        </div>

        <PlaybackDock
          clock={clock}
          lifecycle={lifecycle}
          enabled={valid}
          pending={pending}
          onPlayPause={() =>
            action(lifecycle === "PAUSED" ? api.play : api.pause)
          }
          onSeek={(seconds) => action(() => api.seek(seconds))}
          onRate={(rate) => action(() => api.tick(rate))}
          onReset={() => action(() => api.seek(0))}
        />
        </div>


        <div className="toasts" aria-live="polite">
          {sim.toasts.map((n) => (
            <article className="toast glass" key={n.news_id}>
              <div>
                <span className="eyebrow">{n.category}</span>
                <button
                  aria-label="Dismiss notification"
                  onClick={() => sim.dismissToast(n.news_id)}
                >
                  ×
                </button>
              </div>
              <p>{n.message.replace(/^\[.*?\]\s*/, "")}</p>
            </article>
          ))}
        </div>

        {(sim.error || sim.stale || actionError) && (
          <div
            role="alert"
            className={`error-banner glass ${mapError ? "map-error" : ""}`}
          >
            {actionError ||
              sim.error ||
              "Simulation data is stale. Reconnecting…"}
            {actionError && (
              <button
                aria-label="Dismiss error"
                onClick={() => setActionError("")}
              >
                ×
              </button>
            )}
          </div>
        )}

        {!sim.topology && !sim.error && (
          <div className="loading-card glass" role="status">
            <span className="eyebrow">Simulation observatory</span>
            <h2>{sim.stage}</h2>
            {lifecycle === "IDLE" && (
              <>
                <p>Start a simulation from your terminal.</p>
                <code>./launcher start --seed 382923</code>
                <p>
                  The seed selects a real city district, which is downloaded
                  from OpenStreetMap on first use. The map and live analysis
                  connect automatically.
                </p>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
