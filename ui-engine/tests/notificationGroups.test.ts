import { describe, expect, it } from "vitest";
import {
  groupNotifications,
  notificationBody,
  notificationKind,
  stackLabel,
} from "../src/notificationGroups";
import type { News } from "../src/types";

let nextId = 1;
const news = (message: string, category = "flooding", time = "08:00:00"): News => ({
  news_id: nextId++,
  event_id: nextId,
  virtual_day_s: 28800,
  simulated_current_time: time,
  category,
  severity: "info",
  template_id: "T",
  message,
  data: {},
});

describe("kind extraction", () => {
  it("ignores the entity a message is about", () => {
    expect(notificationKind(news("Flooding detected on Edge 1710"))).toBe(
      notificationKind(news("Flooding detected on Edge 3616")),
    );
  });

  it("keeps genuinely different messages apart", () => {
    expect(notificationKind(news("Flooding detected on Edge 12"))).not.toBe(
      notificationKind(news("Collision reported on Edge 12")),
    );
  });

  it("strips a bracketed category prefix", () => {
    expect(notificationKind(news("[DWS] Rain started over the district"))).toBe(
      notificationKind(news("Rain started over the district")),
    );
  });

  it("ignores varying quantities and times", () => {
    expect(notificationKind(news("Demand rose 40% at 08:15:00"))).toBe(
      notificationKind(news("Demand rose 75% at 09:42:00")),
    );
  });

  it("never returns an empty kind for a real message", () => {
    expect(notificationKind(news("Flooding detected on Edge 1710")).length).toBeGreaterThan(0);
  });
});

describe("grouping", () => {
  it("collapses a burst into a single group", () => {
    const burst = Array.from({ length: 40 }, (_, i) =>
      news(`Flooding detected on Edge ${i * 7}`),
    );
    const groups = groupNotifications(burst);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(40);
    expect(groups[0].stacked).toBe(true);
  });

  it("leaves a lone notification unstacked", () => {
    const groups = groupNotifications([news("Collision reported on Edge 4")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].stacked).toBe(false);
    expect(groups[0].items).toHaveLength(1);
  });

  it("separates different kinds and different categories", () => {
    const groups = groupNotifications([
      news("Flooding detected on Edge 1"),
      news("Flooding detected on Edge 2"),
      news("Collision reported on Edge 3", "safety"),
      news("Rain started over the district", "weather"),
    ]);
    expect(groups).toHaveLength(3);
    const flooding = groups.find((g) => g.category === "flooding");
    expect(flooding?.items).toHaveLength(2);
  });

  it("shows the newest member of a group, whatever order it arrived in", () => {
    const first = news("Flooding detected on Edge 1");
    const second = news("Flooding detected on Edge 2");
    // Deliberately out of order.
    const groups = groupNotifications([first, second].reverse());
    expect(groups[0].latest.news_id).toBe(Math.max(first.news_id, second.news_id));
    // And the members are listed newest first.
    expect(groups[0].items[0].news_id).toBeGreaterThan(groups[0].items[1].news_id);
  });

  it("orders groups by their newest member, so a fresh event surfaces", () => {
    const old = news("Rain started over the district", "weather");
    const recent = news("Collision reported on Edge 9", "safety");
    const groups = groupNotifications([old, recent]);
    expect(groups[0].category).toBe("safety");
  });

  it("returns nothing for an empty list", () => {
    expect(groupNotifications([])).toEqual([]);
  });

  it("keeps every notification: grouping hides none of them", () => {
    const items = [
      ...Array.from({ length: 12 }, (_, i) => news(`Flooding detected on Edge ${i}`)),
      news("Collision reported on Edge 99", "safety"),
    ];
    const total = groupNotifications(items).reduce((sum, g) => sum + g.items.length, 0);
    expect(total).toBe(items.length);
  });
});

describe("presentation helpers", () => {
  it("strips the bracketed prefix from a body", () => {
    expect(notificationBody(news("[FLOOD] Water on the carriageway"))).toBe(
      "Water on the carriageway",
    );
  });

  it("pluralises the stack label", () => {
    expect(stackLabel(1)).toBe("1 event");
    expect(stackLabel(40)).toBe("40 events");
  });
});
