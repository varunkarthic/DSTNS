// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { formatBytes } from "../core/units";
import { BrandLogo } from "../components/BrandLogo";
import { Spring, SPRINGS } from "../CoreMotion/motion";
import { Badge } from "../components/settingsControls";
import { api } from "../core/api";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import type { FigureName } from "../CoreMotion/Figure";
import { Icon, type IconName } from "../components/Icons";
import { Logo } from "../components/Logo";
import { LoadingSurface } from "../film/LoadingSurface";
import { filmAvailable, REJOIN_AT_MS } from "../film/BootScene";
import { BOOT_STEPS, LICENCE, splashStageFor } from "../film/Splash";
import type { SplashStage } from "../film/Splash";
import { useTimeFormat } from "../core/preferences";
import { formatDuration, formatWallDuration } from "../core/timeFormat";
import type { Backpressure, WorldStatus, Envelope, Status, Topology } from "../core/types";

/** A figure that counts up to its value on a spring, so the result arrives rather than appears. */
function Stat({ label, value, digits = 0, suffix = "" }: { label: string; value: number; digits?: number; suffix?: string }) {
  const out = useRef<HTMLElement>(null);
  const text = (n: number) => `${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${suffix}`;
  useEffect(() => {
    if (document.querySelector(".reduce-motion")) return;
    const spring = new Spring(0, SPRINGS.spatialSlow, (n) => {
      if (out.current) out.current.textContent = text(n);
    }, 0.001);
    spring.set(value);
    return () => spring.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div>
      <dt>{label}</dt>
      <dd ref={out as never} className="mono">{text(value)}</dd>
    </div>
  );
}

/** About DSTNS: a card over the map rather than a separate page. */
export function AboutCard({
  version,
  onClose,
  closing,
  location,
  seed, status, topology, narratorBadge,
}: {
  narratorBadge?: string;
  status?: Envelope<Status> | null;
  topology?: Topology | null;
  version: string;
  onClose: () => void;
  closing?: boolean;
  location?: { city: string; country: string } | null;
  seed?: string;
}) {
  const [system, setSystem] = useState<Awaited<ReturnType<typeof api.systemInfo>> | null>(null);
  useEffect(() => {
    let cancelled=false;
    void api.systemInfo().then((info) => { if(!cancelled && typeof info?.version === "string")setSystem(info); }).catch(() => {});
    return () => { cancelled=true; };
  }, []);
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
    <Dialog onClose={onClose} labelledBy="about-title" closing={closing} className="about-dialog" figure="city">
      <header className="about-hero">
        <Logo height={24} />
        <button type="button" className="icon-btn about-close" aria-label="Close About DSTNS" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
        <h2 id="about-title" className="about-title">Deterministic Spatiotemporal Transport Network Simulator</h2>
        <p className="about-byline">Version {version} · © 2026 Varun Karthic · AGPL-3.0-or-later</p>
        <nav className="about-links" aria-label="Links">
          <a href="https://github.com/varunkarthic/DSTNS" target="_blank" rel="noreferrer noopener"><Icon name="github" size={16} />GitHub</a>
          <a href="https://dstns.readthedocs.io/" target="_blank" rel="noreferrer noopener"><Icon name="book" size={16} />Documentation</a>
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener"><Icon name="external" size={16} />Map attribution</a>
        </nav>
      </header>

      <div className="about-scroll scroll-region" tabIndex={0} aria-label="System details">
      <section className="about-section">
        <h3>This run</h3>
        <dl className="about-facts">
          <div>
            <dt>Simulating</dt>
            <dd>{location?.city ? `${location.city}, ${location.country}` : status?.run_id ? "Pinned map" : "No run"}</dd>
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
          <div><dt>Lifecycle</dt><dd>{status?.data.lifecycle || "Unavailable"}</dd></div>
          <div><dt>Network</dt><dd>{topology ? `${topology.nodes.length.toLocaleString()} nodes · ${topology.edges.length.toLocaleString()} edges · ${topology.features.length.toLocaleString()} places` : "Unavailable"}</dd></div>
          <div className="advanced-only"><dt>Coordinates</dt><dd className="mono">{topology?.location?.city ? `${topology.location.anchor_lat.toFixed(4)}, ${topology.location.anchor_lon.toFixed(4)}` : "Unavailable"}</dd></div>
          <div className="advanced-only"><dt>Run</dt><dd className="mono">{status?.run_id || "No run"}</dd></div>
          <div className="advanced-only"><dt>Graph hash</dt><dd className="mono">{topology?.graph_hash || "Unavailable"}</dd></div>
          <div className="advanced-only"><dt>Map source</dt><dd>{topology?.source || "Unavailable"}</dd></div>
          <div className="advanced-only"><dt>Map selection</dt><dd>{topology?.map_selection_version || "Unavailable"}</dd></div>
        </dl>
      </section>

      <section className="about-section">
        <h3>Built to be built on</h3>
        <div className="subsystem-cards">
          <article className="subsystem-card">
            <BrandLogo name="fabric" height={18} />
            <p>
              The layer through which everything reaches the simulator. Every program talks to DSTNS through one documented API, which
              keeps working as the engine beneath it changes.
            </p>
          </article>
          <article className="subsystem-card">
            <BrandLogo name="webfabric" height={18} />
            <p>
              Lets independent applications, such as a bus network planner, appear here beside the simulation. They register themselves,
              ask for what they need, and you decide what they may do in Settings.
            </p>
          </article>
        </div>
        <p className="about-fineprint">Fabric and WebFabric are DSTNS subsystems, © 2026 Varun Karthic, under the same licence.</p>
      </section>

      <section className="about-section">
        <h3>The system</h3>
        <dl className="about-facts">
          <div><dt>Engine</dt><dd>{system?.version || "Unavailable"}</dd></div>
          <div><dt>Interface</dt><dd>{version}</dd></div>
          <div><dt>API</dt><dd>{status?.api_version || "Unavailable"}</dd></div>
          <div>
            <dt>Realistic News</dt>
            <dd>{narratorBadge ? <Badge tone="warn">{narratorBadge}</Badge> : <Badge tone="ok">Available</Badge>}</dd>
          </div>
          <div>
            <dt>SUMO adapter</dt>
            <dd>{system?.sumo?.available ? <Badge tone="ok">{system.sumo.version || "Available"}</Badge> : <Badge>{system ? "Not installed" : "Unavailable"}</Badge>}</dd>
          </div>
          <div className="advanced-only"><dt>Compiler</dt><dd>{typeof system?.build?.compiler === "string" ? system.build.compiler : "Unavailable"}</dd></div>
          <div className="advanced-only"><dt>C++ standard</dt><dd>{typeof system?.build?.cpp_standard === "number" ? system.build.cpp_standard : "Unavailable"}</dd></div>
        </dl>
      </section>

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

      </div>
    </Dialog>
  );
}

