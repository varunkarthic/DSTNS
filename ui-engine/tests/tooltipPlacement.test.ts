// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { computePlacement, intersectionArea } from "../src/tooltipPlacement";
import type { Rect } from "../src/tooltipPlacement";

const viewport = { width: 1280, height: 800 };
const tip = { width: 160, height: 44 };
const anchor = (left: number, top: number, size = 36): Rect => ({ left, top, width: size, height: size });
const boxOf = (p: { left: number; top: number }) => ({ left: p.left, top: p.top, ...tip });

describe("intersectionArea", () => {
  it("measures overlap and ignores touching edges", () => {
    expect(intersectionArea({ left: 0, top: 0, width: 10, height: 10 }, { left: 5, top: 5, width: 10, height: 10 })).toBe(25);
    expect(intersectionArea({ left: 0, top: 0, width: 10, height: 10 }, { left: 10, top: 0, width: 10, height: 10 })).toBe(0);
  });
});

describe("computePlacement", () => {
  it("prefers the top when there is room", () => {
    const a = anchor(600, 400);
    const p = computePlacement({ anchor: a, tip, viewport });
    expect(p.side).toBe("top");
    expect(p.top + tip.height).toBeLessThanOrEqual(a.top);
    expect(p.left + tip.width / 2).toBeCloseTo(a.left + a.width / 2);
    expect(p.fits).toBe(true);
  });

  it("flips below an anchor at the top of the viewport", () => {
    const a = anchor(600, 10);
    const p = computePlacement({ anchor: a, tip, viewport });
    expect(p.side).toBe("bottom");
    expect(p.top).toBeGreaterThanOrEqual(a.top + a.height);
  });

  it("slides along the edge instead of overflowing, keeping the arrow on the anchor", () => {
    const a = anchor(1250, 400, 24);
    const p = computePlacement({ anchor: a, tip, viewport });
    expect(p.left + tip.width).toBeLessThanOrEqual(viewport.width - 8);
    // The arrow still points at the anchor centre.
    expect(p.left + p.arrow).toBeCloseTo(a.left + a.width / 2, 0);
  });

  it("never covers the anchor itself", () => {
    for (const [x, y] of [[4, 4], [1240, 4], [4, 760], [1240, 760], [600, 400]]) {
      const a = anchor(x, y);
      const p = computePlacement({ anchor: a, tip, viewport });
      expect(intersectionArea(boxOf(p), a)).toBe(0);
    }
  });

  it("moves off a neighbouring control when another side is free", () => {
    const a = anchor(600, 400);
    const neighbourAbove: Rect = { left: 540, top: 330, width: 160, height: 60 };
    const p = computePlacement({ anchor: a, tip, viewport, avoid: [neighbourAbove] });
    expect(p.side).not.toBe("top");
    expect(p.overlap).toBe(0);
  });

  it("chooses the least-covering side when every side is crowded", () => {
    const a = anchor(600, 400);
    const avoid: Rect[] = [
      { left: 500, top: 300, width: 240, height: 90 }, // above, large
      { left: 560, top: 446, width: 120, height: 20 }, // below, small
      { left: 646, top: 380, width: 200, height: 80 }, // right
      { left: 380, top: 380, width: 210, height: 80 }, // left
    ];
    const p = computePlacement({ anchor: a, tip, viewport, avoid });
    const overlaps = (["top", "bottom", "left", "right"] as const).map((side) =>
      computePlacement({ anchor: a, tip, viewport, avoid, preferred: [side] }),
    );
    expect(p.overlap).toBe(Math.min(...overlaps.map((o) => o.overlap)));
    expect(p.side).toBe("bottom");
  });

  it("ignores an avoided region that contains the anchor", () => {
    const a = anchor(600, 740);
    const rail: Rect = { left: 300, top: 730, width: 700, height: 56 };
    const p = computePlacement({ anchor: a, tip, viewport, avoid: [rail] });
    expect(p.side).toBe("top");
  });

  it("uses the side the caller prefers when it is clear", () => {
    const p = computePlacement({ anchor: anchor(600, 400), tip, viewport, preferred: ["right"] });
    expect(p.side).toBe("right");
  });

  it("stays within the viewport even when nothing fits", () => {
    const tiny = { width: 120, height: 60 };
    const p = computePlacement({ anchor: { left: 20, top: 10, width: 80, height: 40 }, tip: { width: 200, height: 50 }, viewport: tiny });
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.fits).toBe(false);
  });

  it("reacts to viewport changes", () => {
    // Too close to the top for "top": a tall window flips below the anchor...
    const a = anchor(600, 80);
    const big = { width: 160, height: 100 };
    const tall = computePlacement({ anchor: a, tip: big, viewport });
    expect(tall.side).toBe("bottom");
    // ...but once the window is too short for that as well, it moves beside it.
    const short = computePlacement({ anchor: a, tip: big, viewport: { width: 1280, height: 200 } });
    expect(short.side).toBe("right");
    expect(short.fits).toBe(true);
    expect(short.top + big.height).toBeLessThanOrEqual(200 - 8);
  });
});

describe("weighted regions", () => {
  it("prefers covering a readout over covering a control", () => {
    const a = anchor(600, 400);
    const readoutAbove: Rect = { left: 560, top: 350, width: 120, height: 40 };
    const buttonBelow: Rect = { left: 560, top: 440, width: 120, height: 40, weight: 3 };
    const buttonsBeside: Rect[] = [
      { left: 640, top: 380, width: 200, height: 80, weight: 3 },
      { left: 380, top: 380, width: 216, height: 80, weight: 3 },
    ];
    const p = computePlacement({ anchor: a, tip, viewport, avoid: [readoutAbove, buttonBelow, ...buttonsBeside] });
    expect(p.side).toBe("top");
  });
});
