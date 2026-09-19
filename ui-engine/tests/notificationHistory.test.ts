import { describe, expect, it } from "vitest";
import { buildNotifications, shouldDisplayNotification } from "../src/notificationModel";
import type { DisplayPolicy, UiNotification } from "../src/notificationModel";
import { NotificationHistory, filterHistory } from "../src/notificationHistory";
import type { DeliveryContext } from "../src/notificationHistory";
import type { News } from "../src/types";

let nextId = 1;
function news(partial: Partial<News>): News {
  const id = partial.news_id ?? nextId++;
  return {
    news_id: id,
    event_id: id,
    virtual_day_s: 3600,
    simulated_current_time: "01:00:00",
    category: "weather",
    severity: "warning",
    template_id: "DWS_RAIN_STARTED",
    message: "[01:00:00] Rain storm initiated at Node 1 (Radius: 1400m, Intensity: 83%)",
    data: { epicenter: 1, radius_m: 1400, intensity: 0.83 },
    ...partial,
  };
}

const rain = news({ news_id: 10, event_id: 7 });
const crash = news({
  news_id: 11,
  virtual_day_s: 4000,
  category: "incident",
  severity: "alert",
  template_id: "INCIDENT_ACTIVATED",
  message: "[01:06:40] Multi-vehicle collision on Edge #0 near Node #1. (HIGH SEVERITY)",
  data: { incident_id: 4, type: "accident", edge_id: 0, closed: true },
});

/** Mirrors App: decide what is shown under a policy, then record. */
function deliver(history: NotificationHistory, items: News[], policy: DisplayPolicy, focusKey: string | null = null) {
  const list = buildNotifications(items, null);
  const focus = { enabled: !!focusKey, targetKey: focusKey };
  const shown = list.filter((n) => shouldDisplayNotification(n, policy, focus));
  const ctx: DeliveryContext = {
    shownIds: new Set(shown.map((n) => n.id)),
    enabled: policy.enabled,
    focusKey,
    wouldShow: (n) => shouldDisplayNotification(n, policy, { enabled: false, targetKey: null }),
  };
  return history.recordNotifications(list, new Map(items.map((n) => [n.news_id, n])), null, ctx);
}

const open: DisplayPolicy = { enabled: true, dnd: false, mutedCategories: [], mutedSeverities: [] };
const dnd: DisplayPolicy = { enabled: true, dnd: true, mutedCategories: ["weather", "incident"], mutedSeverities: [] };

describe("notification history", () => {
  it("records shown notifications", () => {
    const h = new NotificationHistory();
    expect(deliver(h, [rain], open)).toBe(true);
    expect(h.list()).toHaveLength(1);
    expect(h.list()[0]).toMatchObject({ key: "news:10", delivery: "shown", override: false, title: "Heavy rain" });
  });

  it("keeps events Do Not Disturb silenced", () => {
    const h = new NotificationHistory();
    deliver(h, [rain, crash], dnd);
    expect(h.list().map((e) => e.delivery)).toEqual(["silenced", "silenced"]);
    expect(h.counts()).toMatchObject({ all: 2, silenced: 2, shown: 0 });
  });

  it("marks the Auto Focus override and the focused event", () => {
    const h = new NotificationHistory();
    deliver(h, [rain], dnd, "weather-7");
    const [entry] = h.list();
    expect(entry).toMatchObject({ delivery: "shown", override: true, autoFocused: true });
  });

  it("records synthesised Auto Focus notifications once", () => {
    const h = new NotificationHistory();
    const synthetic: UiNotification = {
      id: "focus:incident-4", newsIds: [], type: "INCIDENT_ACTIVATED", category: "incident", severity: "alert",
      timestamp: 5000, startedAt: 5000, title: "Collision", summary: "On Harbour Road.", details: [], technical: [],
      focusKey: "incident-4", count: 1,
    };
    const ctx: DeliveryContext = { shownIds: new Set([synthetic.id]), enabled: true, focusKey: "incident-4", wouldShow: () => false };
    expect(h.recordNotifications([synthetic], new Map(), null, ctx)).toBe(true);
    expect(h.recordNotifications([synthetic], new Map(), null, ctx)).toBe(false);
    expect(h.list()[0]).toMatchObject({ key: "focus:incident-4", autoFocused: true, override: true });
  });

  it("never duplicates an event across re-renders, regrouping or replay", () => {
    const h = new NotificationHistory();
    deliver(h, [rain], open);
    const revision = h.revision;
    expect(deliver(h, [rain], dnd)).toBe(false);
    expect(deliver(h, [rain, news({ news_id: 12, event_id: 8 })], open)).toBe(true);
    expect(h.size).toBe(2);
    // The first decision stands: a later policy change does not rewrite history.
    expect(h.list().find((e) => e.newsId === 10)!.delivery).toBe("shown");
    expect(h.revision).toBeGreaterThan(revision);
  });

  it("records the backlog present before the view connected", () => {
    const h = new NotificationHistory();
    const routine = news({ news_id: 20, template_id: "SIGNAL_PHASE", category: "signals", severity: "info" });
    expect(h.recordBacklog([rain, routine], null)).toBe(true);
    expect(h.list().map((e) => [e.newsId, e.delivery])).toEqual([[10, "earlier"]]);
    // A later live delivery of the same event does not add a second record.
    deliver(h, [rain], open);
    expect(h.size).toBe(1);
  });

  it("marks earlier records once Auto Focus frames their event", () => {
    const h = new NotificationHistory();
    deliver(h, [rain], open);
    expect(h.list()[0].autoFocused).toBe(false);
    expect(h.markFocused("weather-7")).toBe(true);
    expect(h.list()[0].autoFocused).toBe(true);
    expect(h.markFocused("weather-7")).toBe(false);
  });

  it("stays bounded, dropping the oldest events", () => {
    const h = new NotificationHistory(5);
    const items = Array.from({ length: 12 }, (_, i) => news({ news_id: 100 + i, event_id: 100 + i, virtual_day_s: 100 * i }));
    h.recordBacklog(items, null);
    expect(h.size).toBe(5);
    expect(h.list().map((e) => e.newsId)).toEqual([111, 110, 109, 108, 107]);
  });

  it("orders newest first and filters by delivery", () => {
    const h = new NotificationHistory();
    deliver(h, [rain], open);
    deliver(h, [crash], dnd);
    expect(h.list().map((e) => e.newsId)).toEqual([11, 10]);
    expect(filterHistory(h.list(), "silenced").map((e) => e.newsId)).toEqual([11]);
    expect(filterHistory(h.list(), "shown").map((e) => e.newsId)).toEqual([10]);
    expect(filterHistory(h.list(), "all")).toHaveLength(2);
  });

  it("starts empty for a new run", () => {
    const h = new NotificationHistory();
    deliver(h, [rain], open);
    h.reset("run-2");
    expect(h.size).toBe(0);
    expect(h.runId).toBe("run-2");
  });
});
