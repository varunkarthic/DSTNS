import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icons";
import { Logo } from "./Logo";

/**
 * The loading surface.
 *
 * One design for every wait: starting up, generating a new world, and
 * reconnecting. It shows only what the core has actually reported: the
 * stages it has passed, a concise status line, and a percentage only where a
 * real total is known. Failures replace the stages with an explanation and a
 * way forward.
 */

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
  seed,
  actions,
  closing = false,
  reduceMotion,
  footer,
  titleId = "loading-title",
  role = "status",
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
  seed?: string;
  actions?: ReactNode;
  closing?: boolean;
  reduceMotion: boolean;
  footer?: ReactNode;
  titleId?: string;
  role?: "status" | "alertdialog";
}) {
  const done = !!steps && stepIndex >= steps.length - 1 && !failed;
  const known = typeof progress === "number" && Number.isFinite(progress);
  const percent = known ? Math.round(Math.min(1, Math.max(0, progress!)) * 100) : 0;
  const body = (
    <div className="loading-card" data-tip-avoid>
      {mode === "boot" && (
        <div className="loading-mark">
          <Logo height={40} animated={!reduceMotion} />
        </div>
      )}
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
      <h2 id={titleId}>{title}</h2>
      {seed && (
        <p className="loading-seed">
          <span>Seed</span> <span className="mono">{seed}</span>
        </p>
      )}
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
              {steps.map((s, i) => (
                <li key={s.id} className={i < stepIndex ? "done" : i === stepIndex ? "active" : ""} aria-current={i === stepIndex ? "step" : undefined}>
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
          {known && (
            <div className="loading-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={progressLabel}>
              <i style={{ transform: `scaleX(${percent / 100})` }} />
            </div>
          )}
          {note && <p className="loading-note">{note}</p>}
        </>
      )}
      {actions && <div className="loading-actions">{actions}</div>}
    </div>
  );
  return (
    <div
      className={`loading-surface ${mode}${closing ? " closing" : ""}${reduceMotion ? " still" : ""}`}
      role={role}
      aria-modal={role === "alertdialog" ? true : undefined}
      aria-labelledby={titleId}
      aria-describedby={`${titleId}-detail`}
      aria-live={role === "status" ? "polite" : undefined}
    >
      {body}
      {footer}
    </div>
  );
}

/**
 * Keeps a surface mounted for its exit transition. Returns whether to render
 * it and whether it is on its way out.
 */
export function usePresence(visible: boolean, exitMs: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    if (visible) {
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      timer.current = setTimeout(() => {
        setMounted(false);
        setClosing(false);
      }, exitMs);
    }
    return () => clearTimeout(timer.current);
    // `mounted` is read, not tracked: only visibility drives the transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, exitMs]);
  return { mounted, closing };
}
