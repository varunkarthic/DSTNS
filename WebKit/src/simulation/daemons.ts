// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type DaemonMessage } from "../core/api";
import type { NotificationSeverity, UiNotification } from "../core/notificationModel";

/** How often the observer asks the daemons' queues for what is new. */
const POLL_MS = 3000;

/** A daemon's message, as a notification from System, at the severity of its level. */
export function daemonNotification(message: DaemonMessage, virtual: number): UiNotification {
  const severity: NotificationSeverity = message.level === "info" ? "info" : message.level === "warning" ? "warning" : "alert";
  return {
    id: `daemon:${message.queue}:${message.sequence}`,
    newsIds: [],
    type: "DAEMON",
    category: "system",
    severity,
    timestamp: virtual,
    startedAt: virtual,
    title: message.title,
    summary: message.text,
    details: Object.entries(message.data)
      .filter(([, v]) => typeof v === "number" || typeof v === "string")
      .map(([label, value]) => ({ label: label.replace(/_/g, " "), value: String(value) })),
    technical: [
      { label: "Daemon", value: message.daemon },
      { label: "Message", value: message.id },
      { label: "Queue", value: message.queue },
    ],
    count: 1,
  };
}

/**
 * The daemons' queues, heard from now on: what they notice, as notifications from System, each for its dwell. Off, or
 * on a server without them, it does nothing.
 */
export function useDaemonNotifications(dwellMs: number, virtual: number) {
  const [items, setItems] = useState<{ note: UiNotification; until: number }[]>([]);
  const clock = useRef(virtual);
  clock.current = virtual;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cursor: Record<"emergency" | "notification", number | null> = { emergency: null, notification: null };
    const poll = async () => {
      try {
        // From the latest when first heard, so that what happened before this page opened is not replayed.
        if (cursor.emergency === null || cursor.notification === null) {
          const overview = (await api.daemons()).data;
          if (!overview.enabled) return;
          cursor.emergency = overview.queues.daemonEmergencyQueue?.latest_sequence ?? 0;
          cursor.notification = overview.queues.daemonNotificationQueue?.latest_sequence ?? 0;
        }
        for (const queue of ["emergency", "notification"] as const) {
          const read = (await api.daemonQueue(queue, cursor[queue] ?? 0)).data;
          cursor[queue] = read.latest_sequence;
          if (cancelled || !read.items.length) continue;
          const until = performance.now() + dwellMs * (queue === "emergency" ? 2 : 1);
          setItems((old) => [...old, ...read.items.map((m) => ({ note: daemonNotification(m, clock.current), until }))].slice(-100));
        }
      } catch {
        // A server without daemons, or not answering: asked again in a moment.
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [dwellMs]);
  useEffect(() => {
    if (!items.length) return;
    const next = Math.min(...items.map((item) => item.until));
    const timer = setTimeout(() => setItems((old) => old.filter((item) => item.until > performance.now())), Math.max(0, next - performance.now()) + 10);
    return () => clearTimeout(timer);
  }, [items]);
  return {
    notes: useMemo(() => items.map((item) => item.note), [items]),
    dismiss: (id: string) => setItems((old) => old.filter((item) => item.note.id !== id)),
  };
}
