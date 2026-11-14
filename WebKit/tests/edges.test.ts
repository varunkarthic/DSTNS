// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic
import { describe, expect, it } from "vitest";
import { edgeOf } from "../src/CoreMotion/edges";

describe("scrolling regions' faded ends", () => {
  it("fade only where there is more beyond", () => {
    expect(edgeOf(0, 200, 200)).toBe("");
    expect(edgeOf(0, 1000, 200)).toBe("end");
    expect(edgeOf(400, 1000, 200)).toBe("both");
    expect(edgeOf(800, 1000, 200)).toBe("start");
    // Sub-pixel positions at an end count as the end.
    expect(edgeOf(0.5, 1000, 200)).toBe("end");
    expect(edgeOf(799.5, 1000, 200)).toBe("start");
  });
});
