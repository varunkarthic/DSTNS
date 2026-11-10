// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISD_DWELL_MS, isdNote, isdNotification, newlyBegun, useISDNotifications } from "../src/notifications/ISDHandler";
import type { ISDCondition } from "../src/notifications/ISDHandler";
import { orderForDisplay, shouldDisplayNotification } from "../src/core/notificationModel";
import type { UiNotification } from "../src/core/notificationModel";

const figures = { requested: 10, applied: 5 };
const ALL: ISDCondition[] = ["async", "restricted", "rate-locked", "rate-governed", "motion-locked", "reduced-detail", "large-steps", "app-lapsed"];

describe("Intentional System Design Handler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("says why and what to do next, for every condition", () => {
    for (const condition of ALL) {
      const note = isdNote(condition, figures);
      expect(note.title.length).toBeGreaterThan(0);
      expect(note.why.length).toBeGreaterThan(0);
      expect(note.next.length).toBeGreaterThan(0);
    }
  });

  it("states the target and the speed actually applied when ASB reduces it", () => {
    const note = isdNote("rate-governed", figures);
    expect(note.title).toContain("5×");
    expect(note.why).toContain("target is 10×");
    expect(note.why).toContain("Adaptive Simulation Backpressure");
  });

  it("is not silenced by Do Not Disturb or by turning notifications off, and is read first among its equals", () => {
    const note = isdNotification("async", figures, 0);
    const silenced = { enabled: false, dnd: true, mutedCategories: ["system"], mutedSeverities: ["info"] } as never;
    expect(shouldDisplayNotification(note, silenced, { enabled: false, targetKey: null })).toBe(true);
    const other = { ...note, id: "other", isd: false, timestamp: note.timestamp + 9 } as UiNotification;
    expect(orderForDisplay([other, note], null)[0].id).toBe(note.id);
    expect(orderForDisplay([{ ...other, severity: "alert" }, { ...note, severity: "warning" }], null)[0].id).toBe("other");
    // It is up for only a few seconds, so a warning does not bury it.
    expect(orderForDisplay([{ ...other, severity: "warning" }, { ...note, severity: "info" }], null)[0].id).toBe(note.id);
  });

  it("announces a condition once a page load", () => {
    expect(newlyBegun(["async", "restricted"], new Set(["async"]))).toEqual(["restricted"]);
    const { result, rerender } = renderHook(({ active }) => useISDNotifications(active, figures, 0), { initialProps: { active: [] as ISDCondition[] } });
    expect(result.current).toEqual([]);
    rerender({ active: ["rate-governed"] });
    expect(result.current.map((n) => n.id)).toEqual(["isd:rate-governed"]);
    rerender({ active: [] });
    expect(result.current).toEqual([]);
    rerender({ active: ["rate-governed"] });
    expect(result.current).toEqual([]);
  });

  it("leaves the tray after its time, even if the condition holds", () => {
    const { result, rerender } = renderHook(({ active }) => useISDNotifications(active, figures, 0), { initialProps: { active: [] as ISDCondition[] } });
    rerender({ active: ["large-steps"] });
    expect(result.current).toHaveLength(1);
    act(() => vi.advanceTimersByTime(ISD_DWELL_MS + 1));
    expect(result.current).toEqual([]);
  });
});
