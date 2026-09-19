import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NetworkMap from "./NetworkMap";
import type { MapControls, MapView } from "./NetworkMap";
import { TelemetryDeck } from "./TelemetryDeck";
import { PlaybackDock } from "./PlaybackDock";
import { LayersPopover } from "./LayersPopover";
import { MapDock } from "./MapDock";
import { Logo } from "./Logo";
import { Splash, splashStageFor } from "./Splash";
import { AboutCard, AutoFocusPrompt, ConfirmCard, SuspendedOverlay } from "./Dialogs";
import { Tooltip } from "./Tooltip";
import { useSimulation } from "./useSimulation";
import { useBackpressure, describeAsb, formatRate } from "./useBackpressure";
import { api } from "./api";
import { formatCoordinate, scaleBarFor } from "./mapProjection";
import { BUILT_IN, loadConfig, resolveReduceMotion, writeOverrides } from "./uiConfig";
import type { UiConfig, AutoFocusStrategy } from "./uiConfig";
import type { Congestion, Layers, MapFeature } from "./types";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
// style.css is the legacy sheet (map canvas, report chrome); theme.css carries
// the current design and must win where the two overlap.
import "./style.css";
import "./theme.css";

const VERSION = "2.0.0";

/** Dialogs are mutually exclusive; one slot keeps them from stacking. */
type DialogKind = "about" | "reset" | "terminate" | "auto-focus" | null;

