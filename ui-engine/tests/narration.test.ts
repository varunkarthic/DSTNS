// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { applyNarrations, mergeNews } from "../src/useSimulation";
import type { News } from "../src/types";

const item = (news_id: number, narrative?: string): News => ({
  news_id,
  event_id: news_id,
  virtual_day_s: news_id,
  simulated_current_time: "00:00:00",
  category: "incident",
  severity: "warning",
  template_id: "INCIDENT_ACTIVATED",
  message: `item ${news_id}`,
  data: {},
  narrative,
});

describe("applyNarrations", () => {
  it("attaches late narrations to the items already held", () => {
    const list = [item(3), item(2), item(1)];
    const next = applyNarrations(list, [{ news_id: 2, narrative: "A collision on Harbour Road." }]);
    expect(next.find((n) => n.news_id === 2)?.narrative).toBe("A collision on Harbour Road.");
    expect(next[0]).toBe(list[0]);
    expect(next[2]).toBe(list[2]);
  });

  it("returns the same list when nothing changes, so React does not re-render", () => {
    const list = [item(1, "Already worded.")];
    expect(applyNarrations(list, [])).toBe(list);
    expect(applyNarrations(list, [{ news_id: 1, narrative: "Already worded." }])).toBe(list);
    expect(applyNarrations(list, [{ news_id: 9, narrative: "Not held." }])).toBe(list);
  });

  it("survives a later merge of the same item", () => {
    const held = applyNarrations([item(1)], [{ news_id: 1, narrative: "Worded." }]);
    const merged = mergeNews([item(2)], held, 10);
    expect(merged.find((n) => n.news_id === 1)?.narrative).toBe("Worded.");
  });
});
