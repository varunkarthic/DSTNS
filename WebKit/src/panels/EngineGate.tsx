// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icons";
import { GateParticles } from "./GateParticles";
import { api } from "../core/api";
import type { EngineApproval, EngineIdentity } from "../core/types";
import type { UiNotification } from "../core/notificationModel";

/**
 * The unstable-engine gate (docs/design/engine-governance.md), as a person meets it.
 *
 * A run on an alpha or beta engine waits on the server until someone accepts the risk. This asks, once the interface
 * is ready, above everything else: the tour and notifications wait while it is open. The approval itself lives only on
 * the server, for that run, so nothing kept in this browser can answer it. What is kept here is only which engine
 * versions this browser has been told about, so that a new version is announced once, with its changes.
 *
 * A stable engine is never held; a new version of one is announced once, in a notice that needs no answer.
 */

const SEEN = "dstns.engine-versions-seen";

/** Which version of each engine this browser has been told about. */
export function seenVersion(id: string): string | null {
  try {
    return (JSON.parse(localStorage.getItem(SEEN) || "{}") as Record<string, string>)[id] ?? null;
  } catch {
    return null;
  }
}

export function rememberVersion(engine: EngineIdentity) {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN) || "{}") as Record<string, string>;
    seen[engine.id] = engine.version;
    localStorage.setItem(SEEN, JSON.stringify(seen));
  } catch {
    // Storage may be full or off; the notice then shows again, which is the safe side.
  }
}

export function channelName(channel: EngineIdentity["channel"]) {
  return channel === "alpha" ? "Alpha" : channel === "beta" ? "Beta" : "Stable";
}

/** core-ng 0.6.0 · Alpha · standalone engine */
export function engineLabel(engine: EngineIdentity) {
  return `${engine.id} ${engine.version} · ${channelName(engine.channel)} · ${engine.type === "delegating" ? "delegating engine" : "standalone engine"}`;
}

/** How long the notice of an engine's new version stays in the tray, if nothing has opened it. */
export const ENGINE_UPDATE_DWELL_MS = 20000;

/**
 * A stable engine's new version, announced once in the notifications at the bottom left, as everything else the
 * system has to say is, once the interface is ready: the version before and after, and what changed.
 */
export function engineUpdateNotification(engine: EngineIdentity, previous: string, virtual: number): UiNotification {
  return {
    id: `engine-update:${engine.id}@${engine.version}`,
    newsIds: [],
    type: "ENGINE_UPDATED",
    category: "system",
    severity: "info",
    timestamp: virtual,
    startedAt: virtual,
    title: `${engine.id} updated to ${engine.version}`,
    summary: sentence(engine.changes[0]?.replace(/^[0-9.]+(?: \([a-z]+\))?: /, "")) ?? `${engine.id} ${engine.version} runs this world.`,
    details: [
      { label: "Version", value: `${previous} → ${engine.version}` },
      ...engine.changes.slice(0, 3).map((change) => ({ label: change.split(":")[0], value: change.slice(change.indexOf(":") + 1).trim() })),
    ],
    technical: [
      { label: "Engine", value: engine.id },
      { label: "Channel", value: channelName(engine.channel) },
      { label: "Type", value: engine.type === "delegating" ? "Delegating" : "Standalone" },
    ],
    count: 1,
  };
}

/** A change note as a sentence: its first letter capitalised. */
function sentence(text?: string): string | undefined {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : undefined;
}