export default function App() {
  const sim = useSimulation();

  // ---- Configuration ----------------------------------------------------
  const [config, setConfig] = useState<UiConfig>(BUILT_IN);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [layers, setLayers] = useState<Layers>(BUILT_IN.layers);
  const [motionChoice, setMotionChoice] = useState(() =>
    resolveReduceMotion(BUILT_IN.reduce_motion),
  );
  const [dnd, setDnd] = useState(BUILT_IN.notifications.dnd);
  const [hour12, setHour12] = useState(BUILT_IN.clock.hour12);

  useEffect(() => {
    let cancelled = false;
    void loadConfig().then(({ config: resolved }) => {
      if (cancelled) return;
      setConfig(resolved);
      setLayers(resolved.layers);
      setMotionChoice(resolveReduceMotion(resolved.reduce_motion));
      setDnd(resolved.notifications.dnd);
      setHour12(resolved.clock.hour12);
      setConfigLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the viewer's choices as deltas from the built-in defaults, so a
  // later edit to config/ui-config.json still reaches fields they never touched.
  const persist = useCallback((patch: Partial<UiConfig>) => {
    setConfig((current) => {
      const next = { ...current, ...patch };
      writeOverrides(next, BUILT_IN);
      return next;
    });
  }, []);

  // ---- Shell state ------------------------------------------------------
  const [layersOpen, setLayersOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dialogClosing, setDialogClosing] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [history, setHistory] = useState<Congestion | null>(null);
  const [fullSeed, setFullSeed] = useState(false);
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [view, setView] = useState<MapView>({ scale: 1, metresPerPixel: 1 });
  const [mapStatus, setMapStatus] = useState<Record<string, unknown> | null>(null);
  const [splashDismissed, setSplashDismissed] = useState(false);
  const [manualFocus, setManualFocus] = useState<{
    x_m: number;
    y_m: number;
    scale: number;
    token: number;
  } | null>(null);
  const mapControls = useRef<MapControls | null>(null);

  const status = sim.status?.data;
  const lifecycle = status?.lifecycle ?? "IDLE";
  const clock = sim.snapshot?.clock ?? sim.status?.clock;
  const valid = !!sim.snapshot && !sim.error && !sim.stale;
  const congestion = sim.snapshot?.data.congestion;
  const rawLocation = sim.topology?.location;
  const location = rawLocation?.city ? rawLocation : undefined;
  const origin = sim.topology?.projection;
  const runId = sim.status?.run_id ?? "";

  // ---- Backpressure -----------------------------------------------------
  const { asb, resetToken } = useBackpressure({
    enabled: config.asb.enabled,
    intervalMs: config.asb.report_interval_ms,
    renderedVirtualSecond: sim.snapshot?.clock.virtual_day_seconds ?? 0,
    coreVirtualSecond: sim.status?.clock.virtual_day_seconds ?? 0,
    active: valid && !!sim.topology,
  });
  const suspended = asb?.gui_suspended === true;
  const rateLocked = asb?.rate_locked === true;
  const motionLocked = asb?.motion_locked === true;
  const reduceMotion = motionChoice || motionLocked;

  // ASB's default state: strip the presentation back to a minimum and soft
  // restart, as a Ctrl+R would, without reloading the page itself.
  const softReset = useCallback(() => {
    setLayers({
      ...BUILT_IN.layers,
      roads: false,
      traffic: false,
      vehicles: false,
      buildings: false,
      labels: false,
      place_names: false,
      weather: false,
    });
    setLayersOpen(false);
    setDialog(null);
    mapControls.current?.fit();
  }, []);
  const seenReset = useRef(resetToken);
  useEffect(() => {
    if (resetToken !== seenReset.current) {
      seenReset.current = resetToken;
      softReset();
    }
  }, [resetToken, softReset]);

  // ---- Auto-focus -------------------------------------------------------
  const mode = config.auto_focus.mode;
  const [autoFocus, setAutoFocus] = useState(false);
  // The offer is made once per run, and the answer survives a page reload:
  // reloading is not a new simulation, so re-asking would be nagging.
  const ANSWERED_KEY = "dstns.auto-focus-answered.v1";
  const [promptedRun, setPromptedRun] = useState(() => {
    try {
      return localStorage.getItem(ANSWERED_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const rememberAnswer = useCallback((id: string) => {
    try {
      localStorage.setItem(ANSWERED_KEY, id);
    } catch {
      /* Storage may be disabled; the offer simply returns on reload. */
    }
  }, []);
  const [focusIndex, setFocusIndex] = useState(0);
  const focusToken = useRef(0);

  useEffect(() => {
    if (!configLoaded) return;
    if (mode === "enable-force") setAutoFocus(true);
    if (mode === "disable") setAutoFocus(false);
  }, [configLoaded, mode]);

  // "enable" offers the choice once per run rather than deciding for the operator.
  useEffect(() => {
    if (mode !== "enable" || !configLoaded) return;
    if (!runId || !sim.topology || suspended) return;
    if (promptedRun === runId) return;
    setPromptedRun(runId);
    rememberAnswer(runId);
    setDialog((current) => current ?? "auto-focus");
  }, [mode, configLoaded, runId, sim.topology, suspended, promptedRun, rememberAnswer]);

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
    for (const cell of snap.active_weather)
      out.push({
        key: `weather-${cell.id}`,
        label: "Weather cell",
        x_m: cell.x_m,
        y_m: cell.y_m,
        rank: 3,
      });
    return out.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
  }, [sim.snapshot, sim.topology]);

  const focusKeys = focusTargets.map((t) => t.key).join("|");
  useEffect(() => setFocusIndex(0), [focusKeys]);
  useEffect(() => {
    // Round-Robin cycles; Latest stays on the newest, so it needs no timer.
    if (!autoFocus || config.auto_focus.strategy !== "round-robin") return;
    if (focusTargets.length < 2) return;
    const timer = setInterval(
      () => setFocusIndex((i) => (i + 1) % focusTargets.length),
      config.auto_focus.dwell_seconds * 1000,
    );
    return () => clearInterval(timer);
  }, [
    autoFocus,
    config.auto_focus.strategy,
    config.auto_focus.dwell_seconds,
    focusTargets.length,
  ]);

  const active =
    autoFocus && focusTargets.length
      ? config.auto_focus.strategy === "latest"
        ? focusTargets[focusTargets.length - 1]
        : focusTargets[focusIndex % focusTargets.length]
      : undefined;
  const activeKey = active?.key;
  const focus = useMemo(() => {
    if (!active) return null;
    focusToken.current += 1;
    return {
      x_m: active.x_m,
      y_m: active.y_m,
      scale: config.auto_focus.zoom,
      token: focusToken.current,
    };
    // A new token is minted only when the camera should actually move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, config.auto_focus.zoom]);

  // ---- Congestion history ------------------------------------------------
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
        if (!cancel && value.run_id === sim.status?.run_id) setHistory(value.data);
      } catch {
        /* Supplementary; the deck degrades gracefully. */
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

  // ---- Map download status, for the splash -------------------------------
  useEffect(() => {
    if (sim.topology) return;
    let cancel = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch("/api/v1/system/map-status");
        const body = await res.json();
        if (!cancel) setMapStatus(body?.data ?? null);
      } catch {
        /* The splash falls back to the lifecycle stage. */
      } finally {
        if (!cancel) timer = setTimeout(poll, 600);
      }
    };
    void poll();
    return () => {
      cancel = true;
      clearTimeout(timer);
    };
  }, [sim.topology]);

  // ---- Actions ----------------------------------------------------------
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

  const closeDialog = useCallback(() => {
    // Let the exit transition run before the node is removed.
    setDialogClosing(true);
    setTimeout(() => {
      setDialog(null);
      setDialogClosing(false);
    }, 160);
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
        asb,
      );
    });

  const toggleMotion = () => {
    const next = !motionChoice;
    setMotionChoice(next);
    persist({ reduce_motion: next ? "on" : "off" });
  };
  const toggleDnd = () => {
    const next = !dnd;
    setDnd(next);
    persist({ notifications: { ...config.notifications, dnd: next } });
  };
  const setStrategy = (strategy: AutoFocusStrategy) =>
    persist({ auto_focus: { ...config.auto_focus, strategy } });
  const changeLayers = (next: Layers) => {
    setLayers(next);
    persist({ layers: next });
  };
  const changeHour12 = (value: boolean) => {
    setHour12(value);
    persist({ clock: { hour12: value } });
  };

  const focusOnPlace = (feature: MapFeature) => {
    setAutoFocus(false);
    focusToken.current += 1;
    setManualFocus({
      x_m: feature.position.x_m,
      y_m: feature.position.y_m,
      scale: Math.max(view.scale, 1.6),
      token: focusToken.current,
    });
    // Say what was found, not merely move to it. The glide takes ~900ms, so
    // the card is raised once the camera has arrived.
    window.setTimeout(() => mapControls.current?.inspectFeature(feature.id), 950);
  };

  const seed = sim.status?.global_seed ?? "";
  const shortSeed = seed.length > 14 ? `${seed.slice(0, 8)}…${seed.slice(-4)}` : seed;
  const scaleBar = scaleBarFor(view.metresPerPixel);
  const mapError = /MAP_FETCH_FAILED|OSM download|map tile/i.test(sim.error || actionError);
  const asbInfo = describeAsb(asb);

  const splashStage = splashStageFor(mapStatus as never, lifecycle, sim.stage, !!sim.topology);
  const showSplash = !splashDismissed && !!splashStage && !sim.error;

  return (
    <div
      className={`app-shell ${reduceMotion ? "reduce-motion" : ""}${suspended ? " suspended-shell" : ""}`}
    >
      <header className="app-header">
        <div className="brand">
          <Logo size={30} />
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
                description: `The 128-bit seed resolved to this city and to ${formatCoordinate(location.anchor_lat, location.anchor_lon)}. The extract was downloaded from OpenStreetMap on demand.`,
              }}
            >
              <span className="chip">
                {location.city}, {location.country}
              </span>
            </Tooltip>
          )}
          {asb && asb.state !== "NORMAL" && (
            <Tooltip
              info={{ title: asbInfo.label, category: "Backpressure", description: asbInfo.detail }}
            >
              <span className={`chip asb ${asbInfo.tone}`}>{asbInfo.label}</span>
            </Tooltip>
          )}
          <button className="btn" onClick={report} disabled={!valid || pending || suspended}>
            <span aria-hidden="true">↓</span> <span>Export Report</span>
          </button>
          <Tooltip info={{ title: "About DSTNS", category: "Licence & source" }}>
            <button
              className="btn icon"
              aria-label="About DSTNS, licence and source"
              onClick={() => setDialog("about")}
            >
              <span aria-hidden="true">ⓘ</span>
            </button>
          </Tooltip>
        </div>
      </header>

      <main className="workspace">
        <div className="map-layer">
          <NetworkMap
            topology={sim.topology}
            snapshot={sim.snapshot?.data ?? null}
            layers={layers}
            reduceMotion={reduceMotion}
            running={valid && lifecycle === "RUNNING" && !suspended}
            virtualTime={clock?.virtual_day_seconds ?? 0}
            tickRate={clock?.tick_rate ?? 1}
            focus={manualFocus ?? focus}
            controls={mapControls}
            onView={setView}
            onCursor={setCursor}
          />
        </div>

        <MapDock
          onZoomIn={() => mapControls.current?.zoomIn()}
          onZoomOut={() => mapControls.current?.zoomOut()}
          onFit={() => mapControls.current?.fit()}
          autoFocus={autoFocus}
          autoFocusAvailable={mode !== "disable"}
          strategy={config.auto_focus.strategy}
          onToggleAutoFocus={() => {
            setAutoFocus((v) => !v);
            setManualFocus(null);
          }}
          onStrategy={setStrategy}
          dnd={dnd}
          onToggleDnd={toggleDnd}
          reduceMotion={reduceMotion}
          motionLocked={motionLocked}
          onToggleMotion={toggleMotion}
          features={sim.topology?.features ?? []}
          onPickPlace={focusOnPlace}
          disabled={suspended}
        />

        {layersOpen && (
          <LayersPopover
            layers={layers}
            defaults={config.layers}
            onChange={changeLayers}
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
          runId={runId}
          asb={asb}
        />

        <div className="bottom-stack">
          <div className="map-hud">
            <div className="hud-chip">
              <span aria-hidden="true" className="accent">
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
                description: "Stops the run and shuts the simulation server down.",
              }}
            >
              <button
                className="btn pill danger"
                onClick={() => setDialog("terminate")}
                disabled={pending || lifecycle === "IDLE"}
              >
                <span aria-hidden="true">⏻</span> <span>Terminate</span>
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
              {asb && (
                <Tooltip
                  info={{
                    title: "Stream throughput",
                    category: "Backpressure",
                    description: `The observer is receiving ${(asb.throughput?.snapshots_per_s ?? 0).toFixed(1)} snapshots per second. Backpressure score ${(asb.score * 100).toFixed(0)}%.`,
                  }}
                >
                  <span className="addr mono">{formatRate(asb.throughput?.bytes_per_s ?? 0)}</span>
                </Tooltip>
              )}
            </div>

            <button
              className="seed-toggle"
              aria-label="Toggle the full 128-bit seed"
              onClick={() => setFullSeed((v) => !v)}
            >
              <span className="muted">Seed</span>
              <span className="value mono">{seed ? (fullSeed ? seed : shortSeed) : "—"}</span>
            </button>

            <button
              className={`btn pill${layersOpen ? " active" : ""}`}
              data-layers-trigger
              aria-expanded={layersOpen}
              onClick={() => setLayersOpen((v) => !v)}
              disabled={suspended}
            >
              <span aria-hidden="true">▤</span> <span>Display Layers</span>
            </button>
          </div>

          <PlaybackDock
            clock={clock}
            lifecycle={lifecycle}
            enabled={valid && !suspended}
            pending={pending}
            hour12={hour12}
            onHour12={changeHour12}
            rateLocked={rateLocked}
            onPlayPause={() => action(lifecycle === "PAUSED" ? api.play : api.pause)}
            onSeek={(seconds) => action(() => api.seek(seconds))}
            onRate={(rate) => action(() => api.tick(rate))}
            onReset={() => setDialog("reset")}
          />
        </div>

        {/* Notifications: silenced by DND, and never shown while suspended. */}
        {!dnd && config.notifications.enabled && !suspended && (
          <div className="toasts" aria-live="polite">
            {sim.toasts.slice(0, config.notifications.max_visible).map((n) => (
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
        )}

        {(sim.error || sim.stale || actionError) && !suspended && (
          <div role="alert" className={`error-banner glass ${mapError ? "map-error" : ""}`}>
            <span>{actionError || sim.error || "Simulation data is stale. Reconnecting…"}</span>
            {actionError && (
              <button aria-label="Dismiss error" onClick={() => setActionError("")}>
                ×
              </button>
            )}
          </div>
        )}

        {showSplash && splashStage && (
          <Splash
            stage={splashStage}
            reduceMotion={reduceMotion}
            onDismiss={() => setSplashDismissed(true)}
          />
        )}

        {dialog === "about" && (
          <AboutCard
            version={VERSION}
            closing={dialogClosing}
            onClose={closeDialog}
            location={location ?? null}
            seed={seed}
          />
        )}
        {dialog === "reset" && (
          <ConfirmCard
            title="Reset the simulation?"
            body="The run returns to 00:00:00. The scenario, its seed and its map are unchanged, so the same day replays from the beginning."
            confirmLabel="Reset to 00:00:00"
            closing={dialogClosing}
            onCancel={closeDialog}
            onConfirm={() => {
              closeDialog();
              void action(() => api.seek(0));
            }}
          />
        )}
        {dialog === "terminate" && (
          <ConfirmCard
            title="Terminate this session?"
            body="The run stops and the simulation server shuts down. A new run must be started from the CLI."
            confirmLabel="Terminate"
            tone="danger"
            closing={dialogClosing}
            onCancel={closeDialog}
            onConfirm={() => {
              closeDialog();
              void action(() => api.terminate());
            }}
          />
        )}
        {dialog === "auto-focus" && (
          <AutoFocusPrompt
            closing={dialogClosing}
            onEnable={() => {
              setAutoFocus(true);
              closeDialog();
            }}
            onDecline={() => {
              setAutoFocus(false);
              closeDialog();
            }}
          />
        )}

        {suspended && asb && (
          <SuspendedOverlay
            asb={asb}
            paused={lifecycle === "PAUSED"}
            pending={pending}
            onPlayPause={() => action(lifecycle === "PAUSED" ? api.play : api.pause)}
            onReset={() => action(() => api.seek(0))}
            onTerminate={() => action(() => api.terminate())}
          />
        )}
      </main>
    </div>
  );
}
