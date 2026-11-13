// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { WebFabricSettings } from "../src/webfabric/Settings";
import { fabric } from "../src/webfabric/store";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// The Settings drawer is drawn again whenever the observer polls the run. The WebFabric pages are not drawn with it:
// drawing their lists mid-scroll is what made scrolling them stutter.
it("is not drawn again when the drawer around it is", async () => {
  // The page reads the applications from the store each time it is drawn.
  const reads = vi.spyOn(fabric, "getApps");
  let poll = () => {};
  const back = () => {};
  function Drawer() {
    const [, setTick] = useState(0);
    poll = () => setTick((t) => t + 1);
    return <WebFabricSettings onBack={back} />;
  }
  render(<Drawer />);
  await act(async () => {});
  const settled = reads.mock.calls.length;
  expect(settled).toBeGreaterThan(0);
  for (let i = 0; i < 5; i++) await act(async () => poll());
  expect(reads.mock.calls.length).toBe(settled);
});
