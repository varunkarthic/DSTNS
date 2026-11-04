// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeFormatProvider } from "../src/preferences";
import { describeDistance, fromFields, jumpTarget, LONG_PRESS_MS, TimeControl } from "../src/TimeControl";
import { rollingTime } from "../src/SeekFilm";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Clock({ seconds = 8 * 3600 + 30 * 60, onSeekTo = () => {} }: { seconds?: number; onSeekTo?: (t: number) => void }) {
  const [hour12, setHour12] = useState(false);
  return (
    <TimeFormatProvider hour12={hour12} onToggle={() => setHour12((v) => !v)}>
      <TimeControl seconds={seconds} hasClock percent={35} paused={false} disabled={false} onSeekTo={onSeekTo} />
    </TimeFormatProvider>
  );
}

describe("Time Control", () => {
  it("works out targets within the day", () => {
    expect(jumpTarget(3600, 1, 2, 30)).toBe(3600 + 9000);
    expect(jumpTarget(3600, -1, 5, 0)).toBe(0);
    expect(jumpTarget(80000, 1, 3, 0)).toBe(86400);
    expect(fromFields(12, 0, true, false)).toBe(0);
    expect(fromFields(12, 30, true, true)).toBe(12 * 3600 + 1800);
    expect(fromFields(7, 5, true, true)).toBe(19 * 3600 + 300);
    expect(fromFields(19, 5, false, false)).toBe(19 * 3600 + 300);
    expect(describeDistance(5400)).toBe("1 h 30 min ahead.");
    expect(describeDistance(-600)).toBe("10 min back.");
    expect(describeDistance(10)).toBe("That is now.");
  });

  it("opens on a click and goes to the time typed", () => {
    const onSeekTo = vi.fn();
    render(<Clock onSeekTo={onSeekTo} />);
    fireEvent.click(screen.getByRole("button", { name: /Simulation time/ }));
    const menu = screen.getByRole("dialog", { name: "Time Control" });
    expect(menu).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Hour"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("Minute"), { target: { value: "05" } });
    expect(menu).toHaveTextContent("5 h 35 min ahead.");
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onSeekTo).toHaveBeenCalledWith(14 * 3600 + 300);
  });

  it("jumps by hours and minutes, either way", () => {
    const onSeekTo = vi.fn();
    render(<Clock onSeekTo={onSeekTo} />);
    fireEvent.click(screen.getByRole("button", { name: /Simulation time/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Back" }));
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Jump" }));
    expect(onSeekTo).toHaveBeenCalledWith(8 * 3600 + 30 * 60 - (2 * 3600 + 15 * 60));
  });

  it("switches to 12-hour time from the menu, or by holding the clock", () => {
    vi.useFakeTimers();
    render(<Clock seconds={15 * 3600} />);
    const clock = screen.getByRole("button", { name: /Simulation time/ });
    expect(clock).toHaveTextContent("15:00:00");
    fireEvent.pointerDown(clock, { button: 0 });
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    fireEvent.pointerUp(clock);
    fireEvent.click(clock);
    expect(clock).toHaveTextContent(/3:00:00\s*PM/);
    expect(screen.queryByRole("dialog", { name: "Time Control" })).toBeNull();
    fireEvent.click(clock);
    fireEvent.click(screen.getByRole("radio", { name: "24-hour" }));
    expect(clock).toHaveTextContent("15:00:00");
  });
});

describe("a jump's clock", () => {
  it("runs most of the way while the jump is worked out, and lands on the target", () => {
    expect(rollingTime(1000, 4600, 0, false)).toBe(1000);
    const later = rollingTime(1000, 4600, 3, false);
    expect(later).toBeGreaterThan(4000);
    expect(later).toBeLessThan(4600);
    expect(rollingTime(1000, 4600, 0.1, true)).toBe(4600);
    expect(rollingTime(4600, 1000, 3, false)).toBeLessThan(1600);
  });
});
