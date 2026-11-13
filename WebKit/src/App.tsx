// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import NetworkMap from "./map/NetworkMap";
import type { MapControls, MapTransform } from "./map/NetworkMap";
import { TelemetryDeck } from "./panels/TelemetryDeck";
import { CommandRail } from "./panels/CommandRail";
import { LayersPopover } from "./map/LayersPopover";
import { Floating } from "./components/Popover";
import { MapDock } from "./map/MapDock";
import { Logo } from "./components/Logo";
import { Icon } from "./components/Icons";
import { BootFailure, launchStage, ShutdownSurface, Splash, splashStageFor, useBootPhase, usePacedStages } from "./film/Splash";
import { reportEta } from "./core/eta";
import { filmAvailable, mapCarry, LANDING_MS, landingPoints, MAP_AT_MS, PANELS_AT_MS, QUICK_ARRIVAL, REJOIN_MIN_MS } from "./film/BootScene";
import { usePresence } from "./CoreMotion/presence";
import { settle, useSettle } from "./CoreMotion/settle";
import { PlaceLegend, RoadLegend } from "./map/Legends";
import { NotificationHistory } from "./notifications/notificationHistory";
import { ViewportNotice, useViewportSize, viewportTooSmall } from "./panels/Viewport";
import {
  AboutCard,
  AutoFocusPrompt,
  CompletionDialog,
  ConfirmCard,
  SeedToCopy,
  SuspendedOverlay,
  WorldGenerationOverlay,
} from "./panels/Dialogs";
import type { CompletionSummary } from "./panels/Dialogs";
import { Tooltip } from "./components/Tooltip";
import { ReportFilm } from "./report/ReportFilm";
import type { ReportPreview } from "./report/ReportFilm";
import { useISDNotifications } from "./notifications/ISDHandler";
import { BindingsContext, resolveBindings, useShortcuts } from "./core/shortcuts";
import { useSteadyStatus } from "./simulation/useSteadyStatus";
import { RATES, rateIndexOf } from "./panels/CommandRail";
import type { ISDCondition } from "./notifications/ISDHandler";
import { Tutorial } from "./tutorial/Tutorial";
import { EngineGate } from "./panels/EngineGate";
import { localiseNames } from "./core/labelLanguage";
import { useTutorial } from "./tutorial/useTutorial";
import { NotificationCapsule } from "./notifications/NotificationCapsule";
import { SettingsDrawer } from "./panels/SettingsDrawer";
import { useSimulation } from "./simulation/useSimulation";
import { excuseBackpressure, useBackpressure, describeAsb, formatRate } from "./simulation/useBackpressure";
import { api, UNREACHABLE } from "./core/api";
import { SeekFilm, type Seek } from "./film/SeekFilm";
import { useDaemonNotifications } from "./simulation/daemons";
import { formatCoordinate } from "./core/mapProjection";
import { MOTION_MS } from "./CoreMotion/motion";
import { applyAppearance, resolveTheme } from "./core/appearance";
import { installEdgeResistance } from "./CoreMotion/resistance";
import { setByteUnits } from "./core/units";
import { MapReadout } from "./map/MapReadout";
import type { MapReadoutHandle } from "./map/MapReadout";
import { fabric, useFabricNotifications } from "./webfabric/store";
import { FabricDialog, FabricDockItems, FabricHeader, FabricIndicators, FabricPanel, FabricSidebar, FabricStatus } from "./webfabric/Slots";
import { FabricOverlay } from "./webfabric/Overlay";
import { useFabricApps, useHeld, useLaunchPlan } from "./webfabric/store";
import { useFeatures } from "./core/features";
import { MusicControl, useFullscreen } from "./film/Presentation";
import { heldOver, PERSON_HOLDS_CAMERA_MS, releaseKey, viewDeclined, viewTarget } from "./webfabric/direction";
import type { FabricOverlayHandle } from "./webfabric/Overlay";
import { BUILT_IN, clearOverrides, loadConfig, resolveReduceMotion, writeOverrides } from "./core/uiConfig";
import type { UiConfig, AutoFocusStrategy } from "./core/uiConfig";
import { AdvancedContext, TimeFormatProvider } from "./core/preferences";
import { boundsOf, chooseTarget, focusTargets, framingSignature } from "./notifications/autoFocus";
import type { Bounds } from "./notifications/autoFocus";
import {
  buildNotifications,
  focusMatches,
  orderForDisplay,
  shouldDisplayNotification,
} from "./core/notificationModel";
import type { UiNotification } from "./core/notificationModel";
import { focusNotification } from "./notifications/focusNotification";
import { TelemetryRecorder, runtimeStatus, sampleFrom } from "./simulation/telemetryRecorder";
import { DAY_SECONDS, formatDuration, formatSimulationTime } from "./core/timeFormat";
import type { Congestion, Layers, MapFeature, NarratorStatus, News, PlaceVisibility, WorldStatus } from "./core/types";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
// style.css carries the map canvas and base rules; theme.css the shell;
// hud.css the floating instrumentation; system.css the shared tokens and
// redesigned surfaces, and wins overlaps.
import "./styles/style.css";
import "./styles/theme.css";
import "./styles/hud.css";
import "./styles/system.css";
import "./CoreMotion/motion.css";
import "./styles/webfabric.css";
import "./styles/design.css";

export const VERSION = "3.4.0";

const DECK_KEY = "dstns.telemetry-mode.v1";

function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener?.("change", onChange);
    return () => list.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}

/** Dialogs are mutually exclusive; one slot keeps them from stacking. */
type DialogKind = "about" | "reset" | "terminate" | "auto-focus" | "regenerate" | "complete" | null;

const NO_FEATURES: MapFeature[] = [];

type FocusRequest = { whole?: boolean; zoomBy?: number; span_m?: number; bounds?: Bounds; x_m?: number; y_m?: number; scale?: number; padding?: number; token: number };

/** How long the panels take to come to rest once they are let in. */
const SETTLE_MS = 700;

interface WorldJob {
  active: boolean;
  requestedSeed: string;
  status: WorldStatus | null;
  error: string;
  closing: boolean;
}
/**
 * What may be on screen as a world arrives. While the film is building the roads nothing is;
 * then the map comes under them, and last of all the panels come in around it.
 */
function useArrival(covered: boolean, instant: boolean, quick: boolean): "covered" | "map" | "all" {
  const [stage, setStage] = useState<"covered" | "map" | "all">(covered ? "covered" : "all");
  useEffect(() => {
    if (covered) {
      setStage("covered");
      return;
    }
    if (instant) {
      setStage("all");
      return;
    }
    const map = setTimeout(() => setStage((now) => (now === "covered" ? "map" : now)), quick ? QUICK_ARRIVAL.mapAt : MAP_AT_MS);
    const panels = setTimeout(() => setStage("all"), quick ? QUICK_ARRIVAL.panelsAt : PANELS_AT_MS);
    return () => {
      clearTimeout(map);
      clearTimeout(panels);
    };
  }, [covered, instant, quick]);
  return stage;
}

const NO_WORLD_JOB: WorldJob = { active: false, requestedSeed: "", status: null, error: "", closing: false };

/** A concise, operator-facing reason for a failed world generation. */
export function worldErrorMessage(code: string, message: string): string {
  if (code === "MAP_FETCH_FAILED") {
    // The core prefixes the city and coordinates, and the downloader its own
    // name; what follows is the cause, which may name several mirrors and what
    // to do about them, so it is kept whole.
    const cause = message.replace(/^.*?fetch_osm:\s*/s, "").replace(/^OSM download failed[^:]*:\s*/s, "").trim();
    return `This city's map could not be downloaded from OpenStreetMap. ${cause || message}`.trim();
  }
  if (code === "WORLD_REGENERATION_DISABLED") return "World generation is disabled for this deployment.";
  if (code === "LIFECYCLE_CONFLICT") return message.charAt(0).toUpperCase() + message.slice(1) + ".";
  return "The new world could not be generated. Retry, or return to the current world.";
}

/** What the News setting says about the narrator, for its hint. */
/** Why Realistic News cannot run, in a word or two; nothing when it can. */
export function narratorBadge(status: NarratorStatus | null): string | undefined {
  if (!status || !status.enabled) return "Not supported on this device";
  if (status.state === "unavailable" || status.state === "disabled") return "Model not responding";
  if (status.state === "starting") return "Loading";
  return undefined;
}

function narratorNote(status: NarratorStatus | null): string {
  if (!status) return "Unavailable: the core did not report a narrator.";
  if (!status.enabled) return "Unavailable: Apple Foundation Models are not available or are turned off for this server.";
  if (status.state === "unavailable" || status.state === "disabled")
    return `Unavailable: ${status.last_error || "the model is not answering"}.`;
  const model = status.backend?.on_device ? "Apple's on-device Foundation Model" : "the configured language model";
  const loading = status.state === "starting" ? " It is loading; Standard wording shows meanwhile." : "";
  return `Written by ${model} from the event, the road, the hour, the places nearby and the day so far.${loading}`;
}

