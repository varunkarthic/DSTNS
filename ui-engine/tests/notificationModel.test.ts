import { describe, expect, it } from "vitest";
import {
  buildNotifications,
  categoryOf,
  describeNews,
  districtOf,
  focusMatches,
  orderForDisplay,
  shouldDisplayNotification,
  stripPrefix,
} from "../src/notificationModel";
import type { DisplayPolicy, UiNotification } from "../src/notificationModel";
import type { News, Topology } from "../src/types";

/** A 2 km square network: nodes at the corners and centre, one named road. */
const topology = {
  graph_hash: "sha256:x",
  nodes: [
    { id: 0, position: { x_m: -1000, y_m: -1000, lat: 0, lon: 0 }, degree: 2, signal: false, osm_node_id: 1 },
    { id: 1, position: { x_m: 1000, y_m: 1000, lat: 0, lon: 0 }, degree: 2, signal: false, osm_node_id: 2 },
    { id: 2, position: { x_m: 0, y_m: 0, lat: 0, lon: 0 }, degree: 2, signal: false, osm_node_id: 3 },
    { id: 3, position: { x_m: 900, y_m: 900, lat: 0, lon: 0 }, degree: 2, signal: false, osm_node_id: 4 },
  ],
  edges: [
    {
      id: 0, from: 1, to: 3, reverse_twin: -1, synthetic_reverse: false, name: "Harbour Road",
      road_class: "primary", length_m: 140, lanes: 2, free_speed_mps: 14,
      geometry: [
        { x_m: 1000, y_m: 1000, lat: 0, lon: 0 },
        { x_m: 900, y_m: 900, lat: 0, lon: 0 },
      ],
    },
    {
      id: 1, from: 2, to: 0, reverse_twin: -1, synthetic_reverse: false, name: "",
      road_class: "residential", length_m: 1400, lanes: 1, free_speed_mps: 9,
      geometry: [
        { x_m: 0, y_m: 0, lat: 0, lon: 0 },
        { x_m: -1000, y_m: -1000, lat: 0, lon: 0 },
      ],
    },
  ],
  features: [
    { id: "way/7", name: "Riverside School", category: "school", polygon: false,
      position: { x_m: -500, y_m: 800, lat: 0, lon: 0 }, geometry: [], tags: {} },
  ],
  source: "OpenStreetMap",
  map_selection_version: "v",
  bounds: { min_lat: 0, max_lat: 0, min_lon: 0, max_lon: 0 },
} as unknown as Topology;

let nextId = 1;
function news(partial: Partial<News>): News {
  const id = nextId++;
  return {
    news_id: id,
    event_id: id,
    virtual_day_s: 3600,
    simulated_current_time: "01:00:00",
    category: "system",
    severity: "info",
    template_id: "X",
    message: "",
    data: {},
    ...partial,
  };
}

describe("taxonomy", () => {
  it("maps core categories onto the notification taxonomy", () => {
    expect(categoryOf("weather")).toBe("weather");
    expect(categoryOf("incident")).toBe("incident");
    expect(categoryOf("control")).toBe("system");
    expect(categoryOf("anything-else")).toBe("system");
  });
});

describe("geography", () => {
  it("names districts by compass direction from the network centre", () => {
    expect(districtOf(topology, { x_m: 0, y_m: 0 })).toBe("the central district");
    expect(districtOf(topology, { x_m: 900, y_m: 900 })).toBe("the north-east district");
    expect(districtOf(topology, { x_m: 0, y_m: -900 })).toBe("the south district");
    expect(districtOf(topology, { x_m: -900, y_m: 0 })).toBe("the west district");
    expect(districtOf(null, { x_m: 0, y_m: 0 })).toBeUndefined();
  });
});

