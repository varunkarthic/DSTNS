// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Compass } from "../src/NetworkMap";

describe("compass", () => {
  afterEach(cleanup);
  it("names all four directions with north up on an unrotated map", () => {
    render(<Compass />);
    const compass = screen.getByTestId("compass");
    for (const d of ["N", "E", "S", "W"]) expect(compass).toHaveTextContent(d);
    expect(compass.querySelector("svg")?.getAttribute("style") ?? "").toContain("rotate(0deg)");
  });
  it("turns against the map, so north still points north", () => {
    render(<Compass rotation={30} />);
    expect(screen.getByTestId("compass").querySelector("svg")?.getAttribute("style")).toContain("rotate(-30deg)");
  });
});