/** The notice of a new version of the running engine, while it is in the tray. */
export function useEngineUpdateNotes(ready: boolean, running: EngineIdentity | null | undefined, virtual: number): UiNotification[] {
  const [note, setNote] = useState<UiNotification | null>(null);
  useEffect(() => {
    if (!ready || !running || running.channel !== "stable") return;
    const previous = seenVersion(running.id);
    if (previous === running.version) return;
    rememberVersion(running);
    // The first engine this browser has seen is not news; a new version of one it has is.
    if (previous === null) return;
    setNote(engineUpdateNotification(running, previous, virtual));
    const timer = window.setTimeout(() => setNote(null), ENGINE_UPDATE_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [ready, running?.id, running?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => (note ? [note] : []), [note]);
}

export function EngineGate({ ready, onOpenChange }: {
  /** The interface is ready (and its start-up film has played where it plays): the question may be asked. */
  ready: boolean;
  /** Whether the gate is on screen, so the tour and notifications can wait. */
  onOpenChange: (open: boolean) => void;
}) {
  const [approval, setApproval] = useState<EngineApproval | null>(null);
  const [step, setStep] = useState<"ask" | "reject">("ask");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showChanges, setShowChanges] = useState(false);
  // forming: the particles gather onto the box; open; leaving: the box gives way to them.
  const [phase, setPhase] = useState<"forming" | "open" | "leaving">("forming");
  const decidedId = useRef("");
  const box = useRef<HTMLDivElement>(null);

  // The gate's state, every second while the page is open: a start may be held at any time the operator starts one.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const answer = await api.engineApproval();
        if (!cancelled) setApproval(answer.data);
      } catch {
        // The server may be starting or gone; the next poll tells.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const waiting = approval?.state === "pending" && approval.approval?.acknowledge_in === "observer" ? approval.approval : null;
  // While leaving, the box stays until its particles have gone, whatever the server now says.
  const [leavingFor, setLeavingFor] = useState<EngineApprovalWait | null>(null);
  const shown = waiting && decidedId.current !== waiting.id ? waiting : leavingFor;
  const open = ready && !!shown;
  useEffect(() => onOpenChange(open), [open, onOpenChange]);
  useEffect(() => {
    if (!waiting || decidedId.current === waiting.id) return;
    setStep("ask");
    setError("");
    // A version new to this browser opens its changes, where the window has the room; otherwise they are a click away.
    setShowChanges(seenVersion(waiting.engine.id) !== waiting.engine.version && window.innerHeight >= 780);
  }, [waiting?.id]); // eslint-disable-line react-hooks/exhaustive-deps


  const decide = useCallback(async (decision: "accept" | "reject", then = "", engine = "") => {
    if (!waiting) return;
    setBusy(true);
    setError("");
    try {
      const answer = await api.decideEngine(waiting.id, decision, then, engine);
      rememberVersion(waiting.engine);
      if (answer.data.start_error) {
        setError(answer.data.start_error);
        return;
      }
      decidedId.current = waiting.id;
      setLeavingFor(waiting);
      setPhase("leaving");
      setApproval(answer.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The decision was not recorded. Try again.");
    } finally {
      setBusy(false);
    }
  }, [waiting]);

  const rect = () => box.current?.querySelector(".engine-gate")?.getBoundingClientRect() ?? null;
  const tone = shown?.engine.channel === "beta" ? "beta" : "alpha";

  return (
    <>
      {open && shown && createPortal(
        // On the body itself, so no stacking context of the page (the start-up film's included) can sit above it.
        <div ref={box} className={`engine-gate-stage engine-gate-${phase}`}>
          <Dialog labelledBy="engine-gate-title" role="alertdialog" className={`engine-gate engine-gate-${shown.engine.channel}`} scrimClassName="engine-gate-scrim">
            <div className="engine-gate-body">
            <header className="engine-gate-head">
              <span className={`engine-gate-badge engine-gate-badge-${shown.engine.channel}`}>
                <span aria-hidden="true">{shown.engine.channel === "alpha" ? "▲▲" : "▲"}</span> {channelName(shown.engine.channel)} engine
              </span>
              <h2 id="engine-gate-title">
                {step === "ask" ? <>{shown.engine.id} {shown.engine.version} is not yet a stable engine</> : "Rejected. What now?"}
              </h2>
              <p className="engine-gate-lead">
                {step === "ask" ? (
                  <>This run asks for <strong>{shown.engine.id}</strong>, a {channelName(shown.engine.channel).toLowerCase()} engine. Please confirm you accept what that means before it starts.</>
                ) : (
                  <>A new start on another engine keeps <strong>only the seed</strong>. It is a new world: another engine may make a different one from the same seed, and nothing of this run is carried over.</>
                )}
              </p>
              {error && <p className="engine-gate-error" role="alert">{error}</p>}
            </header>
            <div className="engine-gate-grid">
              <section className="engine-gate-card" aria-label="What this means">
                <h3><Icon name="info" size={13} /> What this means</h3>
                <ul className="engine-gate-points">
                  <li><span aria-hidden="true"><Icon name="clock" size={16} /></span><span><strong>Nothing has started.</strong> The run, and anything an application asks of it, waits for your answer.</span></li>
                  <li><span aria-hidden="true"><Icon name="pulse" size={16} /></span><span><strong>Results may change.</strong> A later version may give a different result for the same seed.</span></li>
                  <li><span aria-hidden="true"><Icon name="history" size={16} /></span><span><strong>There is a way back.</strong> Reject, and you can start the same seed on a stable engine.</span></li>
                </ul>
              </section>
              <aside className="engine-gate-card engine-gate-facts" aria-label="About this engine">
                <h3><Icon name="system" size={13} /> This engine</h3>
                <dl>
                  <div><dt>Engine</dt><dd>{shown.engine.id}</dd></div>
                  <div><dt>Version</dt><dd className="mono">{shown.engine.version}{seenVersion(shown.engine.id) !== shown.engine.version && <span className="engine-gate-new">New</span>}</dd></div>
                  <div><dt>Channel</dt><dd>{channelName(shown.engine.channel)}</dd></div>
                  <div><dt>Type</dt><dd>{shown.engine.type === "delegating" ? "Delegating" : "Standalone"}</dd></div>
                  {shown.seed && <div className="wide"><dt>Seed</dt><dd className="mono engine-gate-seed">{shown.seed}</dd></div>}
                </dl>
                {shown.engine.shared.length > 0 && <p className="engine-gate-shared">Shared with every engine: {shown.engine.shared.join(", ")}.</p>}
              </aside>
            </div>
            {shown.engine.changes.length > 0 && (
              <div className="engine-gate-changelog">
                <button type="button" className="engine-gate-disclosure" aria-expanded={showChanges} onClick={() => setShowChanges((s) => !s)}>
                  <Icon name={showChanges ? "chevronDown" : "chevronRight"} size={13} /> What changed, version by version
                </button>
                {showChanges && (
                  <ul className="engine-gate-changes">
                    {shown.engine.changes.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                )}
              </div>
            )}
            </div>
            {step === "ask" ? (
              <div className="engine-gate-actions">
                <span className="engine-gate-footnote">Asked once for this run. Settings, Engine says how runs are held.</span>
                <button type="button" className="btn" disabled={busy || phase !== "open"} onClick={() => setStep("reject")}>Reject</button>
                <button type="button" className="btn primary" disabled={busy || phase !== "open"} autoFocus onClick={() => void decide("accept")}>Accept the risk and start</button>
              </div>
            ) : (
              <div className="engine-gate-actions">
                <button type="button" className="btn" disabled={busy} onClick={() => setStep("ask")}>Back</button>
                <span className="engine-gate-spacer" />
                <button type="button" className="btn danger" disabled={busy} onClick={() => void decide("reject", "terminate")}>End the session</button>
                <button type="button" className="btn" disabled={busy} onClick={() => void decide("reject")}>Start nothing</button>
                {(approval?.alternatives ?? []).map((engine) => (
                  <button key={engine.id} type="button" className="btn primary" disabled={busy} onClick={() => void decide("reject", "regenerate", engine.id)}>
                    Start the seed on {engine.id} {engine.version} (stable)
                  </button>
                ))}
              </div>
            )}
          </Dialog>
          {/* Keyed by the approval, so each one gathers afresh; it may finish at once (reduced motion), before any effect here. */}
          {phase === "forming" && <GateParticles key={`gather-${shown.id}`} target={rect} mode="gather" tone={tone} onDone={() => setPhase("open")} />}
          {phase === "leaving" && <GateParticles target={rect} mode="scatter" tone={tone} onDone={() => { setLeavingFor(null); setPhase("forming"); }} />}
        </div>,
        document.body,
      )}
    </>
  );
}

type EngineApprovalWait = NonNullable<EngineApproval["approval"]>;
