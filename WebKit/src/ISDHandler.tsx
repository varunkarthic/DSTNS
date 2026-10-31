// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icons";

/**
 * Intentional System Design Handler.
 *
 * Some of what DSTNS does on purpose looks like a fault from the outside: the
 * interface suspending itself, a speed that will not change, a screen that refuses to
 * draw. When one of these begins, a small note says that it is intended, why, and what
 * to do next. Real failures are not handled here: they belong to the notification
 * capsule, which reports them as errors.
 *
 * Each note appears once in a session, whenever its condition first becomes true, and
 * one at a time. It leaves when dismissed or when the condition ends.
 */

export type ISDCondition = "async" | "restricted" | "rate-locked" | "rate-governed" | "motion-locked" | "viewport" | "large-steps" | "app-lapsed";

export interface ISDNote {
  title: string;
  why: string;
  next: string[];
}

export const ISD_NOTES: Record<ISDCondition, ISDNote> = {
  async: {
    title: "The interface has suspended itself",
    why: "It could not keep pace with the simulation, so Adaptive Simulation Backpressure stopped drawing to protect the run. The simulation is still running and its results are not affected.",
    next: ["Wait, or pause the simulation to let the interface catch up.", "Reload the page if it does not recover."],
  },
  restricted: {
    title: "The interface is running with less",
    why: "It fell behind the simulation, so Adaptive Simulation Backpressure has reduced what is drawn until it recovers. The results of the run are not affected.",
    next: ["No action is needed. Full detail returns on its own.", "A lower simulation speed helps it recover sooner."],
  },
  "rate-locked": {
    title: "Speed is being held at 1×",
    why: "The core holds the speed while the interface returns to sync, so it cannot fall further behind.",
    next: ["No action is needed. The speed control unlocks on its own."],
  },
  "rate-governed": {
    title: "The speed applied is lower than the one chosen",
    why: "The interface cannot currently keep up with the chosen speed, so the core is applying a lower one. Your choice is kept and returns when there is room.",
    next: ["No action is needed. Closing other demanding tabs can help."],
  },
  "motion-locked": {
    title: "Reduced motion is being held on",
    why: "Animation is the first thing given up when the interface falls behind.",
    next: ["No action is needed. Your own setting returns once the interface recovers."],
  },
  viewport: {
    title: "This window is too small for DSTNS",
    why: "The controls and the map need a minimum amount of room, so the interface does not draw below that size. The simulation continues unaffected.",
    next: ["Enlarge the window or reduce the browser's zoom. The interface returns immediately."],
  },
  "large-steps": {
    title: "The map moves in larger steps at this speed",
    why: "Above 5×, a second of real time spans more simulated time than one snapshot shows, so vehicles appear to jump. The simulation still runs every step, and its results do not change.",
    next: ["Choose 5× or lower for continuous movement."],
  },
  "app-lapsed": {
    title: "An application has stopped checking in",
    why: "WebFabric suspends an application that stops responding and removes what it was showing, so it cannot leave stale information on screen. DSTNS itself is unaffected.",
    next: ["Restart the application. It resumes where it was.", "Find its state in Settings, under WebFabric."],
  },
};

/** Which condition to show: the one showing, if it still holds, else the first new one. */
export function nextNote(active: readonly ISDCondition[], showing: ISDCondition | null, seen: ReadonlySet<ISDCondition>): ISDCondition | null {
  if (showing && active.includes(showing)) return showing;
  return active.find((condition) => !seen.has(condition)) ?? null;
}

export function ISDHandler({ active }: { active: readonly ISDCondition[] }) {
  const [showing, setShowing] = useState<ISDCondition | null>(null);
  const seen = useRef(new Set<ISDCondition>());
  const key = active.join();
  const conditions = useMemo(() => active, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setShowing((current) => {
      const next = nextNote(conditions, current, seen.current);
      if (next) seen.current.add(next);
      return next;
    });
  }, [conditions]);
  if (!showing) return null;
  const note = ISD_NOTES[showing];
  const dismiss = () => {
    const next = nextNote(conditions.filter((condition) => condition !== showing), null, seen.current);
    if (next) seen.current.add(next);
    setShowing(next);
  };
  return (
    <aside className="isd" role="status" aria-live="polite" aria-label="Intentional system design" key={showing} data-tip-avoid>
      <header>
        <Icon name="info" size={14} />
        <span>Intentional system design</span>
        <button type="button" className="icon-btn" aria-label="Dismiss" onClick={dismiss}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <h3>{note.title}</h3>
      <p>{note.why}</p>
      <strong>What to do next</strong>
      <ul>
        {note.next.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ul>
    </aside>
  );
}
