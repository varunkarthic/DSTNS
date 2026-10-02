// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { computeSummary } from "../src/TelemetryDeck";

describe("compute summary in the stack view", () => {
  it("says nothing it does not know", () => {
    expect(computeSummary(null)).toEqual({ tag: "Unknown", meta: "Not reporting", timing: undefined });
  });

  it("names the GPU and its Metal path when Vulkan runs the physics", () => {
    const s = computeSummary({
      requested_backend: "auto",
      active_backend: "vulkan",
      device: { name: "Apple M4", moltenvk: true },
      step: { total_ms: 1.234, gpu_ms: 0.5 },
    });
    expect(s.tag).toBe("Vulkan");
    expect(s.meta).toBe("Apple M4 via Metal · Vulkan");
    expect(s.timing).toBe("1.23 ms/step · GPU 0.50");
  });

  it("reports the CPU, and a GPU that is available but not used", () => {
    const s = computeSummary({ requested_backend: "auto", active_backend: "cpu", device: { name: "Radeon" }, step: { total_ms: 0.2 } });
    expect(s.tag).toBe("CPU");
    expect(s.meta).toBe("CPU reference · Radeon available");
    expect(s.timing).toBe("0.20 ms/step");
  });
});
