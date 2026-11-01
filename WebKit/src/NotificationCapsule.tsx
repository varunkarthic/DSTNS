// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { BrandLogo } from "./BrandLogo";
import { MOTION_MS } from "./motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, categoryIcon } from "./Icons";
import { focusMatches, SEVERITY_LABEL, REALISTIC_NEWS } from "./notificationModel";
import type { UiNotification } from "./notificationModel";
import { useTimeFormat } from "./preferences";
import { formatDuration } from "./timeFormat";

/**
 * The notification capsule.
 *
 * Collapsed, it is one fixed-height line in the lower map cluster: the most
 * relevant event and a count of the others. Clicking expands the same card
 * upward in place to the full description, measured details, the raw
 * technical fields and the other current events. The list shown while it is
 * open is held steady, so an expiring notification cannot vanish mid-read.
 */
export function NotificationCapsule(
{
  items,
  focusedKey,
  reduceMotion,
  onDismiss,
  systemError = "",
  onDismissError,
}: {
  /** Visible notifications, most relevant first. */
  items: UiNotification[];
  systemError?: string;
  onDismissError?: () => void;
  focusedKey: string | null;
  reduceMotion: boolean;
  onDismiss: (n: UiNotification) => void;
}) {
  const time = useTimeFormat();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [technical, setTechnical] = useState(false);
  const [held, setHeld] = useState<UiNotification[] | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // While open, what the person is reading is theirs. Newer events wait behind a
  // count rather than moving the list or the scroll position under them.
  const list = useMemo(() => {
    if (!held) return items;
    const live = new Map(items.map((n) => [n.id, n]));
    return held.map((n) => live.get(n.id) ?? n);
  }, [held, items]);
  const waiting = held ? items.filter((n) => !held.some((h) => h.id === n.id)).length : 0;

  // Runtime failures always preempt a selected/held simulation event. They
  // are not inserted into the held list, so recovery removes them immediately.
  const urgent: UiNotification | null = systemError ? {
    id: "runtime-error", type: "RUNTIME_ERROR", category: "system", severity: "alert",
    newsIds: [], timestamp: 0, startedAt: 0, title: "System error", summary: systemError,
    details: [], technical: [], count: 1,
  } : null;
  const current = urgent ?? list.find((n) => n.id === selected) ?? list[0];
  const others = list.filter((n) => n !== current);

  // What it shows stays put until it has finished closing, so closing is opening
  // played backward rather than something else entirely.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const collapse = () => {
    setOpen(false);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setHeld(null);
      setSelected(null);
      setTechnical(false);
    }, reduceMotion ? 0 : MOTION_MS.overlay + 160);
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) collapse();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") collapse();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!systemError && !list.length && open) collapse();
  }, [systemError, list.length, open]);

  // Nothing to show: the slot keeps its place in the HUD, empty. Silenced
  // events are reviewed in the Notifications tab, not announced here.
  if (!current) return <div className="capsule-slot empty" data-tutorial="notifications"><span className="hud-pill notification-idle"><Icon name="bell" size={16} /><span>Notifications</span><small>No new events</small></span></div>;

  const focused = focusMatches(current.focusKey, focusedKey);
  return (
    <div className="capsule-slot" data-tutorial="notifications" ref={root} data-tip-avoid>
      <article
        className={`capsule sev-${current.severity}${open ? " open" : ""}${reduceMotion ? " still" : ""}${current.app ? " from-webfabric" : ""}${current.isd ? " from-isd" : ""}`}
        aria-label="Notifications"
        role={urgent ? "alert" : undefined}
        aria-live={urgent ? "assertive" : "polite"}
      >
        <div className="capsule-body" aria-hidden={!open} inert={!open || undefined}>
          <div className="capsule-body-inner scroll-region">
            <div className="capsule-pad">
              <>
                <div className="capsule-detail-head">
                  <span className="capsule-kind">
                    {current.app ? <><BrandLogo name="webfabric" height={13} /><span className="capsule-app">{current.app}</span></> : current.isd ? "Intentional system design" : current.category === "incident" ? "Incident" : current.category.charAt(0).toUpperCase() + current.category.slice(1)}
                    {focused && <em className="capsule-following">Following</em>}
                    {current.source === "realistic" && <em className="capsule-realistic" title="Written on this device by Apple's Foundation Model">{REALISTIC_NEWS}</em>}
                  </span>
                  {(!urgent || onDismissError) && <button type="button" className="capsule-icon-btn" aria-label={urgent ? "Dismiss error" : "Dismiss notification"} onClick={() => urgent ? onDismissError?.() : onDismiss(current)}>
                    <Icon name="close" size={14} />
                  </button>}
                </div>
                <h3 className="capsule-full-title">{current.title}</h3>
                <p className="capsule-summary">{time.text(current.summary)}</p>
                <dl className="capsule-facts">
                  <div>
                    <dt>Severity</dt>
                    <dd>{SEVERITY_LABEL[current.severity]}</dd>
                  </div>
                  <div>
                    <dt>{current.count > 1 ? "First seen" : "Time"}</dt>
                    <dd className="mono">{time.time(current.startedAt)}</dd>
                  </div>
                  {current.count > 1 && (
                    <div>
                      <dt>Events</dt>
                      <dd>
                        {current.count} over {formatDuration(current.timestamp - current.startedAt) || "0 s"}
                      </dd>
                    </div>
                  )}
                  {current.location && (
                    <div>
                      <dt>Location</dt>
                      <dd>{current.location}</dd>
                    </div>
                  )}
                  {current.details.map((d) => (
                    <div key={d.label}>
                      <dt>{d.label}</dt>
                      <dd className={d.time !== undefined ? "mono" : undefined}>{d.time !== undefined ? time.time(d.time) : d.value}</dd>
                    </div>
                  ))}
                </dl>
                {current.technical.length > 0 && (
                  <div className={`capsule-tech${technical ? " shown" : ""}`}>
                    <button type="button" aria-expanded={technical} onClick={() => setTechnical((v) => !v)}>
                      Technical details
                      <Icon name="chevronDown" size={14} />
                    </button>
                    <div className="capsule-tech-body" inert={!technical || undefined}>
                      <dl className="mono">
                        {current.technical.map((t) => (
                          <div key={t.label}>
                            <dt>{t.label}</dt>
                            <dd>{t.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  </div>
                )}
                {waiting > 0 && (
                  <button type="button" className="capsule-waiting" onClick={() => setHeld(items.some((n) => n.id === current.id) ? items : [current, ...items])}>
                    <Icon name="bell" size={14} />
                    {waiting === 1 ? "1 new event" : `${waiting} new events`}
                  </button>
                )}
                {others.length > 0 && (
                  <div className="capsule-others">
                    <span className="capsule-others-title">Other events</span>
                    <ul>
                      {others.slice(0, 6).map((n) => (
                        <li key={n.id}>
                          <button type="button" onClick={() => { setSelected(n.id); setTechnical(false); }}>
                            <span className={`sev-dot sev-${n.severity}`} aria-hidden="true" />
                            <span className="capsule-other-title">{n.title}</span>
                            <span className="mono">{time.time(n.timestamp, { seconds: false })}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            </div>
          </div>
        </div>
        <button
          type="button"
          className="capsule-head"
          aria-expanded={open}
          aria-label={`${current.title}. ${current.summary}${others.length ? ` ${others.length} more.` : ""} ${open ? "Collapse" : "Expand"} notification.`}
          onClick={() => {
            if (open) collapse();
            else {
              clearTimeout(resetTimer.current);
              setHeld(list);
              setSelected(current.id);
              setOpen(true);
            }
          }}
        >
          <span className={`capsule-icon sev-${current.severity}`} aria-hidden="true">
            <Icon name={current.app ? "fabric" : categoryIcon(current.category)} size={14} />
          </span>
          <span className="capsule-text">
            {current.app && <small className="capsule-from">WebFabric · {current.app}</small>}
            {current.isd && <small className="capsule-from">Intentional system design</small>}
            <strong>{current.title}</strong>
            {!current.app && !current.isd && <span className="capsule-line">{current.location ?? time.text(current.summary)}</span>}
          </span>
          {!urgent && <span className="capsule-time mono">{time.time(current.timestamp, { seconds: false })}</span>}
          {others.length > 0 && (
            <span className="capsule-badge" key={others.length} aria-hidden="true">
              +{others.length}
            </span>
          )}
          <span className="capsule-chevron" aria-hidden="true">
            <Icon name="chevronUp" size={14} />
          </span>
        </button>
      </article>
    </div>
  );
}
