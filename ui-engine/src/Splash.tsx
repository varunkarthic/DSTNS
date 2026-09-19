import { useEffect, useState } from "react";
import { Logo } from "./Logo";

/**
 * Boot screen.
 *
 * The interface starts before the core has a map: a district is often being
 * downloaded from OpenStreetMap, which takes tens of seconds. Rather than an
 * empty page, the splash shows the mark assembling itself and reports what the
 * core is actually doing, so the wait is legible instead of blank.
 *
 * It is a status display, not a loading bar for its own sake - every line it
 * shows comes from a real stage the core reported.
 */

export interface SplashStage {
  /** Short phrase: what is happening right now. */
  label: string;
  /** Longer explanation, when there is something worth saying. */
  detail?: string;
  /** 0..1 when the core knows, undefined when it does not. */
  progress?: number;
}

export function Splash({
  stage,
  reduceMotion,
  onDismiss,
}: {
  stage: SplashStage;
  reduceMotion: boolean;
  onDismiss?: () => void;
}) {
  // Only offer a way past the splash once waiting has become notable, so the
  // option does not flash up during a fast start.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setStalled(true), 12000);
    return () => clearTimeout(timer);
  }, []);

  const known = typeof stage.progress === "number" && Number.isFinite(stage.progress);
  const percent = known ? Math.round(Math.min(1, Math.max(0, stage.progress!)) * 100) : 0;

  return (
    <div className={`splash${reduceMotion ? " still" : ""}`} role="status" aria-live="polite">
      <div className="splash-mark">
        <Logo size={96} animated={!reduceMotion} />
      </div>
      <h1 className="splash-word">DSTNS</h1>
      <p className="splash-sub">Deterministic Spatiotemporal Transport Network Simulator</p>

      <div className="splash-status">
        <span className="splash-stage">{stage.label}</span>
        {stage.detail && <span className="splash-detail">{stage.detail}</span>}
      </div>

      <div
        className={`splash-track${known ? "" : " indeterminate"}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? percent : undefined}
        aria-label={stage.label}
      >
        <i style={known ? { width: `${percent}%` } : undefined} />
      </div>

      {known && <span className="splash-percent mono">{percent}%</span>}

      {stalled && onDismiss && (
        <button className="btn splash-skip" onClick={onDismiss}>
          Continue without waiting
        </button>
      )}

      <p className="splash-licence">
        © 2026 Varun Karthic · AGPL-3.0-or-later · Map data © OpenStreetMap
        contributors (ODbL)
      </p>
    </div>
  );
}

/**
 * Translate what the core reports into a stage the splash can show.
 *
 * `mapStatus` is the live download report; `lifecycle` and `stage` come from
 * the simulation client. Keeping the mapping here means the splash itself has
 * no opinion about the core's vocabulary.
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
): SplashStage | null {
  if (hasTopology) return null;

  if (mapStatus?.active) {
    const city = mapStatus.city || "the district";
    const mib = (n: number) => (n / (1024 * 1024)).toFixed(1);
    if (mapStatus.phase === "download") {
      const known = (mapStatus.total ?? 0) > 0;
      return {
        label: `Downloading ${city}`,
        detail: known
          ? `${mib(mapStatus.bytes ?? 0)} of ${mib(mapStatus.total!)} MiB from OpenStreetMap`
          : `${mib(mapStatus.bytes ?? 0)} MiB from OpenStreetMap`,
        progress: known ? (mapStatus.bytes ?? 0) / mapStatus.total! : undefined,
      };
    }
    if (mapStatus.phase === "parse")
      return { label: `Validating ${city}`, detail: "Checking the downloaded map" };
    return {
      label: `Requesting ${city}`,
      detail: "Waiting for Overpass to build the extract",
    };
  }

  if (lifecycle === "IDLE")
    return { label: "Awaiting a run", detail: "Start a simulation from the CLI" };
  if (lifecycle === "PREPARING")
    return { label: "Compiling the scenario", detail: "Building the road graph and schedules" };

  return { label: clientStage || "Connecting to the simulation" };
}