export default function App() {
  // ---- Configuration ----------------------------------------------------
  const [config, setConfig] = useState<UiConfig>(BUILT_IN);
  // Realistic News needs the core's narrator; ask what it is doing now and then.
  const [narrator, setNarrator] = useState<NarratorStatus | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      api.narrator().then((r) => live && setNarrator(r.data), () => live && setNarrator(null));
    void load();
    const timer = setInterval(load, 20000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const realisticAvailable = !!narrator?.enabled && narrator.state !== "unavailable" && narrator.state !== "disabled";
  const realistic = config.news.style === "realistic" && realisticAvailable;
  const simulation = useSimulation(config.notifications.dwell_ms, realistic);
  // Road and place names in the language chosen for labels (ui.display.label_language); display only.
  const localTopology = useMemo(() => localiseNames(simulation.topology, config.display.label_language), [simulation.topology, config.display.label_language]);
  const sim = useMemo(() => (localTopology === simulation.topology ? simulation : { ...simulation, topology: localTopology }), [simulation, localTopology]);
  const [operatorConfig, setOperatorConfig] = useState<UiConfig>(BUILT_IN);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [layers, setLayers] = useState<Layers>(BUILT_IN.layers);
  const [places, setPlaces] = useState<PlaceVisibility>(BUILT_IN.places);
  const [motionChoice, setMotionChoice] = useState(() => resolveReduceMotion(BUILT_IN.reduce_motion));

  useEffect(() => {
    let cancelled = false;
    void loadConfig().then(({ config: resolved, operator }) => {
      if (cancelled) return;
      setConfig(resolved);
      setOperatorConfig(operator);
      setLayers(resolved.layers);
      setPlaces(resolved.places);
      setMotionChoice(resolveReduceMotion(resolved.reduce_motion));
      setConfigLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the viewer's choices as deltas from the operator defaults, so a
  // later edit to config/ui-config.json still reaches fields they never touched.
  const persist = useCallback(
    (patch: Partial<UiConfig>) => {
      setConfig((current) => {
        const next = { ...current, ...patch };
        writeOverrides(next, operatorConfig);
        return next;
      });
    },
    [operatorConfig],
  );
  const hour12 = config.clock.hour12;
  const dnd = config.notifications.dnd;
  const toggleHour12 = useCallback(() => persist({ clock: { hour12: !config.clock.hour12 } }), [persist, config.clock.hour12]);

  // ---- Appearance ---------------------------------------------------------
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const access = config.accessibility;
  const theme = resolveTheme(access.theme, prefersDark);
  const [appearanceKey, setAppearanceKey] = useState(0);
  useLayoutEffect(() => {
    applyAppearance({ theme, vision: access.color_vision, reduceTransparency: access.reduce_transparency, highContrast: access.high_contrast, advanced: access.advanced });
    setAppearanceKey((n) => n + 1);
  }, [theme, access.color_vision, access.reduce_transparency, access.high_contrast, access.advanced]);
  useEffect(() => installEdgeResistance(), []);
  useEffect(() => setByteUnits(config.display.byte_units), [config.display.byte_units]);

  // ---- Shell state ------------------------------------------------------
  const [layersOpen, setLayersOpen] = useState(false);
  const layersTrigger = useRef<HTMLButtonElement>(null);
  const [preferencesEpoch, setPreferencesEpoch] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Anything open puts itself away before a dialog asks about the whole session.
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeLayers = useCallback(() => setLayersOpen(false), []);
  useSettle(settingsOpen, closeSettings, 700, () => setSettingsOpen(true));
  useSettle(layersOpen, closeLayers, 700, () => setLayersOpen(true));
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dialogClosing, setDialogClosing] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [history, setHistory] = useState<Congestion | null>(null);
  // Pointer position and camera update every frame, so they go straight to the
  // readout and never through this component's state.
  const readout = useRef<MapReadoutHandle>(null);
  const mapScale = useRef(1);
  const [mapStatus, setMapStatus] = useState<Record<string, unknown> | null>(null);
  const [shutDown, setShutDown] = useState(false);
  const [manualFocus, setManualFocus] = useState<FocusRequest | null>(null);
  const [appFocus, setAppFocus] = useState<FocusRequest | null>(null);
  const personMovedAt = useRef(-Infinity);
  useEffect(() => {
    if (manualFocus) personMovedAt.current = performance.now();
  }, [manualFocus]);
  // It has its moment, and then whatever else was going to happen goes on happening.
  useEffect(() => {
    if (!appFocus) return;
    const timer = setTimeout(() => setAppFocus(null), PERSON_HOLDS_CAMERA_MS);
    return () => clearTimeout(timer);
  }, [appFocus]);
  const [world, setWorld] = useState<WorldJob>(NO_WORLD_JOB);
  const [regenerationEnabled, setRegenerationEnabled] = useState(true);
  const [completion, setCompletion] = useState<CompletionSummary | null>(null);
  const [reportError, setReportError] = useState("");
  const mapControls = useRef<MapControls | null>(null);
  const focusToken = useRef(0);
  const recorder = useRef(new TelemetryRecorder());

  const status = sim.status?.data;
  // A world waiting for the start-up to finish is about to run, and nobody asked it to pause.
  const lifecycle = status?.observer_hold ? "RUNNING" : status?.lifecycle ?? "IDLE";
  const clock = sim.snapshot?.clock ?? sim.status?.clock;
  const virtual = clock?.virtual_day_seconds ?? 0;
  const valid = !!sim.snapshot && !sim.error && !sim.stale;
  const congestion = sim.snapshot?.data.congestion;
  const rawLocation = sim.topology?.location;
  const location = rawLocation?.city ? rawLocation : undefined;
  const origin = sim.topology?.projection;
  const runId = sim.status?.run_id ?? "";
  // The seed an operator reads and retypes is the raw number, not the hash.
  const seed = sim.status?.seed || sim.status?.global_seed || "";

  // ---- Backpressure -----------------------------------------------------
  const { asb, resetToken, catchingUp } = useBackpressure({
    enabled: config.asb.enabled,
    intervalMs: config.asb.report_interval_ms,
    renderedVirtualSecond: sim.snapshot?.clock.virtual_day_seconds ?? 0,
    coreVirtualSecond: sim.status?.clock.virtual_day_seconds ?? 0,
    lastDataAt: sim.lastDataAt,
    // Keep reporting while data is stale: that is the condition ASB acts on.
    // A world being replaced is the exception: nothing measured across that
    // swap describes how well the interface is keeping up.
    active: !!runId && !["IDLE", "TERMINATING"].includes(lifecycle) && !world.active,
    runId,
  });
  const suspended = asb?.gui_suspended === true;
  const rateLocked = asb?.rate_locked === true;
  const motionLocked = asb?.motion_locked === true;
  // A long jump has just landed: the speed climbs back from a quarter, with motion reduced, on purpose.
  const jumpRestricted = asb?.state === "RESTRICTED" && asb.restriction === "jump";
  // Falling behind costs the map its animation. The interface around it stays as it was.
  const reduceMotion = motionChoice;
  const mapStill = motionChoice || motionLocked;
  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);
  const runtime = useSteadyStatus(runtimeStatus({ connected: !!sim.snapshot, stale: sim.stale, error: !!sim.error, asb }));

  const [tutorialTarget, setTutorialTarget] = useState("");
  // Below 1024px the full deck opens over the map on request; above it the
  // viewer chooses between the panel and its collapsed strip.
  const [telemetryOpen, setTelemetryOpen] = useState(false);
  const [deckCollapsed, setDeckCollapsed] = useState(() => {
    try {
      return localStorage.getItem(DECK_KEY) === "compact";
    } catch {
      return false;
    }
  });
  const narrow = useMediaQuery("(max-width: 1024px)");
  const touringTelemetry = tutorialTarget === "telemetry" || tutorialTarget.startsWith("telemetry-");
  const deckCompact = !touringTelemetry && (narrow ? !telemetryOpen : deckCollapsed);
  const setCollapsed = useCallback(
    (collapsed: boolean) => {
      if (narrow) {
        setTelemetryOpen(!collapsed);
        return;
      }
      setDeckCollapsed(collapsed);
      try {
        localStorage.setItem(DECK_KEY, collapsed ? "compact" : "full");
      } catch {
        /* A remembered layout is a convenience only. */
      }
    },
    [narrow],
  );
  // The tour waits for the start-up film to finish handing over.
  const startupOnScreen = useRef(false);
  // The unstable-engine gate is on screen: it comes before the tour and notifications, which wait.
  const [gateOpen, setGateOpen] = useState(false);
  // The start-up has landed and its panels have come to rest; a tour that opens by itself waits for this.
  const [settled, setSettled] = useState(false);
  const tutorial = useTutorial({
    config: config.tutorial,
    ready: configLoaded && valid && !!sim.topology && ["RUNNING", "PAUSED"].includes(lifecycle) && !startupOnScreen.current && settled,
    runId,
    suspended: suspended || rateLocked,
    playbackRevision: status?.playback_revision,
    blocked: !!dialog || layersOpen || settingsOpen || pending || world.active || gateOpen,
    onError: setActionError,
  });

  const fabricApps = useFabricApps();
  const [reducedDetail, setReducedDetail] = useState(false);
  const appliedRate = clock?.tick_rate ?? 1;
  // Only what the core says is capped. The two figures are polled apart, so right after a
  // change of speed they differ for a moment with nothing holding it back.
  const requestedRate = asb?.rate_capped ? (asb.requested_tick_rate ?? appliedRate) : appliedRate;
  // What looks like a fault but is not. The tour has the screen to itself.
  const intentional: ISDCondition[] = tutorial.active
    ? []
    : [
        catchingUp && ("returned" as const),
        suspended && ("async" as const),
        jumpRestricted && ("jump" as const),
        asb?.state === "RESTRICTED" && !jumpRestricted && ("restricted" as const),
        rateLocked && ("rate-locked" as const),
        !rateLocked && !jumpRestricted && !!asb && Math.abs(requestedRate - appliedRate) > 1e-6 && ("rate-governed" as const),
        motionLocked && !motionChoice && !jumpRestricted && ("motion-locked" as const),
        lifecycle === "RUNNING" && appliedRate > 5 && ("large-steps" as const),
        reducedDetail && ("reduced-detail" as const),
        fabricApps.some((app) => app.state === "suspended" && !app.user_suspended) && ("app-lapsed" as const),
      ].filter((condition): condition is Exclude<typeof condition, false> => !!condition);

  // ASB's default state strips the presentation back to a minimum and soft restarts
  // it, as a reload would, without reloading the page. Roads and buildings stay: they
  // are drawn once and cached, so they cost nothing per frame, and a map without them
  // looks as if it has failed. What goes is what is redrawn all the time.
  const softReset = useCallback(() => {
    setLayers((current) => ({
      ...current,
      roads: true,
      buildings: true,
      traffic: false,
      vehicles: false,
      labels: false,
      place_names: false,
      weather: false,
    }));
  }, []);
  // What applications hold is laid over a person's layers and places, and is never one of them: `layers` and
  // `places` stay theirs, and are all that is saved. What is drawn is `shownLayers` and `shownPlaces`.
  const held = useHeld();
  const [released, setReleased] = useState<ReadonlyMap<string, number>>(new Map());
  const { shown: shownLayers, holders: layerHolders } = useMemo(() => heldOver(layers, held, "layers", released, reducedDetail), [layers, held, released, reducedDetail]);
  const { shown: shownPlaces, holders: placeHolders } = useMemo(() => heldOver(places, held, "places", released, false, true), [places, held, released]);
  const release = (field: "layers" | "places", keys: readonly string[]) =>
    setReleased((current) => {
      const next = new Map(current);
      for (const app of held) for (const key of keys) if (key in app[field]) next.set(releaseKey(app.app, field, key), app.revision);
      return next;
    });
  const beforeAsbLayers = useRef<Layers | null>(null);
  const seenReset = useRef(resetToken);
  useEffect(() => {
    if (resetToken !== seenReset.current) {
      seenReset.current = resetToken;
      if (!beforeAsbLayers.current) beforeAsbLayers.current = layers;
      setReducedDetail(true);
      softReset();
    }
    // A speed still being capped is not a reason to keep detail off once it is back in sync.
    if (asb?.state === "NORMAL" && asb.synced && beforeAsbLayers.current) {
      setLayers(beforeAsbLayers.current);
      beforeAsbLayers.current = null;
      setReducedDetail(false);
    }
  }, [resetToken, softReset, asb?.state, asb?.synced, layers]);

  // ---- Telemetry recording ------------------------------------------------
  useEffect(() => {
    if (runId) recorder.current.reset(runId);
  }, [runId]);
  useEffect(() => {
    const snap = sim.snapshot;
    if (!snap || snap.run_id !== recorder.current.runId) return;
    recorder.current.sample(
      sampleFrom({
        snapshot: snap.data,
        virtual_s: snap.clock.virtual_day_seconds,
        lifecycle: sim.status?.data.lifecycle ?? snap.clock.playback_state,
        tick_rate: snap.clock.tick_rate,
        asb,
        latency_ms: sim.latencyMs,
        status: runtime,
      }),
    );
    // Sampled once per delivered snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim.snapshot]);
  // The server's memory and this page's, every few seconds while a run is open, for the report's resources chart.
  const virtualRef = useRef(virtual);
  virtualRef.current = virtual;
  useEffect(() => {
    if (!runId) return;
    let stopped = false;
    const read = () => {
      api
        .resources()
        .then(({ process }) => {
          if (stopped || recorder.current.runId !== runId) return;
          const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
          recorder.current.resource({
            virtual_s: virtualRef.current,
            rss_bytes: process.rss_bytes,
            peak_rss_bytes: process.peak_rss_bytes,
            cpu_s: process.cpu_s,
            heap_bytes: heap ? heap.usedJSHeapSize : null,
            heap_limit_bytes: heap ? heap.jsHeapSizeLimit : null,
          });
        })
        .catch(() => {
          /* An older core without the route, or a moment without the server: the chart says what it has. */
        });
    };
    read();
    const timer = setInterval(read, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runId]);
  const logControl = useCallback(
    (action: string, detail = "") => recorder.current.control(action, detail, virtual),
    [virtual],
  );

  // ---- Auto Focus ---------------------------------------------------------
  const mode = config.auto_focus.mode;
  const [autoFocus, setAutoFocus] = useState(false);
  // The offer is made once per run, and the answer survives a reload.
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

  useEffect(() => {
    if (!configLoaded) return;
    if (mode === "enable-force") setAutoFocus(true);
    if (mode === "disable") setAutoFocus(false);
  }, [configLoaded, mode]);

  // "enable" offers the choice once per run rather than deciding for the operator.
  useEffect(() => {
    if (mode !== "enable" || !configLoaded) return;
    if (!runId || !sim.topology || suspended || tutorial.busy || dialog || world.active) return;
    if (promptedRun === runId) return;
    setPromptedRun(runId);
    rememberAnswer(runId);
    setDialog((current) => current ?? "auto-focus");
  }, [mode, configLoaded, runId, sim.topology, suspended, promptedRun, rememberAnswer, tutorial.busy, dialog, world.active]);

  const targets = useMemo(() => focusTargets(sim.snapshot?.data ?? null, sim.topology), [sim.snapshot, sim.topology]);
  // When each target first appeared, for the Latest order.
  const firstSeen = useRef(new Map<string, number>());
  useEffect(() => {
    firstSeen.current.clear();
  }, [runId]);
  for (const t of targets) if (!firstSeen.current.has(t.key)) firstSeen.current.set(t.key, performance.now());

  const [focusIndex, setFocusIndex] = useState(0);
  const targetKeys = targets.map((t) => t.key).join("|");
  useEffect(() => setFocusIndex(0), [targetKeys]);
  useEffect(() => {
    // Round-Robin rotates; Latest stays on the newest and needs no timer.
    if (tutorial.busy || !autoFocus || config.auto_focus.strategy !== "round-robin" || targets.length < 2) return;
    const timer = setInterval(() => setFocusIndex((i) => i + 1), config.auto_focus.dwell_seconds * 1000);
    return () => clearInterval(timer);
  }, [autoFocus, tutorial.busy, config.auto_focus.strategy, config.auto_focus.dwell_seconds, targets.length]);

  const active = autoFocus ? chooseTarget(targets, config.auto_focus.strategy, focusIndex, firstSeen.current) : undefined;
  const activeKey = active?.key ?? null;
  // The camera moves only when the framing an event needs actually changes:
  // a new event, or a rain footprint that has grown or drifted materially.
  const framing = active ? framingSignature(active) : autoFocus && sim.topology ? `network:${runId}` : "";
  const autoFocusRequest = useMemo<FocusRequest | null>(() => {
    if (!framing) return null;
    focusToken.current += 1;
    if (active) return { bounds: boundsOf(active.geometry), token: focusToken.current };
    return { whole: true, token: focusToken.current };
    // A new token is minted only when the framing changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framing]);

  // ---- WebFabric ----------------------------------------------------------
  useEffect(() => {
    fabric.start();
    return () => fabric.stop();
  }, []);
  // Frames follow the simulation at the observer's own pace.
  useEffect(() => {
    if (!sim.snapshot) return;
    fabric.publishSim({ lifecycle, virtual_s: virtual, tick_rate: clock?.tick_rate ?? 1, congestion: congestion?.current ?? 0, run_id: runId });
    // Once per delivered snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim.snapshot]);
  const [sidebarInset, setSidebarInset] = useState(0);
  const overlay = useRef<FabricOverlayHandle>(null);
  const features = useFeatures();
  const webfabricOn = features.presentation.webfabric;
  const mapView = useRef<MapTransform | null>(null);
  const landedAt = useRef<MapTransform | null>(null);
  const onMapTransform = useCallback<NonNullable<ComponentProps<typeof NetworkMap>["onTransform"]>>((view) => {
    mapView.current = view;
    // Particles standing on the roads go with them as the camera moves.
    if (landedAt.current) {
      mapCarry.x = view.x - landedAt.current.x;
      mapCarry.y = view.y - landedAt.current.y;
    }
    mapScale.current = view.scale;
    overlay.current?.draw(view);
    readout.current?.camera(view.scale);
  }, []);
  const onMapCursor = useCallback((point: { lat: number; lon: number } | null) => readout.current?.cursor(point), []);
  const fabricNotes = useFabricNotifications(config.notifications.dwell_ms, virtual);
  const daemonNotes = useDaemonNotifications(config.notifications.dwell_ms, virtual);

  // ---- Notifications ------------------------------------------------------
  const [dismissedFocus, setDismissedFocus] = useState<Set<string>>(new Set());
  useEffect(() => setDismissedFocus(new Set()), [runId]);
  const isdNotes = useISDNotifications(intentional, { requested: requestedRate, applied: appliedRate }, virtual);
  // Once the day has ended nothing more is happening in it, so its events stop too.
  const dayOver = lifecycle === "COMPLETED";
  const notifications = useMemo(() => [...isdNotes, ...(dayOver ? [] : buildNotifications(sim.toasts, sim.topology)), ...fabricNotes.notes, ...daemonNotes.notes], [isdNotes, dayOver, sim.toasts, sim.topology, fabricNotes.notes, daemonNotes.notes]);
  const policy = useMemo(
    () => ({
      enabled: config.notifications.enabled,
      dnd,
      mutedCategories: config.notifications.dnd_categories,
      mutedSeverities: config.notifications.dnd_severities,
    }),
    [config.notifications, dnd],
  );
  const onScreen = useRef(new Set<string>());
  const { shown } = useMemo(() => {
    const focus = { enabled: autoFocus, targetKey: activeKey };
    // Do Not Disturb stops new notifications. One already on screen lives out its
    // time: it was seen, and taking it away mid-read would be its own disturbance.
    const visible = notifications.filter((n) => shouldDisplayNotification(n, policy, focus) || (policy.enabled && onScreen.current.has(n.id)));
    let list: UiNotification[] = visible;
    // The event auto-focus is showing always has a notification, even if the
    // news that announced it has expired or was muted.
    if (!dayOver && autoFocus && active && sim.snapshot && !dismissedFocus.has(active.key) && !list.some((n) => focusMatches(n.focusKey, activeKey)))
      list = [focusNotification(active, sim.snapshot.data, sim.topology, virtual), ...list];
    list = orderForDisplay(list, activeKey, config.notifications.important_first);
    onScreen.current = new Set(list.map((n) => n.id));
    return { shown: list };
    // Rebuilt when inputs change; the virtual clock alone does not warrant it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications, policy, autoFocus, activeKey, active?.key, sim.snapshot, sim.topology, dismissedFocus, dayOver, config.notifications.important_first]);
  // ---- Notification history ------------------------------------------------
  // Every notification-worthy event is kept, whether or not it was shown.
  const historyStore = useRef(new NotificationHistory());
  const [historyRevision, setHistoryRevision] = useState(0);
  useEffect(() => {
    // A new world starts clean, unless the launcher's worlds.keep_history keeps the history across them.
    historyStore.current.reset(runId, features.presentation.keep_history ?? false);
    setHistoryRevision(historyStore.current.revision);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);
  useEffect(() => {
    const store = historyStore.current;
    if (!runId || store.runId !== runId) return;
    const byId = new Map(sim.toasts.map((n) => [n.news_id, n]));
    const shownIds = new Set(shown.map((n) => n.id));
    const ctx = {
      shownIds,
      enabled: policy.enabled,
      focusKey: autoFocus ? activeKey : null,
      wouldShow: (n: UiNotification) => shouldDisplayNotification(n, policy, { enabled: false, targetKey: null }),
    };
    let changed = store.recordNotifications(notifications, byId, sim.topology, ctx);
    // The synthesised Auto Focus record, when one is on screen.
    changed = store.recordNotifications(shown.filter((n) => !n.newsIds.length), byId, sim.topology, ctx) || changed;
    changed = store.recordBacklog(sim.news, sim.topology) || changed;
    if (autoFocus) changed = store.markFocused(activeKey) || changed;
    if (changed) setHistoryRevision(store.revision);
  }, [runId, notifications, shown, sim.news, sim.toasts, sim.topology, policy, autoFocus, activeKey]);
  const historyFeed = useMemo(
    () => ({ entries: historyStore.current.list(), counts: historyStore.current.counts(), revision: historyRevision }),
    [historyRevision],
  );

  const dismissNotification = useCallback(
    (n: UiNotification) => {
      if (n.newsIds.length) sim.dismissToasts(n.newsIds);
      if (n.type === "APPLICATION") fabricNotes.dismiss(n.id);
      if (n.type === "DAEMON") daemonNotes.dismiss(n.id);
      if (n.focusKey && !n.newsIds.length) setDismissedFocus((s) => new Set(s).add(n.focusKey!));
    },
    [sim, fabricNotes, daemonNotes],
  );

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
        /* Supplementary; the report falls back to the current value. */
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
        const res = await fetch("/api/v1/system/map-status", { signal: AbortSignal.timeout(5000) });
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

  // Whether this deployment allows world regeneration at all.
  useEffect(() => {
    let cancel = false;
    api
      .worldStatus()
      .then((r) => {
        if (!cancel) {
          setRegenerationEnabled(r.data.enabled !== false);
          if (r.data.state === "generating") setWorld({ ...NO_WORLD_JOB, active: true, status: r.data, requestedSeed: r.data.seed });
        }
      })
      .catch(() => {
        /* An older core without the endpoint: leave the control enabled; a request reports why it failed. */
      });
    return () => {
      cancel = true;
    };
  }, []);

  // ---- Actions ----------------------------------------------------------
  // A jump through the day, while the server works it out, for the particles that show it.
  const [seeking, setSeeking] = useState<Seek | null>(null);
  const seekBy = useCallback((delta: number, from: number) => {
    const to = Math.max(0, Math.min(DAY_SECONDS, from + delta));
    setSeeking({ direction: delta < 0 ? -1 : 1, seconds: Math.abs(to - from), from, to });
    return api.seek(to).finally(() => setSeeking(null));
  }, []);
  /** Back to the start of the day: the day rewinds before your eyes, for at least a moment however quick the jump. */
  const rewindDay = useCallback((from: number, play: boolean) => {
    const began = performance.now();
    setSeeking({ direction: -1, seconds: Math.max(3600, from), from, to: 0 });
    return api.seek(0, play).finally(() => setTimeout(() => setSeeking(null), Math.max(0, 1300 - (performance.now() - began))));
  }, []);
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

  // A terminated server does not come back, so the interface says so rather than
  // reporting a lost connection for ever.
  const terminate = useCallback(async () => {
    await api.terminate();
    setShutDown(true);
  }, []);

  // The clear a closing dialog has scheduled. Opening another dialog cancels
  // it, or the clear would take the new dialog with it a moment after it
  // appeared.
  const dialogCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDialogClose = useCallback(() => {
    if (dialogCloseTimer.current !== null) clearTimeout(dialogCloseTimer.current);
    dialogCloseTimer.current = null;
  }, []);
  const closeDialog = useCallback(() => {
    // Let the exit transition run before the node is removed.
    cancelDialogClose();
    setDialogClosing(true);
    dialogCloseTimer.current = setTimeout(() => {
      dialogCloseTimer.current = null;
      setDialog(null);
      setDialogClosing(false);
    }, MOTION_MS.dismiss);
  }, [cancelDialogClose]);
  /** Open a dialog, replacing any that is open or still leaving. */
  const openDialog = useCallback(
    (next: Exclude<DialogKind, null>) => {
      cancelDialogClose();
      setDialogClosing(false);
      setDialog(next);
    },
    [cancelDialogClose],
  );
  useEffect(() => cancelDialogClose, [cancelDialogClose]);

  const [reportFilm, setReportFilm] = useState<{ label: string; share: number; ready: boolean } | null>(null);
  const reportFile = useRef<{ blob: Blob; name: string } | null>(null);
  const saveReport = useCallback(() => {
    excuseBackpressure();
    const file = reportFile.current;
    reportFile.current = null;
    if (!file) return;
    const url = URL.createObjectURL(file.blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: file.name });
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, []);
  const closeReportFilm = useCallback(() => {
    setReportFilm(null);
    // Once the film has gone, what was open before it comes back.
    const back = afterReport.current;
    afterReport.current = null;
    if (back) window.setTimeout(back, 260);
  }, []);
  const reportView = useCallback(() => {
    const view = mapView.current;
    const box = document.querySelector(".static-map")?.getBoundingClientRect();
    return view && box ? { view, box } : null;
  }, []);
  const reportPreview: ReportPreview | null = sim.topology && sim.snapshot && {
    city: sim.topology?.location?.city || "Explicit map file",
    country: sim.topology?.location?.country || "",
    seed: sim.status?.seed || sim.status?.global_seed || "",
    generated: new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
    topology: sim.topology,
    snapshot: sim.snapshot.data,
    virtualS: sim.snapshot.clock.virtual_day_seconds,
  };
  // What was open before a report, brought back once it has been saved or put away.
  const afterReport = useRef<(() => void) | null>(null);
  const report = useCallback(
    () =>
      action(async () => {
        setReportError("");
        if (!sim.status || !sim.snapshot || !sim.topology) throw new Error("The report needs a loaded simulation.");
        // Whatever is open goes first (a finished day's card included), so the film has the screen to itself.
        if (dialog) closeDialog();
        afterReport.current = await settle();
        try {
          // The film takes the city from the map as it is on screen, so the whole of it is brought into view first,
          // and the camera is given time to arrive.
          mapControls.current?.fit();
          await new Promise((settled) => setTimeout(settled, reduceMotion ? 60 : 1100));
          setReportFilm({ label: "Gathering the run", share: 0, ready: false });
          excuseBackpressure(12000);
          const [{ exportReport }, fullNews] = await Promise.all([
            import("./report/report"),
            api.allNews(sim.status.run_id).catch(() => sim.news),
          ]);
          reportFile.current = await exportReport(
            {
              status: sim.status,
              snapshot: sim.snapshot,
              topology: sim.topology,
              congestion: history ?? sim.snapshot.data.congestion,
              news: fullNews,
              asb,
              telemetry: recorder.current.export(),
              hour12,
              uiVersion: VERSION,
              layers: shownLayers,
            },
            (label, share) => setReportFilm((film) => film && { ...film, label, share }),
          );
          setReportFilm((film) => film && { ...film, label: "Done", share: 1, ready: true });
          logControl("report", "downloaded");
        } catch (e) {
          const message = e instanceof Error ? e.message : "The report could not be generated.";
          setReportError(message);
          setReportFilm(null);
          afterReport.current?.();
          afterReport.current = null;
          throw new Error(`Report generation failed. ${message}`);
        }
      }),
    [action, sim.status, sim.snapshot, sim.topology, sim.news, history, asb, hour12, shownLayers, logControl, reduceMotion, dialog, closeDialog],
  );

  const setMotion = (next: boolean) => {
    setMotionChoice(next);
    persist({ reduce_motion: next ? "on" : "off" });
  };
  const setDnd = (next: boolean) => persist({ notifications: { ...config.notifications, dnd: next } });
  const setStrategy = (strategy: AutoFocusStrategy) => persist({ auto_focus: { ...config.auto_focus, strategy } });
  const changeLayers = (next: Layers) => {
    setLayers(next);
    persist({ layers: next });
  };
  const changePlaces = (next: PlaceVisibility) => {
    setPlaces(next);
    persist({ places: next });
  };
  // Only what the person changed becomes theirs. Whatever else an application is holding is left out of it.
  const changeShownLayers = (next: Layers) => {
    const changed = (Object.keys(next) as (keyof Layers)[]).filter((key) => next[key] !== shownLayers[key]);
    release("layers", changed);
    changeLayers({ ...layers, ...Object.fromEntries(changed.map((key) => [key, next[key]])) });
  };
  const changeShownPlaces = (next: PlaceVisibility) => {
    const changed = Object.keys(next).filter((key) => next[key] !== shownPlaces[key]);
    release("places", changed);
    changePlaces({ ...places, ...Object.fromEntries(changed.map((key) => [key, next[key]])) });
  };
  const togglePlace = (kind: string, on: boolean) => changeShownPlaces({ ...shownPlaces, [kind]: on });
  /** Back to the kinds shown out of the box, forgetting every per-kind choice. */
  const resetPlaces = () => {
    release("places", Object.keys(placeHolders));
    changePlaces({ ...operatorConfig.places });
  };
  const resetAllPreferences = () => {
    clearOverrides();
    setConfig(operatorConfig);
    setLayers({ ...operatorConfig.layers });
    setPlaces({ ...operatorConfig.places });
    setMotionChoice(resolveReduceMotion(operatorConfig.reduce_motion));
    setAutoFocus(operatorConfig.auto_focus.mode === "enable-force");
    setManualFocus(null);
    setDeckCollapsed(false);
    setTelemetryOpen(false);
    try {
      localStorage.removeItem(DECK_KEY);
      localStorage.removeItem("dstns.telemetry-tab.v1");
    } catch { /* Session preferences still reset when storage is unavailable. */ }
    setPreferencesEpoch((n) => n + 1);
  };
  // An application asks to move the map, and this decides. It says what it did either way.
  const viewContext = useRef({ busy: null as string | null, world: sim.topology });
  useEffect(
    () =>
      fabric.onView((requests) => {
        for (const { request, app, view } of requests) {
          const { busy, world } = viewContext.current;
          const declined = viewDeclined(performance.now(), personMovedAt.current, busy);
          const target = declined ? null : viewTarget(view, world);
          if (!target) {
            void fabric.reportView(app, request, "declined", declined ?? "no_position");
            continue;
          }
          focusToken.current += 1;
          setManualFocus(null);
          setAppFocus({ ...target, token: focusToken.current });
          void fabric.reportView(app, request, "applied");
        }
      }),
    [],
  );
  const takeCamera = useCallback(() => {
    personMovedAt.current = performance.now();
    setAutoFocus(false);
    setManualFocus(null);
    setAppFocus(null);
  }, []);
  const toggleAutoFocus = (on: boolean) => {
    setAutoFocus(on);
    setManualFocus(null);
  };

  const focusOnPlace = (feature: MapFeature) => {
    setAutoFocus(false);
    focusToken.current += 1;
    setManualFocus({
      x_m: feature.position.x_m,
      y_m: feature.position.y_m,
      scale: Math.max(mapScale.current, 1.6),
      token: focusToken.current,
    });
    // The card is raised once the camera has arrived.
    window.setTimeout(() => mapControls.current?.inspectFeature(feature.id), 1000);
  };

  // ---- Simulation completion ------------------------------------------------
  const completedRuns = useRef(new Set<string>());
  useEffect(() => {
    if (lifecycle !== "COMPLETED" || !runId || completedRuns.current.has(runId)) return;
    completedRuns.current.add(runId);
    const log = recorder.current.export();
    const peak = history?.history?.length ? Math.max(...history.history.map((h) => h.current)) : congestion?.current ?? null;
    const summary: CompletionSummary = {
      seed,
      finalTime: virtual,
      simulatedSeconds: DAY_SECONDS,
      wallMs: log.samples.length ? Date.now() - log.startedWall : null,
      incidents: null,
      significant: null,
      rainEvents: null,
      peakCongestion: peak,
      city: location ? `${location.city}, ${location.country}` : undefined,
    };
    setCompletion(summary);
    // Counts come from the complete record, not the recent window held on screen.
    const countFrom = (items: News[]) =>
      setCompletion((c) =>
        c && {
          ...c,
          incidents: items.filter((n) => n.template_id === "INCIDENT_ACTIVATED").length,
          rainEvents: items.filter((n) => n.template_id === "DWS_RAIN_STARTED").length,
          significant: items.filter((n) => n.severity === "warning" || n.severity === "alert").length,
        },
      );
    api.allNews(runId).then(countFrom).catch(() => countFrom(sim.news));
  }, [lifecycle, runId, seed, virtual, history, congestion, location, sim.news]);
  // Shown as soon as nothing else occupies the dialog slot.
  useEffect(() => {
    // Not while a report is being made from it: the card has stepped aside for the film, and comes back after it.
    if (completion && !dialog && !world.active && !tutorial.busy && !reportFilm && !pending && lifecycle === "COMPLETED") setDialog("complete");
  }, [completion, dialog, world.active, tutorial.busy, lifecycle, reportFilm, pending]);
  useEffect(() => {
    if (lifecycle !== "COMPLETED") setCompletion(null);
  }, [lifecycle]);

  // ---- World generation -----------------------------------------------------
  // With Fast Boot or Dynamic Fastboot, the new world is prepared the moment a person asks for one, while they decide,
  // and put in when they confirm; forgotten if they don't.
  const prepareAhead = features.presentation.fast_boot || features.presentation.dynamic_fastboot;
  const staged = useRef<Promise<boolean> | null>(null);
  const confirmed = useRef(false);
  useEffect(() => {
    if (dialog !== "regenerate" || !prepareAhead || !runId) return;
    confirmed.current = false;
    staged.current = api
      .regenerateWorld(runId, true)
      .then(() => true)
      .catch((e) => {
        console.warn("Could not prepare the new world ahead:", e);
        return false;
      });
    return () => {
      const ahead = staged.current;
      if (!confirmed.current && ahead) {
        void ahead.then((ok) => {
          if (ok) void api.discardWorld().catch(() => undefined);
        });
      }
      if (!confirmed.current) staged.current = null;
    };
  }, [dialog, prepareAhead, runId]);
  const requestWorld = useCallback(async () => {
    setLayersOpen(false);
    setSettingsOpen(false);
    const ahead = staged.current;
    staged.current = null;
    setWorld({ ...NO_WORLD_JOB, active: true });
    logControl("regenerate", ahead ? "confirmed, prepared ahead" : "requested");
    try {
      const response = (ahead && (await ahead) && (await api.commitWorld().catch(() => null))) || (await api.regenerateWorld(runId || undefined));
      setWorld((w) => ({ ...w, status: response.data, requestedSeed: response.data.seed }));
    } catch (e) {
      const text = e instanceof Error ? e.message : "";
      const code = /disabled/i.test(text) ? "WORLD_REGENERATION_DISABLED" : /in progress/i.test(text) ? "LIFECYCLE_CONFLICT" : "";
      console.error("World generation request failed:", e);
      setWorld((w) => ({ ...w, error: worldErrorMessage(code, text) }));
    }
  }, [runId, logControl]);

  const worldLoaded =
    world.status?.state === "ready" && !!sim.topology && sim.snapshot?.run_id === world.status.run_id && sim.status?.run_id === world.status.run_id;
  // How long until the world is ready, for the film to plan by: the new world's, the run's, or nothing left to wait for.
  const etaNow = world.active
    ? worldLoaded ? 0 : world.status?.state === "generating" ? world.status.eta_s ?? null : null
    : lifecycle === "PREPARING" ? status?.eta_s ?? null : sim.topology && lifecycle !== "IDLE" ? 0 : null;
  const etaSure = etaNow === 0 || (world.active ? !!world.status?.eta_confident : !!status?.eta_confident);
  reportEta(etaNow, etaSure);
  useEffect(() => {
    if (!world.active || world.error || worldLoaded) return;
    let cancel = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api.worldStatus();
        if (cancel) return;
        setWorld((w) => {
          if (r.data.state === "failed" && r.data.error) {
            console.error(`World generation failed [${r.data.error.code}]: ${r.data.error.message}`);
            return { ...w, status: r.data, error: worldErrorMessage(r.data.error.code, r.data.error.message) };
          }
          return { ...w, status: r.data };
        });
      } catch {
        /* Transient: the next poll will tell. */
      } finally {
        if (!cancel) timer = setTimeout(poll, 400);
      }
    };
    timer = setTimeout(poll, 250);
    return () => {
      cancel = true;
      clearTimeout(timer);
    };
  }, [world.active, world.error, worldLoaded]);
  // Once the new world is on screen, show Ready briefly, then fade out.
  const worldStartedAt = useRef(0);
  useEffect(() => {
    if (world.active) worldStartedAt.current = performance.now();
  }, [world.active]);
  useEffect(() => {
    if (!world.active || !worldLoaded) return;
    setManualFocus(null);
    setDismissedFocus(new Set());
    setDialog(null);
    logControl("regenerate", `ready ${world.status?.seed ?? ""}`);
    // The old world finishes leaving and the name re-forms, however fast the new one was,
    // and then the particles land on the new roads.
    const film = !reduceMotion && filmAvailable();
    // Once the name has re-formed, a world that is ready lands at once: no caption, and no film between.
    const wait = film ? Math.max(700, REJOIN_MIN_MS - (performance.now() - worldStartedAt.current)) : 700;
    const t1 = setTimeout(() => setWorld((w) => ({ ...w, closing: true })), wait);
    const t2 = setTimeout(() => setWorld(NO_WORLD_JOB), wait + (film ? LANDING_MS : MOTION_MS.overlay));
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.active, worldLoaded]);

  // ---- Derived presentation ---------------------------------------------------
  const systemError = sim.error || (sim.stale && !catchingUp && !document.hidden ? "Simulation data is stale. Reconnecting." : "") || actionError;
  const asbInfo = describeAsb(asb);
  const launchPlan = useLaunchPlan();
  const coreStage = splashStageFor(mapStatus as never, lifecycle, sim.stage, !!sim.topology, !!sim.status);
  const splashStage = launchPlan?.apps.length && coreStage?.waiting ? launchStage(launchPlan) : coreStage;
  // The opening plays once, for a page opened ahead of its world. Reloading a run goes straight in.
  const firstLifecycle = useRef<string | null>(null);
  if (firstLifecycle.current === null && sim.status) firstLifecycle.current = lifecycle;
  const opening = firstLifecycle.current === null ? null : ["IDLE", "PREPARING", "BOOTING"].includes(firstLifecycle.current);
  // Fast Boot opens as a reload does: the name alone, then the roads, with no title or film.
  const fastStart = features.presentation.fast_boot && !features.presentation.demo;
  const bootPhase = useBootPhase(opening === null ? null : !opening || fastStart);
  const [filmSeen, setFilmSeen] = useState(false);
  const onFilmCycle = useCallback(() => setFilmSeen(true), []);
  // Without force_animate (and always with Fast Boot) the film need not finish: the screen goes the moment the world is ready.
  const { force_animate: forceAnimate, demo } = features.presentation;
  // The dynamic film paces itself by when the world will be ready, so the stages need not be held on screen for it.
  const dynamicFilm = features.presentation.dynamic_particles && !demo;
  const paced = usePacedStages(splashStage, bootPhase, opening !== false && !reduceMotion, filmSeen || !forceAnimate, forceAnimate && !dynamicFilm ? undefined : 240);
  const shownStage = paced.stage;
  // A server that stays away is treated as stopped, whoever stopped it. It clears if it returns.
  const [serverGone, setServerGone] = useState(false);
  // Demo Mode's film plays on while its server is away, until the ending takes over.
  const showSplash = (!!shownStage || paced.holding) && (!sim.error || (demo && sim.error === UNREACHABLE && !serverGone)) && !world.active;
  useFullscreen(features.presentation.fullscreen);
  // The start-up screen dissolves over the rendered map rather than vanishing.
  const lastSplash = useRef(shownStage);
  if (shownStage) lastSplash.current = shownStage;
  // Reloading a run comes straight back: the roads, the map and the panels, without the film.
  const returning = opening === false || fastStart;
  const splash = usePresence(showSplash, reduceMotion ? MOTION_MS.boot : returning ? QUICK_ARRIVAL.landing : LANDING_MS);
  startupOnScreen.current = splash.mounted;
  const landOnRoads = useCallback(() => {
    const view = mapView.current;
    const box = document.querySelector(".static-map")?.getBoundingClientRect();
    if (!view || !box || !sim.topology) return null;
    landedAt.current = view;
    mapCarry.x = mapCarry.y = 0;
    return landingPoints(sim.topology.edges.map((edge) => edge.geometry), view, box, window.innerWidth, window.innerHeight);
  }, [sim.topology]);
  // Nothing has ever loaded and the simulator is not answering, or refused the
  // world. Once a world is on screen a lost connection is shown over it instead.
  // A server that stays away is treated as stopped, whoever stopped it. It clears if it returns.
  // Demo Mode has no world to lose, but loses its server as a run does: the same ending, and back when it returns.
  const lostConnection = !!sim.error && (!!sim.topology || (demo && sim.error === UNREACHABLE)) && !world.active && !shutDown;
  useEffect(() => {
    if (!lostConnection) {
      setServerGone(false);
      return;
    }
    // The ending is to be seen: a hidden page waits until it is shown, then plays it from the start.
    const gone = () => {
      if (document.hidden) document.addEventListener("visibilitychange", gone, { once: true });
      else setServerGone(true);
    };
    const timer = setTimeout(gone, 8000);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", gone);
    };
  }, [lostConnection]);
  const bootFailure = sim.error && !sim.topology && !world.active && !shutDown && !(demo && sim.error === UNREACHABLE) ? sim.error : "";
  const lastFailure = useRef(bootFailure);
  if (bootFailure) lastFailure.current = bootFailure;
  const failure = usePresence(!!bootFailure, MOTION_MS.boot);
  // A new world lands as a start-up does: the particles build its roads, then the map comes in under them, then the
  // panels. Never on a reload's quicker timing, which would show the map before the particles had reached it.
  const arrival = useArrival(!!(showSplash || bootFailure || shutDown || serverGone || (world.active && !world.closing)), reduceMotion || !filmAvailable(), returning && !world.active);
  const still = reduceMotion || !filmAvailable();
  useEffect(() => {
    if (arrival !== "all" || still) {
      setSettled(arrival === "all");
      return;
    }
    const t = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, [arrival, still]);
  // Once a world has arrived, its landing is over: what the particles stood on is forgotten, so that the next ending
  // does not start from where this one's map was.
  useEffect(() => {
    if (arrival !== "all") return;
    const t = setTimeout(() => {
      landedAt.current = null;
      mapCarry.x = mapCarry.y = 0;
    }, LANDING_MS);
    return () => clearTimeout(t);
  }, [arrival]);
  viewContext.current = { busy: suspended ? "suspended" : tutorial.busy ? "tutorial" : dialog ? "dialog" : arrival !== "all" ? "arriving" : null, world: sim.topology };
  // While the start-up is on screen, a world that finishes waits for it. A hidden tab is not
  // watching, and a closed one stops saying so, and the engine then carries on by itself.
  const waitingForFilm = opening === true && arrival !== "all" && !bootFailure && !shutDown;
  useEffect(() => {
    if (!waitingForFilm) return;
    const report = () => void api.observer(!document.hidden).catch(() => undefined);
    report();
    const timer = setInterval(report, 1500);
    document.addEventListener("visibilitychange", report);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", report);
      void api.observer(false).catch(() => undefined);
    };
  }, [waitingForFilm]);
  const statusDetail = [
    ...(asb ? [`${formatRate(asb.throughput?.bytes_per_s ?? 0)}`, `${(asb.throughput?.snapshots_per_s ?? 0).toFixed(1)} snapshots/s`] : []),
    ...(sim.latencyMs !== null ? [`${sim.latencyMs} ms round trip`] : []),
    ...(asb && asb.state !== "NORMAL" ? [`Backpressure ${asb.state.toLowerCase()}`] : asb?.rate_capped ? ["Speed held by backpressure"] : []),
  ];
  const interactive = valid && !suspended && !world.active;
  const viewport = useViewportSize();
  const tooSmall = viewportTooSmall(viewport.width, viewport.height);

  const stepSpeed = (direction: number) => {
    const next = RATES[Math.max(0, Math.min(RATES.length - 1, rateIndexOf(requestedRate) + direction))];
    if (next !== requestedRate) void action(() => api.tick(next));
  };
  const bindings = useMemo(() => resolveBindings(config.shortcuts), [config.shortcuts]);
  useShortcuts(bindings, {
    play: () => interactive && ["RUNNING", "PAUSED"].includes(lifecycle) && void action(lifecycle === "PAUSED" ? api.play : api.pause),
    back: () => interactive && void action(() => seekBy(-config.playback.skip_seconds, virtual)),
    forward: () => interactive && void action(() => seekBy(config.playback.skip_seconds, virtual)),
    step: () => interactive && void action(() => api.step(config.playback.step_seconds)),
    slower: () => interactive && !rateLocked && stepSpeed(-1),
    faster: () => interactive && !rateLocked && stepSpeed(1),
    "zoom-in": () => mapControls.current?.zoomIn(),
    "zoom-out": () => mapControls.current?.zoomOut(),
    fit: () => mapControls.current?.fit(),
    search: () => document.querySelector<HTMLElement>("[data-search-trigger]")?.click(),
    layers: () => !suspended && setLayersOpen((v) => !v),
    "auto-focus": () => mode !== "disable" && toggleAutoFocus(!autoFocus),
    dnd: () => setDnd(!dnd),
    motion: () => setMotion(!motionChoice),
    settings: () => setSettingsOpen((v) => !v),
    telemetry: () => setCollapsed(!deckCollapsed),
    clock: () => toggleHour12(),
  }, !tutorial.active && !dialog && !startupOnScreen.current);

  if (tooSmall) {
    return (
      <TimeFormatProvider hour12={hour12} onToggle={toggleHour12}>
        <ViewportNotice width={viewport.width} height={viewport.height} reduceMotion={reduceMotion} />
      </TimeFormatProvider>
    );
  }

  return (
    <AdvancedContext.Provider value={access.advanced}>
    <BindingsContext.Provider value={bindings}>
    <TimeFormatProvider hour12={hour12} onToggle={toggleHour12}>
      <div
        inert={tutorial.active || undefined}
        data-tour-target={tutorial.active ? tutorialTarget : undefined}
        className={`app-shell${reduceMotion ? " reduce-motion" : ""}${suspended ? " suspended-shell" : ""}${telemetryOpen ? " telemetry-open" : ""}${deckCompact ? " deck-compact" : ""}${arrival !== "all" ? " booting" : ""}${arrival === "map" ? " map-showing" : ""}${world.active ? " world-busy" : ""}${lifecycle === "COMPLETED" ? " day-complete" : ""}`}
      >
        {asb && asb.state !== "NORMAL" && (
          <div className={`asb-banner ${asbInfo.tone}`} role="status">
            <span className="asb-dot" aria-hidden="true" />
            <strong>{asbInfo.label}</strong>
            <span className="asb-detail">{asbInfo.detail}</span>
            <span className="asb-figure mono">
              {(asb.score * 100).toFixed(0)}% · {asb.applied_tick_rate}×
            </span>
          </div>
        )}
        <header className="app-header" data-tutorial="header">
          <div className="brand">
            <Logo height={18} title="DSTNS" />
            {location?.city && (
              <>
                <span className="brand-rule" aria-hidden="true" />
                <Tooltip label="Seed-selected district" detail={`${formatCoordinate(location.anchor_lat, location.anchor_lon)}, from OpenStreetMap.`} side={["bottom"]}>
                  <span className="brand-place" tabIndex={0}>
                    <Icon name="pin" size={14} />
                    <strong>{location.city}</strong>
                    <span>{location.country}</span>
                  </span>
                </Tooltip>
              </>
            )}
          </div>
          <div className="header-actions" data-tutorial="help">
            {interactive && webfabricOn && <FabricHeader />}
            {configLoaded && config.tutorial.enabled && (
              <Tooltip label="Tutorial" side={["bottom"]}>
                <button
                  className="btn icon"
                  onClick={() => void tutorial.start()}
                  disabled={!valid || tutorial.busy || suspended || rateLocked || pending || !!dialog || world.active || !["RUNNING", "PAUSED"].includes(lifecycle)}
                  aria-label="Start tutorial"
                >
                  <Icon name="help" size={16} />
                </button>
              </Tooltip>
            )}
            <Tooltip label="About DSTNS" side={["bottom", "left"]}>
              <button className="btn icon" aria-label="About DSTNS, licence and source" onClick={() => openDialog("about")}>
                <Icon name="info" size={16} />
              </button>
            </Tooltip>
            <button className="btn primary-soft" onClick={() => void report()} disabled={!!reportFilm || !valid || pending || suspended || world.active}>
              <Icon name="download" size={16} />
              <span>Export Report</span>
            </button>
          </div>
        </header>

        <main className="workspace">
          <div className="map-layer" data-tutorial="map" key={runId || "none"}>
            <NetworkMap
              topology={sim.topology}
              snapshot={sim.snapshot?.data ?? null}
              layers={shownLayers}
              places={shownPlaces}
              reduceMotion={mapStill}
              running={valid && lifecycle === "RUNNING" && !suspended}
              virtualTime={virtual}
              tickRate={clock?.tick_rate ?? 1}
              focus={tutorial.busy || tutorial.pending || arrival !== "all" ? null : manualFocus ?? appFocus ?? autoFocusRequest}
              arriving={arrival !== "all"}
              onCameraTaken={takeCamera}
              controls={mapControls}
              onTransform={onMapTransform}
              onCursor={onMapCursor}
              deckCompact={deckCompact}
              advanced={access.advanced}
              appearanceKey={appearanceKey}
              leftInset={sidebarInset}
              onMapPick={fabric.deliverPick}
            />
            {webfabricOn && <FabricOverlay ref={overlay} topology={sim.topology} snapshot={sim.snapshot?.data ?? null} />}
            <SeekFilm seek={seeking} reduceMotion={reduceMotion} reached={lifecycle === "SEEKING" ? sim.status?.clock.virtual_day_seconds : undefined} />
          </div>

          {interactive && webfabricOn && (
            <>
              <FabricSidebar onInset={setSidebarInset} reduceMotion={reduceMotion} />
              <FabricStatus />
              <FabricIndicators />
              <FabricPanel />
            </>
          )}

          <MapDock
            onZoomIn={() => mapControls.current?.zoomIn()}
            onZoomOut={() => mapControls.current?.zoomOut()}
            onFit={() => mapControls.current?.fit()}
            autoFocus={autoFocus}
            autoFocusAvailable={mode !== "disable"}
            strategy={config.auto_focus.strategy}
            onToggleAutoFocus={() => toggleAutoFocus(!autoFocus)}
            onStrategy={setStrategy}
            dnd={dnd}
            onToggleDnd={() => setDnd(!dnd)}
            reduceMotion={reduceMotion}
            motionLocked={false}
            onToggleMotion={() => setMotion(!motionChoice)}
            settingsOpen={settingsOpen}
            onToggleSettings={() => setSettingsOpen((v) => !v)}
            features={sim.topology?.features ?? []}
            city={location?.city}
            onPickPlace={focusOnPlace}
            disabled={suspended}
            extra={interactive && webfabricOn ? <FabricDockItems /> : undefined}
          />

          <SettingsDrawer
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            values={{
              autoFocus,
              autoFocusAvailable: mode !== "disable",
              strategy: config.auto_focus.strategy,
              importantFirst: config.notifications.important_first,
              dnd,
              mutedCategories: config.notifications.dnd_categories,
              mutedSeverities: config.notifications.dnd_severities,
              hour12,
              reduceMotion,
              motionLocked: false,
              skipSeconds: config.playback.skip_seconds,
              stepSeconds: config.playback.step_seconds,
              newsStyle: config.news.style,
              realisticAvailable,
              narratorNote: narratorNote(narrator),
              narratorBadge: narratorBadge(narrator),
              theme: access.theme,
              colorVision: access.color_vision,
              reduceTransparency: access.reduce_transparency,
              highContrast: access.high_contrast,
              advanced: access.advanced,
              byteUnits: config.display.byte_units,
              labelLanguage: config.display.label_language,
              shortcuts: config.shortcuts,
              fineControl: config.playback.fine_control,
            }}
            actions={{
              onReset: resetAllPreferences,
              onAutoFocus: toggleAutoFocus,
              onStrategy: setStrategy,
              onImportantFirst: (on) => persist({ notifications: { ...config.notifications, important_first: on } }),
              onDnd: setDnd,
              onMutedCategories: (ids) => persist({ notifications: { ...config.notifications, dnd_categories: ids } }),
              onMutedSeverities: (ids) => persist({ notifications: { ...config.notifications, dnd_severities: ids } }),
              onHour12: (value) => persist({ clock: { hour12: value } }),
              onReduceMotion: setMotion,
              onSkipSeconds: (s) => persist({ playback: { ...config.playback, skip_seconds: s } }),
              onStepSeconds: (s) => persist({ playback: { ...config.playback, step_seconds: s } }),
              onNewsStyle: (style) => persist({ news: { style } }),
              onTheme: (value) => persist({ accessibility: { ...access, theme: value } }),
              onColorVision: (value) => persist({ accessibility: { ...access, color_vision: value } }),
              onReduceTransparency: (value) => persist({ accessibility: { ...access, reduce_transparency: value } }),
              onHighContrast: (value) => persist({ accessibility: { ...access, high_contrast: value } }),
              onAdvanced: (value) => persist({ accessibility: { ...access, advanced: value } }),
              onByteUnits: (value) => persist({ display: { ...config.display, byte_units: value } }),
              onLabelLanguage: (value) => persist({ display: { ...config.display, label_language: value } }),
              onShortcuts: (shortcuts) => persist({ shortcuts }),
              onFineControl: (value) => persist({ playback: { ...config.playback, fine_control: value } }),
            }}
          />

          <TelemetryDeck
            key={preferencesEpoch}
            status={status}
            snapshot={sim.snapshot?.data ?? null}
            topology={sim.topology}
            congestion={congestion}
            news={sim.news}
            runtime={runtime}
            virtualTime={virtual}
            runId={runId}
            asb={asb}
            history={historyFeed}
            compact={deckCompact}
            tutorialTarget={tutorial.active ? tutorialTarget : undefined}
            onCollapse={() => setCollapsed(true)}
            onExpand={() => setCollapsed(false)}
          />


          <div className="bottom-stack">
            <div className="lower-hud">
              <div className="hud-zone hud-left">
                <NotificationCapsule items={suspended || tutorial.active || gateOpen ? [] : shown} systemError={systemError} onDismissError={!sim.error && !sim.stale && actionError ? () => setActionError("") : undefined} focusedKey={autoFocus ? activeKey : null} reduceMotion={reduceMotion} onDismiss={dismissNotification} />
              </div>
              <div className="hud-zone hud-center">
              <MapReadout
                ref={readout}
                fallback={location ? { lat: location.anchor_lat, lon: location.anchor_lon } : origin ? { lat: origin.origin_lat, lon: origin.origin_lon } : null}
              />
              </div>
              <div className="hud-zone hud-right map-hud hud-group" role="group" aria-label="Map key and layers">
                <RoadLegend />
                <PlaceLegend
                  features={sim.topology?.features ?? NO_FEATURES}
                  demand={sim.snapshot?.data.demand}
                  visible={shownLayers.buildings}
                  showOther={shownLayers.other_places}
                  onShowOther={(on) => changeShownLayers({ ...shownLayers, other_places: on })}
                  places={shownPlaces}
                  heldBy={placeHolders}
                  onRelease={(kind) => release("places", [kind])}
                  onTogglePlace={togglePlace}
                  onShowAll={(kinds) => changeShownPlaces({ ...shownPlaces, ...Object.fromEntries(kinds.map((kind) => [kind, true])) })}
                  onResetPlaces={resetPlaces}
                />
                <button
                  ref={layersTrigger}
                  className={`hud-pill hud-button${layersOpen ? " active" : ""}`}
                  data-tutorial="layers"
                  data-layers-trigger
                  aria-expanded={layersOpen}
                  onClick={() => setLayersOpen((v) => !v)}
                  disabled={suspended}
                >
                  <Icon name="layers" size={16} />
                  <span>Layers</span>
                </button>
                <Floating anchor={layersTrigger} open={layersOpen} preferred={["top"]} className="layers-menu">
                  <LayersPopover
                    layers={shownLayers}
                    defaults={operatorConfig.layers}
                    onChange={changeShownLayers}
                    heldBy={layerHolders}
                    onRelease={(key) => release("layers", [key])}
                    onClose={() => setLayersOpen(false)}
                    topology={sim.topology}
                    snapshot={sim.snapshot?.data ?? null}
                  />
                </Floating>
              </div>
            </div>

            <CommandRail
              clock={clock}
              lifecycle={lifecycle}
              enabled={interactive}
              pending={pending}
              rateLocked={rateLocked}
              requestedRate={requestedRate}
              reduceMotion={reduceMotion}
              seed={seed}
              status={runtime}
              statusDetail={statusDetail}
              skipSeconds={config.playback.skip_seconds}
              stepSeconds={config.playback.step_seconds}
              canRegenerate={regenerationEnabled && !!runId && !world.active && !suspended && lifecycle !== "IDLE"}
              onPlayPause={() => {
                logControl(lifecycle === "PAUSED" ? "play" : "pause");
                void action(lifecycle === "PAUSED" ? api.play : api.pause);
              }}
              fineControl={config.playback.fine_control}
              onBack={(seconds = config.playback.skip_seconds) => {
                logControl("back", formatDuration(seconds));
                void action(() => seekBy(-seconds, virtual));
              }}
              onForward={(seconds = config.playback.skip_seconds) => {
                logControl("forward", formatDuration(seconds));
                void action(() => seekBy(seconds, virtual));
              }}
              onSeekTo={(target) => {
                logControl(target < virtual ? "back" : "forward", `to ${formatSimulationTime(target, false)}`);
                void action(() => seekBy(target - virtual, virtual));
              }}
              onStep={() => {
                logControl("step", formatDuration(config.playback.step_seconds));
                void action(() => api.step(config.playback.step_seconds));
              }}
              onRate={(rate) => {
                logControl("speed", `${rate}x`);
                void action(() => api.tick(rate));
              }}
              onReset={() => openDialog("reset")}
              onRegenerate={() => void settle().then(() => openDialog("regenerate"))}
              onTerminate={() => void settle().then(() => openDialog("terminate"))}
            />
          </div>

          {splash.mounted && lastSplash.current && (
            <Splash stage={lastSplash.current} closing={splash.closing} reduceMotion={reduceMotion} landing={landOnRoads} phase={bootPhase} quick={returning} demo={demo} fastBoot={fastStart && opening !== false} onFilmCycle={onFilmCycle} />
          )}
          {failure.mounted && (
            <BootFailure
              message={/^OSM download/.test(lastFailure.current) ? worldErrorMessage("MAP_FETCH_FAILED", lastFailure.current) : lastFailure.current}
              reachable={!!sim.status}
              // Only the download of a seed-chosen city leaves something to try again.
              onRetry={regenerationEnabled && /^OSM download|map tile for/.test(lastFailure.current) ? () => void api.regenerateWorld().catch((e) => console.error("Could not try another city:", e)) : undefined}
              closing={failure.closing}
              reduceMotion={reduceMotion}
            />
          )}
          {/* The music belongs to the film: it fades as the map arrives. */}
          <MusicControl playing={features.presentation.music && (demo || showSplash)} volume={features.presentation.music_volume} track={!!features.presentation.music_track} />
          {reportFilm && reportPreview && <ReportFilm {...reportFilm} preview={reportPreview} view={reportView} reduceMotion={reduceMotion} onSave={saveReport} onDone={closeReportFilm} />}
          {(shutDown || serverGone) && <ShutdownSurface reduceMotion={reduceMotion} landing={landOnRoads} lost={serverGone && !shutDown} />}

          {dialog === "about" && <AboutCard version={VERSION} closing={dialogClosing} onClose={closeDialog} location={location ?? null} seed={seed} status={sim.status} topology={sim.topology} narratorBadge={narratorBadge(narrator)} />}
          {dialog === "reset" && (
            <ConfirmCard
              icon="reset"
              title="Start the day over?"
              body="The same day plays again from 00:00, with the same seed and map."
              confirmLabel="Start Over"
              closing={dialogClosing}
              onCancel={closeDialog}
              onConfirm={() => {
                closeDialog();
                // A finished day replays at once; a running one keeps its play state.
                const replay = lifecycle === "COMPLETED";
                logControl(replay ? "restart" : "reset");
                void action(() => rewindDay(virtual, replay));
              }}
            />
          )}
          {dialog === "regenerate" && (
            <ConfirmCard
              icon="reroll"
              title="Generate a new world?"
              body="A new seed picks a new city district. This one keeps running until the new world is ready."
              note={seed ? { icon: "history", text: <SeedToCopy seed={seed} /> } : undefined}
              confirmLabel="Generate World"
              closing={dialogClosing}
              onCancel={closeDialog}
              onConfirm={() => {
                confirmed.current = true;
                closeDialog();
                // Let the dialog finish leaving before the world overlay
                // arrives, so the two are never on screen together.
                window.setTimeout(() => void requestWorld(), MOTION_MS.dismiss);
              }}
            />
          )}
          {dialog === "terminate" && (
            <ConfirmCard
              icon="power"
              title="Terminate this session?"
              body="The run stops and the simulation server shuts down. Start again with ./launcher start."
              note={{ icon: "download", text: "Export Report first to keep a record of this run." }}
              confirmLabel="Terminate"
              tone="danger"
              closing={dialogClosing}
              onCancel={closeDialog}
              onConfirm={() => {
                closeDialog();
                logControl("terminate");
                void action(terminate);
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
          {dialog === "complete" && completion && (
            <CompletionDialog
              summary={completion}
              closing={dialogClosing}
              pending={pending}
              reportError={reportError}
              onDownload={() => void report()}
              onReplay={() => {
                setCompletion(null);
                openDialog("reset");
              }}
              onNewWorld={() => {
                setCompletion(null);
                openDialog("regenerate");
              }}
              canGenerate={regenerationEnabled && !world.active && !suspended}
              onClose={() => {
                setCompletion(null);
                closeDialog();
              }}
            />
          )}

          {webfabricOn && <FabricDialog blocked={!interactive || !!dialog || tutorial.active || settingsOpen} />}

          {world.active && (
            <WorldGenerationOverlay
              status={world.status}
              loaded={worldLoaded}
              closing={world.closing}
              error={world.error}
              onRetry={() => void requestWorld()}
              onCancel={() => setWorld(NO_WORLD_JOB)}
              landing={landOnRoads}
              reduceMotion={reduceMotion}
            />
          )}

          {suspended && asb && (
            <SuspendedOverlay
              asb={asb}
              paused={lifecycle === "PAUSED"}
              pending={pending}
              onPlayPause={() => action(lifecycle === "PAUSED" ? api.play : api.pause)}
              onReset={() => action(() => api.seek(0))}
              onTerminate={() => action(terminate)}
            />
          )}
        </main>
      </div>
      {tutorial.active && (
        <Tutorial
          onSkip={() => void tutorial.finish(false)}
          onStart={() => void tutorial.finish(true)}
          reduceMotion={reduceMotion}
          onTarget={setTutorialTarget}
        />
      )}
      <EngineGate ready={configLoaded && (filmSeen || !forceAnimate || reduceMotion)} running={status?.engine_identity ?? null} onOpenChange={setGateOpen} />
    </TimeFormatProvider>
    </BindingsContext.Provider>
    </AdvancedContext.Provider>
  );
}
