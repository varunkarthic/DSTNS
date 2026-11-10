// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "../components/Icons";
import { Logo } from "../components/Logo";
import { BootScene, MAP_AT_MS, QUICK_ARRIVAL } from "./BootScene";
import { currentFeatures } from "../core/features";
import type { CSSProperties } from "react";

/**
 * The loading surface.
 *
 * One design for every wait: starting up, generating a new world, and
 * reconnecting. It shows only what the core has actually reported: the
 * stages it has passed, a concise status line, and a percentage only where a
 * real total is known. Failures replace the stages with an explanation and a
 * way forward.
 *
 * "boot" takes the whole screen and leads with the mark, because at that point
 * there is nothing behind it to see. "overlay" floats a card over the dimmed
 * map, because there is.
 */

export type BootPhase = "blank" | "title" | "film";

/**
 * The first thing seen: still and plain, so that everything after it arrives. As the
 * film starts, particles take up the logo's exact shape and it fades out from under them.
 */
function BootTitle({ phase }: { phase: BootPhase }) {
  const [gone, setGone] = useState(phase === "film");
  useEffect(() => {
    if (phase !== "film" || gone) return;
    // The particles take it apart from here, sweeping across it.
    const timer = setTimeout(() => setGone(true), 1700);
    return () => clearTimeout(timer);
  }, [phase, gone]);
  if (gone) return null;
  return (
    <div className={`boot-title is-${phase}`}>
      <div className="boot-title-logo"><Logo height={56} /></div>
      <p>Designed by Varun Karthic</p>
      <p className="boot-title-licence">© 2026 Varun Karthic · AGPL-3.0-or-later</p>
    </div>
  );
}

export interface LoadingStep {
  id: string;
  label: string;
}

