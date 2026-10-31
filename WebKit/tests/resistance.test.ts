// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resist, resistBound, resistClamp, installEdgeResistance, resistZoomOut, ZOOM_FLOOR, ZOOM_REST } from "../src/resistance";

describe("Dynamic Edge Resistance", () => {
  it("gives, ever less, and never reaches its bound", () => {
    const pulls = [10, 50, 100, 500, 5000, 1e6].map((p) => resist(p, 64));
    for (let i = 1; i < pulls.length; i++) expect(pulls[i]).toBeGreaterThan(pulls[i - 1]);
    expect(pulls[1] - pulls[0]).toBeGreaterThan(pulls[3] - pulls[2] > 0 ? (pulls[4] - pulls[3]) / 10 : 0);
    expect(pulls.at(-1)!).toBeLessThan(64);
    expect(resist(10, 64)).toBeLessThan(10);
  });

  it("is zero at the limit and symmetric either way", () => {
    expect(resist(0)).toBe(0);
    expect(resist(-80, 64)).toBeCloseTo(-resist(80, 64));
  });

  it("scales with what is being stretched, within limits", () => {
    expect(resistBound(100)).toBeLessThan(resistBound(400));
    expect(resistBound(10)).toBe(28);
    expect(resistBound(10000)).toBe(120);
  });

  it("leaves values in range alone, and resists past either end", () => {
    expect(resistClamp(50, 0, 100)).toBe(50);
    expect(resistClamp(140, 0, 100, 20)).toBeGreaterThan(100);
    expect(resistClamp(140, 0, 100, 20)).toBeLessThan(120);
    expect(resistClamp(-40, 0, 100, 20)).toBeLessThan(0);
    expect(resistClamp(-40, 0, 100, 20)).toBeGreaterThan(-20);
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
    remove = installEdgeResistance();
    region = document.createElement("div");
    region.style.overflowY = "auto";
    region.innerHTML = "<p>text</p>";
    document.body.appendChild(region);
    Object.defineProperties(region, { clientHeight: { value: 200, configurable: true }, scrollHeight: { value: 600, configurable: true } });
  });
  afterEach(() => {
    vi.advanceTimersByTime(3000); // Lets every spring come to rest.
    remove();
    region.remove();
    vi.useRealTimers();
  });

  const offset = () => parseFloat(region.style.getPropertyValue("--edge-y"));
  const settle = () => vi.advanceTimersByTime(48);

  it("stretches at the end, opposite to the push, smoothly, and not before", () => {
    region.scrollTop = 100;
    wheel(-50);
    settle();
    expect(region.hasAttribute("data-edge")).toBe(false);
    region.scrollTop = 0;
    wheel(-50);
    settle();
    expect(region.hasAttribute("data-edge")).toBe(true);
    const first = offset();
    expect(first).toBeGreaterThan(0);
    wheel(-50);
    settle();
    const second = offset();
    wheel(-50);
    settle();
    const third = offset();
    expect(second).toBeGreaterThan(first);
    expect(third - second).toBeLessThan(second - first + 1);
  });

  it("starts back at once, even while a trackpad's fading momentum still arrives", () => {
    region.scrollTop = 0;
    wheel(-200);
    settle();
    // Events that small cannot hold a stretch out: there is no waiting for them to end.
    let peak = 0;
    for (let i = 0; i < 36; i++) {
      wheel(-1);
      vi.advanceTimersByTime(16);
      peak = Math.max(peak, offset());
    }
    expect(offset()).toBeLessThan(peak * 0.5);
    vi.advanceTimersByTime(2000);
    expect(region.hasAttribute("data-edge")).toBe(false);
  });

  it("goes home when the wheel stops", () => {
    region.scrollTop = 0;
    wheel(-200);
    settle();
    expect(offset()).toBeGreaterThan(0);
    vi.advanceTimersByTime(2000);
    expect(region.hasAttribute("data-edge")).toBe(false);
  });

  it("stretches the other way at the bottom", () => {
    region.scrollTop = 400;
    wheel(50);
    settle();
    expect(offset()).toBeLessThan(0);
  });

  it("never lets the page scroll over something that does not scroll", () => {
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    const event = new WheelEvent("wheel", { deltaY: 50, bubbles: true, cancelable: true });
    plain.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    plain.remove();
  });

  it("puts back a container that focus or scrollIntoView moved", () => {
    const shell = document.createElement("div");
    shell.className = "workspace";
    document.body.appendChild(shell);
    shell.scrollTop = 40;
    shell.dispatchEvent(new Event("scroll"));
    expect(shell.scrollTop).toBe(0);
    shell.remove();
  });

  it("does nothing under reduced motion", () => {
    document.documentElement.classList.add("reduce-motion");
    region.scrollTop = 0;
    wheel(-50);
    settle();
    expect(region.hasAttribute("data-edge")).toBe(false);
    document.documentElement.classList.remove("reduce-motion");
  });
});
