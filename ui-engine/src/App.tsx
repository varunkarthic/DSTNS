import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NetworkMap from "./NetworkMap";
import type { MapControls, MapView } from "./NetworkMap";
import { TelemetryDeck } from "./TelemetryDeck";
import { CommandRail } from "./CommandRail";
import { LayersPopover } from "./LayersPopover";
import { MapDock } from "./MapDock";
import { Logo } from "./Logo";
import { Icon } from "./Icons";
import { Splash, splashStageFor } from "./Splash";
import { usePresence } from "./LoadingSurface";
import { PlaceLegend, RoadLegend } from "./Legends";
import { NotificationHistory } from "./notificationHistory";
import {
  AboutCard,
  AutoFocusPrompt,
  CompletionDialog,
  ConfirmCard,
  SuspendedOverlay,
  WorldGenerationOverlay,
} from "./Dialogs";
import type { CompletionSummary } from "./Dialogs";
import { Tooltip } from "./Tooltip";
import { Tutorial } from "./Tutorial";
import { useTutorial } from "./useTutorial";
import { NotificationCapsule } from "./NotificationCapsule";
import { SettingsDrawer } from "./SettingsDrawer";
import { useSimulation } from "./useSimulation";
import { useBackpressure, describeAsb, formatRate } from "./useBackpressure";
import { api } from "./api";
import { formatCoordinate, scaleBarFor } from "./mapProjection";
import { BUILT_IN, loadConfig, resolveReduceMotion, writeOverrides } from "./uiConfig";
import type { UiConfig, AutoFocusStrategy } from "./uiConfig";
import { TimeFormatProvider } from "./preferences";
import { boundsOf, chooseTarget, focusTargets, framingSignature, networkBounds } from "./autoFocus";
import type { Bounds } from "./autoFocus";
import {
  buildNotifications,
  focusMatches,
  orderForDisplay,
  shouldDisplayNotification,
} from "./notificationModel";
import type { UiNotification } from "./notificationModel";
import { focusNotification } from "./focusNotification";
import { TelemetryRecorder, runtimeStatus, sampleFrom } from "./telemetryRecorder";
import { DAY_SECONDS, formatDuration } from "./timeFormat";
import type { Congestion, Layers, MapFeature, News, WorldStatus } from "./types";
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
import "./style.css";
import "./theme.css";
import "./hud.css";
import "./system.css";

export const VERSION = "2.2.0";

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

type FocusRequest = { bounds?: Bounds; x_m?: number; y_m?: number; scale?: number; padding?: number; token: number };

interface WorldJob {
  active: boolean;
  requestedSeed: string;
  status: WorldStatus | null;
  error: string;
  closing: boolean;
}
const NO_WORLD_JOB: WorldJob = { active: false, requestedSeed: "", status: null, error: "", closing: false };

/** A concise, operator-facing reason for a failed world generation. */
export function worldErrorMessage(code: string, message: string): string {
  if (code === "MAP_FETCH_FAILED")
    return `The map for the new seed could not be downloaded from OpenStreetMap. ${message.split(":").slice(-1)[0].trim()}`.trim();
  if (code === "WORLD_REGENERATION_DISABLED") return "World generation is disabled for this deployment.";
  if (code === "LIFECYCLE_CONFLICT") return message.charAt(0).toUpperCase() + message.slice(1) + ".";
  return "The new world could not be generated. Retry, or return to the current world.";
}

