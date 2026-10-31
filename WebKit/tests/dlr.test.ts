// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dlr, dlrBound, dlrClamp, installDLR, resistZoomOut, ZOOM_FLOOR, ZOOM_REST } from "../src/dlr";

describe("Dynamic Logarithmic Resistance", () => {
  it("gives, ever less, and never reaches its bound", () => {
    const pulls = [10, 50, 100, 500, 5000, 1e6].map((p) => dlr(p, 64));
    for (let i = 1; i < pulls.length; i++) expect(pulls[i]).toBeGreaterThan(pulls[i - 1]);
    expect(pulls[1] - pulls[0]).toBeGreaterThan(pulls[3] - pulls[2] > 0 ? (pulls[4] - pulls[3]) / 10 : 0);
    expect(pulls.at(-1)!).toBeLessThan(64);
    expect(dlr(10, 64)).toBeLessThan(10);
  });

  it("is zero at the limit and symmetric either way", () => {
    expect(dlr(0)).toBe(0);
    expect(dlr(-80, 64)).toBeCloseTo(-dlr(80, 64));
  });

  it("scales with what is being stretched, within limits", () => {
    expect(dlrBound(100)).toBeLessThan(dlrBound(400));
    expect(dlrBound(10)).toBe(20);
    expect(dlrBound(10000)).toBe(72);
  });

  it("leaves values in range alone, and resists past either end", () => {
    expect(dlrClamp(50, 0, 100)).toBe(50);
    expect(dlrClamp(140, 0, 100, 20)).toBeGreaterThan(100);
    expect(dlrClamp(140, 0, 100, 20)).toBeLessThan(120);
    expect(dlrClamp(-40, 0, 100, 20)).toBeLessThan(0);
    expect(dlrClamp(-40, 0, 100, 20)).toBeGreaterThan(-20);
  });
});

describe("zooming out", () => {
  const fit = 0.5;
  it("is free to 5% past fit", () => {
    expect(resistZoomOut(0.6, fit)).toBe(0.6);
    expect(resistZoomOut(fit * ZOOM_REST, fit)).toBeCloseTo(fit * ZOOM_REST);
  });
  it("resists after that, and never passes 10%", () => {
    let last = fit * ZOOM_REST;
    for (const asked of [0.47, 0.4, 0.3, 0.1, 0.01, 0.0001]) {
      const shown = resistZoomOut(asked, fit);
      expect(shown).toBeLessThan(last);
      expect(shown).toBeGreaterThan(fit * ZOOM_FLOOR);
      last = shown;
    }
  });
});

describe("in scrolling regions", () => {
  let remove: () => void;
  let region: HTMLDivElement;
  const wheel = (deltaY: number) => region.firstElementChild!.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
  beforeEach(() => {
    vi.useFakeTimers();
    remove = installDLR();
    region = document.createElement("div");
    region.style.overflowY = "auto";
    region.innerHTML = "<p>text</p>";
    document.body.appendChild(region);
    Object.defineProperties(region, { clientHeight: { value: 200, configurable: true }, scrollHeight: { value: 600, configurable: true } });
  });
  afterEach(() => {
    remove();
    region.remove();
    vi.useRealTimers();
  });

  it("stretches at the end, in the opposite direction to the push, and not before", () => {
    region.scrollTop = 100;
    wheel(-50);
    expect(region.hasAttribute("data-dlr")).toBe(false);
    region.scrollTop = 0;
    wheel(-50);
    expect(region.hasAttribute("data-dlr")).toBe(true);
    expect(parseFloat(region.style.getPropertyValue("--dlr-y"))).toBeGreaterThan(0);
    const first = parseFloat(region.style.getPropertyValue("--dlr-y"));
    wheel(-50);
    const second = parseFloat(region.style.getPropertyValue("--dlr-y"));
    expect(second).toBeGreaterThan(first);
    expect(second - first).toBeLessThan(first);
  });

  it("stretches the other way at the bottom", () => {
    region.scrollTop = 400;
    wheel(50);
    expect(parseFloat(region.style.getPropertyValue("--dlr-y"))).toBeLessThan(0);
  });

  it("does nothing under reduced motion", () => {
    const shell = document.createElement("div");
    shell.className = "reduce-motion";
    document.body.appendChild(shell);
    region.scrollTop = 0;
    wheel(-50);
    expect(region.hasAttribute("data-dlr")).toBe(false);
    shell.remove();
  });
});