/** Confirmation before anything that cannot be taken back. The figure acts out what confirming does. */
export function ConfirmCard({
  title,
  body,
  confirmLabel,
  confirmIcon,
  tone,
  figure,
  onConfirm,
  onCancel,
  closing,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  /** Drawn before the action's name, as the control that asked for it draws it. */
  confirmIcon?: IconName;
  tone?: "danger";
  figure: FigureName;
  onConfirm: () => void;
  onCancel: () => void;
  closing?: boolean;
}) {
  return (
    <Dialog onClose={onCancel} labelledBy="confirm-title" closing={closing} figure={figure} tone={tone}>
      <h2 id="confirm-title">{title}</h2>
      <p className="dialog-body">{body}</p>
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className={`btn tinted${tone === "danger" ? " danger" : ""}`} onClick={onConfirm}>
          {confirmIcon && <Icon name={confirmIcon} size={14} />}
          {confirmLabel}
        </button>
      </div>
    </Dialog>
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
    <Dialog onClose={onDecline} labelledBy="af-title" closing={closing} figure="viewfinder">
      <h2 id="af-title">This simulation supports Auto Focus</h2>
      <p className="dialog-body">
        The camera can follow incidents, flooding and rain on its own, framing
        each event's full extent as it develops. Any manual pan or zoom returns
        control to you. It can be changed at any time in Settings.
      </p>
      <div className="dialog-actions">
        <button className="btn" onClick={onDecline}>
          Not Now
        </button>
        <button className="btn primary" onClick={onEnable}>
          Turn On
        </button>
      </div>
    </Dialog>
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
    <Dialog labelledBy="asb-title" role="alertdialog" scrimClassName="suspended" className="suspended-dialog" figure="apart" tone="danger">
      <span className="eyebrow">Adaptive Simulation Backpressure</span>
      <h2 id="asb-title">Interface suspended</h2>
      <p className="dialog-body">
        The display fell out of step with the simulation and could not catch up, so it has been stood down. The simulation
        is unaffected: it is still running and still streaming. The interface resumes on its own once the two hold together
        again.
      </p>
      <dl className="dialog-facts">
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
    </Dialog>
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

/**
 * Shown once when the virtual day reaches its end.
 *
 * A finished run leaves the operator with three reasonable next moves - look
 * at what happened, watch the same day again, or go somewhere new - so the
 * screen offers all three rather than only a way out of the dialog. Replaying
 * the same seed is the safe one and leads; a new world discards this district
 * and is set apart from it.
 */
export function CompletionDialog({
  summary,
  closing,
  pending,
  reportError,
  onDownload,
  onReplay,
  onNewWorld,
  canGenerate = true,
  onClose,
}: {
  summary: CompletionSummary;
  closing?: boolean;
  pending: boolean;
  reportError?: string;
  onDownload: () => void;
  /** Replay this same scenario from the start of the day. */
  onReplay?: () => void;
  /** Leave this district and build a world from a fresh seed. */
  onNewWorld?: () => void;
  canGenerate?: boolean;
  onClose: () => void;
}) {
  const time = useTimeFormat();
  return (
    <Dialog onClose={onClose} labelledBy="complete-title" closing={closing} className="done-dialog" figure="arc">
      <h2 id="complete-title">The day is complete</h2>
      <p className="dialog-body">{summary.city ? `A full day in ${summary.city} has finished.` : "A full day has finished."}</p>
      <dl className="done-stats">
        {summary.peakCongestion !== null && <Stat label="Peak congestion" value={summary.peakCongestion} digits={1} suffix="%" />}
        {summary.incidents !== null && <Stat label="Incidents" value={summary.incidents} />}
        {summary.significant !== null && <Stat label="Significant events" value={summary.significant} />}
        {summary.rainEvents !== null && <Stat label="Rain events" value={summary.rainEvents} />}
      </dl>
      <dl className="done-facts">
        <div><dt>Final time</dt><dd className="mono">{time.time(summary.finalTime)}</dd></div>
        <div><dt>Simulated</dt><dd>{formatDuration(summary.simulatedSeconds)}</dd></div>
        {summary.wallMs !== null && <div><dt>Observed for</dt><dd>{formatWallDuration(summary.wallMs)}</dd></div>}
        <div className="done-seed"><dt>Seed</dt><dd className="mono">{summary.seed || "None"}</dd></div>
      </dl>
      {reportError && (
        <p className="dialog-error" role="alert">
          {reportError}
        </p>
      )}
      <div className="done-actions">
        <button className="btn primary done-save" onClick={onDownload} disabled={pending}>
          <Icon name="download" size={16} />
          {pending ? "Preparing report" : "Save Report"}
        </button>
        {onReplay && (
          <button className="btn" onClick={onReplay}>
            <Icon name="reset" size={16} />
            Restart same simulation
          </button>
        )}
        {onNewWorld && (
          <button className="btn" onClick={onNewWorld} disabled={!canGenerate}>
            <Icon name="reroll" size={16} />
            Generate a new world
          </button>
        )}
        <button className="btn ghost done-later" onClick={onClose}>
          Not Now
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// World generation
// ---------------------------------------------------------------------------

/**
 * The screen's words for a stage the core reports, the same as starting up: what is
 * happening on the left, its details on the right.
 */
export function worldStage(status: WorldStatus | null, loaded: boolean): SplashStage {
  const selecting = { step: 1, label: "Selecting world", detail: "Resolving the seed to a city district" };
  switch (status?.stage) {
    case "requesting":
    case "downloading":
    case "validating":
      return splashStageFor({ ...status.map, active: true }, "PREPARING", "", false) ?? selecting;
    case "building":
      // Before the map fetch reports anything the core is still choosing the district.
      return status.elapsed_s < 0.8 ? selecting : { step: 3, label: "Generating world", detail: "Building the road graph, signals and schedules" };
    case "installing":
      return { step: 4, label: "Initializing simulation", detail: "Starting the new world" };
    case "ready":
      return loaded ? { step: 4, label: "New world ready", detail: "The new world is loaded" } : { step: 4, label: "Initializing simulation", detail: "Loading the new map" };
    default:
      return selecting;
  }
}

export function WorldGenerationOverlay({
  status,
  loaded,
  closing,
  error,
  reduceMotion = false,
  landing,
  onRetry,
  onCancel,
}: {
  landing?: () => Float32Array | null;
  status: WorldStatus | null;
  /** The new world's map has arrived in the interface. */
  loaded: boolean;
  closing?: boolean;
  error: string;
  reduceMotion?: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const stage = worldStage(status, loaded);
  const failed = !!error;
  // The old world leaves first, and only then is there anything to report on screen.
  const [exiting, setExiting] = useState(!reduceMotion && filmAvailable());
  useEffect(() => {
    if (reduceMotion || !exiting) return;
    const timer = setTimeout(() => setExiting(false), REJOIN_AT_MS);
    return () => clearTimeout(timer);
  }, [reduceMotion, exiting]);
  const retry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (failed) retry.current?.focus();
  }, [failed]);
  return (
    <LoadingSurface
      mode="boot"
      rejoin
      exiting={exiting && !failed}
      landing={landing}
      footer={<p className="loading-licence">{LICENCE}</p>}
      role="alertdialog"
      titleId="world-title"
      title={failed ? "World generation failed" : stage.label}
      steps={BOOT_STEPS}
      stepIndex={stage.step}
      status={stage.detail}
      progress={stage.progress}
      progressLabel="Download progress"
      failed={failed}
      error={error}
      note={failed ? "The previous world is unchanged, and is still loaded." : undefined}
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
              Try another city
            </button>
          </>
        ) : undefined
      }
    />
  );
}