describe("describeNews", () => {
  it("leads rain notifications with plain language, not identifiers", () => {
    const n = describeNews(
      news({
        category: "weather", severity: "warning", template_id: "DWS_RAIN_STARTED", event_id: 7,
        message: "[01:00:00] Rain storm initiated at Node 1 (Radius: 1400m, Intensity: 83%)",
        data: { epicenter: 1, radius_m: 1400, intensity: 0.83 },
      }),
      topology,
    );
    expect(n.title).toBe("Heavy rain");
    expect(n.summary).toBe("Heavy rainfall has developed over the north-east district near Harbour Road.");
    expect(n.summary).not.toMatch(/Node|epicenter|0\.83/);
    expect(n.details).toContainEqual({ label: "Affected radius", value: "1.4 km" });
    expect(n.details).toContainEqual({ label: "Intensity", value: "83% (heavy)" });
    expect(n.technical.some((t) => t.label === "Template" && t.value === "DWS_RAIN_STARTED")).toBe(true);
    expect(n.focusKey).toBe("weather-7");
    expect(n.coordinates).toEqual({ x_m: 1000, y_m: 1000 });
  });

  it("links rain peak and end back to the originating cell", () => {
    const peak = describeNews(news({ template_id: "DWS_RAIN_PEAK", event_id: 50007, data: { epicenter: 2 } }), topology);
    const end = describeNews(news({ template_id: "DWS_RAIN_ENDED", event_id: 100007, data: {} }), topology);
    expect(peak.focusKey).toBe("weather-7");
    expect(peak.summary).toMatch(/central district/);
    expect(end.focusKey).toBe("weather-7");
    expect(end.title).toBe("Rain cleared");
  });

  it("rewrites incidents around the road name", () => {
    const n = describeNews(
      news({
        category: "incident", severity: "alert", template_id: "INCIDENT_ACTIVATED",
        message:
          "[02:00:00] Multi-vehicle collision: lane blocked, emergency services on scene on Edge #0 near Node #1. (HIGH SEVERITY)",
        data: { incident_id: 4, type: "accident", edge_id: 0, closed: true, speed_multiplier: 0.3, capacity_multiplier: 0.5, end_virtual_s: 9000 },
      }),
      topology,
    );
    expect(n.title).toBe("Collision");
    expect(n.summary).toBe("Multi-vehicle collision on Harbour Road. Lane blocked, emergency services on scene.");
    expect(n.details).toContainEqual({ label: "Severity", value: "High" });
    expect(n.details).toContainEqual({ label: "Road closed", value: "Yes" });
    expect(n.details).toContainEqual({ label: "Speed limit", value: "30% of normal" });
    expect(n.details.find((d) => d.label === "Expected to clear")?.time).toBe(9000);
    expect(n.focusKey).toBe("incident-4");
  });

  it("describes resolved incidents and unnamed roads", () => {
    const n = describeNews(
      news({ template_id: "INCIDENT_RESOLVED", data: { incident_id: 4, type: "vehicle_breakdown", edge_id: 1 } }),
      topology,
    );
    expect(n.title).toBe("Vehicle breakdown cleared");
    expect(n.summary).toBe("The vehicle breakdown on Residential road has cleared. Normal traffic flow is restored.");
  });

  it("describes demand changes by place", () => {
    const n = describeNews(
      news({ template_id: "DEMAND_CHANGED", message: "School arrival / departure peak · Riverside School", data: { feature_id: "way/7", multiplier: 1.62 } }),
      topology,
    );
    expect(n.title).toBe("Demand at peak");
    expect(n.summary).toBe("School arrival / departure is at its peak around Riverside School.");
    expect(n.coordinates).toEqual({ x_m: -500, y_m: 800 });
    const back = describeNews(news({ template_id: "DEMAND_CHANGED", message: "Demand returns to normal · Riverside School", data: { multiplier: 1 } }), topology);
    expect(back.title).toBe("Demand normal");
  });

  it("falls back to the message for unknown templates", () => {
    const n = describeNews(news({ category: "control", template_id: "DAY_CHANGED", message: "[03:00:00] Day mode changed to weekend" }), topology);
    expect(n.summary).toBe("Day mode changed to weekend.");
    expect(stripPrefix("[01:00:00] x")).toBe("x");
  });

  it("survives a missing topology", () => {
    const n = describeNews(news({ template_id: "FLOOD_STARTED", data: { edge_id: 0, flood: 0.4 } }), null);
    expect(n.summary).toBe("Flooding is affecting a road.");
  });
});

