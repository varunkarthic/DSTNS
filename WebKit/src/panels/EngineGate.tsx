// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
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
  const decidedId = useRef("");

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
  const open = ready && !!waiting && decidedId.current !== waiting.id;
  useEffect(() => onOpenChange(open), [open, onOpenChange]);
  useEffect(() => {
    if (!open) return;
    setStep("ask");
    setError("");
    setShowChanges(waiting ? seenVersion(waiting.engine.id) !== waiting.engine.version : false);
  }, [open, waiting?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (answer.data.start_error) setError(answer.data.start_error);
      rememberVersion(waiting.engine);
      decidedId.current = waiting.id;
      setApproval(answer.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The decision was not recorded. Try again.");
    } finally {
      setBusy(false);
    }
  }, [waiting]);

  return (
    <>
      {notice && (
        <div className="engine-notice" role="status">
          <strong>Engine updated</strong>
          <span>{engineLabel(notice)}</span>
          <button type="button" className="btn small" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {open && waiting && (
        <Dialog labelledBy="engine-gate-title" role="alertdialog" className={`engine-gate engine-gate-${waiting.engine.channel}`} scrimClassName="engine-gate-scrim">
          <header className="engine-gate-head">
            <span className={`engine-gate-badge engine-gate-badge-${waiting.engine.channel}`}>
              <span aria-hidden="true">{waiting.engine.channel === "alpha" ? "▲▲" : "▲"}</span> {channelName(waiting.engine.channel)} engine
            </span>
            <h2 id="engine-gate-title">
              {step === "ask" ? `${waiting.engine.id} ${waiting.engine.version} is not a stable engine` : "Rejected: what now?"}
            </h2>
          </header>
          {step === "ask" ? (
            <div className="engine-gate-body">
              <p>
                This run asks for <strong>{waiting.engine.id}</strong> ({engineLabel(waiting.engine)}). An {channelName(waiting.engine.channel).toLowerCase()}{" "}
                engine may fail, give results that later versions change, or behave in ways a stable engine does not. Nothing has started:
                the run, and anything an application asks of it, waits for your answer.
              </p>
              {waiting.engine.shared.length > 0 && (
                <p className="muted">Still shared with core-legacy: {waiting.engine.shared.join(", ")}.</p>
              )}
              {seenVersion(waiting.engine.id) !== waiting.engine.version && (
                <p><strong>New version for this browser.</strong></p>
              )}
              <button type="button" className="btn link" aria-expanded={showChanges} onClick={() => setShowChanges((s) => !s)}>
                {showChanges ? "Hide what changed" : "What changed"}
              </button>
              {showChanges && (
                <ul className="engine-gate-changes">
                  {waiting.engine.changes.map((line) => <li key={line}>{line}</li>)}
                </ul>
              )}
              {waiting.seed && <p className="muted mono">Seed {waiting.seed}</p>}
              {error && <p className="engine-gate-error" role="alert">{error}</p>}
              <div className="engine-gate-actions">
                <button type="button" className="btn" disabled={busy} onClick={() => setStep("reject")}>Reject</button>
                <button type="button" className="btn primary" disabled={busy} autoFocus onClick={() => void decide("accept")}>Accept the risk and start</button>
              </div>
            </div>
          ) : (
            <div className="engine-gate-body">
              <p>
                A new start on another engine keeps <strong>only the seed</strong>. It is a new world: another engine may make a different one
                from the same seed, and nothing of this run is carried over.
              </p>
              {error && <p className="engine-gate-error" role="alert">{error}</p>}
              <div className="engine-gate-actions column">
                {(approval?.alternatives ?? []).map((engine) => (
                  <button key={engine.id} type="button" className="btn primary" disabled={busy} onClick={() => void decide("reject", "regenerate", engine.id)}>
                    Start the seed on {engine.id} {engine.version} (stable)
                  </button>
                ))}
                <button type="button" className="btn" disabled={busy} onClick={() => void decide("reject")}>Start nothing</button>
                <button type="button" className="btn danger" disabled={busy} onClick={() => void decide("reject", "terminate")}>End the session</button>
                <button type="button" className="btn" disabled={busy} onClick={() => setStep("ask")}>Back</button>
              </div>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
