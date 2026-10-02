// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { weatherSummary } from "../src/telemetryModel";

describe("weather summary", () => {
  it("reports the rain rate the hydrology uses", () => {
    const s = weatherSummary([
      { id: 1, x_m: 0, y_m: 0, radius_m: 400, intensity: 0.9, rain_mm_h: 45 },
      { id: 2, x_m: 0, y_m: 0, radius_m: 400, intensity: 0.4, rain_mm_h: 20 },
    ]);
    expect(s.rate).toBe("45.0 mm/h");
    expect(s.level).toBe("heavy");
  });
  it("falls back to the indicative rate for an older core", () => {
    expect(weatherSummary([{ id: 1, x_m: 0, y_m: 0, radius_m: 400, intensity: 0.5 }]).rate).toBe("4.0 mm/h");
  });
});
