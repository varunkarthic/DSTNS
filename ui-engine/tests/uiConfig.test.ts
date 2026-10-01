// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILT_IN,
  clearOverrides,
  diffConfig,
  loadConfig,
  mergeConfig,
  readOverrides,
  resolveReduceMotion,
  writeOverrides,
} from "../src/uiConfig";
import shipped from "../../config/ui-config.json?raw";

beforeEach(() => clearOverrides());
afterEach(() => {
  clearOverrides();
  vi.restoreAllMocks();
});

describe("configuration merging", () => {
  it("leaves the defaults alone when the patch is empty or junk", () => {
    for (const junk of [null, undefined, 42, "nope", [], {}]) {
      expect(mergeConfig(BUILT_IN, junk)).toEqual(BUILT_IN);
    }
  });

  it("applies only the fields the patch actually sets", () => {
    const merged = mergeConfig(BUILT_IN, { reduce_motion: "on" });
    expect(merged.reduce_motion).toBe("on");
    // Everything else is untouched.
    expect(merged.layers).toEqual(BUILT_IN.layers);
    expect(merged.auto_focus).toEqual(BUILT_IN.auto_focus);
  });

  it("rejects values outside the permitted set", () => {
    const merged = mergeConfig(BUILT_IN, {
      reduce_motion: "sometimes",
      auto_focus: { mode: "maybe", strategy: "random" },
    });
    expect(merged.reduce_motion).toBe(BUILT_IN.reduce_motion);
    expect(merged.auto_focus.mode).toBe(BUILT_IN.auto_focus.mode);
    expect(merged.auto_focus.strategy).toBe(BUILT_IN.auto_focus.strategy);
  });

  it("accepts every documented enum value", () => {
    for (const mode of ["disable", "enable", "enable-force"] as const)
      expect(mergeConfig(BUILT_IN, { auto_focus: { mode } }).auto_focus.mode).toBe(mode);
    for (const strategy of ["round-robin", "latest"] as const)
      expect(mergeConfig(BUILT_IN, { auto_focus: { strategy } }).auto_focus.strategy).toBe(
        strategy,
      );
    for (const rm of ["auto", "on", "off"] as const)
      expect(mergeConfig(BUILT_IN, { reduce_motion: rm }).reduce_motion).toBe(rm);
  });

  it("clamps numbers into their usable range", () => {
    const low = mergeConfig(BUILT_IN, {
      auto_focus: { dwell_seconds: -5, zoom: 0 },
      notifications: { max_visible: 0, dwell_ms: 1 },
      asb: { report_interval_ms: 1 },
    });
    expect(low.auto_focus.dwell_seconds).toBeGreaterThanOrEqual(2);
    expect(low.auto_focus.zoom).toBeGreaterThanOrEqual(0.2);
    expect(low.notifications.max_visible).toBeGreaterThanOrEqual(1);
    expect(low.asb.report_interval_ms).toBeGreaterThanOrEqual(250);

    const high = mergeConfig(BUILT_IN, {
      auto_focus: { dwell_seconds: 10_000, zoom: 999 },
      notifications: { max_visible: 99, dwell_ms: 10 ** 9 },
      asb: { report_interval_ms: 10 ** 9 },
    });
    expect(high.auto_focus.dwell_seconds).toBeLessThanOrEqual(120);
    expect(high.auto_focus.zoom).toBeLessThanOrEqual(8);
    expect(high.notifications.max_visible).toBeLessThanOrEqual(8);
    expect(high.asb.report_interval_ms).toBeLessThanOrEqual(10000);
  });

  it("ignores unknown keys and non-boolean layers", () => {
    const merged = mergeConfig(BUILT_IN, {
      layers: { weather: false, nonsense: true, roads: "yes" },
      totally_unknown: { nested: 1 },
    });
    expect(merged.layers.weather).toBe(false);
    expect(merged.layers.roads).toBe(BUILT_IN.layers.roads);
    expect(merged.layers).not.toHaveProperty("nonsense");
  });

  it("keeps place names independent of the buildings layer", () => {
    const merged = mergeConfig(BUILT_IN, { layers: { place_names: false } });
    // Buildings stay drawn; only their names are withheld.
    expect(merged.layers.place_names).toBe(false);
    expect(merged.layers.buildings).toBe(true);
  });

  it("never mutates the configuration it was given", () => {
    const before = JSON.stringify(BUILT_IN);
    mergeConfig(BUILT_IN, { layers: { weather: false }, reduce_motion: "on" });
    expect(JSON.stringify(BUILT_IN)).toBe(before);
  });
});

describe("viewer overrides", () => {
  it("round-trips through storage", () => {
    const custom = mergeConfig(BUILT_IN, { reduce_motion: "on" });
    writeOverrides(custom);
    expect(mergeConfig(BUILT_IN, readOverrides())).toEqual(custom);
    clearOverrides();
    expect(readOverrides()).toBeNull();
  });

  it("stores only what the viewer changed, not the whole configuration", () => {
    writeOverrides(mergeConfig(BUILT_IN, { reduce_motion: "on" }));
    const stored = readOverrides() as Record<string, unknown>;
    expect(stored).toEqual({ reduce_motion: "on" });
    // Nothing else was pinned, so operator defaults still reach this viewer.
    expect(stored).not.toHaveProperty("auto_focus");
    expect(stored).not.toHaveProperty("layers");
  });

  it("clears storage when the viewer returns to the defaults", () => {
    writeOverrides(mergeConfig(BUILT_IN, { reduce_motion: "on" }));
    expect(readOverrides()).not.toBeNull();
    writeOverrides(BUILT_IN);
    expect(readOverrides()).toBeNull();
  });

  it("survives unreadable or corrupt storage", () => {
    localStorage.setItem("dstns.ui-config.v1", "{not json");
    expect(readOverrides()).toBeNull();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readOverrides()).toBeNull();
  });
});

