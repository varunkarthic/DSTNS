import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Logo } from "./Logo";
import type { Backpressure } from "./types";

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
}: {
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
  closing?: boolean;
  dismissible?: boolean;
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
        className="dialog glass"
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

/** Item 7: the About card. A card, not a page. */
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
  return (
    <Scrim onClose={onClose} labelledBy="about-title" closing={closing}>
      <div className="about-head">
        <Logo size={48} />
        <div>
          <h2 id="about-title">DSTNS</h2>
          <p>Deterministic Spatiotemporal Transport Network Simulator</p>
          <span className="chip">v{version}</span>
        </div>
      </div>

      <dl className="about-facts">
        <div>
          <dt>Simulating</dt>
          <dd>{location?.city ? `${location.city}, ${location.country}` : "No run"}</dd>
        </div>
        <div>
          <dt>Seed</dt>
          <dd className="mono">{seed || "—"}</dd>
        </div>
      </dl>

      <div className="about-licence">
        <p>
          Copyright © 2026 <strong>Varun Karthic</strong>
        </p>
        <p>
          Released under the <strong>GNU Affero General Public License v3 or
          later</strong>. This is free software: you are welcome to redistribute
          it under the terms of that licence, and it comes with{" "}
          <strong>absolutely no warranty</strong>.
        </p>
        <p>
          Because DSTNS is operated over a network, section 13 applies: you are
          entitled to the complete corresponding source of the version you are
          interacting with.
        </p>
        <p className="muted">
          Map data © OpenStreetMap contributors, licensed under the Open
          Database License (ODbL) 1.0 — separate from, and not superseded by,
          this program's licence.
        </p>
      </div>

      <div className="dialog-actions">
        <a className="btn" href="/api/v1/system/source">
          Source &amp; licence
        </a>
        <a
          className="btn"
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer noopener"
        >
          Map attribution
        </a>
        <button className="btn primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Scrim>
  );
}

/** Item 12: confirm before anything destructive. */
export function ConfirmCard({
  title,
  body,
  confirmLabel,
  tone = "default",
  onConfirm,
  onCancel,
  closing,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  tone?: "default" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
  closing?: boolean;
}) {
  return (
    <Scrim onClose={onCancel} labelledBy="confirm-title" closing={closing}>
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
 * Item 3: the auto-focus offer, shown once per run when the mode is "enable".
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
      <h2 id="af-title">This simulation supports Auto-Focus</h2>
      <p className="dialog-body">
        The camera can follow live disruption on its own — incidents, flooding
        and weather cells — gliding between them as they appear. Traffic signals
        are ignored, and any manual pan or zoom hands control straight back to
        you.
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
 * Item 11: the Async terminal state. The interface is suspended, but the
 * simulation is not: it keeps running and keeps streaming, and the few controls
 * that remain reflect exactly that.
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
