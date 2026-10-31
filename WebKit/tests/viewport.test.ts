// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { MIN_HEIGHT, MIN_WIDTH, shortfall, viewportTooSmall } from "../src/Viewport";
import { mapFitLayout } from "../src/mapProjection";
import { RATES } from "../src/CommandRail";

describe("minimum viewport", () => {
  it("accepts the sizes the HUD was laid out for", () => {
    for (const [w, h] of [
      [MIN_WIDTH, MIN_HEIGHT],
      [1280, 800],
      [1440, 900],
      [1920, 1080],
      [2560, 1440],
    ])
      expect(viewportTooSmall(w, h), `${w}x${h}`).toBe(false);
  });

  it("refuses sizes where the interface would be squeezed", () => {
    expect(viewportTooSmall(MIN_WIDTH - 1, 900)).toBe(true);
    expect(viewportTooSmall(1440, MIN_HEIGHT - 1)).toBe(true);
    expect(viewportTooSmall(820, 600)).toBe(true);
  });

  it("names which dimension falls short", () => {
    expect(shortfall(1440, 900)).toBeNull();
    expect(shortfall(900, 900)).toBe("width");
    expect(shortfall(1440, 500)).toBe("height");
    expect(shortfall(900, 500)).toBe("both");
  });

  it("leaves the map a usable area at the minimum size", () => {
    // The command rail, the tool dock and the telemetry strip all take space;
    // what is left has to be worth drawing a network in.
    const layout = mapFitLayout(MIN_WIDTH, MIN_HEIGHT);
    expect(layout.available).toBeGreaterThanOrEqual(800);
    // Header, lower HUD and rail come out of the height.
    expect(MIN_HEIGHT - 56 - 60 - 60).toBeGreaterThanOrEqual(400);
  });

  it("is wide enough for every speed the rail offers", () => {
    // Below 1180px the rail drops the seed's label and the word Terminate.
    // What remains: transport, the clock, seven speeds, the seed value, the
    // re-roll, runtime status, Terminate and the gaps between them. The live
    // measurement is in the browser suite; this keeps the arithmetic honest.
    const speeds = RATES.length * 33;
    const rail = 200 + 124 + speeds + 110 + 36 + 90 + 44 + 60;
    expect(rail).toBeLessThanOrEqual(MIN_WIDTH - 40);
  });
});
