// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useScrollFade } from "./scrollFade";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, categoryIcon } from "./Icons";
import { focusMatches, SEVERITY_LABEL } from "./notificationModel";
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
  const bodyScroll = useScrollFade<HTMLDivElement>();

  // While open, keep what the operator is reading, and add anything new.
  const list = useMemo(() => {
    if (!held) return items;
    const live = new Map(items.map((n) => [n.id, n]));
    const kept = held.map((n) => live.get(n.id) ?? n);
    return [...kept, ...items.filter((n) => !held.some((h) => h.id === n.id))];
  }, [held, items]);

  // Runtime failures always preempt a selected/held simulation event. They
  // are not inserted into the held list, so recovery removes them immediately.
  const urgent: UiNotification | null = systemError ? {
    id: "runtime-error", type: "RUNTIME_ERROR", category: "system", severity: "alert",
    newsIds: [], timestamp: 0, startedAt: 0, title: "System error", summary: systemError,
    details: [], technical: [], count: 1,
  } : null;
  const current = urgent ?? list.find((n) => n.id === selected) ?? list[0];
  const others = list.filter((n) => n !== current);

  const collapse = () => {
    setOpen(false);
    setHeld(null);
    setTechnical(false);
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
        className={`capsule sev-${current.severity}${open ? " open" : ""}${reduceMotion ? " still" : ""}`}
        aria-label="Notifications"
        role={urgent ? "alert" : undefined}
        aria-live={urgent ? "assertive" : "polite"}
      >
        <div className="capsule-body" aria-hidden={!open} inert={!open || undefined}>
          <div {...bodyScroll} className={`capsule-body-inner ${bodyScroll.className}`}>
              <>
                <div className="capsule-detail-head">
                  <span className="capsule-kind">
                    {current.category === "incident" ? "Incident" : current.category.charAt(0).toUpperCase() + current.category.slice(1)}
                    {focused && <em className="capsule-following">Following</em>}
                  </span>
                  {(!urgent || onDismissError) && <button type="button" className="capsule-icon-btn" aria-label={urgent ? "Dismiss error" : "Dismiss notification"} onClick={() => urgent ? onDismissError?.() : onDismiss(current)}>
                    <Icon name="close" size={14} />
                  </button>}
                </div>
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
                    {technical && (
                      <dl className="mono">
                        {current.technical.map((t) => (
                          <div key={t.label}>
                            <dt>{t.label}</dt>
                            <dd>{t.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
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
        <button
          type="button"
          className="capsule-head"
          aria-expanded={open}
          aria-label={`${current.title}. ${current.summary}${others.length ? ` ${others.length} more.` : ""} ${open ? "Collapse" : "Expand"} notification.`}
          onClick={() => {
            if (open) collapse();
            else {
              setHeld(list);
              setSelected(current.id);
              setOpen(true);
            }
          }}
        >
          <span className={`capsule-icon sev-${current.severity}`} aria-hidden="true">
            <Icon name={categoryIcon(current.category)} size={14} />
          </span>
          <span className="capsule-text">
            <strong>{current.title}</strong>
            <span className="capsule-line">{current.location ?? time.text(current.summary)}</span>
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
