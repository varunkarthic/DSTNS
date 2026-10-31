// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BootFailure, BOOT_STEPS, ShutdownSurface, Splash, splashStageFor } from "../src/Splash";

afterEach(cleanup);

describe("start-up states", () => {
  it("names the real stage rather than reassuring, and shows every stage", () => {
    render(<Splash stage={{ step: 3, label: "Generating world", detail: "Building the road graph" }} reduceMotion={false} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Generating world");
    expect(screen.getByText("Building the road graph")).toBeInTheDocument();
    for (const step of BOOT_STEPS) expect(screen.getAllByText(step.label).length).toBeGreaterThan(0);
    expect(document.querySelector(".loading-steps [aria-current=step]")).toHaveTextContent("Generating world");
  });

  it("claims no progress until a real total is known", () => {
    const { rerender } = render(<Splash stage={{ step: 2, label: "Downloading" }} reduceMotion={false} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    rerender(<Splash stage={{ step: 2, label: "Downloading", progress: 0.5 }} reduceMotion={false} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  });

  it("looks idle when nothing is running: no ring, stages or working band", () => {
    render(<Splash stage={{ step: 1, waiting: true, label: "Waiting for a simulation", detail: "Start a run from the DSTNS CLI." }} reduceMotion={false} />);
    expect(document.querySelector(".loading-ring")).toBeNull();
    expect(document.querySelector(".loading-steps")).toBeNull();
    expect(document.querySelector(".loading-progress.working")).toBeNull();
    expect(document.querySelector(".loading-mark")).not.toHaveClass("animated");
  });

  it("carries the licence on every start-up surface", () => {
    for (const surface of [
      <Splash key="a" stage={{ step: 0, label: "Starting" }} reduceMotion />,
      <BootFailure key="b" message="Connection failed." reduceMotion />,
      <ShutdownSurface key="c" reduceMotion />,
    ]) {
      render(surface);
      expect(screen.getByText(/AGPL-3.0-or-later/)).toHaveTextContent(/Varun Karthic.*OpenStreetMap contributors/);
      cleanup();
    }
  });

  it("explains a failure, says what is safe, and offers a way forward", () => {
    render(<BootFailure message="World preparation failed." reduceMotion={false} />);
    expect(screen.getByRole("alertdialog")).toHaveTextContent("DSTNS could not start");
    expect(screen.getByText("World preparation failed.")).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been lost/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("says plainly when the server has gone", () => {
    render(<ShutdownSurface reduceMotion={false} />);
    expect(screen.getByRole("heading")).toHaveTextContent("DSTNS has shut down");
    expect(screen.getByText(/Start a new run from the DSTNS CLI/)).toBeInTheDocument();
    expect(document.querySelector(".loading-progress.working")).toBeNull();
  });

  it("stops at the first network, with nothing held after it", () => {
    expect(splashStageFor(null, "RUNNING", "", true)).toBeNull();
  });
});
