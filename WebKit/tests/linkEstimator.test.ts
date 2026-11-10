// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { foldLink } from "../src/core/linkEstimator";

describe("the link estimate", () => {
  it("ignores small responses, starts from the first large one, and follows newer ones", () => {
    expect(foldLink(null, { bytes: 2000, transferMs: 10, waitMs: 5 })).toBeNull();
    const first = foldLink(null, { bytes: 1_000_000, transferMs: 1000, waitMs: 40 })!;
    expect(first).toEqual({ bytesPerSecond: 1_000_000, latencyMs: 40, samples: 1 });
    const second = foldLink(first, { bytes: 2_000_000, transferMs: 1000, waitMs: 40 })!;
    expect(second.bytesPerSecond).toBeCloseTo(1_300_000);
    expect(second.samples).toBe(2);
    expect(foldLink(second, { bytes: 1_000_000, transferMs: 0, waitMs: 0 })).toBe(second);
  });
});
