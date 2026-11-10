// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resist, resistBound, resistClamp, installEdgeResistance, resistZoomOut, ZOOM_FLOOR, ZOOM_REST } from "../src/CoreMotion/resistance";

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
  type Played = { keyframes: { transform: string; clipPath: string }[]; duration: number; cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null; currentTime: number };
  let played: Played[] = [];
  const flush = (ms = 16) => {
    vi.advanceTimersByTime(ms);
    const now = performance.now();
    frames.splice(0).forEach((frame) => frame(now));
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    played = [];
    region = document.createElement("div");
    region.style.overflowY = "auto";
    Object.defineProperty(region, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(region, "clientHeight", { value: 200, configurable: true });
    region.animate = ((keyframes: Played["keyframes"], options: { duration: number }) => {
      const one: Played = { keyframes, duration: options.duration, cancel: vi.fn(), onfinish: null, currentTime: 0 };
      played.push(one);
      return one;
    }) as never;
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
  // How long ago the input really happened, for events held up behind a busy page.
  let late = 0;
  const wheel = (deltaY: number) => {
    const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
    Object.defineProperty(event, "timeStamp", { value: performance.now() - late });
    region.dispatchEvent(event);
    return event;
  };
  const scrollTo = (top: number) => {
    region.scrollTop = top;
    region.dispatchEvent(new Event("scroll", { bubbles: true }));
  };
  const offset = (transform: string) => parseFloat(transform.split(",")[1] ?? "0");
  const curve = (one: Played) => one.keyframes.map((frame) => offset(frame.transform));
  const peak = (one: Played) => Math.max(...curve(one).map(Math.abs));
  const run = (count: number) => {
    for (let i = 0; i < count; i++) flush();
  };
  /** Reach the end of the list at `step` pixels a frame. */
  const arriveAt = (step: number) => {
    region.scrollTop = 800 - step * 3;
    wheel(step);
    scrollTo(800 - step * 2);
    flush();
    scrollTo(800 - step);
    flush();
    scrollTo(800);
    flush();
  };

  it("never blocks a wheel event, so scrolling stays with the compositor", () => {
    region.scrollTop = 0;
    expect(wheel(-300).defaultPrevented).toBe(false);
    region.scrollTop = 800;
    expect(wheel(300).defaultPrevented).toBe(false);
    run(8);
  });

  it("does nothing while there is room to scroll", () => {
    region.scrollTop = 100;
    wheel(-50);
    run(3);
    expect(played).toEqual([]);
    expect(region.style.transform).toBe("");
  });

  it("carries a fast arrival further than a slow one, within its bound", () => {
    arriveAt(6);
    const slow = peak(played[0]);
    flush(400);
    arriveAt(60);
    const fast = peak(played[1]);
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBeLessThanOrEqual(60);
    expect(fast).toBeGreaterThan(12);
  });

  it("starts just before the limit, so the content never stops and waits", () => {
    region.scrollTop = 500;
    wheel(40);
    scrollTo(540);
    flush();
    expect(played).toEqual([]);
    scrollTo(779);
    flush();
    expect(played).toHaveLength(1);
  });

  it("does not fire again on the way to a limit it has already answered", () => {
    region.scrollTop = 700;
    wheel(40);
    scrollTo(740);
    flush();
    scrollTo(780);
    wheel(40);
    flush();
    expect(played).toHaveLength(1);
    scrollTo(800);
    wheel(40);
    flush();
    expect(played).toHaveLength(1);
  });

  it("plays one curve: out, then home, with nothing left behind", () => {
    arriveAt(40);
    const one = curve(played[0]);
    expect(one[0]).toBeCloseTo(0);
    expect(one.at(-1)).toBeCloseTo(0);
    const furthest = one.findIndex((value) => value === Math.min(...one));
    for (let i = 1; i < one.length; i++) {
      if (i <= furthest) expect(one[i]).toBeLessThanOrEqual(one[i - 1]);
      else expect(one[i]).toBeGreaterThanOrEqual(one[i - 1]);
    }
    expect(played[0].duration).toBeGreaterThan(400);
    expect(played[0].duration).toBeLessThan(1000);
    expect(region.style.transform).toBe("");
  });

  it("clips what moves, so the region's frame stays still", () => {
    arriveAt(40);
    const furthest = played[0].keyframes[6];
    expect(offset(furthest.transform)).toBeLessThan(0);
    expect(furthest.clipPath).toMatch(/^inset\(\d/);
    expect(parseFloat(furthest.clipPath.slice(6))).toBeCloseTo(-offset(furthest.transform));
  });

  it("does not take a list being reset by code for a person scrolling", () => {
    scrollTo(800);
    flush(500);
    scrollTo(0);
    run(3);
    expect(played).toEqual([]);
  });

  it("gives a gesture one motion, however unevenly its momentum fades", () => {
    arriveAt(40);
    let size = 100;
    for (let i = 0; i < 60; i++) {
      // Plateaus and small rises, as a trackpad really sends them.
      wheel(Math.max(1, Math.round(size * (i % 5 === 0 ? 1.12 : 1))));
      size *= 0.93;
      flush();
    }
    expect(played).toHaveLength(1);
    expect(region.style.transform).toBe("");
  });

  it("does not take events held up by a busy page for a new gesture", () => {
    arriveAt(40);
    // The page stalls for 400 ms. Input carried on, and arrives all at once.
    flush(400);
    for (let at = 380; at >= 0; at -= 40) {
      late = at;
      wheel(40);
    }
    late = 0;
    run(12);
    expect(played).toHaveLength(1);
    expect(region.style.transform).toBe("");
  });

  it("goes without a bounce if the page missed the arrival", () => {
    region.scrollTop = 500;
    wheel(40);
    flush();
    scrollTo(540);
    flush();
    // Still scrolling during a stall: the content has stopped by the time the page sees it.
    flush(400);
    for (let at = 360; at >= 0; at -= 40) {
      late = at;
      wheel(40);
    }
    late = 0;
    scrollTo(800);
    flush();
    wheel(40);
    run(12);
    expect(played).toEqual([]);
    expect(region.style.transform).toBe("");
  });

  it("follows a push at the limit, then hands over without moving", () => {
    region.scrollTop = 800;
    wheel(100);
    run(4);
    const held = Math.abs(offset(region.style.transform));
    expect(held).toBeGreaterThan(0.5);
    expect(played).toEqual([]);
    run(8);
    expect(played).toHaveLength(1);
    expect(region.style.transform).toBe("");
    expect(Math.abs(curve(played[0])[0])).toBeGreaterThan(held * 0.5);
    expect(curve(played[0]).at(-1)).toBeCloseTo(0);
  });

  it("follows a slow, uneven pull at the limit for as long as it lasts", () => {
    region.scrollTop = 800;
    let last = 0;
    let most = 0;
    // A real finger: small, noisy, sometimes shrinking several times running.
    for (const delta of [3, 5, 4, 3, 2, 6, 5, 4, 3, 7, 5, 6, 4, 3, 5, 6, 4, 5, 3, 6]) {
      wheel(delta);
      flush();
      last = Math.abs(offset(region.style.transform));
      most = Math.max(most, last);
    }
    expect(most).toBeGreaterThan(12);
    expect(last).toBeGreaterThan(most * 0.8);
    expect(played).toEqual([]);
    run(14);
    expect(played).toHaveLength(1);
    expect(region.style.transform).toBe("");
  });

  it("answers at once: the first event of a pull already moves it", () => {
    region.scrollTop = 800;
    wheel(30);
    run(3);
    const shown = Math.abs(offset(region.style.transform));
    run(14);
    expect(shown).toBeGreaterThan(3);
  });

  it("picks up a pull that carries on after a fast arrival", () => {
    arriveAt(40);
    expect(played).toHaveLength(1);
    for (let i = 0; i < 8; i++) {
      wheel(20);
      flush();
    }
    expect(played[0].cancel).toHaveBeenCalled();
    expect(Math.abs(offset(region.style.transform))).toBeGreaterThan(8);
    run(14);
    expect(played).toHaveLength(2);
  });

  it("starts each pull from rest, not from where the last one reached", () => {
    region.scrollTop = 800;
    for (let i = 0; i < 8; i++) {
      wheel(30);
      flush();
    }
    run(14);
    played[0].onfinish?.();
    flush(300);
    wheel(6);
    run(3);
    const shown = Math.abs(offset(region.style.transform));
    run(14);
    expect(shown).toBeLessThan(4);
  });

  it("answers a new gesture after a pause", () => {
    arriveAt(40);
    flush(300);
    wheel(100);
    run(4);
    expect(Math.abs(offset(region.style.transform))).toBeGreaterThan(0.5);
    run(10);
    expect(played).toHaveLength(2);
  });

  it("moves only the region itself", () => {
    const child = document.createElement("div");
    region.appendChild(child);
    region.scrollTop = 800;
    wheel(400);
    run(3);
    expect(Math.abs(offset(region.style.transform))).toBeGreaterThan(0.5);
    expect(child.style.transform).toBe("");
    run(10);
  });

  it("does nothing under reduced motion", () => {
    document.documentElement.classList.add("reduce-motion");
    arriveAt(40);
    wheel(400);
    run(3);
    expect(played).toEqual([]);
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
