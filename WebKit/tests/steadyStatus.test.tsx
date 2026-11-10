// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEGRADE_AFTER_MS, holdFor, RECOVER_AFTER_MS, useSteadyStatus } from "../src/simulation/useSteadyStatus";
import type { RuntimeStatus } from "../src/simulation/telemetryRecorder";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("needs longer to believe a recovery than trouble, and shows a lost server at once", () => {
  expect(holdFor("online", "degraded")).toBe(DEGRADE_AFTER_MS);
  expect(holdFor("degraded", "online")).toBe(RECOVER_AFTER_MS);
  expect(RECOVER_AFTER_MS).toBeGreaterThan(DEGRADE_AFTER_MS);
  expect(holdFor("online", "offline")).toBe(0);
  expect(holdFor("offline", "online")).toBe(0);
});

it("does not flip with a reading that comes and goes", () => {
  const { result, rerender } = renderHook(({ reading }) => useSteadyStatus(reading), { initialProps: { reading: "online" as RuntimeStatus } });
  for (let i = 0; i < 8; i++) {
    rerender({ reading: "degraded" });
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current).toBe("online");
    rerender({ reading: "online" });
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current).toBe("online");
  }
});

it("settles on a reading that holds, and comes back only after it has really recovered", () => {
  const { result, rerender } = renderHook(({ reading }) => useSteadyStatus(reading), { initialProps: { reading: "online" as RuntimeStatus } });
  rerender({ reading: "degraded" });
  act(() => vi.advanceTimersByTime(DEGRADE_AFTER_MS + 1));
  expect(result.current).toBe("degraded");
  rerender({ reading: "online" });
  act(() => vi.advanceTimersByTime(RECOVER_AFTER_MS - 1000));
  expect(result.current).toBe("degraded");
  act(() => vi.advanceTimersByTime(1001));
  expect(result.current).toBe("online");
});
