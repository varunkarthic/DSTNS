// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { formatCompact } from "../src/format";

describe("formatCompact", () => {
  it.each([
    [0, "0"],
    [7, "7"],
    [999, "999"],
    [1000, "1K"],
    [1240, "1.2K"],
    [6234, "6.2K"],
    [12850, "12.9K"],
    [99_949, "99.9K"],
    [105_000, "105K"],
    [999_400, "999K"],
    [1_250_000, "1.25M"],
    [12_500_000, "12.5M"],
    [250_000_000, "250M"],
    [3_400_000_000, "3.4B"],
  ])("formats %d as %s", (value, text) => {
    expect(formatCompact(value)).toBe(text);
  });

  it("carries a value that rounds up into the next unit", () => {
    expect(formatCompact(999_960)).toBe("1M");
    expect(formatCompact(99_960)).toBe("100K");
  });

  it("drops trailing zeros rather than padding", () => {
    expect(formatCompact(2000)).toBe("2K");
    expect(formatCompact(2_000_000)).toBe("2M");
    expect(formatCompact(1_050_000)).toBe("1.05M");
  });

  it("keeps the sign and rejects non-finite input", () => {
    expect(formatCompact(-1240)).toBe("-1.2K");
    expect(formatCompact(Number.NaN)).toBe("0");
    expect(formatCompact(Infinity)).toBe("0");
  });

  it("never exceeds six characters for realistic counts", () => {
    for (let n = 1; n < 5e9; n = Math.ceil(n * 1.37)) expect(formatCompact(n).length).toBeLessThanOrEqual(6);
  });
});
