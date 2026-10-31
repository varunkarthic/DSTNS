// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ISD_NOTES, ISDHandler, nextNote } from "../src/ISDHandler";
import type { ISDCondition } from "../src/ISDHandler";

describe("Intentional System Design Handler", () => {
  it("says it is intended, why, and what to do next, for every condition", () => {
    for (const note of Object.values(ISD_NOTES)) {
      expect(note.title.length).toBeGreaterThan(0);
      expect(note.why.length).toBeGreaterThan(0);
      expect(note.next.length).toBeGreaterThan(0);
    }
  });

  it("keeps the note showing while it holds, then moves to one not yet seen", () => {
    expect(nextNote(["async", "restricted"], "restricted", new Set(["async", "restricted"]))).toBe("restricted");
    expect(nextNote(["async", "restricted"], null, new Set(["async"]))).toBe("restricted");
    expect(nextNote(["async"], null, new Set(["async"]))).toBeNull();
  });

  it("appears when a condition begins and leaves when it ends", () => {
    const view = render(<ISDHandler active={[]} />);
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(<ISDHandler active={["async"]} />);
    expect(screen.getByText(ISD_NOTES.async.title)).toBeInTheDocument();
    expect(screen.getByText("Intentional system design")).toBeInTheDocument();
    view.rerender(<ISDHandler active={[]} />);
    expect(screen.queryByText(ISD_NOTES.async.title)).toBeNull();
  });

  it("does not come back in the same session once seen, and shows the next when dismissed", () => {
    const both: ISDCondition[] = ["rate-locked", "large-steps"];
    const view = render(<ISDHandler active={both} />);
    expect(screen.getByText(ISD_NOTES["rate-locked"].title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByText(ISD_NOTES["large-steps"].title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(<ISDHandler active={[]} />);
    view.rerender(<ISDHandler active={both} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