export default function App() {
  // ---- Configuration ----------------------------------------------------
  const [config, setConfig] = useState<UiConfig>(BUILT_IN);
  const sim = useSimulation(config.notifications.dwell_ms);
  const [operatorConfig, setOperatorConfig] = useState<UiConfig>(BUILT_IN);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [layers, setLayers] = useState<Layers>(BUILT_IN.layers);
  const [motionChoice, setMotionChoice] = useState(() => resolveReduceMotion(BUILT_IN.reduce_motion));

  useEffect(() => {
    let cancelled = false;
    void loadConfig().then(({ config: resolved, operator }) => {
      if (cancelled) return;
      setConfig(resolved);
      setOperatorConfig(operator);
      setLayers(resolved.layers);
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

  // ---- Shell state ------------------------------------------------------
  const [layersOpen, setLayersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dialogClosing, setDialogClosing] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [history, setHistory] = useState<Congestion | null>(null);
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [view, setView] = useState<MapView>({ scale: 1, metresPerPixel: 1 });
  const [mapStatus, setMapStatus] = useState<Record<string, unknown> | null>(null);
  const [splashDismissed, setSplashDismissed] = useState(false);
  const [manualFocus, setManualFocus] = useState<FocusRequest | null>(null);
  const [world, setWorld] = useState<WorldJob>(NO_WORLD_JOB);
  const [regenerationEnabled, setRegenerationEnabled] = useState(true);
  const [completion, setCompletion] = useState<CompletionSummary | null>(null);
  const [reportError, setReportError] = useState("");
  const mapControls = useRef<MapControls | null>(null);
  const focusToken = useRef(0);
  const recorder = useRef(new TelemetryRecorder());

  const status = sim.status?.data;
  const lifecycle = status?.lifecycle ?? "IDLE";
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
  const { asb, resetToken } = useBackpressure({
    enabled: config.asb.enabled,
    intervalMs: config.asb.report_interval_ms,
    renderedVirtualSecond: sim.snapshot?.clock.virtual_day_seconds ?? 0,
    coreVirtualSecond: sim.status?.clock.virtual_day_seconds ?? 0,
    lastDataAt: sim.lastDataAt,
    // Keep reporting while data is stale: that is the condition ASB acts on.
    active: !!runId && !["IDLE", "TERMINATING"].includes(lifecycle),
    runId,
  });
  const suspended = asb?.gui_suspended === true;
  const rateLocked = asb?.rate_locked === true;
  const motionLocked = asb?.motion_locked === true;
  const reduceMotion = motionChoice || motionLocked;
  const runtime = runtimeStatus({ connected: !!sim.snapshot, stale: sim.stale, error: !!sim.error, asb });

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
  const deckCompact = narrow ? !telemetryOpen : deckCollapsed;
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
  const tutorial = useTutorial({
    config: config.tutorial,
    ready: configLoaded && valid && !!sim.topology && ["RUNNING", "PAUSED"].includes(lifecycle),
    runId,
    suspended: suspended || rateLocked,
    playbackRevision: status?.playback_revision,
    blocked: !!dialog || layersOpen || settingsOpen || pending || world.active,
    onError: setActionError,
  });

  // ASB's default state strips the presentation back to a minimum and soft
  // restarts it, as a reload would, without reloading the page.
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
    setSettingsOpen(false);
    setDialog(null);
    mapControls.current?.fit();
  }, []);
  const beforeAsbLayers = useRef<Layers | null>(null);
  const seenReset = useRef(resetToken);
  useEffect(() => {
    if (resetToken !== seenReset.current) {
      seenReset.current = resetToken;
      if (!beforeAsbLayers.current) beforeAsbLayers.current = layers;
      softReset();
    }
    if (asb?.state === "NORMAL" && asb.synced && !asb.rate_capped && beforeAsbLayers.current) {
      setLayers(beforeAsbLayers.current);
      beforeAsbLayers.current = null;
    }
  }, [resetToken, softReset, asb?.state, asb?.synced, asb?.rate_capped, layers]);

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
    const all = networkBounds(sim.topology);
    return all ? { bounds: all, padding: 0.03, token: focusToken.current } : null;
    // A new token is minted only when the framing changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framing]);

  // ---- Notifications ------------------------------------------------------
  const [dismissedFocus, setDismissedFocus] = useState<Set<string>>(new Set());
  useEffect(() => setDismissedFocus(new Set()), [runId]);
  const notifications = useMemo(() => buildNotifications(sim.toasts, sim.topology), [sim.toasts, sim.topology]);
  const policy = useMemo(
    () => ({
      enabled: config.notifications.enabled,
      dnd,
      mutedCategories: config.notifications.dnd_categories,
      mutedSeverities: config.notifications.dnd_severities,
    }),
    [config.notifications, dnd],
  );
  const { shown } = useMemo(() => {
    const focus = { enabled: autoFocus, targetKey: activeKey };
    const visible = notifications.filter((n) => shouldDisplayNotification(n, policy, focus));
    let list: UiNotification[] = orderForDisplay(visible, activeKey);
    // The event auto-focus is showing always has a notification, even if the
    // news that announced it has expired or was muted.
    if (autoFocus && active && sim.snapshot && !dismissedFocus.has(active.key) && !list.some((n) => focusMatches(n.focusKey, activeKey)))
      list = [focusNotification(active, sim.snapshot.data, sim.topology, virtual), ...list];
    return { shown: list };
    // Rebuilt when inputs change; the virtual clock alone does not warrant it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications, policy, autoFocus, activeKey, active?.key, sim.snapshot, sim.topology, dismissedFocus]);
  // ---- Notification history ------------------------------------------------
  // Every notification-worthy event is kept, whether or not it was shown.
  const historyStore = useRef(new NotificationHistory());
  const [historyRevision, setHistoryRevision] = useState(0);
  useEffect(() => {
    historyStore.current.reset(runId);
    setHistoryRevision(historyStore.current.revision);
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
      if (n.focusKey && !n.newsIds.length) setDismissedFocus((s) => new Set(s).add(n.focusKey!));
    },
    [sim],
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

  // Whether this deployment allows world regeneration at all.
  useEffect(() => {
    let cancel = false;
    api
      .worldStatus()
      .then((r) => {
        if (!cancel) setRegenerationEnabled(r.data.enabled !== false);
      })
      .catch(() => {
        /* An older core without the endpoint: leave the control enabled; a request reports why it failed. */
      });
    return () => {
      cancel = true;
    };
  }, []);

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
    }, 180);
  }, []);

  const report = useCallback(
    () =>
      action(async () => {
        setReportError("");
        if (!sim.status || !sim.snapshot || !sim.topology) throw new Error("The report needs a loaded simulation.");
        try {
          const [{ exportReport }, fullNews] = await Promise.all([
            import("./report"),
            api.allNews(sim.status.run_id).catch(() => sim.news),
          ]);
          await exportReport({
            status: sim.status,
            snapshot: sim.snapshot,
            topology: sim.topology,
            congestion: history ?? sim.snapshot.data.congestion,
            news: fullNews,
            asb,
            telemetry: recorder.current.export(),
            hour12,
            uiVersion: VERSION,
            layers,
          });
          logControl("report", "downloaded");
        } catch (e) {
          const message = e instanceof Error ? e.message : "The report could not be generated.";
          setReportError(message);
          throw new Error(`Report generation failed. ${message}`);
        }
      }),
    [action, sim.status, sim.snapshot, sim.topology, sim.news, history, asb, hour12, layers, logControl],
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
      scale: Math.max(view.scale, 1.6),
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
    if (completion && !dialog && !world.active && !tutorial.busy && lifecycle === "COMPLETED") setDialog("complete");
  }, [completion, dialog, world.active, tutorial.busy, lifecycle]);
  useEffect(() => {
    if (lifecycle !== "COMPLETED") setCompletion(null);
  }, [lifecycle]);

  // ---- World generation -----------------------------------------------------
  const requestWorld = useCallback(async () => {
    setLayersOpen(false);
    setSettingsOpen(false);
    setWorld({ ...NO_WORLD_JOB, active: true });
    logControl("regenerate", "requested");
    try {
      const response = await api.regenerateWorld(runId || undefined);
      setWorld((w) => ({ ...w, status: response.data, requestedSeed: response.data.seed }));
    } catch (e) {
      const text = e instanceof Error ? e.message : "";
      const code = /disabled/i.test(text) ? "WORLD_REGENERATION_DISABLED" : /in progress/i.test(text) ? "LIFECYCLE_CONFLICT" : "";
      console.error("World generation request failed:", e);
      setWorld((w) => ({ ...w, error: worldErrorMessage(code, text) }));
    }
  }, [runId, logControl]);

  const worldLoaded =
    world.status?.state === "ready" && !!sim.topology && sim.status?.run_id === world.status.run_id;
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
  useEffect(() => {
    if (!world.active || !worldLoaded) return;
    setManualFocus(null);
    setDismissedFocus(new Set());
    setDialog(null);
    logControl("regenerate", `ready ${world.status?.seed ?? ""}`);
    const t1 = setTimeout(() => setWorld((w) => ({ ...w, closing: true })), 900);
    const t2 = setTimeout(() => setWorld(NO_WORLD_JOB), 1180);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.active, worldLoaded]);

  // ---- Derived presentation ---------------------------------------------------
  const scaleBar = scaleBarFor(view.metresPerPixel);
  const mapError = /MAP_FETCH_FAILED|OSM download|map tile/i.test(sim.error || actionError);
  const asbInfo = describeAsb(asb);
  const splashStage = splashStageFor(mapStatus as never, lifecycle, sim.stage, !!sim.topology, !!sim.status);
  const showSplash = !splashDismissed && !!splashStage && !sim.error && !world.active;
  // The start-up screen dissolves over the rendered map rather than vanishing.
  const lastSplash = useRef(splashStage);
  if (splashStage) lastSplash.current = splashStage;
  const splash = usePresence(showSplash, 520);
  const statusDetail = [
    ...(asb ? [`${formatRate(asb.throughput?.bytes_per_s ?? 0)}`, `${(asb.throughput?.snapshots_per_s ?? 0).toFixed(1)} snapshots/s`] : []),
    ...(sim.latencyMs !== null ? [`${sim.latencyMs} ms round trip`] : []),
    ...(asb && asb.state !== "NORMAL" ? [`Backpressure ${asb.state.toLowerCase()}`] : asb?.rate_capped ? ["Speed held by backpressure"] : []),
  ];
  const interactive = valid && !suspended && !world.active;

  return (
    <TimeFormatProvider hour12={hour12} onToggle={toggleHour12}>
      <div
        inert={tutorial.active || undefined}
        data-tour-target={tutorial.active ? tutorialTarget : undefined}
        className={`app-shell${reduceMotion ? " reduce-motion" : ""}${suspended ? " suspended-shell" : ""}${telemetryOpen ? " telemetry-open" : ""}${deckCompact ? " deck-compact" : ""}${showSplash ? " booting" : ""}${world.active ? " world-busy" : ""}`}
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
            <Logo height={22} title="DSTNS" />
            <p>Deterministic Spatiotemporal Transport Network Simulator</p>
          </div>
          <div className="header-actions" data-tutorial="help">
            {location?.city && (
              <Tooltip label="Seed-selected district" detail={`${formatCoordinate(location.anchor_lat, location.anchor_lon)}, from OpenStreetMap.`} side={["bottom"]}>
                <span className="chip city-chip" tabIndex={0}>
                  <Icon name="pin" size={14} />
                  {location.city}, {location.country}
                </span>
              </Tooltip>
            )}
            {configLoaded && config.tutorial.enabled && (
              <button
                className="btn"
                onClick={() => void tutorial.start()}
                disabled={!valid || tutorial.busy || suspended || rateLocked || pending || !!dialog || world.active || !["RUNNING", "PAUSED"].includes(lifecycle)}
                aria-label="Start tutorial"
              >
                <Icon name="help" size={16} />
                <span>Tutorial</span>
              </button>
            )}
            <button className="btn" onClick={() => void report()} disabled={!valid || pending || suspended || world.active}>
              <Icon name="download" size={16} />
              <span>Export Report</span>
            </button>
            <Tooltip label="About DSTNS" side={["bottom", "left"]}>
              <button className="btn icon" aria-label="About DSTNS, licence and source" onClick={() => setDialog("about")}>
                <Icon name="info" size={16} />
              </button>
            </Tooltip>
          </div>
        </header>

        <main className="workspace">
          <div className="map-layer" data-tutorial="map" key={runId || "none"}>
            <NetworkMap
              topology={sim.topology}
              snapshot={sim.snapshot?.data ?? null}
              layers={layers}
              reduceMotion={reduceMotion}
              running={valid && lifecycle === "RUNNING" && !suspended}
              virtualTime={virtual}
              tickRate={clock?.tick_rate ?? 1}
              focus={tutorial.busy ? null : manualFocus ?? autoFocusRequest}
              controls={mapControls}
              onView={setView}
              onCursor={setCursor}
              deckCompact={deckCompact}
            />
          </div>

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
            motionLocked={motionLocked}
            onToggleMotion={() => setMotion(!motionChoice)}
            settingsOpen={settingsOpen}
            onToggleSettings={() => setSettingsOpen((v) => !v)}
            features={sim.topology?.features ?? []}
            onPickPlace={focusOnPlace}
            disabled={suspended}
          />

          <SettingsDrawer
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            values={{
              autoFocus,
              autoFocusAvailable: mode !== "disable",
              strategy: config.auto_focus.strategy,
              dnd,
              mutedCategories: config.notifications.dnd_categories,
              mutedSeverities: config.notifications.dnd_severities,
              hour12,
              reduceMotion,
              motionLocked,
              skipSeconds: config.playback.skip_seconds,
              stepSeconds: config.playback.step_seconds,
            }}
            actions={{
              onAutoFocus: toggleAutoFocus,
              onStrategy: setStrategy,
              onDnd: setDnd,
              onMutedCategories: (ids) => persist({ notifications: { ...config.notifications, dnd_categories: ids } }),
              onMutedSeverities: (ids) => persist({ notifications: { ...config.notifications, dnd_severities: ids } }),
              onHour12: (value) => persist({ clock: { hour12: value } }),
              onReduceMotion: setMotion,
              onSkipSeconds: (s) => persist({ playback: { ...config.playback, skip_seconds: s } }),
              onStepSeconds: (s) => persist({ playback: { ...config.playback, step_seconds: s } }),
            }}
          />

          <TelemetryDeck
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
            onCollapse={() => setCollapsed(true)}
            onExpand={() => setCollapsed(false)}
          />

          <div className="bottom-stack">
            <div className="lower-hud">
              <div className="hud-zone hud-left">
                {!suspended && !tutorial.active && (
                  <NotificationCapsule items={shown} focusedKey={autoFocus ? activeKey : null} reduceMotion={reduceMotion} onDismiss={dismissNotification} />
                )}
              </div>
              <div className="hud-zone hud-center">
                <div className="layers-anchor">
                  {layersOpen && (
                    <LayersPopover
                      layers={layers}
                      defaults={operatorConfig.layers}
                      onChange={changeLayers}
                      onClose={() => setLayersOpen(false)}
                      topology={sim.topology}
                      snapshot={sim.snapshot?.data ?? null}
                    />
                  )}
                  <button
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
                </div>
                <RoadLegend />
                <PlaceLegend
                  features={sim.topology?.features ?? NO_FEATURES}
                  demand={sim.snapshot?.data.demand}
                  visible={layers.buildings}
                  showOther={layers.other_places}
                  onShowOther={(on) => changeLayers({ ...layers, other_places: on })}
                />
              </div>
              <div className="hud-zone hud-right map-hud" data-tutorial="hud">
                <span className="hud-pill hud-readout mono" aria-label="Pointer coordinates" data-tip-avoid>
                  <Icon name="pin" size={14} />
                  {cursor
                    ? formatCoordinate(cursor.lat, cursor.lon)
                    : location
                      ? formatCoordinate(location.anchor_lat, location.anchor_lon)
                      : origin
                        ? formatCoordinate(origin.origin_lat, origin.origin_lon)
                        : "No coordinates"}
                </span>
                <span className="hud-pill hud-readout scale-readout" aria-label={`Map scale ${scaleBar.label}`} data-tip-avoid>
                  <i style={{ width: Math.round(scaleBar.pixels) }} />
                  <span className="mono">{scaleBar.label}</span>
                </span>
              </div>
            </div>

            <CommandRail
              clock={clock}
              lifecycle={lifecycle}
              enabled={interactive}
              pending={pending}
              rateLocked={rateLocked}
              requestedRate={asb?.requested_tick_rate}
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
              onBack={() => {
                logControl("back", formatDuration(config.playback.skip_seconds));
                void action(() => api.seek(Math.max(0, virtual - config.playback.skip_seconds)));
              }}
              onForward={() => {
                logControl("forward", formatDuration(config.playback.skip_seconds));
                void action(() => api.seek(Math.min(DAY_SECONDS, virtual + config.playback.skip_seconds)));
              }}
              onStep={() => {
                logControl("step", formatDuration(config.playback.step_seconds));
                void action(() => api.step(config.playback.step_seconds));
              }}
              onRate={(rate) => {
                logControl("speed", `${rate}x`);
                void action(() => api.tick(rate));
              }}
              onReset={() => setDialog("reset")}
              onRegenerate={() => setDialog("regenerate")}
              onTerminate={() => setDialog("terminate")}
            />
          </div>

          {(sim.error || sim.stale || actionError) && !suspended && !world.active && (
            <div role="alert" className={`error-banner${mapError ? " map-error" : ""}`}>
              <Icon name="incident" size={16} />
              <span>{actionError || sim.error || "Simulation data is stale. Reconnecting."}</span>
              {actionError && (
                <button aria-label="Dismiss error" onClick={() => setActionError("")}>
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>
          )}

          {splash.mounted && lastSplash.current && (
            <Splash stage={lastSplash.current} closing={splash.closing} reduceMotion={reduceMotion} onDismiss={() => setSplashDismissed(true)} />
          )}

          {dialog === "about" && <AboutCard version={VERSION} closing={dialogClosing} onClose={closeDialog} location={location ?? null} seed={seed} />}
          {dialog === "reset" && (
            <ConfirmCard
              title="Reset the simulation?"
              body="The run returns to 00:00:00. The scenario, its seed and its map are unchanged, so the same day replays from the beginning."
              confirmLabel="Reset to 00:00:00"
              icon="reset"
              closing={dialogClosing}
              onCancel={closeDialog}
              onConfirm={() => {
                closeDialog();
                logControl("reset");
                void action(() => api.seek(0));
              }}
            />
          )}
          {dialog === "regenerate" && (
            <ConfirmCard
              title="Generate New World?"
              body="A new seed will be generated and a new district prepared, which may need a map download. The current simulation keeps running until the new world is ready, then is replaced. The new world starts paused."
              confirmLabel="Generate"
              icon="reroll"
              closing={dialogClosing}
              onCancel={closeDialog}
              onConfirm={() => {
                closeDialog();
                void requestWorld();
              }}
            />
          )}
          {dialog === "terminate" && (
            <ConfirmCard
              title="Terminate this session?"
              body="The run stops and the simulation server shuts down. A new run must be started from the CLI."
              confirmLabel="Terminate"
              tone="danger"
              icon="power"
              closing={dialogClosing}
              onCancel={closeDialog}
              onConfirm={() => {
                closeDialog();
                logControl("terminate");
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
          {dialog === "complete" && completion && (
            <CompletionDialog
              summary={completion}
              closing={dialogClosing}
              pending={pending}
              reportError={reportError}
              onDownload={() => void report()}
              onClose={() => {
                setCompletion(null);
                closeDialog();
              }}
            />
          )}

          {world.active && (
            <WorldGenerationOverlay
              status={world.status}
              requestedSeed={world.requestedSeed}
              loaded={worldLoaded}
              closing={world.closing}
              error={world.error}
              onRetry={() => void requestWorld()}
              onCancel={() => setWorld(NO_WORLD_JOB)}
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
              onTerminate={() => action(() => api.terminate())}
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
    </TimeFormatProvider>
  );
}
