import { useEffect, useState } from "react";
import { LoadingSurface } from "./LoadingSurface";

/**
 * Start-up screen.
 *
 * The interface starts before the core has a map: a district is often being
 * downloaded from OpenStreetMap, which takes tens of seconds. The start-up
 * screen reports what is actually happening, stage by stage, and dissolves
 * into the map once the first network has arrived.
 */

/** Stages the interface can observe on the way to a live map, in order. */
export const BOOT_STEPS = [
  { id: "connect", label: "Connecting interface" },
  { id: "map", label: "Loading map data" },
  { id: "world", label: "Preparing world" },
  { id: "network", label: "Loading network" },
] as const;

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
      title={stage.label}
      status={stage.detail}
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
  } | null,
  lifecycle: string,
  clientStage: string,
  hasTopology: boolean,
  connected = true,
): SplashStage | null {
  if (hasTopology) return null;

  if (mapStatus?.active) {
    const city = mapStatus.city || "the district";
    const mib = (n: number) => (n / (1024 * 1024)).toFixed(1);
    if (mapStatus.phase === "download") {
      const known = (mapStatus.total ?? 0) > 0;
      return {
        step: 1,
        label: `Downloading ${city}`,
        detail: known
          ? `${mib(mapStatus.bytes ?? 0)} of ${mib(mapStatus.total!)} MiB from OpenStreetMap`
          : `${mib(mapStatus.bytes ?? 0)} MiB from OpenStreetMap`,
        progress: known ? (mapStatus.bytes ?? 0) / mapStatus.total! : undefined,
      };
    }
    if (mapStatus.phase === "parse") return { step: 1, label: `Validating ${city}`, detail: "Checking the downloaded map" };
    return { step: 1, label: `Requesting ${city}`, detail: "Waiting for OpenStreetMap to prepare the extract" };
  }

  if (!connected) return { step: 0, label: "Connecting to the simulation", detail: clientStage || undefined };
  if (lifecycle === "IDLE") return { step: 0, waiting: true, label: "Waiting for a simulation", detail: "Start a run from the DSTNS CLI." };
  if (lifecycle === "PREPARING") return { step: 2, label: "Preparing world", detail: "Building the road graph, signals and schedules" };
  if (/network|buildings/i.test(clientStage)) return { step: 3, label: "Loading network", detail: "Receiving roads and places" };
  return { step: 0, label: "Connecting to the simulation" };
}