describe("resolution order", () => {
  const serverConfig = {
    reduce_motion: "on",
    auto_focus: { mode: "enable-force", strategy: "latest" },
    layers: { weather: false },
  };
  const respond = (body: unknown, ok = true) =>
    vi.fn(async () =>
      ok
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response("{}", { status: 500 }),
    ) as unknown as typeof fetch;

  it("falls back to built-in defaults when the core is unreachable", async () => {
    const failing = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const { config, source } = await loadConfig(failing);
    expect(source).toBe("built-in");
    expect(config).toEqual(BUILT_IN);
  });

  it("falls back when the core answers with an error", async () => {
    const { config, source } = await loadConfig(respond({}, false));
    expect(source).toBe("built-in");
    expect(config).toEqual(BUILT_IN);
  });

  it("applies the operator's file over the built-in defaults", async () => {
    const { config, source } = await loadConfig(respond({ data: serverConfig }));
    expect(source).toBe("server");
    expect(config.reduce_motion).toBe("on");
    expect(config.auto_focus.mode).toBe("enable-force");
    expect(config.layers.weather).toBe(false);
    // Fields the file omits keep their built-in value.
    expect(config.auto_focus.dwell_seconds).toBe(BUILT_IN.auto_focus.dwell_seconds);
  });

  it("puts the viewer's own choices above the operator's file", async () => {
    writeOverrides(mergeConfig(BUILT_IN, { reduce_motion: "off" }));
    const { config, source } = await loadConfig(respond({ data: serverConfig }));
    expect(source).toBe("viewer");
    // The viewer wins where they disagree...
    expect(config.reduce_motion).toBe("off");
    // ...and the operator's file still applies where the viewer is silent.
    expect(config.auto_focus.mode).toBe("enable-force");
  });
});

describe("reduced motion resolution", () => {
  const withPreference = (matches: boolean) => {
    window.matchMedia = ((query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  };

  it("honours an explicit choice regardless of the OS", () => {
    withPreference(false);
    expect(resolveReduceMotion("on")).toBe(true);
    withPreference(true);
    expect(resolveReduceMotion("off")).toBe(false);
  });

  it("follows the OS when set to auto", () => {
    withPreference(true);
    expect(resolveReduceMotion("auto")).toBe(true);
    withPreference(false);
    expect(resolveReduceMotion("auto")).toBe(false);
  });
});

describe("notification and playback preferences", () => {
  it("ships with road names hidden and every category muted under DND", () => {
    expect(BUILT_IN.layers.labels).toBe(false);
    expect(BUILT_IN.notifications.dnd).toBe(false);
    expect(BUILT_IN.notifications.dnd_categories).toEqual([
      "weather", "flooding", "incident", "traffic", "demand", "signals", "system",
    ]);
    expect(BUILT_IN.notifications.dnd_severities).toEqual([]);
    expect(BUILT_IN.playback).toEqual({ skip_seconds: 900, step_seconds: 60 });
  });

  it("keeps only known categories and severities, in canonical order", () => {
    const merged = mergeConfig(BUILT_IN, {
      notifications: { dnd_categories: ["system", "bogus", "weather", "weather"], dnd_severities: ["alert", "loud", "info"] },
    });
    expect(merged.notifications.dnd_categories).toEqual(["weather", "system"]);
    expect(merged.notifications.dnd_severities).toEqual(["info", "alert"]);
  });

  it("falls back when the lists are not arrays", () => {
    const merged = mergeConfig(BUILT_IN, { notifications: { dnd_categories: "weather", dnd_severities: 3 } });
    expect(merged.notifications.dnd_categories).toEqual(BUILT_IN.notifications.dnd_categories);
    expect(merged.notifications.dnd_severities).toEqual([]);
  });

  it("allows an empty mute list", () => {
    expect(mergeConfig(BUILT_IN, { notifications: { dnd_categories: [] } }).notifications.dnd_categories).toEqual([]);
  });

  it("accepts only the offered skip and step intervals", () => {
    expect(mergeConfig(BUILT_IN, { playback: { skip_seconds: 3600, step_seconds: 1 } }).playback).toEqual({ skip_seconds: 3600, step_seconds: 1 });
    expect(mergeConfig(BUILT_IN, { playback: { skip_seconds: 7, step_seconds: "60" } }).playback).toEqual(BUILT_IN.playback);
  });

  it("does not record an unchanged list as a viewer change", () => {
    const same = mergeConfig(BUILT_IN, { notifications: { dnd_categories: [...BUILT_IN.notifications.dnd_categories] } });
    expect(diffConfig(BUILT_IN, same)).toEqual({});
    const changed = mergeConfig(BUILT_IN, { notifications: { dnd_categories: ["weather"] } });
    expect(diffConfig(BUILT_IN, changed)).toEqual({ notifications: { dnd_categories: ["weather"] } });
  });

  it("matches the shipped config/ui-config.json", async () => {
    const file = JSON.parse(shipped);
    // The operator file and the built-in defaults describe the same starting state.
    expect(mergeConfig(BUILT_IN, file)).toEqual(BUILT_IN);
  });
});

it("represents an absent place override as visible when the operator hid it", () => {
  const base = mergeConfig(BUILT_IN, {places: {school: false}});
  const next = {...base, places: {}};
  const patch = diffConfig(base, next);
  expect(patch.places).toMatchObject({school: true});
  expect(mergeConfig(base, JSON.parse(JSON.stringify(patch))).places.school).toBe(true);
});
