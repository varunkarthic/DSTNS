// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useMemo, useRef, useState } from "react";
import type { UiNotification } from "./notificationModel";

/**
 * Intentional System Design Handler.
 *
 * Some of what DSTNS does on purpose looks like a fault from the outside: the interface
 * suspending itself, a speed that will not change, a map with less on it. When one of
 * these begins, the notification tray says that it is intended, why, and what to do
 * next. Do Not Disturb does not silence it, because it answers "is something wrong?".
 * Real failures are not handled here: they are reported as errors.
 *
 * Each condition is announced once per page load, for as long as it holds or until its
 * time on screen is up, and it stays in the notification history.
 */

export type ISDCondition = "async" | "restricted" | "rate-locked" | "rate-governed" | "motion-locked" | "reduced-detail" | "large-steps" | "app-lapsed";

export interface ISDNote {
  title: string;
  why: string;
  next: string[];
}

export interface ISDFigures {
  requested: number;
  applied: number;
}

const rate = (value: number) => `${Number(value.toFixed(2))}×`;

export function isdNote(condition: ISDCondition, figures: ISDFigures): ISDNote {
  switch (condition) {
    case "async":
      return {
        title: "Interface suspended on purpose",
        why: "It could not keep pace, so Adaptive Simulation Backpressure stopped drawing to protect the run. The simulation is still running and its results are not affected.",
        next: ["Wait, or pause the simulation to let the interface catch up.", "Reload the page if it does not recover."],
      };
    case "restricted":
      return {
        title: "Running with less, on purpose",
        why: "The interface fell behind, so Adaptive Simulation Backpressure has reduced what it draws until it recovers. The results of the run are not affected.",
        next: ["No action is needed. Full detail returns on its own.", "A lower simulation speed helps it recover sooner."],
      };
    case "rate-locked":
      return {
        title: `Speed held at ${rate(figures.applied)}`,
        why: `Your target is ${rate(figures.requested)}. Adaptive Simulation Backpressure holds the speed while the interface returns to sync, so it cannot fall further behind.`,
        next: ["No action is needed. The speed control unlocks on its own."],
      };
    case "rate-governed":
      return {
        title: `Speed reduced to ${rate(figures.applied)}`,
        why: `Your target is ${rate(figures.requested)}. The interface cannot currently keep up with it, so Adaptive Simulation Backpressure is applying ${rate(figures.applied)}. Your target is kept and returns when there is room.`,
        next: ["No action is needed. Closing other demanding tabs can help."],
      };
    case "motion-locked":
      return {
        title: "Reduced motion held on",
        why: "Animation is the first thing given up when the interface falls behind.",
        next: ["No action is needed. Your own setting returns once the interface recovers."],
      };
    case "reduced-detail":
      return {
        title: "Map detail reduced on purpose",
        why: "To catch up, the map has stopped drawing what changes constantly: traffic colours, flow markers, names and weather. Roads and places remain, and the simulation is unaffected.",
        next: ["No action is needed. The layers return once the interface is back in sync.", "A lower simulation speed helps it recover sooner."],
      };
    case "large-steps":
      return {
        title: "The map moves in larger steps",
        why: "Above 5×, a second of real time spans more simulated time than one snapshot shows, so vehicles appear to jump. The simulation still runs every step, and its results do not change.",
        next: ["Choose 5× or lower for continuous movement."],
      };
    case "app-lapsed":
      return {
        title: "An application stopped checking in",
        why: "WebFabric suspends an application that stops responding, so it cannot leave stale information on screen. DSTNS itself is unaffected.",
        next: ["Restart the application. It resumes where it was.", "Find its state in Settings, under WebFabric."],
      };
  }
}

export function isdNotification(condition: ISDCondition, figures: ISDFigures, virtual: number): UiNotification {
  const note = isdNote(condition, figures);
  return {
    id: `isd:${condition}`,
    newsIds: [],
    type: "INTENTIONAL_SYSTEM_DESIGN",
    category: "system",
    severity: "info",
    timestamp: virtual,
    startedAt: virtual,
    title: note.title,
    summary: note.why,
    details: note.next.map((value, i) => ({ label: i === 0 ? "What to do next" : "Or", value })),
    technical: [{ label: "Condition", value: condition }],
    count: 1,
    isd: true,
  };
}

/** How long one stays in the tray, if nothing has opened it. */
export const ISD_DWELL_MS = 14000;

/** The conditions just begun that have not been announced yet. */
export function newlyBegun(active: readonly ISDCondition[], announced: ReadonlySet<ISDCondition>): ISDCondition[] {
  return active.filter((condition) => !announced.has(condition));
}

export function useISDNotifications(active: readonly ISDCondition[], figures: ISDFigures, virtual: number): UiNotification[] {
  const announced = useRef(new Set<ISDCondition>());
  const startedAt = useRef(new Map<ISDCondition, number>());
  const [live, setLive] = useState<ISDCondition[]>([]);
  const key = active.join();
  useEffect(() => {
    const begun = newlyBegun(active, announced.current);
    for (const condition of begun) {
      announced.current.add(condition);
      startedAt.current.set(condition, virtual);
    }
    setLive((old) => [...old.filter((condition) => active.includes(condition)), ...begun]);
    if (!begun.length) return;
    const timer = setTimeout(() => setLive((old) => old.filter((condition) => !begun.includes(condition))), ISD_DWELL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useMemo(
    () => live.map((condition) => isdNotification(condition, figures, startedAt.current.get(condition) ?? 0)),
    // The figures are read so that a changed speed reads correctly in what is on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.join(), figures.requested, figures.applied],
  );
}
