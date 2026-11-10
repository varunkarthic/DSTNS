// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SeekFilm } from "../src/film/SeekFilm";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a jump through the day", () => {
  it("shows nothing for a quick one, then which way and how far, and leaves once it has landed", () => {
    vi.useFakeTimers();
    const { rerender } = render(<SeekFilm seek={{ direction: 1, seconds: 3600 }} reduceMotion />);
    act(() => void vi.advanceTimersByTime(120));
    expect(document.querySelector(".seek-film")).toBeNull();
    act(() => void vi.advanceTimersByTime(100));
    expect(document.querySelector(".seek-film.visible")).toHaveTextContent("Fast-forward 1 h 00 min");
    rerender(<SeekFilm seek={null} reduceMotion />);
    expect(document.querySelector(".seek-film.visible")).toBeNull();
    act(() => void vi.advanceTimersByTime(500));
    expect(document.querySelector(".seek-film")).toBeNull();
    rerender(<SeekFilm seek={{ direction: -1, seconds: 300 }} reduceMotion />);
    act(() => void vi.advanceTimersByTime(200));
    expect(document.querySelector(".seek-film")).toHaveTextContent(/Rewind/);
  });
});