export function LoadingSurface({
  mode,
  title,
  status,
  steps,
  stepIndex = 0,
  progress,
  progressLabel = "Progress",
  failed = false,
  error,
  note,
  actions,
  closing = false,
  reduceMotion,
  footer,
  titleId = "loading-title",
  role = "status",
  idle = false,
  eyebrow,
  aside,
  landing,
  phase = "film",
  ending = false,
  rejoin = false,
  exiting = false,
  quick = false,
  demo = false,
  fastBoot = false,
  onFilmCycle,
}: {
  /** "boot" covers the screen; "overlay" floats a card over the dimmed map. */
  mode: "boot" | "overlay";
  title: string;
  status?: string;
  steps?: readonly LoadingStep[];
  stepIndex?: number;
  /** 0 to 1, only when a real total is known. */
  progress?: number;
  progressLabel?: string;
  failed?: boolean;
  error?: string;
  note?: string;
  actions?: ReactNode;
  closing?: boolean;
  reduceMotion: boolean;
  footer?: ReactNode;
  titleId?: string;
  role?: "status" | "alertdialog";
  /** Nothing is in progress, so nothing may look as if it is. */
  idle?: boolean;
  /** A line above the title, for the welcome. */
  eyebrow?: string;
  /** Something to read while waiting. */
  aside?: ReactNode;
  /** Where the particles go when the map takes over. */
  landing?: () => Float32Array | null;
  /** How far the opening has got: nothing, then the title, then the film. */
  phase?: BootPhase;
  /** The end of a session, with its own short version of the film. */
  ending?: boolean;
  /** The world is being replaced: its ending runs first, then the film without a title. */
  rejoin?: boolean;
  /** That ending is still under way, so nothing is shown over it yet. */
  exiting?: boolean;
  /** Back into a run already going, on reload. */
  quick?: boolean;
  /** Fast Boot: the name alone, as on a reload, with a quiet line of status under it. */
  fastBoot?: boolean;
  /** Demo Mode: the longer film, on a loop. */
  demo?: boolean;
  onFilmCycle?: () => void;
}) {
  // The wordmark hands over to the one in the header, so the screen resolves into
  // the interface instead of disappearing from in front of it.
  const surface = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!closing || mode !== "boot" || reduceMotion) return;
    const logo = surface.current?.querySelector<HTMLElement>(".boot-logo");
    const home = document.querySelector<HTMLElement>(".app-header .dstns-logo");
    if (!logo || !home) return;
    const a = logo.getBoundingClientRect();
    const b = home.getBoundingClientRect();
    // Where the header comes to rest, not where it is while it arrives, shifted up out of the way.
    const arriving = typeof DOMMatrixReadOnly === "function" ? new DOMMatrixReadOnly(getComputedStyle(home.closest(".app-header") ?? home).transform) : { e: 0, f: 0 };
    const scale = b.height / a.height;
    surface.current?.style.setProperty("--fly", `translate(${b.left - arriving.e + b.width / 2 - (a.left + a.width / 2)}px, ${b.top - arriving.f + b.height / 2 - (a.top + a.height / 2)}px) scale(${scale})`);
  }, [closing, mode, reduceMotion]);
  // The end's light and words are timed from when its particles begin, which is not before the page is seen.
  // Should the particles never begin, the words come anyway, once the page has been seen for a moment.
  const [endBegan, setEndBegan] = useState(false);
  useEffect(() => {
    if (!ending || endBegan) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(() => setEndBegan(true), 2500);
    };
    watch();
    document.addEventListener("visibilitychange", watch);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", watch);
    };
  }, [ending, endBegan]);
  const done = !!steps && stepIndex >= steps.length - 1 && !failed;
  const known = typeof progress === "number" && Number.isFinite(progress);
  const percent = known ? Math.round(Math.min(1, Math.max(0, progress!)) * 100) : 0;
  // Loading plays the film, with progress along the bottom. A failure or a shutdown is
  // something to read, so it stays a card in the middle.
  const film = mode === "boot" && !failed && (!!steps?.length || !!eyebrow || demo);
  // The adaptive film plays as many scenes as the wait allows, so nothing under it counts towards an end.
  const segments = film && !currentFeatures().presentation.dynamic_particles;
  const body = (
    <div className={`loading-card${film ? " film" : ""}`} data-tip-avoid>
      {mode === "boot" && (
        <div className={`loading-mark${reduceMotion || idle || failed ? "" : " animated"}`}>
          <Logo height={46} className="boot-logo" />
          <span className="boot-shine" aria-hidden="true" />
        </div>
      )}
      {/* Boot leads with the mark and reports progress on one line beneath it;
          the ring belongs to the overlay, and to a failure anywhere. */}
      {(mode === "overlay" || failed) && (
        <div className={`loading-ring${failed ? " failed" : ""}${done ? " done" : ""}${known ? " known" : ""}`} aria-hidden="true">
          <svg viewBox="0 0 48 48" width="48" height="48">
            <circle className="loading-ring-track" cx="24" cy="24" r="20" />
            <circle
              className="loading-ring-arc"
              cx="24"
              cy="24"
              r="20"
              pathLength={100}
              style={{ strokeDasharray: `${failed || done ? 100 : known ? Math.max(4, percent) : 26} 100` }}
            />
          </svg>
          {failed ? <Icon name="incident" size={18} /> : <img className="loading-favicon" src="/favicon.svg" alt="" />}
        </div>
      )}
      {eyebrow && <p className="loading-eyebrow">{eyebrow}</p>}
      {/* Demo Mode lets the film speak for itself: its heading is there for a screen reader only. */}
      <h2 id={titleId} key={title} className={demo ? "sr-only" : undefined}>{title}</h2>
      {failed ? (
        <>
          {error && (
            <p className="loading-error" id={`${titleId}-detail`}>
              {error}
            </p>
          )}
          {note && <p className="loading-note">{note}</p>}
        </>
      ) : (
        <>
          {steps && steps.length > 0 && (
            <ol className="loading-steps" aria-label="Progress">
              <span className="loading-steps-rail" aria-hidden="true"><i style={{ transform: `scaleX(${steps.length > 1 ? Math.min(1, stepIndex / (steps.length - 1)) : 0})` }} /></span>
              {steps.map((s, i) => (
                <li key={s.id} className={i < stepIndex ? "done" : i === stepIndex ? "active" : ""} aria-current={i === stepIndex ? "step" : undefined}>
                  {segments && <span className="film-segment" aria-hidden="true"><i style={i === stepIndex && known ? { transform: `translateX(${percent - 100}%)`, animation: "none" } : undefined} /></span>}
                  <span className="loading-step-dot" aria-hidden="true">
                    {i < stepIndex || (done && i === stepIndex) ? <Icon name="check" size={14} strokeWidth={2.4} /> : null}
                  </span>
                  {s.label}
                </li>
              ))}
            </ol>
          )}
          {status && (
            <p className="loading-status" id={`${titleId}-detail`} aria-live="polite">
              {status}
            </p>
          )}
          {known ? (
            <div className="loading-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={progressLabel}>
              <i style={{ transform: `translateX(${percent - 100}%)` }} />
            </div>
          ) : (
            // The bar's place is held, so the layout does not move when a total arrives.
            mode === "boot" && !film && <div className={`loading-progress${idle ? " idle" : " working"}`} aria-hidden="true" />
          )}
          {note && <p className="loading-note">{note}</p>}
        </>
      )}
      {aside}
      {actions && <div className="loading-actions">{actions}</div>}
    </div>
  );
  return (
    <div
      ref={surface}
      style={{ "--map-at": `${quick ? QUICK_ARRIVAL.mapAt : MAP_AT_MS}ms` } as CSSProperties}
      className={`loading-surface ${mode} phase-${film ? phase : "film"}${ending ? " ending" : ""}${ending && endBegan ? " began" : ""}${rejoin ? " rejoin" : ""}${exiting ? " exiting" : ""}${quick ? " quick" : ""}${fastBoot ? " fastboot" : ""}${closing ? " closing" : ""}${closing && film && !reduceMotion ? " landing" : ""}${reduceMotion ? " still" : ""}`}
      role={role}
      aria-modal={role === "alertdialog" ? true : undefined}
      aria-labelledby={titleId}
      aria-describedby={`${titleId}-detail`}
      aria-live={role === "status" ? "polite" : undefined}
    >
      {mode === "boot" && (
        <BootScene playing={film && phase === "film" && !exiting} asleep={film && phase !== "film"} closing={closing} landing={landing} ending={ending || rejoin} rejoin={rejoin} quiet={failed && rejoin} quick={quick} glint={fastBoot} demo={demo} onCycle={onFilmCycle} onEndBegan={() => setEndBegan(true)} reduceMotion={reduceMotion} />
      )}
      {/* The light the name goes out with, at the end of a session and of a world. */}
      {mode === "boot" && (ending || rejoin) && <span className="end-light" aria-hidden="true" />}
      {film && !rejoin && !quick && <BootTitle phase={phase} />}
      {fastBoot && !closing && (
        <div className="fastboot-status" aria-hidden="true">
          <span key={title}>{title}</span>
          {status && <small key={status}>{status}</small>}
          <i />
        </div>
      )}
      {body}
      {footer}
      {/* Where the source is, quietly, on the start-up and in Demo Mode. */}
      {mode === "boot" && !failed && !ending && !rejoin && (
        <a className="boot-source" href="https://github.com/varunkarthic/DSTNS" target="_blank" rel="noreferrer noopener" aria-label="Source on GitHub: varunkarthic/DSTNS">
          <Icon name="github" size={14} />
          <span>varunkarthic/DSTNS</span>
        </a>
      )}
    </div>
  );
}

