// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatEventTime,
  formatSimulationTime,
  formatWallDuration,
  localizeTimes,
  parseClock,
} from "../src/timeFormat";

describe("formatSimulationTime", () => {
  it("formats 24 hour time with seconds", () => {
    expect(formatSimulationTime(0, false)).toBe("00:00:00");
    expect(formatSimulationTime(31337, false)).toBe("08:42:17");
    expect(formatSimulationTime(86399, false)).toBe("23:59:59");
  });

  it("formats 12 hour time with a meridiem", () => {
    expect(formatSimulationTime(0, true)).toBe("12:00:00 AM");
    expect(formatSimulationTime(31337, true)).toBe("8:42:17 AM");
    expect(formatSimulationTime(43200, true)).toBe("12:00:00 PM");
    expect(formatSimulationTime(46800, true)).toBe("1:00:00 PM");
    expect(formatSimulationTime(86399, true)).toBe("11:59:59 PM");
  });

  it("writes the close of the day in each convention", () => {
    expect(formatSimulationTime(86400, false)).toBe("24:00:00");
    expect(formatSimulationTime(86400, true)).toBe("12:00:00 AM");
  });

  it("can omit seconds", () => {
    expect(formatSimulationTime(31337, false, { seconds: false })).toBe("08:42");
    expect(formatSimulationTime(31337, true, { seconds: false })).toBe("8:42 AM");
  });

  it("clamps and sanitizes out-of-range input", () => {
    expect(formatSimulationTime(-50, false)).toBe("00:00:00");
    expect(formatSimulationTime(999999, false)).toBe("24:00:00");
    expect(formatSimulationTime(Number.NaN, false)).toBe("00:00:00");
    expect(formatSimulationTime(59.9, false)).toBe("00:00:59");
  });
});

describe("parseClock", () => {
  it("parses clock strings", () => {
    expect(parseClock("08:42:17")).toBe(31337);
    expect(parseClock("8:42")).toBe(31320);
    expect(parseClock("24:00:00")).toBe(86400);
  });
  it("rejects invalid times", () => {
    expect(parseClock("25:00:00")).toBeNull();
    expect(parseClock("12:60:00")).toBeNull();
    expect(parseClock("24:00:01")).toBeNull();
    expect(parseClock("noon")).toBeNull();
  });
});

describe("formatEventTime", () => {
  it("prefers canonical seconds over the preformatted string", () => {
    expect(formatEventTime({ virtual_day_s: 46800, simulated_current_time: "00:00:00" }, true)).toBe(
      "1:00:00 PM",
    );
  });
  it("accepts scheduled-event records", () => {
    expect(formatEventTime({ virtual_s: 3600 }, false)).toBe("01:00:00");
  });
  it("falls back to the preformatted string", () => {
    expect(formatEventTime({ simulated_current_time: "13:05:09" }, true)).toBe("1:05:09 PM");
    expect(formatEventTime({}, true)).toBe("");
  });
});

describe("localizeTimes", () => {
  const text = "[14:30:00] Rain storm scheduled at 16:45:00 around Node 12 (until 18:00)";
  it("leaves text untouched in 24 hour mode", () => {
    expect(localizeTimes(text, false)).toBe(text);
  });
  it("rewrites every embedded clock time in 12 hour mode", () => {
    expect(localizeTimes(text, true)).toBe(
      "[2:30:00 PM] Rain storm scheduled at 4:45:00 PM around Node 12 (until 6:00 PM)",
    );
  });
  it("ignores numbers that are not clock times", () => {
    expect(localizeTimes("Ratio 99:99 and score 3:1", true)).toBe("Ratio 99:99 and score 3:1");
  });
});

describe("durations", () => {
  it("formats virtual durations", () => {
    expect(formatDuration(42)).toBe("42 s");
    expect(formatDuration(720)).toBe("12 min");
    expect(formatDuration(7500)).toBe("2 h 05 min");
    expect(formatDuration(86400)).toBe("24 h 00 min");
    expect(formatDuration(-1)).toBe("");
  });
  it("formats wall-clock durations", () => {
    expect(formatWallDuration(4000)).toBe("4 s");
    expect(formatWallDuration(125000)).toBe("2 min 05 s");
    expect(formatWallDuration(3723000)).toBe("1 h 02 min 03 s");
  });
});
