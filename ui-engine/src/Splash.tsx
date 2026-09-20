import { useEffect, useState } from "react";
import { LoadingSurface } from "./LoadingSurface";
import { Mark } from "./Logo";

/**
 * Start-up screen.
 *
 * The interface starts before the core has a map: a district is often being
 * downloaded from OpenStreetMap, which takes tens of seconds. The start-up
 * screen reports what is actually happening, stage by stage, and dissolves
 * into the map once the first network has arrived.
 */

/**
 * The stages between opening the interface and watching a live world, in
 * order. Each one is entered only when the core reports it: the world is
 * chosen while the scenario compiles, the map is downloaded only when it is
 * not already cached, and the last stage ends when the first network arrives.
 */
export const BOOT_STEPS = [
  { id: "interface", label: "Starting interface" },
  { id: "select", label: "Selecting world" },
  { id: "download", label: "Downloading map" },
  { id: "generate", label: "Generating world" },
  { id: "initialize", label: "Initializing simulation" },
] as const;

/**
 * What the screen says while it waits.
 *
 * The stage list already says what the machine is doing. This says what the
 * person can expect, which is a different question and the one they are
 * actually asking. It moves forward with the work and never promises a time.
 */
export function reassurance(step: number, total: number, waiting = false): string {
  // Nothing is being got ready when nothing has been asked for: say what is
  // true instead of reassuring about work that is not happening.
  if (waiting) return "";
  if (step <= 0) return "Getting things ready";
  if (step >= total - 1) return "Almost there";
  if (step >= total - 2) return "Just a moment";
  return "This will only take a moment";
}

export interface SplashStage {
  /** Short phrase: what is happening right now. */
  label: string;
  /** Longer explanation, when there is something worth saying. */
  detail?: string;
  /** 0..1 when the core knows, undefined when it does not. */
  progress?: number;
  /** Index into BOOT_STEPS; stages passed quickly (a cached map) count as done. */
  step: number;
  /** No run exists yet, so there is nothing to load until one is started. */
  waiting?: boolean;
}

/**
 * The welcome screen.
 *
 * Between the last stage finishing and the map appearing there is a beat where
 * the work is done but nothing is ready to look at. Rather than flashing
 * through it, the screen names the product, credits the licence, and hands over
 * deliberately - the moment an operating system spends telling you it is
 * yours before it shows you the desktop.
 */
export function Welcome({ closing = false, reduceMotion }: { closing?: boolean; reduceMotion: boolean }) {
  return (
    <div
      className={`loading-surface boot welcome${closing ? " closing" : ""}${reduceMotion ? " still" : ""}`}
      role="status"
      aria-labelledby="welcome-title"
    >
      <div className="welcome-body">
        <div className={`welcome-mark${reduceMotion ? "" : " animated"}`}>
          <Mark size={104} />
        </div>
        <h2 id="welcome-title">Starting DSTNS</h2>
        <p className="welcome-sub">Deterministic Spatiotemporal Transport Network Simulator</p>
      </div>
      <p className="loading-licence welcome-licence">
        © 2026 Varun Karthic · Licensed under AGPL-3.0-or-later · Map data © OpenStreetMap contributors (ODbL)
      </p>
    </div>
  );
}

/** How long the welcome screen is held before it dissolves into the map. */
export const WELCOME_MS = 1600;
/** How long its progressive blur takes to clear. */
export const WELCOME_EXIT_MS = 720;

export function Splash({
  stage,
  reduceMotion,
  closing = false,
  onDismiss,
}: {
  stage: SplashStage;
  reduceMotion: boolean;
  closing?: boolean;
  onDismiss?: () => void;
}) {
  // Only offer a way past the start-up screen once waiting has become
  // notable, so the option does not flash up during a fast start.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setStalled(true), 12000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <LoadingSurface
      mode="boot"
      title={reassurance(stage.step, BOOT_STEPS.length, stage.waiting) || stage.label}
      status={stage.waiting ? stage.detail : stage.detail ? `${stage.label} · ${stage.detail}` : stage.label}
      steps={stage.waiting ? undefined : BOOT_STEPS}
      stepIndex={stage.step}
      progress={stage.progress}
      progressLabel={stage.label}
      closing={closing}
      reduceMotion={reduceMotion}
      titleId="splash-title"
      actions={
        stalled && onDismiss && !closing ? (
          <button type="button" className="btn ghost" onClick={onDismiss}>
            Continue without waiting
          </button>
        ) : undefined
      }
      footer={
        <p className="loading-licence">
          Deterministic Spatiotemporal Transport Network Simulator · © 2026 Varun Karthic · AGPL-3.0-or-later · Map data © OpenStreetMap contributors (ODbL)
        </p>
      }
    />
  );
}

/**
 * Translate what the core reports into a start-up stage.
 *
 * `mapStatus` is the live download report; `lifecycle` and `clientStage` come
 * from the simulation client. Keeping the mapping here means the screen itself
 * has no opinion about the core's vocabulary.
 */
export function splashStageFor(
  mapStatus: {
    active?: boolean;
    city?: string;
    phase?: string;
    bytes?: number;
    total?: number;
    /** What the core's compile is doing: selecting, acquiring or building. */
    preparation?: string;
  } | null,
  lifecycle: string,
  clientStage: string,
  hasTopology: boolean,
  connected = true,
): SplashStage | null {
  if (hasTopology) return null;
  if (!connected) return { step: 0, label: "Starting interface", detail: clientStage || "Connecting to the simulation" };

  // A map is being fetched: the one stage that can report real progress.
  if (mapStatus?.active) {
    const city = mapStatus.city || "the district";
    const mib = (n: number) => (n / (1024 * 1024)).toFixed(1);
    if (mapStatus.phase === "download") {
      const known = (mapStatus.total ?? 0) > 0;
      return {
        step: 2,
        label: `Downloading ${city}`,
        detail: known
          ? `${mib(mapStatus.bytes ?? 0)} of ${mib(mapStatus.total!)} MiB from OpenStreetMap`
          : `${mib(mapStatus.bytes ?? 0)} MiB from OpenStreetMap`,
        progress: known ? (mapStatus.bytes ?? 0) / mapStatus.total! : undefined,
      };
    }
    if (mapStatus.phase === "parse") return { step: 2, label: `Validating ${city}`, detail: "Checking the downloaded map" };
    return { step: 2, label: `Requesting ${city}`, detail: "Waiting for OpenStreetMap to prepare the extract" };
  }

  // What the core says its compile is doing, whether or not a map is moving.
  const preparation = mapStatus?.preparation ?? "";
  if (preparation === "selecting") return { step: 1, label: "Selecting world", detail: "Resolving the seed to a city district" };
  if (preparation === "acquiring") return { step: 2, label: "Preparing map", detail: "Reading the district's map data" };
  if (preparation === "building") return { step: 3, label: "Generating world", detail: "Building the road graph, signals and schedules" };

  if (lifecycle === "IDLE") return { step: 1, waiting: true, label: "Waiting for a simulation", detail: "Start a run from the DSTNS CLI." };
  if (lifecycle === "PREPARING") return { step: 3, label: "Generating world", detail: "Building the road graph, signals and schedules" };
  if (/network|buildings/i.test(clientStage)) return { step: 4, label: "Initializing simulation", detail: "Receiving roads, places and the first state" };
  return { step: 4, label: "Initializing simulation", detail: clientStage || undefined };
}
