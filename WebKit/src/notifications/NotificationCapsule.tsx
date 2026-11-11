// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { BrandLogo } from "../components/BrandLogo";
import { Spring } from "../CoreMotion/motion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSettle } from "../CoreMotion/settle";
import { Icon, categoryIcon } from "../components/Icons";
import { focusMatches, SEVERITY_LABEL, REALISTIC_NEWS } from "../core/notificationModel";
import type { UiNotification } from "../core/notificationModel";
import { useTimeFormat } from "../core/preferences";
import { formatDuration } from "../core/timeFormat";

/**
 * The notification capsule.
 *
 * Collapsed, it is one fixed-height line in the lower map cluster: the most
 * relevant event and a count of the others. Clicking expands the same card
 * upward in place to the full description, measured details, the raw
 * technical fields and the other current events. The list shown while it is
 * open is held steady, so an expiring notification cannot vanish mid-read.
 *
 * It opens as the dock's panels do: one spring carries the card's height, a
 * little past where it settles and back, its corners from the pill's to the
 * panel's, and the words, which sharpen out of a blur once there is room for
 * them. Closing is the same spring run back, and either can interrupt the other.
 */

const OPEN = { k: 170, c: 21 };
const CLOSE = { k: 260, c: 33 };
const CLOSED_RADIUS = 20;
const OPEN_RADIUS = 26;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** The card at a point along the way. Pure, so it can be checked. */
export function capsuleFrame(t: number, fullHeight: number) {
  const words = smooth((t - 0.38) / 0.5);
  return {
    height: Math.max(0, t) * fullHeight,
    radius: CLOSED_RADIUS + (OPEN_RADIUS - CLOSED_RADIUS) * smooth(t / 0.4),
    opacity: words,
    lift: (1 - words) * 10,
    blur: (1 - words) * 4,
  };
}
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
  const closeCapsule = useCallback(() => setOpen(false), []);
  useSettle(open, closeCapsule, 500, () => setOpen(true));
  const [technical, setTechnical] = useState(false);
  const [held, setHeld] = useState<UiNotification[] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const spring = useRef<Spring | null>(null);

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
    }, reduceMotion ? 0 : 560);
  };

  // The spring paints the card directly: nothing re-renders while it moves.
  useLayoutEffect(() => {
    const paint = (t: number) => {
      if (!body.current || !inner.current || !card.current) return;
      const f = capsuleFrame(t, inner.current.offsetHeight);
      // At rest open, the card follows what it holds: another event, or the technical details shown.
      body.current.style.height = t === 1 ? "auto" : `${f.height.toFixed(1)}px`;
      card.current.style.borderRadius = `${f.radius.toFixed(2)}px`;
      inner.current.style.opacity = f.opacity.toFixed(3);
      inner.current.style.transform = f.lift > 0.05 ? `translateY(${f.lift.toFixed(1)}px)` : "";
      inner.current.style.filter = f.blur > 0.05 ? `blur(${f.blur.toFixed(1)}px)` : "";
    };
    spring.current ??= new Spring(0, OPEN, paint, 0.001);
    const s = spring.current;
    if (reduceMotion) {
      s.jump(open ? 1 : 0);
      return;
    }
    s.setPreset(open ? OPEN : CLOSE);
    s.set(open ? 1 : 0);
  });
  useEffect(() => () => spring.current?.stop(), []);

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
        ref={card}
        className={`capsule sev-${current.severity}${open ? " open" : ""}${reduceMotion ? " still" : ""}${current.app ? " from-webfabric" : ""}${current.isd ? " from-isd" : ""}`}
        aria-label="Notifications"
        role={urgent ? "alert" : undefined}
        aria-live={urgent ? "assertive" : "polite"}
      >
        <div ref={body} className="capsule-body" aria-hidden={!open} inert={!open || undefined}>
          <div ref={inner} className="capsule-body-inner scroll-region">
            <div className="capsule-pad">
              <>
                <div className="capsule-detail-head">
                  <span className="capsule-kind">
                    {current.app ? <><BrandLogo name="webfabric" height={13} /><span className="capsule-app">{current.app}</span></> : current.isd ? "Intentional system design" : current.category === "incident" ? "Incident" : current.category.charAt(0).toUpperCase() + current.category.slice(1)}
                    {focused && <em className="capsule-following">Following</em>}
                    {current.source === "realistic" && <em className="capsule-realistic" title="Written on this device by Apple's Foundation Model">{REALISTIC_NEWS}</em>}
                  </span>
                  {/* A notification leaves on its own and closes with its head; only an error, which would stay, can be dismissed. */}
                  {urgent && onDismissError && <button type="button" className="capsule-icon-btn" aria-label="Dismiss error" onClick={() => onDismissError()}>
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
            <span className="capsule-badge" key={others.length} aria-hidden="true" title={`${others.length} more ${others.length === 1 ? "notification" : "notifications"}`}>
              {others.length} more
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
