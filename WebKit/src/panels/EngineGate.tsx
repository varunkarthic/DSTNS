// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { GateParticles } from "./GateParticles";
import { api } from "../core/api";
import type { EngineApproval, EngineIdentity } from "../core/types";

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

/** core-ng 0.6.0 · Alpha · real engine */
export function engineLabel(engine: EngineIdentity) {
  return `${engine.id} ${engine.version} · ${channelName(engine.channel)} · ${engine.kind === "pseudo" ? "pseudo-engine" : "real engine"}`;
}

export function EngineGate({ ready, running, onOpenChange }: {
  /** The interface is ready (and its start-up film has played where it plays): the question may be asked. */
  ready: boolean;
  /** The engine of the running world, for the notice of a new stable version. */
  running?: EngineIdentity | null;
  /** Whether the gate is on screen, so the tour and notifications can wait. */
  onOpenChange: (open: boolean) => void;
}) {
  const [approval, setApproval] = useState<EngineApproval | null>(null);
  const [step, setStep] = useState<"ask" | "reject">("ask");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showChanges, setShowChanges] = useState(false);
  const [notice, setNotice] = useState<EngineIdentity | null>(null);
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
    setShowChanges(seenVersion(waiting.engine.id) !== waiting.engine.version);
  }, [waiting?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A stable engine's new version: one notice, needing no answer.
  useEffect(() => {
    if (!ready || !running || running.channel !== "stable") return;
    if (seenVersion(running.id) === running.version) return;
    const previous = seenVersion(running.id);
    rememberVersion(running);
    if (previous !== null) setNotice(running);
  }, [ready, running?.id, running?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 12000);
    return () => window.clearTimeout(timer);
  }, [notice]);

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
      {notice && (
        <div className="engine-notice" role="status">
          <span className="engine-notice-dot" aria-hidden="true" />
          <span><strong>Engine updated</strong> {notice.id} {notice.version}</span>
          <button type="button" className="btn small" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {open && shown && (
        <div ref={box} className={`engine-gate-stage engine-gate-${phase}`}>
          <Dialog labelledBy="engine-gate-title" role="alertdialog" className={`engine-gate engine-gate-${shown.engine.channel}`} scrimClassName="engine-gate-scrim">
            <div className="engine-gate-grid">
              <div className="engine-gate-main">
                <span className={`engine-gate-badge engine-gate-badge-${shown.engine.channel}`}>
                  <span aria-hidden="true">{shown.engine.channel === "alpha" ? "▲▲" : "▲"}</span> {channelName(shown.engine.channel)} engine
                </span>
                <h2 id="engine-gate-title">
                  {step === "ask" ? `${shown.engine.id} ${shown.engine.version} is not a stable engine` : "Rejected: what now?"}
                </h2>
                {step === "ask" ? (
                  <>
                    <p>
                      This run asks for <strong>{shown.engine.id}</strong>. An {channelName(shown.engine.channel).toLowerCase()} engine may fail,
                      give results that later versions change, or behave in ways a stable engine does not.
                    </p>
                    <p className="muted">Nothing has started. The run, and anything an application asks of it, waits for your answer.</p>
                  </>
                ) : (
                  <p>
                    A new start on another engine keeps <strong>only the seed</strong>. It is a new world: another engine may make a different one
                    from the same seed, and nothing of this run is carried over.
                  </p>
                )}
                {error && <p className="engine-gate-error" role="alert">{error}</p>}
              </div>
              <aside className="engine-gate-facts" aria-label="About this engine">
                <dl>
                  <div><dt>Engine</dt><dd>{shown.engine.id}</dd></div>
                  <div><dt>Version</dt><dd className="mono">{shown.engine.version}{seenVersion(shown.engine.id) !== shown.engine.version && <span className="engine-gate-new">New</span>}</dd></div>
                  <div><dt>Channel</dt><dd>{channelName(shown.engine.channel)}</dd></div>
                  {shown.seed && <div><dt>Seed</dt><dd className="mono">{shown.seed}</dd></div>}
                </dl>
                {shown.engine.shared.length > 0 && <p className="engine-gate-shared">Still shared with core-legacy: {shown.engine.shared.join(", ")}.</p>}
                <button type="button" className="btn link" aria-expanded={showChanges} onClick={() => setShowChanges((s) => !s)}>
                  {showChanges ? "Hide what changed" : "What changed"}
                </button>
                {showChanges && (
                  <ul className="engine-gate-changes">
                    {shown.engine.changes.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                )}
              </aside>
            </div>
            {step === "ask" ? (
              <div className="engine-gate-actions">
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
        </div>
      )}
    </>
  );
}

type EngineApprovalWait = NonNullable<EngineApproval["approval"]>;
