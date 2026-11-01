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
  let region: HTMLElement;
  let remove: () => void;
  const frames: FrameRequestCallback[] = [];
  const flush = (ms = 16) => {
    vi.advanceTimersByTime(ms);
    const now = performance.now();
    frames.splice(0).forEach((frame) => frame(now));
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    region = document.createElement("div");
    region.style.overflowY = "auto";
    Object.defineProperty(region, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(region, "clientHeight", { value: 200, configurable: true });
    document.body.appendChild(region);
    remove = installEdgeResistance();
  });
  afterEach(() => {
    remove();
    region.remove();
    frames.length = 0;
    document.documentElement.classList.remove("reduce-motion");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const wheel = (deltaY: number) => {
    const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
    region.dispatchEvent(event);
    return event;
  };
  const shift = () => Math.abs(parseFloat(region.style.transform.split(",")[1] ?? "0"));
  const run = (count: number) => {
    for (let i = 0; i < count; i++) flush();
  };

  it("never blocks a wheel event, so scrolling stays with the compositor", () => {
    region.scrollTop = 0;
    expect(wheel(-300).defaultPrevented).toBe(false);
    region.scrollTop = 800;
    expect(wheel(300).defaultPrevented).toBe(false);
  });

  it("does nothing until a limit is reached", () => {
    region.scrollTop = 100;
    wheel(-50);
    run(3);
    expect(region.style.transform).toBe("");
  });

  it("gives a little at a limit, and only a little", () => {
    region.scrollTop = 0;
    wheel(-2000);
    run(3);
    expect(shift()).toBeGreaterThan(0.5);
    expect(shift()).toBeLessThanOrEqual(12);
  });

  it("is back quickly, and leaves nothing behind", () => {
    region.scrollTop = 0;
    wheel(-400);
    run(30);
    expect(region.style.transform).toBe("");
    expect(region.style.transform).toBe("");
  });

  it("moves only the region itself, one transform", () => {
    const child = document.createElement("div");
    region.appendChild(child);
    region.scrollTop = 0;
    wheel(-400);
    run(3);
    expect(child.style.transform).toBe("");
    expect(region.style.getPropertyValue("--edge-y")).toBe("");
  });

  it("does nothing under reduced motion", () => {
    document.documentElement.classList.add("reduce-motion");
    region.scrollTop = 0;
    wheel(-200);
    run(3);
    expect(region.style.transform).toBe("");
  });

  it("puts back a container that focus or scrollIntoView moved", () => {
    const shell = document.createElement("div");
    shell.className = "app-shell";
    document.body.appendChild(shell);
    Object.defineProperty(shell, "scrollTop", { value: 40, writable: true, configurable: true });
    shell.dispatchEvent(new Event("scroll"));
    expect(shell.scrollTop).toBe(0);
    shell.remove();
  });
});