describe("buildNotifications", () => {
  it("groups a flood burst into one record with a count", () => {
    const burst = [0, 1, 0, 1].map((edge, i) =>
      news({
        category: "flooding", severity: "warning", template_id: "FLOOD_STARTED",
        message: `Flooding detected on Edge ${edge}`, data: { edge_id: edge, flood: 0.2 }, virtual_day_s: 100 + i,
      }),
    );
    const out = buildNotifications(burst, topology);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(4);
    expect(out[0].summary).toBe("Flooding is affecting 4 roads.");
    expect(out[0].timestamp).toBe(103);
    expect(out[0].startedAt).toBe(100);
    expect(out[0].newsIds).toHaveLength(4);
  });

  it("reports the worst severity in a group", () => {
    const out = buildNotifications(
      [
        news({ category: "weather", severity: "info", template_id: "T", message: "Rain on Edge 1" }),
        news({ category: "weather", severity: "alert", template_id: "T", message: "Rain on Edge 2" }),
      ],
      topology,
    );
    expect(out[0].severity).toBe("alert");
  });
});

describe("Do Not Disturb", () => {
  const rain = { category: "weather", severity: "warning", focusKey: "weather-7" } as const;
  const crash = { category: "incident", severity: "alert", focusKey: "incident-4" } as const;
  const on: DisplayPolicy = { enabled: true, dnd: true, mutedCategories: ["weather"], mutedSeverities: [] };
  const off: DisplayPolicy = { ...on, dnd: false };
  const noFocus = { enabled: false, targetKey: null };

  it("shows everything when DND is off", () => {
    expect(shouldDisplayNotification(rain, off, noFocus)).toBe(true);
  });

  it("mutes only the selected categories", () => {
    expect(shouldDisplayNotification(rain, on, noFocus)).toBe(false);
    expect(shouldDisplayNotification(crash, on, noFocus)).toBe(true);
  });

  it("mutes by severity", () => {
    const policy = { ...on, mutedCategories: [], mutedSeverities: ["alert"] };
    expect(shouldDisplayNotification(crash, policy, noFocus)).toBe(false);
    expect(shouldDisplayNotification(rain, policy, noFocus)).toBe(true);
  });

  it("lets the auto-focused event through DND", () => {
    expect(shouldDisplayNotification(rain, on, { enabled: true, targetKey: "weather-7" })).toBe(true);
  });

  it("applies the override to the focused event only", () => {
    const other = { ...rain, focusKey: "weather-8" };
    expect(shouldDisplayNotification(other, on, { enabled: true, targetKey: "weather-7" })).toBe(false);
  });

  it("does not override when auto-focus is off", () => {
    expect(shouldDisplayNotification(rain, on, { enabled: false, targetKey: "weather-7" })).toBe(false);
  });

  it("matches grouped flood notifications to any flood cluster", () => {
    expect(focusMatches("flood", "flood-3")).toBe(true);
    expect(focusMatches("flood", "flooding")).toBe(false);
    expect(focusMatches("weather-7", "weather-70")).toBe(false);
    expect(focusMatches(undefined, "weather-7")).toBe(false);
  });

  it("hides everything when notifications are disabled, except the focused event", () => {
    const disabled = { ...off, enabled: false };
    expect(shouldDisplayNotification(crash, disabled, noFocus)).toBe(false);
    expect(shouldDisplayNotification(crash, disabled, { enabled: true, targetKey: "incident-4" })).toBe(true);
  });
});

describe("ordering", () => {
  const base = (id: string, severity: UiNotification["severity"], timestamp: number, focusKey?: string) =>
    ({ id, severity, timestamp, focusKey }) as UiNotification;
  it("puts the focused event first, then severity, then recency", () => {
    const list = [base("a", "info", 50), base("b", "alert", 10), base("c", "alert", 20), base("d", "info", 5, "weather-1")];
    expect(orderForDisplay(list, "weather-1").map((n) => n.id)).toEqual(["d", "c", "b", "a"]);
    expect(orderForDisplay(list, null).map((n) => n.id)).toEqual(["c", "b", "a", "d"]);
  });
});
