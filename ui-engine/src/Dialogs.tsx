import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icons";
import { Logo } from "./Logo";
import { LoadingSurface } from "./LoadingSurface";
import { useTimeFormat } from "./preferences";
import { formatDuration, formatWallDuration } from "./timeFormat";
import type { Backpressure, WorldStatus } from "./types";

/**
 * Modal surfaces.
 *
 * All of them share one shell: a blurred scrim that keeps the map legible
 * behind the dialog, a focus trap, Escape to dismiss, and a paired entry and
 * exit transition so nothing ever appears or vanishes abruptly.
 */

export function Scrim({
  onClose,
  labelledBy,
  children,
  closing = false,
  dismissible = true,
  className = "",
}: {
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
  closing?: boolean;
  dismissible?: boolean;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restore = useRef<Element | null>(null);

  useEffect(() => {
    restore.current = document.activeElement;
    // Move focus into the dialog so keyboard users are not left behind it.
    const first = panel.current?.querySelector<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    (first ?? panel.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const focusable = Array.from(
        panel.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      (restore.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose, dismissible]);

  return (
    <div
      className={`scrim${closing ? " closing" : ""}`}
      onPointerDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={`dialog glass ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}

/** About DSTNS: a card over the map rather than a separate page. */
export function AboutCard({
  version,
  onClose,
  closing,
  location,
  seed,
}: {
  version: string;
  onClose: () => void;
  closing?: boolean;
  location?: { city: string; country: string } | null;
  seed?: string;
}) {
  const [licence, setLicence] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copySeed = async () => {
    if (!seed) return;
    try {
      await navigator.clipboard.writeText(seed);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Scrim onClose={onClose} labelledBy="about-title" closing={closing} className="about-dialog">
      <div className="about-head">
        <Logo height={26} />
        <button type="button" className="icon-btn" aria-label="Close About DSTNS" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <h2 id="about-title" className="about-title">
        Deterministic Spatiotemporal Transport Network Simulator
      </h2>
      <div className="about-badges">
        <span className="badge">Version {version}</span>
        <span className="badge">AGPL-3.0-or-later</span>
      </div>

      <dl className="about-facts">
        <div>
          <dt>Simulating</dt>
          <dd>{location?.city ? `${location.city}, ${location.country}` : "No run"}</dd>
        </div>
        <div>
          <dt>Seed</dt>
          <dd className="about-seed">
            <span className="mono">{seed || "None"}</span>
            {seed && (
              <button type="button" className="icon-btn small" aria-label={copied ? "Seed copied" : "Copy seed"} onClick={() => void copySeed()}>
                <Icon name={copied ? "check" : "copy"} size={14} />
              </button>
            )}
          </dd>
        </div>
      </dl>

      <div className={`disclosure${licence ? " open" : ""}`}>
        <button type="button" className="disclosure-head" aria-expanded={licence} aria-controls="about-licence" onClick={() => setLicence((v) => !v)}>
          <Icon name="info" size={16} />
          <span>Licence and attribution</span>
          <Icon name="chevronDown" size={14} className="disclosure-chevron" />
        </button>
        <div className="disclosure-body" id="about-licence" inert={!licence || undefined}>
          <div>
            <p>
              Copyright © 2026 <strong>Varun Karthic</strong>. Released under the <strong>GNU Affero General Public License v3 or later</strong>.
              This is free software: you may redistribute it under the terms of that licence, and it comes with <strong>absolutely no warranty</strong>.
            </p>
            <p>
              Because DSTNS is operated over a network, section 13 applies: you are entitled to the complete corresponding source of the version
              you are interacting with.
            </p>
            <p className="muted">
              Map data © OpenStreetMap contributors, licensed under the Open Database License (ODbL) 1.0. That licence is separate from, and not
              superseded by, this program's licence.
            </p>
          </div>
        </div>
      </div>

      <div className="about-links">
        <a className="link-row" href="/api/v1/system/source">
          <Icon name="download" size={16} />
          <span>
            Source code
            <small>Complete corresponding source for this version</small>
          </span>
        </a>
        <a className="link-row" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">
          <Icon name="external" size={16} />
          <span>
            Map attribution
            <small>OpenStreetMap copyright and licence</small>
          </span>
        </a>
      </div>

      <div className="dialog-actions">
        <button className="btn primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Scrim>
  );
}

/** Confirmation before anything destructive. */
export function ConfirmCard({
  title,
  body,
  confirmLabel,
  tone = "default",
  icon,
  onConfirm,
  onCancel,
  closing,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  tone?: "default" | "danger";
  icon?: string;
  onConfirm: () => void;
  onCancel: () => void;
  closing?: boolean;
}) {
  return (
    <Scrim onClose={onCancel} labelledBy="confirm-title" closing={closing}>
      {icon && (
        <span className={`dialog-icon${tone === "danger" ? " danger" : ""}`} aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
      )}
      <h2 id="confirm-title" className={tone === "danger" ? "danger" : ""}>
        {title}
      </h2>
      <p className="dialog-body">{body}</p>
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          className={`btn ${tone === "danger" ? "danger-solid" : "primary"}`}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Scrim>
  );
}

/**
 * The Auto Focus offer, shown once per run when the mode is "enable".
 * "enable-force" turns it on without asking; "disable" never offers it.
 */
export function AutoFocusPrompt({
  onEnable,
  onDecline,
  closing,
}: {
  onEnable: () => void;
  onDecline: () => void;
  closing?: boolean;
}) {
  return (
    <Scrim onClose={onDecline} labelledBy="af-title" closing={closing}>
      <h2 id="af-title">This simulation supports Auto Focus</h2>
      <p className="dialog-body">
        The camera can follow incidents, flooding and rain on its own, framing
        each event's full extent as it develops. Any manual pan or zoom returns
        control to you. It can be changed at any time in Settings.
      </p>
      <div className="dialog-actions">
        <button className="btn" onClick={onDecline}>
          Disable
        </button>
        <button className="btn primary" onClick={onEnable}>
          Enable
        </button>
      </div>
    </Scrim>
  );
}

/**
 * The Async state. The interface is suspended, but the simulation is not: it
 * keeps running and keeps streaming, and the few controls that remain reflect
 * exactly that.
 */
export function SuspendedOverlay({
  asb,
  paused,
  onPlayPause,
  onReset,
  onTerminate,
  pending,
}: {
  asb: Backpressure;
  paused: boolean;
  onPlayPause: () => void;
  onReset: () => void;
  onTerminate: () => void;
  pending: boolean;
}) {
  return (
    <div className="scrim suspended" role="alertdialog" aria-labelledby="asb-title">
      <div className="dialog glass">
        <span className="eyebrow">Adaptive Simulation Backpressure</span>
        <h2 id="asb-title" className="danger">
          Interface suspended
        </h2>
        <p className="dialog-body">
          This simulation's interface has been suspended by the ASB (Adaptive
          Simulation Backpressure) because the simulation and the GUI were out of
          sync and failed to re-establish synchronization.
        </p>
        <p className="dialog-body muted">
          The simulation itself is unaffected. It is still running and still
          streaming data; only the display has been stood down. The interface
          resumes on its own once synchronization holds again.
        </p>
        <dl className="about-facts">
          <div>
            <dt>Backpressure</dt>
            <dd className="mono">{(asb.score * 100).toFixed(0)}%</dd>
          </div>
          <div>
            <dt>Suspended for</dt>
            <dd className="mono">{asb.state_for_s.toFixed(0)}s</dd>
          </div>
        </dl>
        <div className="dialog-actions">
          <button className="btn" onClick={onPlayPause} disabled={pending}>
            {paused ? "Resume simulation" : "Pause simulation"}
          </button>
          <button className="btn" onClick={onReset} disabled={pending}>
            Reset
          </button>
          <button className="btn danger-solid" onClick={onTerminate} disabled={pending}>
            Terminate session
          </button>
        </div>
      </div>
    </div>
  );
}

export interface CompletionSummary {
  seed: string;
  finalTime: number;
  simulatedSeconds: number;
  wallMs: number | null;
  incidents: number | null;
  significant: number | null;
  rainEvents: number | null;
  peakCongestion: number | null;
  city?: string;
}

/** Shown once when the virtual day reaches its end. */
export function CompletionDialog({
  summary,
  closing,
  pending,
  reportError,
  onDownload,
  onClose,
}: {
  summary: CompletionSummary;
  closing?: boolean;
  pending: boolean;
  reportError?: string;
  onDownload: () => void;
  onClose: () => void;
}) {
  const time = useTimeFormat();
  const fact = (label: string, value: ReactNode) => (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <Scrim onClose={onClose} labelledBy="complete-title" closing={closing}>
      <span className="dialog-icon ok" aria-hidden="true">
        <Icon name="check" size={20} strokeWidth={2.2} />
      </span>
      <h2 id="complete-title">Simulation Complete</h2>
      <p className="dialog-body">
        The virtual day has finished{summary.city ? ` for ${summary.city}` : ""}. The full record is available as a report.
      </p>
      <dl className="summary-grid">
        {fact("Final time", <span className="mono">{time.time(summary.finalTime)}</span>)}
        {fact("Simulated", formatDuration(summary.simulatedSeconds))}
        {summary.wallMs !== null && fact("Observed for", formatWallDuration(summary.wallMs))}
        {summary.incidents !== null && fact("Incidents", summary.incidents.toLocaleString())}
        {summary.significant !== null && fact("Significant events", summary.significant.toLocaleString())}
        {summary.rainEvents !== null && fact("Rain events", summary.rainEvents.toLocaleString())}
        {summary.peakCongestion !== null && fact("Peak congestion", `${summary.peakCongestion.toFixed(1)}%`)}
        {fact("Seed", <span className="mono seed-cell">{summary.seed || "None"}</span>)}
      </dl>
      {reportError && (
        <p className="dialog-error" role="alert">
          {reportError}
        </p>
      )}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button className="btn primary" onClick={onDownload} disabled={pending}>
          <Icon name="download" size={16} />
          {pending ? "Preparing report" : "Download Report"}
        </button>
      </div>
    </Scrim>
  );
}

// ---------------------------------------------------------------------------
// World generation
// ---------------------------------------------------------------------------

export const WORLD_STEPS = [
  { id: "seed", label: "Generating seed" },
  { id: "map", label: "Preparing map data" },
  { id: "network", label: "Building road network" },
  { id: "init", label: "Initializing simulation" },
  { id: "ready", label: "Ready" },
] as const;

/**
 * Which step a backend stage belongs to, and how to describe it. Only stages
 * the core actually reports are shown; download progress is a percentage only
 * when the core knows the total size.
 */
export function worldStep(status: WorldStatus | null, loaded: boolean): { index: number; detail: string; progress?: number } {
  if (!status || status.state === "idle") return { index: 0, detail: "Requesting a new seed" };
  const mib = (n: number) => (n / (1024 * 1024)).toFixed(1);
  const city = status.map?.city ? `${status.map.city}${status.map.country ? `, ${status.map.country}` : ""}` : "";
  switch (status.stage) {
    case "compiling":
      return { index: 1, detail: "Selecting a district from the seed" };
    case "requesting":
      return { index: 1, detail: city ? `Requesting ${city} from OpenStreetMap` : "Requesting map data" };
    case "downloading": {
      const total = status.map?.total ?? 0;
      const bytes = status.map?.bytes ?? 0;
      return {
        index: 1,
        detail: total > 0 ? `Downloading ${city || "map data"}: ${mib(bytes)} of ${mib(total)} MiB` : `Downloading ${city || "map data"}: ${mib(bytes)} MiB`,
        progress: total > 0 ? Math.min(1, bytes / total) : undefined,
      };
    }
    case "validating":
      return { index: 1, detail: city ? `Validating ${city}` : "Validating map data" };
    case "building":
      // Before the map fetch reports anything the core is still choosing the
      // district, which reads as preparation rather than construction.
      return status.elapsed_s < 0.8 ? { index: 1, detail: "Selecting a district from the seed" } : { index: 2, detail: "Constructing the graph, signals and schedules" };
    case "installing":
      return { index: 3, detail: "Starting the new world" };
    case "ready":
      return loaded ? { index: 4, detail: "The new world is loaded" } : { index: 3, detail: "Loading the new map" };
    default:
      return { index: 0, detail: "" };
  }
}

export function WorldGenerationOverlay({
  status,
  requestedSeed,
  loaded,
  closing,
  error,
  reduceMotion = false,
  onRetry,
  onCancel,
}: {
  status: WorldStatus | null;
  requestedSeed: string;
  /** The new world's map has arrived in the interface. */
  loaded: boolean;
  closing?: boolean;
  error: string;
  reduceMotion?: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const step = worldStep(status, loaded);
  const failed = !!error;
  const done = step.index >= WORLD_STEPS.length - 1;
  const retry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (failed) retry.current?.focus();
  }, [failed]);
  return (
    <LoadingSurface
      mode="overlay"
      role="alertdialog"
      titleId="world-title"
      title={failed ? "World generation failed" : done ? "New world ready" : "Generating new world"}
      seed={status?.seed || requestedSeed || undefined}
      steps={WORLD_STEPS}
      stepIndex={step.index}
      status={step.detail}
      progress={step.progress}
      progressLabel="Download progress"
      failed={failed}
      error={error}
      note={failed ? "The previous world is unchanged, and is still loaded." : done ? undefined : "The current world is paused and stays loaded until the new one is ready."}
      closing={closing}
      reduceMotion={reduceMotion}
      actions={
        failed ? (
          <>
            <button type="button" className="btn" onClick={onCancel}>
              Return to current world
            </button>
            <button type="button" ref={retry} className="btn primary" onClick={onRetry}>
              <Icon name="reroll" size={16} />
              Retry
            </button>
          </>
        ) : undefined
      }
    />
  );
}
